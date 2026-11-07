import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

const SIZE = 512;
const blocks = [
  [2, 2, 11, 20, [57, 135, 229]],
  [14, 2, 8, 11, [242, 242, 243]],
  [14, 14, 3.5, 8, [138, 140, 146]],
  [18.5, 14, 3.5, 3.5, [217, 89, 38]],
  [18.5, 18.5, 3.5, 3.5, [138, 140, 146]],
];
const GROUND = [23, 23, 25];
const scale = SIZE / 32;
const offset = 4 * scale;
const radius = 6 * scale;

function inRounded(x, y) {
  const cx = x < radius ? radius : x > SIZE - radius ? SIZE - radius : x;
  const cy = y < radius ? radius : y > SIZE - radius ? SIZE - radius : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

const rows = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y += 1) {
  const start = y * (SIZE * 4 + 1);
  rows[start] = 0;
  for (let x = 0; x < SIZE; x += 1) {
    let hits = 0;
    let color = GROUND;
    for (const [sx, sy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
      if (inRounded(x + sx, y + sy)) hits += 1;
    }
    for (const [bx, by, bw, bh, c] of blocks) {
      const left = offset + bx * scale;
      const top = offset + by * scale;
      if (x >= left && x < left + bw * scale && y >= top && y < top + bh * scale) color = c;
    }
    const at = start + 1 + x * 4;
    rows[at] = color[0];
    rows[at + 1] = color[1];
    rows[at + 2] = color[2];
    rows[at + 3] = Math.round((hits / 4) * 255);
  }
}

const table = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) c = table[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const check = Buffer.alloc(4);
  check.writeUInt32BE(crc(body));
  return Buffer.concat([length, body, check]);
};
const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8;
header[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(rows, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
for (const target of ['build/icon.png', 'src/renderer/public/icon.png']) {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, png);
}
