// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a dark-to-blue gradient, a
// window with a roller shade half down (its motor in the tube) next to a
// venetian blind with tilted slats, the SOMA Connect bridge with its waves,
// and a position slider. Plain Node (zlib), no dependency.
// Run: npm run cover
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WIDTH = 800;
const HEIGHT = 534;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const smooth = (edge, distance) => Math.min(1, Math.max(0, edge - distance + 0.5));

const DARK = [16, 26, 40];
const TEAL = [30, 96, 170];
const WHITE = [255, 255, 255];
const GREEN = [120, 220, 140];
const AMBER = [255, 196, 84];

/** Distance to the border of a rounded rectangle (negative inside). */
function roundedBox(x, y, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(x - cx) - halfW + radius;
  const qy = Math.abs(y - cy) - halfH + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** Distance to a segment. */
function segment(x, y, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

function pixel(x, y) {
  let color = mix(DARK, TEAL, (x / WIDTH) * 0.55 + (y / HEIGHT) * 0.45);
  // Two windows behind: a soft light and their frames.
  for (const cx of [250, 520]) {
    const window = roundedBox(x, y, cx, 230, 110, 140, 8);
    if (window < 0) {
      color = mix(color, AMBER, 0.18);
    }
    color = mix(color, WHITE, smooth(4, Math.abs(window)) * 0.6);
  }
  // The roller shade: its tube (the motor, a green light), the fabric half down.
  color = mix(color, WHITE, smooth(9, segment(x, y, 140, 92, 360, 92)));
  color = mix(color, GREEN, smooth(5, Math.hypot(x - 345, y - 92)));
  if (x >= 148 && x <= 352 && y >= 100 && y <= 250) {
    color = mix(color, WHITE, 0.72);
  }
  color = mix(color, WHITE, smooth(5, segment(x, y, 148, 252, 352, 252)));
  // The venetian blind: tilted slats.
  for (let i = 0; i < 10; i += 1) {
    const sy = 104 + i * 26;
    color = mix(color, WHITE, smooth(4, segment(x, y, 418, sy, 622, sy + 8)) * 0.8);
  }
  // SOMA Connect, and its waves towards the shades.
  const bridge = roundedBox(x, y, 690, 420, 40, 24, 10);
  color = mix(color, WHITE, smooth(1.5, bridge));
  color = mix(color, GREEN, smooth(5, Math.hypot(x - 712, y - 420)));
  const wave = Math.hypot(x - 690, y - 395);
  if (y < 395 && x < 700) {
    for (const r of [30, 48, 66]) {
      color = mix(color, WHITE, smooth(3, Math.abs(wave - r)) * 0.55);
    }
  }
  // The position: a track and its knob, 60 % open.
  color = mix(color, WHITE, smooth(4, segment(x, y, 150, 462, 520, 462)) * 0.7);
  color = mix(color, GREEN, smooth(5, segment(x, y, 150, 462, 372, 462)));
  const knob = Math.hypot(x - 372, y - 462);
  color = mix(color, GREEN, smooth(18, knob) * 0.95);
  color = mix(color, DARK, smooth(7, knob) * 0.6);
  return color;
}

const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const row = y * (WIDTH * 3 + 1);
  raw[row] = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = pixel(x, y);
    raw.set([r, g, b], row + 1 + x * 3);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../cover.png', import.meta.url), png);
console.log(`cover.png: ${WIDTH}×${HEIGHT}, ${png.length} bytes`);
