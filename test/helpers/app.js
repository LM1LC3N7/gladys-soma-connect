// -----------------------------------------------------------------------------
// The app with the SDK's fake Gladys, the exact handlers of the container
// (src/handlers.js), a fake SOMA Connect behind the client's `request`, the
// virtual clock (it moves at every read) and a memory store. No network.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { SomaApp } from '../../src/app.js';
import { buildDevice } from '../../src/devices.js';
import { registerHandlers } from '../../src/handlers.js';
import { SomaClient } from '../../src/soma/client.js';
import { memoryStore } from '../../src/store.js';
import { createClock, settle } from './clock.js';
import { createBridge } from './fakeBridge.js';

export const SELECTOR = 'soma-connect';
export const ADDRESS = '192.168.1.50';
export const KEY = `${ADDRESS}:3000`;
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const id = (shadeId, key) => `ext:${SELECTOR}:soma:${shadeId}${key ? `:${key}` : ''}`;

/** The Gladys device of a shade as the user created it. */
export function created(shadeId, kind = 'shade', name = 'Salon') {
  const gladys = createFakeGladys({ selector: SELECTOR });
  return buildDevice(gladys, { id: shadeId, kind, name });
}

export async function setup({
  config = { address: ADDRESS },
  clock = createClock(),
  bridge,
  store = memoryStore(),
  devices = [],
  connect = true,
  getConfig,
} = {}) {
  const fakeBridge = bridge ?? createBridge(clock);
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices });
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.message ?? a).join(' ')}`),
    ]),
  );
  const app = new SomaApp({
    gladys,
    logger,
    client: new SomaClient({
      request: fakeBridge.request,
      now: clock.now,
      monotonic: clock.monotonic,
    }),
    store,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
  });
  if (getConfig) {
    gladys.getConfig = getConfig;
  }
  registerHandlers(gladys, app, logger);
  if (connect) {
    await gladys.connect();
    await settle();
    await clock.run(0);
  }
  const feature = (shadeId, key) => ({ external_id: id(shadeId, key) });
  const setValue = (shadeId, key, value) =>
    gladys.fake.setValue({ external_id: id(shadeId) }, feature(shadeId, key), value);
  const status = () => gladys.fake.connectionStatus;
  return { app, gladys, clock, bridge: fakeBridge, store, logs, setValue, status };
}
