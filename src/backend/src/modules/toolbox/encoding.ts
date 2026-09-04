import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';

/** 编码转换相关路由：Base64、URL、时间戳、颜色、GBK/UTF-8、文本↔编码 */
export function registerEncodingRoutes(app: FastifyInstance, config: BackendConfig): void {
  // 编码转换在 /api/toolbox/utility 和 /api/toolbox/encode 中处理
  // 这里导出供相关端点使用的核心函数
}

/** Utility 工具操作（Base64、URL、时间戳、颜色、GBK-UTF8） */
export async function utilityOp(op: string, input?: string, options?: any): Promise<{ success: boolean; result: string }> {
  switch (op) {
    case 'base64-encode': return { success: true, result: Buffer.from(input || '').toString('base64') };
    case 'base64-decode': return { success: true, result: Buffer.from(input || '', 'base64').toString('utf-8') };
    case 'url-encode': return { success: true, result: encodeURIComponent(input || '') };
    case 'url-decode': return { success: true, result: decodeURIComponent(input || '') };
    case 'timestamp-to-date': {
      const ts = Number(input) || 0;
      return { success: true, result: new Date(ts * 1000).toLocaleString('zh-CN') };
    }
    case 'date-to-timestamp': {
      const ts = Date.parse(input || '') / 1000;
      return { success: true, result: String(Number.isFinite(ts) ? Math.floor(ts) : 0) };
    }
    case 'hex-rgb': {
      const hex = (input || '').replace('#', '').trim();
      if (!/^[0-9a-fA-F]{6}$/.test(hex)) throw new Error('请输入 6 位 hex 颜色');
      const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
      return { success: true, result: `rgb(${r}, ${g}, ${b})` };
    }
    case 'rgb-hex': {
      const m = (input || '').match(/rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
      if (!m) throw new Error('请输入 rgb(r,g,b) 格式');
      const toHex = (n: number) => n.toString(16).padStart(2, '0');
      return { success: true, result: `#${toHex(Number(m[1]))}${toHex(Number(m[2]))}${toHex(Number(m[3]))}`.toUpperCase() };
    }
    case 'gbk-utf8': {
      // 输入按二进制字节读取，按 GBK 解码为 UTF-8 文本
      const iconvModule = await import('iconv-lite');
      const iconv = (iconvModule as any).default ?? iconvModule;
      const raw = Buffer.from(input || '');
      return { success: true, result: iconv.decode(raw, 'gbk') };
    }
    default:
      throw new Error(`未知工具: ${op}`);
  }
}

/** 编码转换核心逻辑（文本↔编码 双向互转 / base64 / 图片转base64） */
export async function encodeOp(op: string, input: string, encoding: string, format: string): Promise<{ success: boolean; result: string }> {
  const iconvModule = await import('iconv-lite');
  const iconv = (iconvModule as any).default ?? iconvModule;
  // 将编码名映射到 iconv-lite 支持的名字
  const encMap: Record<string, string> = { utf8: 'utf8', utf8bom: 'utf8', gbk: 'gbk', big5: 'big5', gb18030: 'gb18030', latin1: 'latin1', unicode: 'utf16le' };
  const enc = encMap[encoding] || 'utf8';

  switch (op) {
    case 'to-utf8': {
      // 修复中文乱码：输入可能是两种情形
      // A: UTF-8 文本被 GBK 误解码显示的乱码（如"浣犲ソ"）
      // B: GBK 字节以 latin1/iso-8859-1 形式传入
      // 方式A: 还原"GBK误解码UTF-8"的乱码 — 文本先转回UTF-8字节，再按GBK解码
      const utf8Bytes = iconv.encode(input, 'utf8');
      const roundTrip = iconv.decode(utf8Bytes, 'gbk');
      // 方式B: 直接按GBK解码 latin1 表示的字节
      const latinBuf = Buffer.from(input, 'latin1');
      const directGbk = iconv.decode(latinBuf, 'gbk');
      // 选择能够产出更多中文字符的结果（乱码修复的简单启发式）
      function countHanzi(s: string): number {
        const m = s.match(/[\u4e00-\u9fff]/g);
        return m ? m.length : 0;
      }
      const finalResult = countHanzi(directGbk) >= countHanzi(roundTrip) ? directGbk : roundTrip;
      return { success: true, result: finalResult };
    }
    // 文字 → 编码（encode）：把中文文本转成指定编码的表示
    case 'encode-text': {
      const bytes = iconv.encode(input, enc);
      if (format === 'base64') {
        return { success: true, result: bytes.toString('base64') };
      }
      if (format === 'unicode') {
        // Unicode 转义 \uXXXX
        let unicodeOut = '';
        for (const ch of input) {
          const code = ch.codePointAt(0)!;
          if (code > 0xFFFF) {
            const hi = Math.floor((code - 0x10000) / 0x400) + 0xD800;
            const lo = ((code - 0x10000) % 0x400) + 0xDC00;
            unicodeOut += `\\u${hi.toString(16).padStart(4, '0')}\\u${lo.toString(16).padStart(4, '0')}`;
          } else {
            unicodeOut += `\\u${code.toString(16).padStart(4, '0')}`;
          }
        }
        return { success: true, result: unicodeOut };
      }
      // hex 默认
      const hexOut = Array.from(bytes as Uint8Array).map((b: number) => b.toString(16).padStart(2, '0')).join(' ');
      const hexCompact = hexOut.replace(/ /g, '');
      return { success: true, result: `${hexCompact}${bytes.length > 0 ? `\n[带空格] ${hexOut}` : ''}\n[${encoding} 字节数] ${bytes.length}` };
    }
    // 编码 → 文字（decode）：把编码表示解码成中文文本
    case 'decode-text': {
      let bytes: Buffer;
      const trimmed = input.trim();
      if (format === 'base64') {
        bytes = Buffer.from(trimmed, 'base64');
      } else if (format === 'unicode') {
        // \uXXXX 转义解码
        const decoded = trimmed.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
        return { success: true, result: decoded };
      } else {
        // hex：支持带空格或紧凑，也支持 \x 前缀
        const clean = trimmed.replace(/\\x/g, '').replace(/[^0-9a-fA-F]/g, '');
        if (clean.length % 2 !== 0) throw new Error('十六进制长度必须为偶数');
        bytes = Buffer.from(clean, 'hex');
      }
      const text = iconv.decode(bytes, enc);
      return { success: true, result: text };
    }
    case 'base64-encode': {
      return { success: true, result: Buffer.from(input, 'utf-8').toString('base64') };
    }
    case 'base64-decode': {
      return { success: true, result: Buffer.from(input, 'base64').toString('utf-8') };
    }
    case 'image-to-base64': {
      // input 是 base64 图片数据，转换为 data URL 格式
      const dataUrl = input.startsWith('data:') ? input : `data:image/png;base64,${input.replace(/^data:image\/\w+;base64,/, '')}`;
      return { success: true, result: dataUrl };
    }
    default:
      throw new Error(`未知操作: ${op}`);
  }
}