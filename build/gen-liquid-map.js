/**
 * Generate a Signed-Distance-Field displacement map PNG for iOS-26-style
 * liquid glass edge refraction. Center is neutral grey (128,128) = no bend;
 * edges ramp outward following the rounded-rectangle normal. Negative
 * feDisplacementMap scale on this map produces an Apple-style magnifying rim.
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const W = 256, H = 256, RADIUS = 24; // 半径对应 -radius-md (14px) 放大到 256px 贴图尺度

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

// Signed distance to rounded rect (negative inside)
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  const outside = Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - r;
  const inside = Math.min(Math.max(qx, qy), 0) + r;
  return outside > 0 ? outside : -inside;
}

// Build raw RGBA with filter byte (0) per row
const stride = W * 4 + 1;
const raw = Buffer.alloc(H * stride);
raw.fill(0);

const cx = (W - 1) / 2, cy = (H - 1) / 2;
const hw = W / 2 - 2, hh = H / 2 - 2;
const maxDist = Math.hypot(hw, hh);

for (let y = 0; y < H; y++) {
  const rowStart = y * stride;
  raw[rowStart] = 0; // filter none
  for (let x = 0; x < W; x++) {
    const d = sdRoundRect(x, y, cx, cy, hw, hh, RADIUS);
    // Edge band: strongest within ~24px of the rim, fading to 0 (128) at center & outside
    const band = Math.max(0, 1 - Math.abs(d) / 24);
    // Direction: from center outward (normal-ish)
    const dx = (x - cx) / maxDist;
    const dy = (y - cy) / maxDist;
    const strength = band * 90; // pushes outward -> magnify with negative scale
    const R = Math.max(0, Math.min(255, 128 + dx * strength));
    const G = Math.max(0, Math.min(255, 128 + dy * strength));
    const B = 128, A = 255;
    const p = rowStart + 1 + x * 4;
    raw[p] = Math.round(R);
    raw[p + 1] = Math.round(G);
    raw[p + 2] = B;
    raw[p + 3] = A;
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // color type RGBA
ihdr[10] = 0; // compression
ihdr[11] = 0; // filter
ihdr[12] = 0; // interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const outDir = path.join(__dirname, '..', 'src', 'frontend', 'public');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'liquid-lens-map.png');
fs.writeFileSync(outPath, png);
console.log('Wrote', outPath, png.length, 'bytes');