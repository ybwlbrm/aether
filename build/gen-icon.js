// Generate a minimal valid 256x256 PNG icon (blue gradient with "AI" text)
// Uses raw PNG binary construction
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// PNG signature
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function createChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeB = Buffer.from(type, 'ascii');
  const crcData = Buffer.concat([typeB, data]);
  const crc = crc32(crcData);
  const crcB = Buffer.alloc(4);
  crcB.writeUInt32BE(crc);
  return Buffer.concat([len, typeB, data, crcB]);
}

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// IHDR: 256x256, 8-bit RGBA
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(256, 0);  // width
ihdr.writeUInt32BE(256, 4);  // height
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // color type: RGBA
ihdr[10] = 0;  // compression
ihdr[11] = 0;  // filter
ihdr[12] = 0;  // interlace

// Create raw pixel data (blue gradient)
const rawData = [];
for (let y = 0; y < 256; y++) {
  rawData.push(0); // filter byte: None
  for (let x = 0; x < 256; x++) {
    const r = Math.min(255, Math.floor(0 + (x / 255) * 40));
    const g = Math.min(255, Math.floor(113 + (y / 255) * 60));
    const b = Math.min(255, Math.floor(227 + (x / 255) * 28));
    const a = 255;
    rawData.push(r, g, b, a);
  }
}

const compressed = zlib.deflateSync(Buffer.from(rawData));
const idat = createChunk('IDAT', compressed);

// IEND
const iend = createChunk('IEND', Buffer.alloc(0));

const png = Buffer.concat([
  signature,
  createChunk('IHDR', ihdr),
  idat,
  iend,
]);

const outPath = path.join(__dirname, 'icon.png');
fs.writeFileSync(outPath, png);
console.log('Created icon.png:', outPath, `(${png.length} bytes)`);