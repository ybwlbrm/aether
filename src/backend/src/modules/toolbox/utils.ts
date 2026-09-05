import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, readdirSync } from 'node:fs';
import { resolve, parse, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import type { BackendConfig } from '../../config/index.js';

// P1-18 修复：ffmpeg/LibreOffice 路径 — 优先环境变量，回退系统 PATH 搜索
// 自包含修复：优先查找随包分发的 build/ffmpeg.exe（EXE 版无需用户另装 ffmpeg）
import { fileURLToPath } from 'node:url';
import { dirname as pathDirname } from 'node:path';
const __dirname = pathDirname(fileURLToPath(import.meta.url));
function resolveFfmpegPath(): string {
  // 1. 环境变量显式指定
  if (process.env.FFMPEG_PATH && existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  // 2. 随包分发的 build/ffmpeg.exe（打包版/开发版都覆盖）
  const candidates = [
    resolve(__dirname, '../../../build/ffmpeg.exe'),   // dist/modules/toolbox → 项目根/build
    resolve(process.cwd(), 'build/ffmpeg.exe'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // 3. 系统 PATH
  return 'ffmpeg';
}
const FFMPEG_PATH = resolveFfmpegPath();
// LibreOffice：内置目录(便携版) → 环境变量 → 系统 PATH（转换失败时明确报错而非静默）
function resolveSofficePath(): string {
  if (process.env.SOFFICE_PATH && existsSync(process.env.SOFFICE_PATH)) return process.env.SOFFICE_PATH;
  const candidates = [
    resolve(__dirname, '../../../build/soffice/program/soffice.exe'),
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    resolve(process.cwd(), 'build/soffice/program/soffice.exe'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return 'soffice';
}
const SOFFICE_PATH = resolveSofficePath();

// docx 懒加载（与 documents/index.ts 一致，减少启动内存占用）
let _docx: typeof import('docx') | null = null;
export async function getDocx() {
  if (!_docx) _docx = await import('docx');
  return _docx;
}

/** 检测 qmc / kgm 加密音频。返回格式与魔数区长度（魔数为明文标识，跳过后再 XOR） */
// unlock-music 参考实现：QmcStaticCipher 静态密码表（256 字节，完整索引 0x00-0xFF）
export const QMC_STATIC_CIPHER = new Uint8Array([
  0x77, 0x48, 0x32, 0x73, 0xDE, 0xF2, 0xC0, 0xC8,
  0x95, 0xEC, 0x30, 0xB2, 0x51, 0xC3, 0xE1, 0xA0,
  0x9E, 0xE6, 0x9D, 0xCF, 0xFA, 0x7F, 0x14, 0xD1,
  0xCE, 0xB8, 0xDC, 0xC3, 0x4A, 0x67, 0x93, 0xD6,
  0x28, 0xC2, 0x91, 0x70, 0xCA, 0x8D, 0xA2, 0xA4,
  0xF0, 0x08, 0x61, 0x90, 0x7E, 0x6F, 0xA2, 0xE0,
  0xEB, 0xAE, 0x3E, 0xB6, 0x67, 0xC7, 0x92, 0xF4,
  0x91, 0xB5, 0xF6, 0x6C, 0x5E, 0x84, 0x40, 0xF7,
  0xF3, 0x1B, 0x02, 0x7F, 0xD5, 0xAB, 0x41, 0x89,
  0x28, 0xF4, 0x25, 0xCC, 0x52, 0x11, 0xAD, 0x43,
  0x68, 0xA6, 0x41, 0x8B, 0x84, 0xB5, 0xFF, 0x2C,
  0x92, 0x4A, 0x26, 0xD8, 0x47, 0x6A, 0x7C, 0x95,
  0x61, 0xCC, 0xE6, 0xCB, 0xBB, 0x3F, 0x47, 0x58,
  0x89, 0x75, 0xC3, 0x75, 0xA1, 0xD9, 0xAF, 0xCC,
  0x08, 0x73, 0x17, 0xDC, 0xAA, 0x9A, 0xA2, 0x16,
  0x41, 0xD8, 0xA2, 0x06, 0xC6, 0x8B, 0xFC, 0x66,
  // 0x80-0xFF: 完整 256 字节扩展
  0x34, 0x9F, 0xCF, 0x18, 0x23, 0xA0, 0x0A, 0x74,
  0xE7, 0x2B, 0x27, 0x70, 0x92, 0xE9, 0xAF, 0x37,
  0xE6, 0x8C, 0xA7, 0xBC, 0x62, 0x65, 0x9C, 0xC2,
  0x5C, 0xBC, 0xBE, 0x9B, 0x8E, 0x16, 0xA5, 0xDF,
  0x87, 0x20, 0x6F, 0x11, 0x4E, 0x78, 0xFC, 0xB6,
  0x50, 0x5A, 0xFC, 0xCB, 0x1E, 0xC8, 0xA0, 0xA4,
  0x47, 0x4B, 0x8C, 0x9E, 0xEF, 0xEE, 0xD7, 0x90,
  0x3F, 0xB2, 0x1C, 0xD8, 0x68, 0xFC, 0x5B, 0xCB,
  0xB6, 0xE8, 0x1E, 0xC2, 0x17, 0x1C, 0x5D, 0x16,
  0xE0, 0x33, 0x9B, 0x7B, 0x3F, 0x3F, 0xA5, 0x58,
  0xC2, 0x4A, 0x7B, 0x47, 0x6F, 0xF0, 0xAF, 0x3F,
  0x0C, 0x25, 0x1C, 0xE8, 0xBC, 0x0F, 0x67, 0x7B,
  0x45, 0x3A, 0x43, 0x44, 0x1D, 0x37, 0x05, 0x1B,
  0x55, 0x5E, 0x55, 0xE0, 0x1C, 0x71, 0xDB, 0x00,
  0xBC, 0xFD, 0x0C, 0x6C, 0xA5, 0x47, 0xF7, 0xF6,
  0x00, 0x79, 0x4A, 0x11, 0xB0, 0xE5, 0xD1, 0xB8,
]);

/** 使用 QmcStaticCipher 解密 v1 老格式 qmc 数据（unlock-music 参考实现） */
export function decryptQmcStaticCipher(data: Uint8Array, startOffset: number): void {
  for (let i = 0; i < data.length; i++) {
    let offset = startOffset + i;
    // 修复：添加 % 0x7fff 约简，与 unlock-music 参考实现一致
    if (offset > 0x7fff) offset %= 0x7fff;
    const idx = (offset * offset + 27) & 0xFF;
    data[i] ^= QMC_STATIC_CIPHER[idx];
  }
}

export function detectEncryptedAudio(buf: Buffer): { format: 'qmc' | 'kgm'; skip: number } | null {
  // qmc 检测：尝试用 QmcStaticCipher 解密首字节检查是否为音频魔数
  // 老格式 qmcflac/qmcogg/qmc0/qmc3/tkm 无特定魔数，直接尝试解密
  if (buf.length > 0) {
    const testData = new Uint8Array(buf.slice(0, 1));
    decryptQmcStaticCipher(testData, 0);
    const testByte = testData[0];
    // 音频魔数常见首字节：0xFF(mp3), 0x49(ID3), 0x66(fLaC), 0x4F(Ogg)
    if (testByte === 0xFF || testByte === 0x49 || testByte === 0x66 || testByte === 0x4F) {
      return { format: 'qmc', skip: 0 };
    }
  }
  // kgm 魔数：7C D5 32 EB 86 02 7F 4B A8 AF A6 8E 0F FF 99 14（unlock-music KgmHeader）
  if (buf.length >= 16) {
    const kgmMagic = Buffer.from([0x7C, 0xD5, 0x32, 0xEB, 0x86, 0x02, 0x7F, 0x4B, 0xA8, 0xAF, 0xA6, 0x8E, 0x0F, 0xFF, 0x99, 0x14]);
    if (buf.subarray(0, 16).equals(kgmMagic)) {
      // 从偏移 0x10 读取真正的头部长度（4 字节 LE uint32）
      const headerLen = buf.readUInt32LE(0x10);
      return { format: 'kgm', skip: headerLen > 16 ? headerLen : 16 };
    }
  }
  return null;
}

export const exportDir = (config: BackendConfig) => {
  const dir = resolve(config.dataDir, 'export', 'toolbox');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
};

/** 用 ffmpeg 转换音频/视频格式 */
export function convertWithFfmpeg(input: Buffer, ext: string, target: string): Promise<Buffer> {
  return new Promise((resolveP, rejectP) => {
    const tmpIn = `${randomUUID()}.${ext}`;
    const tmpOut = `${randomUUID()}.${target}`;
    const inPath = resolve(process.env.TEMP || '.', tmpIn);
    const outPath = resolve(process.env.TEMP || '.', tmpOut);
    writeFileSync(inPath, input);
    execFile(FFMPEG_PATH, ['-y', '-i', inPath, outPath], { timeout: 60000 }, (err) => {
      try {
        if (err) { rejectP(new Error(`ffmpeg 转换失败: ${err.message}`)); return; }
        if (!existsSync(outPath)) { rejectP(new Error('ffmpeg 无输出文件')); return; }
        resolveP(readFileSync(outPath));
      } catch (e) { rejectP(e); }
      finally {
        try { if (existsSync(inPath)) unlinkSync(inPath); } catch (_e: unknown) { /* ignore - intentional */ }
        try { if (existsSync(outPath)) unlinkSync(outPath); } catch (_e: unknown) { /* ignore - intentional */ }
      }
    });
  });
}

/** 用 LibreOffice 转换文档为 PDF（docx/xlsx→pdf） */
export function convertWithLibreOffice(input: Buffer, ext: string): Promise<Buffer> {
  return new Promise((resolveP, rejectP) => {
    const tmpIn = `${randomUUID()}.${ext}`;
    const tmpDir = `${randomUUID()}`;
    const inPath = resolve(process.env.TEMP || '.', tmpIn);
    const outDir = resolve(process.env.TEMP || '.', tmpDir);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(inPath, input);
    execFile(SOFFICE_PATH, ['--headless', '--convert-to', 'pdf', '--outdir', outDir, inPath], { timeout: 120000 }, (err) => {
      try {
        if (err) {
          const hint = SOFFICE_PATH === 'soffice'
            ? '（未检测到 LibreOffice。请安装 LibreOffice 或设置 SOFFICE_PATH 环境变量指向 soffice.exe）'
            : '';
          rejectP(new Error(`LibreOffice 转换失败: ${err.message}${hint}`)); return;
        }
        const outName = `${tmpIn.replace('.' + ext, '')}.pdf`;
        const outPath = resolve(outDir, outName);
        if (!existsSync(outPath)) { rejectP(new Error('LibreOffice 无输出文件')); return; }
        resolveP(readFileSync(outPath));
      } catch (e) { rejectP(e); }
      finally {
        try { unlinkSync(inPath); } catch (_e: unknown) { /* ignore - intentional */ }
        try { if (existsSync(outDir)) { for (const f of readdirSync(outDir)) unlinkSync(resolve(outDir, f)); unlinkSync(outDir); } } catch (_e: unknown) { /* ignore - intentional */ }
      }
    });
  });
}

/** 图片数组 → 合并为一个 PDF。webp 先用 sharp 转 png 再嵌入 */
export async function imagesToPdf(buffers: Buffer[]): Promise<Buffer> {
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  for (const buf of buffers) {
    let img;
    try { img = await pdf.embedJpg(buf); }
    catch {
      try {
        img = await pdf.embedPng(buf);
      } catch {
        // webp/gif 等：用 sharp 转 png
        const sharpMod = await import('sharp');
        const png = await sharpMod.default(buf).png().toBuffer();
        img = await pdf.embedPng(png);
      }
    }
    const page = pdf.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  }
  return Buffer.from(await pdf.save());
}

/** 简易但正确的 CSV → 二维数组（支持引号/逗号/换行转义） */
export function parseCsv(text: string): string[][] {
  // 剥离 UTF-8 BOM
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); field = '';
      if (row.some(f => f.length > 0) || rows.length > 0) rows.push(row);
      row = [];
    } else if (ch === '\r') {
      // 忽略回车
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}