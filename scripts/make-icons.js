#!/usr/bin/env node
/**
 * Generates the extension's PNG icons: a rounded terracotta plate with a
 * white robot face. Hand-rolls the PNG so the repo needs no image library.
 */

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, "..", "extension", "icons");

const PLATE = [217, 119, 87]; // terracotta
const WHITE = [255, 255, 255];

// --- PNG encoding ----------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

function encodePng(size, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// --- Artwork (unit coordinates, 0..1) -------------------------------------

function insideRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

const insidePlate = (x, y) => insideRoundedRect(x, y, 0.05, 0.05, 0.95, 0.95, 0.22);

/** Robot face: a head outline is implied by the plate; two eyes, a mouth, an antenna. */
function insideFace(x, y) {
  // eyes
  if (insideRoundedRect(x, y, 0.26, 0.36, 0.42, 0.52, 0.04)) return true;
  if (insideRoundedRect(x, y, 0.58, 0.36, 0.74, 0.52, 0.04)) return true;
  // mouth
  if (insideRoundedRect(x, y, 0.3, 0.62, 0.7, 0.72, 0.04)) return true;
  // antenna stem + tip
  if (x >= 0.48 && x <= 0.52 && y >= 0.16 && y <= 0.28) return true;
  const dx = x - 0.5;
  const dy = y - 0.16;
  return dx * dx + dy * dy <= 0.045 * 0.045;
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 4; // supersampling per axis
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let plateHits = 0;
      let faceHits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          if (!insidePlate(x, y)) continue;
          plateHits++;
          if (insideFace(x, y)) faceHits++;
        }
      }
      const alpha = plateHits / (SS * SS);
      if (alpha === 0) continue;
      const fg = faceHits / Math.max(plateHits, 1);
      const i = (py * size + px) * 4;
      rgba[i] = Math.round(PLATE[0] * (1 - fg) + WHITE[0] * fg);
      rgba[i + 1] = Math.round(PLATE[1] * (1 - fg) + WHITE[1] * fg);
      rgba[i + 2] = Math.round(PLATE[2] * (1 - fg) + WHITE[2] * fg);
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(size, rgba);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const path = join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(path, render(size));
  console.log(`wrote ${path}`);
}
