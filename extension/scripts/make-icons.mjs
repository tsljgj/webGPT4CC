// Generates extension/icons/icon-{16,32,48,128}.png (no dependencies: node:zlib only).
// Run: node extension/scripts/make-icons.mjs
//
// The icon is a rounded indigo square with a white terminal prompt ">_",
// rasterized from signed-distance shapes with 4x4 supersampling.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SIZES = [16, 32, 48, 128];
const BG = [59, 91, 219]; // #3b5bdb
const FG = [255, 255, 255];
const outDir = new URL('../icons/', import.meta.url);

// CRC-32 (PNG chunk checksums).
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Signed distances in unit coordinates (0..1). Negative = inside.
function roundedSquare(x, y, half, r) {
  const qx = Math.abs(x - 0.5) - (half - r);
  const qy = Math.abs(y - 0.5) - (half - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function segment(x, y, ax, ay, bx, by, w) {
  const px = x - ax;
  const py = y - ay;
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - dx * t, py - dy * t) - w;
}

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const ss = 4;
  const stroke = size <= 16 ? 0.075 : 0.06;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const u = (x + (sx + 0.5) / ss) / size;
          const v = (y + (sy + 0.5) / ss) / size;
          if (roundedSquare(u, v, 0.47, 0.16) <= 0) {
            bg++;
            const chevron = Math.min(segment(u, v, 0.25, 0.3, 0.45, 0.5, stroke), segment(u, v, 0.45, 0.5, 0.25, 0.7, stroke));
            const underscore = segment(u, v, 0.52, 0.7, 0.76, 0.7, stroke);
            if (Math.min(chevron, underscore) <= 0) fg++;
          }
        }
      const n = ss * ss;
      const a = bg / n;
      const f = bg ? fg / bg : 0;
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) px[i + c] = Math.round(BG[c] * (1 - f) + FG[c] * f);
      px[i + 3] = Math.round(a * 255);
    }
  return px;
}

mkdirSync(outDir, { recursive: true });
for (const size of SIZES) {
  const file = new URL(`icon-${size}.png`, outDir);
  writeFileSync(file, encodePng(size, render(size)));
  console.log(`wrote ${file.pathname}`);
}
