import { open } from 'node:fs/promises';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Reads format, size and alpha from the file header without decoding pixels.
export async function imageInfo(path) {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const head = Buffer.alloc(Math.min(size, 64 * 1024));
    await fh.read(head, 0, head.length, 0);
    if (head.subarray(0, 8).equals(PNG_SIG)) return { ...(await png(fh, head, size)), bytes: size };
    if (head[0] === 0xff && head[1] === 0xd8) return { ...jpeg(head), bytes: size };
    return { format: 'unknown', bytes: size };
  } finally {
    await fh.close();
  }
}

async function png(fh, head, size) {
  const width = head.readUInt32BE(16);
  const height = head.readUInt32BE(20);
  const colorType = head[25];
  let alpha = colorType === 4 || colorType === 6;
  // A tRNS chunk before the first IDAT also means transparency.
  let pos = 8;
  const buf = Buffer.alloc(8);
  while (!alpha && pos + 8 <= size) {
    await fh.read(buf, 0, 8, pos);
    const len = buf.readUInt32BE(0);
    const type = buf.toString('latin1', 4, 8);
    if (type === 'tRNS') alpha = true;
    if (type === 'IDAT' || type === 'IEND') break;
    pos += 12 + len;
  }
  return { format: 'png', width, height, alpha };
}

function jpeg(buf) {
  let pos = 2;
  while (pos + 9 < buf.length) {
    if (buf[pos] !== 0xff) {
      pos++;
      continue;
    }
    const marker = buf[pos + 1];
    const len = buf.readUInt16BE(pos + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof) {
      return {
        format: 'jpeg',
        height: buf.readUInt16BE(pos + 5),
        width: buf.readUInt16BE(pos + 7),
        alpha: false,
      };
    }
    pos += 2 + len;
  }
  return { format: 'jpeg', alpha: false };
}

export const contentType = (format) => (format === 'png' ? 'image/png' : 'image/jpeg');
