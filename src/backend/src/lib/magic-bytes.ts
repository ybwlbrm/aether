/**
 * SEC-002: 上传文件 magic bytes（文件签名）检测
 *
 * 仅靠 MIME/扩展名判断文件类型可被轻易伪装（evil.exe → evil.png）。
 * 本模块读取文件头字节识别真实格式，供上传端点二次校验。
 *
 * 设计约束：
 * - 无第三方依赖（file-type 未引入，保持轻量）
 * - zip 族（docx/xlsx/pptx）头字节相同（PK），统一识别为 'zip'，
 *   由调用方按扩展名白名单放行；doc/xls/ppt 老格式为 OLE2 复合文档（D0 CF）
 * - mkv/webm 同容器（EBML），统一 'mkv'；webm 扩展名接受 mkv 签名
 * - ts/mts 无强签名（0x47 sync byte），结合 188 字节周期降低误报
 * - 弱签名格式保留宽容判定，强签名格式（PNG/JPEG/PDF/zip）严格
 */

export type DetectedType =
  | 'png' | 'jpg' | 'gif' | 'webp' | 'bmp' | 'avif'
  | 'pdf' | 'zip' | 'ole2'
  | 'mp4' | 'm4a' | 'mov' | 'mkv' | 'avi' | 'flv' | 'wmv'
  | 'mp3' | 'aac' | 'wav' | 'flac' | 'ogg' | 'ts'
  | 'text' | 'unknown';

/** zip 容器扩展名（PK 签名即可放行） */
const ZIP_EXTENSIONS = new Set(['docx', 'xlsx', 'pptx', 'zip']);
/** OLE2 复合文档扩展名（老式 .doc/.xls/.ppt） */
const OLE2_EXTENSIONS = new Set(['doc', 'xls', 'ppt']);
/** 文本类扩展名（UTF-8 文本即可放行） */
const TEXT_EXTENSIONS = new Set(['txt', 'csv', 'md', 'json', 'log', 'text']);
/** mkv/webm 同容器，相互放行 */
const MKV_EXTENSIONS = new Set(['mkv', 'webm']);
/** ts/mts 同源（MPEG-TS），相互放行 */
const TS_EXTENSIONS = new Set(['ts', 'mts']);

/** 文本类扩展名清单（供调用方决定是否允许） */
export function isTextExtension(ext: string): boolean {
  return TEXT_EXTENSIONS.has(ext.toLowerCase());
}

/** zip/OLE2 类扩展名清单 */
export function isContainerZipExtension(ext: string): boolean {
  return ZIP_EXTENSIONS.has(ext.toLowerCase()) || OLE2_EXTENSIONS.has(ext.toLowerCase());
}

/**
 * 从文件头识别真实类型
 * @param buf 文件内容（可为完整文件；仅读取头部）
 */
