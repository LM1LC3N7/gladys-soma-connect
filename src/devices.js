// -----------------------------------------------------------------------------
// The answers of SOMA Connect -> plain records and Gladys devices (pure).
//
// One Gladys device per SOMA device, a `shutter` (never a switch nor a
// binary: a "turn everything off" never reaches it):
//   state     shutter/state      open, close, stop (write only)
//   position  shutter/position   0 closed .. 100 open (read and write)
//   battery   battery/integer    % (read only, read at most once an hour)
//
// Positions (Gladys 100 = open, as every cover of Gladys):
//   - Smart Shades: SOMA 0 = open, 100 = closed, so Gladys = 100 - SOMA;
//   - Tilt (slats of a venetian blind): SOMA 0 = slats level (open), 100 =
//     closed downwards; a Tilt closed upwards answers its position with
//     `closed_upwards`. Gladys = 100 - |SOMA| either way, and the commands
//     only ever close downwards (SOMA 0..100, never a negative value).
// So a command is always SOMA = 100 - Gladys, an integer 0..100.
//
// Identity rule (frozen: it fixes the external ids): the MAC address of the
// shade given by list_devices, 12 lower-case hexadecimal digits without
// separators. `ext:<selector>:soma:<mac>`, features `<device>:<key>`.
// Values from the network are copied key by key, never merged.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { cleanText } from './config.js';
import { FEATURES, KINDS, LIMITS, MAX_SHADES } from './constants.js';
import { label } from './i18n.js';
import { isRawMac, styleOf } from './soma/client.js';

const MAC = /^[0-9a-f]{12}$/;

/** The identity of a MAC address as SOMA Connect gives it: 12 lower-case hexadecimal digits. */
export function idOf(raw) {
  return isRawMac(raw) ? raw.replace(/:/g, '').toLowerCase() : undefined;
}

/** The firmware version of list_devices, or undefined. */
export function versionOf(json) {
  const v = json?.version;
  return typeof v === 'string' && styleOf(v) !== undefined ? v : undefined;
}

/**
 * The devices of list_devices: `{ shades: [{ id, mac, name, kind }], duplicates, dropped }`.
 * The first entry of a MAC wins (two entries of one MAC are counted, never
 * merged); at most MAX_SHADES; an entry without a valid MAC is skipped.
 */
export function shadesOf(json) {
  const out = [];
  let duplicates = 0;
  let dropped = 0;
  let skipped = 0;
  const list = Array.isArray(json?.shades) ? json.shades.slice(0, LIMITS.listEntries) : [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      skipped += 1;
      continue;
    }
    const id = idOf(entry.mac);
    if (!id) {
      skipped += 1;
      continue;
    }
    if (out.some((s) => s.id === id)) {
      duplicates += 1;
      continue;
    }
    if (out.length >= MAX_SHADES) {
      dropped += 1;
      continue;
    }
    out.push({
      id,
      mac: entry.mac,
      name: cleanText(entry.name, LIMITS.name),
      // Connect before 2.2.6 gives no type: a shade (as Home Assistant does).
      kind:
        typeof entry.type === 'string' && entry.type.toLowerCase() === KINDS.TILT
          ? KINDS.TILT
          : KINDS.SHADE,
    });
  }
  return { shades: out, duplicates, dropped, skipped };
}

/**
 * A position of SOMA Connect: a finite number (or the text of one), rounded
 * as Home Assistant does with int(); undefined otherwise.
 */
function integerOf(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.round(value) : undefined;
  }
  if (typeof value === 'string' && /^-?\d{1,4}(\.\d{1,6})?$/.test(value)) {
    return Math.round(Number(value));
  }
  return undefined;
}

/** The Gladys position (0 closed .. 100 open) of a get_shade_state answer, or undefined. */
export function positionOf(json, kind) {
  const p = integerOf(json?.position);
  if (p === undefined) {
    return undefined;
  }
  if (kind === KINDS.TILT) {
    return Math.abs(p) <= 100 ? 100 - Math.abs(p) : undefined;
  }
  return p >= 0 && p <= 100 ? 100 - p : undefined;
}

/** The SOMA position of a Gladys position (both 0..100 integers): what is written. */
export const apiPositionFor = (position) => Math.min(100, Math.max(0, 100 - Math.round(position)));

/**
 * The battery (%) of a get_battery_level answer, or undefined:
 * `battery_percentage` when given, else `battery_level` (a voltage reading,
 * 360 = empty, 410 = full: 2 × (level − 360), as Home Assistant does),
 * bounded to 0..100.
 */
export function batteryOf(json) {
  const percent = json?.battery_percentage;
  if (typeof percent === 'number' && Number.isFinite(percent)) {
    return percent >= 0 && percent <= 100 ? Math.round(percent) : undefined;
  }
  const level = json?.battery_level;
  if (typeof level === 'number' && Number.isFinite(level) && level >= 0 && level <= 1000) {
    return Math.min(100, Math.max(0, Math.round(2 * (level - 360))));
  }
  return undefined;
}

/** The ids of a shade: `{ device, feature(key) }`. */
export const shadeIds = (gladys, id) => gladys.externalIds('soma', id);

/** The shade id and the feature key of an external id of this integration, or undefined. */
export function parseExternalId(gladys, externalId) {
  if (typeof externalId !== 'string' || externalId.length > 200) {
    return undefined;
  }
  const prefix = gladys.externalIds('soma', 'x').device.slice(0, -1);
  if (!externalId.startsWith(prefix)) {
    return undefined;
  }
  const [id, key, ...rest] = externalId.slice(prefix.length).split(':');
  if (!MAC.test(id ?? '') || rest.length > 0) {
    return undefined;
  }
  return { id, key };
}

/** The name of a shade in Gladys: its own name, else "SOMA" and the end of its MAC. */
export const nameOf = (shade) =>
  shade.name || `${shade.kind === KINDS.TILT ? 'SOMA Tilt' : 'SOMA'} ${shade.id.slice(-6)}`;

/** The Gladys device of a shade. */
export function buildDevice(gladys, shade, { language = 'fr' } = {}) {
  const ids = shadeIds(gladys, shade.id);
  return {
    name: nameOf(shade),
    external_id: ids.device,
    should_poll: false,
    params: [
      { name: 'SOMA_MAC', value: shade.id },
      { name: 'SOMA_TYPE', value: shade.kind },
    ],
    features: [
      {
        name: label(FEATURES.STATE, language),
        external_id: ids.feature(FEATURES.STATE),
        category: C.SHUTTER,
        type: T.SHUTTER.STATE,
        min: -1,
        max: 1,
        read_only: false,
        has_feedback: false,
        keep_history: false,
      },
      {
        name: label(FEATURES.POSITION, language),
        external_id: ids.feature(FEATURES.POSITION),
        category: C.SHUTTER,
        type: T.SHUTTER.POSITION,
        min: 0,
        max: 100,
        read_only: false,
        has_feedback: true,
        keep_history: true,
      },
      {
        name: label(FEATURES.BATTERY, language),
        external_id: ids.feature(FEATURES.BATTERY),
        category: C.BATTERY,
        type: T.BATTERY.INTEGER,
        unit: U.PERCENT,
        min: 0,
        max: 100,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
    ],
  };
}

/** A value of a command: a finite number, never null nor '' nor a boolean (they are not 0). */
export function numberIn(value, min, max) {
  if (typeof value === 'string' && value.trim() === '') {
    return undefined;
  }
  if (value === null || value === undefined || typeof value === 'boolean') {
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
}
