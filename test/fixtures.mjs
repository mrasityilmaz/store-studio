import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { deflateSync } from 'node:zlib';

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

// Writes a solid PNG; alpha adds an RGBA channel.
export function writePng(path, w, h, { alpha = false, rgb = [20, 16, 48] } = {}) {
  const px = alpha ? [...rgb, 255] : rgb;
  const row = Buffer.alloc(1 + w * px.length);
  for (let x = 0; x < w; x++) row.set(px, 1 + x * px.length);
  const raw = Buffer.alloc(row.length * h);
  for (let y = 0; y < h; y++) row.copy(raw, y * row.length);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

// A small export tree in the layout the tools expect.
export function makeTree(root, { ios = {}, play = {} }) {
  for (const [locale, sets] of Object.entries(ios)) {
    for (const [folder, [w, h, n, opts]] of Object.entries(sets)) {
      for (let i = 1; i <= n; i++) writePng(`${root}/ios/${locale}/${folder}/${String(i).padStart(2, '0')}_shot.png`, w, h, opts);
    }
  }
  for (const [lang, sets] of Object.entries(play)) {
    for (const [folder, [w, h, n, opts]] of Object.entries(sets)) {
      for (let i = 1; i <= n; i++) writePng(`${root}/play/${lang}/${folder}/${String(i).padStart(2, '0')}_shot.png`, w, h, opts);
    }
  }
}