export function detectMagicType(buf: Buffer): DetectedType {
  if (!buf || buf.length < 4) return 'unknown';
  const b = buf;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';

  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';

  // GIF: GIF87a / GIF89a
  if (b.length >= 6) {
    const sig = b.subarray(0, 6).toString('latin1');
    if (sig === 'GIF87a' || sig === 'GIF89a') return 'gif';
  }

  // WEBP: RIFF....WEBP
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';

  // BMP: BM
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp';

  // PDF: %PDF
  if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';

  // ZIP 族: PK\x03\x04 / PK\x05\x06（空 zip）/ PK\x07\x08
  if (b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)) return 'zip';

  // OLE2 复合文档（doc/xls/ppt 老格式）: D0 CF 11 E0 A1 B1 1A E1
  if (b.length >= 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0 &&
      b[4] === 0xa1 && b[5] === 0xb1 && b[6] === 0x1a && b[7] === 0xe1) return 'ole2';

  // MP4/M4A/MOV/AVIF: ....ftyp
  if (b.length >= 12 && b.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = b.subarray(8, 12).toString('latin1');
    if (brand === 'M4A ' || brand === 'M4A\0') return 'm4a';
    if (brand === 'qt  ') return 'mov';
    if (brand === 'avif' || brand === 'avis') return 'avif';
    return 'mp4'; // isom/mp42/avc1/dash 等默认 MP4
  }

  // MKV/WEBM (EBML): 1A 45 DF A3
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'mkv';

  // AVI: RIFF....AVI
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'AVI ') return 'avi';
  // WAV: RIFF....WAVE
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WAVE') return 'wav';

  // FLV: FLV
  if (b.subarray(0, 3).toString('latin1') === 'FLV') return 'flv';

  // WMV/ASF: 30 26 B2 75 8E 66 CF 11 A6 D9
  if (b.length >= 10 && b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xb2 && b[3] === 0x75 &&
      b[4] === 0x8e && b[5] === 0x66 && b[6] === 0xcf && b[7] === 0x11 && b[8] === 0xa6 && b[9] === 0xd9) return 'wmv';

  // MP3: ID3 tag 或 MPEG 音频帧同步（FF Ex…，排除 AAC ADTS）
  if (b.length >= 3 && b.subarray(0, 3).toString('latin1') === 'ID3') return 'mp3';
  if (b[0] === 0xff) {
    const layerBits = (b[1] >> 1) & 0x03;
    if (layerBits === 0x01) return 'mp3';     // Layer III
    if (layerBits === 0x00) return 'aac';     // ADTS（AAC）
    if (b.length >= 2 && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x18) !== 0x08) return 'mp3';
  }

  // FLAC: fLaC
  if (b.length >= 4 && b.subarray(0, 4).toString('latin1') === 'fLaC') return 'flac';

  // OGG/OPUS: OggS
  if (b.length >= 4 && b.subarray(0, 4).toString('latin1') === 'OggS') return 'ogg';

  // MPEG-TS: 0x47 sync byte + 188 字节周期（弱签名，降低误报）
  if (b.length >= 376 && b[0] === 0x47 && b[188] === 0x47 && b[376] === 0x47) return 'ts';

  // 文本类：UTF-8 无 NUL 字节（前 512 字节）
  const head = b.length > 512 ? b.subarray(0, 512) : b;
  if (head.indexOf(0) === -1) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(head);
      return 'text';
    } catch { /* invalid UTF-8 → 二进制 */ }
  }

  return 'unknown';
}

/**
 * 校验文件内容与声明扩展名是否匹配
 * @param buf 文件内容
 * @param ext 声明扩展名（小写，不含点）
 * @returns ok=false 时 detected 为真实类型；ok=true 时 detected 为识别类型
 */
export function assertMagicMatches(buf: Buffer, ext: string): { ok: boolean; detected: DetectedType } {
  const e = (ext || '').toLowerCase();
  const detected = detectMagicType(buf);

  // 容器类放行规则
  if (ZIP_EXTENSIONS.has(e) && detected === 'zip') return { ok: true, detected };
  if (OLE2_EXTENSIONS.has(e) && detected === 'ole2') return { ok: true, detected };
  if (isTextExtension(e) && detected === 'text') return { ok: true, detected };
  if (MKV_EXTENSIONS.has(e) && detected === 'mkv') return { ok: true, detected };
  if (TS_EXTENSIONS.has(e) && detected === 'ts') return { ok: true, detected };
  if (e === 'm4a' && detected === 'm4a') return { ok: true, detected };
  if (e === 'jpeg' && detected === 'jpg') return { ok: true, detected };

  // 双向同类型
  if (e === detected) return { ok: true, detected };

  return { ok: false, detected };
}

/** 空文件/未知类型判断辅助 */
export function isSafeToWrite(buf: Buffer, ext: string): boolean {
  if (!buf || buf.length === 0) return false;
  return assertMagicMatches(buf, ext).ok;
}