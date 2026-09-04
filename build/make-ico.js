// 生成有效 ICO：把 256x256 PNG 嵌入 ICO 容器（Vista+ PNG-compressed ICO 格式）
// ICO 文件 = ICONDIR(6字节) + ICONDIRENTRY(16字节) + PNG 数据
const fs = require('fs');
const path = require('path');

const pngPath = path.join(__dirname, 'icon.png');
const icoPath = path.join(__dirname, 'icon.ico');

const pngData = fs.readFileSync(pngPath);

// 检查 PNG 尺寸（从 IHDR 读取）
const width = pngData.readUInt32BE(16);
const height = pngData.readUInt32BE(20);
console.log(`PNG 尺寸: ${width}x${height}`);

// ICONDIR
const ico = Buffer.alloc(6 + 16 + pngData.length);
ico.writeUInt16LE(0, 0);        // reserved
ico.writeUInt16LE(1, 2);        // type: icon
ico.writeUInt16LE(1, 4);        // image count

// ICONDIRENTRY
ico.writeUInt8(width >= 256 ? 0 : width, 6);    // width (0 = 256)
ico.writeUInt8(height >= 256 ? 0 : height, 7);  // height (0 = 256)
ico.writeUInt8(0, 8);           // color count
ico.writeUInt8(0, 9);           // reserved
ico.writeUInt16LE(1, 10);       // planes
ico.writeUInt16LE(32, 12);      // bit count (32bpp)
ico.writeUInt32LE(pngData.length, 14);  // data size
ico.writeUInt32LE(22, 18);      // data offset (6 + 16)

// PNG data
pngData.copy(ico, 22);

fs.writeFileSync(icoPath, ico);
console.log(`已生成 ${icoPath} (${ico.length} bytes) - 标准 PNG-compressed ICO`);