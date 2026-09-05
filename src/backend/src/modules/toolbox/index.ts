import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { registerImageRoutes, imagesToPdf, exportDir as imageExportDir } from './image.js';
import { registerDocRoutes, xlsxToCsv, csvToXlsx, docxToPdf, xlsxToPdf, exportDir as docExportDir } from './doc.js';
import { registerAudioRoutes, convertWithFfmpeg, unlockMusic, exportDir as audioExportDir, QMC_STATIC_CIPHER, decryptQmcStaticCipher, detectEncryptedAudio } from './audio.js';
import { registerPdfRoutes, mergePdfs, watermarkPdf, compressPdf, pdfToText, pdfToImage, pdfToDocx, exportDir as pdfExportDir } from './pdf.js';
import { registerEncodingRoutes, utilityOp, encodeOp } from './encoding.js';
import { registerDownloadRoutes } from './download.js';
import { registerVideoRoutes, extractAudioFromVideo, downloadWithYtDlp } from './video.js';
import { exportDir, convertWithFfmpeg as utilsConvertWithFfmpeg, convertWithLibreOffice, imagesToPdf as utilsImagesToPdf, parseCsv, detectEncryptedAudio as utilsDetectEncryptedAudio, decryptQmcStaticCipher as utilsDecryptQmcStaticCipher, QMC_STATIC_CIPHER as utilsQMC_STATIC_CIPHER, getDocx } from './utils.js';

// 统一导出目录函数（所有子模块使用同一个）
export { exportDir };

// 重新导出所有子模块的核心函数，保持向后兼容
export {
  // image
  imagesToPdf,
  // doc
  xlsxToCsv,
  csvToXlsx,
  docxToPdf,
  xlsxToPdf,
  parseCsv,
  // audio
  convertWithFfmpeg,
  unlockMusic,
  QMC_STATIC_CIPHER,
  decryptQmcStaticCipher,
  detectEncryptedAudio,
  // pdf
  mergePdfs,
  watermarkPdf,
  compressPdf,
  pdfToText,
  pdfToImage,
  pdfToDocx,
  // encoding
  utilityOp,
  encodeOp,
  // video
  extractAudioFromVideo,
  downloadWithYtDlp,
  // utils
  convertWithLibreOffice,
  getDocx,
};

/** 注册所有工具箱路由 */
export function registerToolboxRoutes(app: FastifyInstance, config: BackendConfig): void {
  // 注册各子模块路由
  registerImageRoutes(app, config);
  registerDocRoutes(app, config);
  registerAudioRoutes(app, config);
  registerPdfRoutes(app, config);
  registerEncodingRoutes(app, config);
  registerDownloadRoutes(app, config);
  registerVideoRoutes(app, config);

  // 获取支持的转换格式（仅真实支持的组合）
  app.get('/api/toolbox/formats', {
    schema: { description: '获取工具箱支持的格式列表', tags: ['工具箱'] },
  }, async () => ({
    imageToPdf: { from: ['png', 'jpg', 'jpeg', 'webp'], to: ['pdf'] },
    imageToImage: {
      from: ['png', 'jpg', 'jpeg', 'webp'],
      to: ['png', 'jpg', 'jpeg', 'webp'],
      options: {
        quality: '1-100（仅 jpg/jpeg/webp 有效，压缩率）',
        width: '目标宽度 px（等比缩放，可只提供一项）',
        height: '目标高度 px（等比缩放，可只提供一项）',
      },
    },
    xlsxToCsv: { from: ['xlsx'], to: ['csv'] },
    csvToXlsx: { from: ['csv'], to: ['xlsx'] },
    audio: { from: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'], to: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'] },
    officeToPdf: { from: ['docx', 'xlsx'], to: ['pdf'], engine: 'LibreOffice' },
    pdfCompress: { description: '压缩 PDF 文件体积' },
    pdfToDocx: { from: ['pdf'], to: ['docx'], description: 'PDF 转 Word（提取每页文本）' },
    unlockMusic: {
      from: ['ncm', 'qmc', 'kgm'],
      to: ['mp3', 'flac'],
      description: '解锁加密音乐（网易云 ncm / QQ音乐 qmc / 酷狗 kgm）',
    },
    videoExtract: {
      from: ['mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'wmv'],
      to: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg'],
      description: '从视频中提取音频（ffmpeg）',
      engine: 'ffmpeg',
    },
    youtubeDownload: {
      from: ['url'],
      to: ['mp4', 'webm', 'mp3', 'm4a', 'wav', 'flac'],
      description: 'YouTube/通用视频下载（yt-dlp）',
      engine: 'yt-dlp',
    },
  }));

  // 执行转换
  app.post('/api/toolbox/convert', {
    schema: { description: '执行文件格式转换', tags: ['工具箱'] },
  }, async (request, reply) => {
    const body = request.body as {
      files: { name: string; data: string }[]; // data = base64
      targetFormat: string;
      options?: any;
    };
    const files = body.files || [];
    if (!Array.isArray(files) || files.length === 0) {
      return reply.code(400).send({ error: '没有上传文件' });
    }

    const dir = exportDir(config);
    const results: { file: string; output: string; success: boolean; message?: string }[] = [];
    const target = (body.targetFormat || '').toLowerCase();
    // P1-11 修复：目标格式仅允许 2-8 位字母数字（作为输出文件扩展名），防注入非法字符
    if (!/^[a-z0-9]{2,8}$/.test(target)) {
      return reply.code(400).send({ error: '不支持的目标格式' });
    }

    try {
      for (const f of files) {
        const name = f.name || 'file';
        const base64 = (f.data || '').split(',')[1] || f.data || '';
        const buf = Buffer.from(base64, 'base64');
        const ext = parse(name).ext.toLowerCase().replace('.', '');
        const outName = `${randomUUID()}.${target}`;
        const outPath = resolve(dir, outName);
        let outBuf: Buffer | null = null;

        // 图片 → PDF
        if (['png', 'jpg', 'jpeg', 'webp'].includes(ext) && target === 'pdf') {
          outBuf = await imagesToPdf([buf]);
        }
        // 图片 → 图片（sharp，支持 options.quality 压缩 + width/height 缩放）
        else if (['png', 'jpg', 'jpeg', 'webp'].includes(ext) && ['png', 'jpg', 'jpeg', 'webp'].includes(target)) {
          const sharpMod = await import('sharp');
          const options = (body.options || {}) as { quality?: number; width?: number; height?: number };
          const fmt = (target === 'jpeg' ? 'jpg' : target) as 'png' | 'jpg' | 'webp';
          let pipeline = sharpMod.default(buf);
          // 缩放：只提供一边时另一边自动等比；不放大原图
          if (options.width || options.height) {
            pipeline = pipeline.resize(options.width, options.height, { fit: 'inside', withoutEnlargement: true });
          }
          // quality 仅对 jpg/jpeg/webp 生效（sharp 对 png 的 quality 会忽略）
          const q = options.quality;
          if (typeof q === 'number' && q > 0 && q <= 100 && ['jpg', 'jpeg', 'webp'].includes(target)) {
            pipeline = pipeline.toFormat(fmt, { quality: Math.round(q) });
          } else {
            pipeline = pipeline.toFormat(fmt);
          }
          outBuf = await pipeline.toBuffer();
        }
        // Excel sheet → CSV
        else if (ext === 'xlsx' && target === 'csv') {
          outBuf = await xlsxToCsv(buf);
        }
        // CSV → XLSX（用正确 CSV 解析器）
        else if (ext === 'csv' && target === 'xlsx') {
          outBuf = await csvToXlsx(buf.toString('utf-8'));
        }
        // DOCX → PDF（LibreOffice）— 让 execFile 搜索 PATH，existsSync 无法搜索 PATH
        else if (ext === 'docx' && target === 'pdf') {
          outBuf = await docxToPdf(buf);
        }
        // XLSX → PDF（LibreOffice）
        else if (ext === 'xlsx' && target === 'pdf') {
          outBuf = await xlsxToPdf(buf);
        }
        // 音频转换（ffmpeg）：mp3/wav/flac/ogg 互转 — 让 execFile 搜索 PATH
        else if (['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'].includes(ext) && ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'].includes(target)) {
          outBuf = await convertWithFfmpeg(buf, ext, target);
        }
        else {
          // 不支持的组合明确报错，不做假转换
          return reply.code(400).send({ error: `不支持的转换: ${ext} → ${target}。支持的组合: 图片→PDF/图片、xlsx→csv、csv→xlsx、音频互转(mp3/wav/flac/ogg/m4a/aac)` });
        }

        if (outBuf) {
          writeFileSync(outPath, outBuf);
          results.push({ file: name, output: `/api/toolbox/download/${outName}`, success: true });
        } else {
          results.push({ file: name, output: '', success: false, message: '不支持的转换组合' });
        }
      }
    } catch (e: unknown) {
      return reply.code(500).send({ error: `转换失败: ${(e instanceof Error ? e.message : String(e))}` });
    }

    return { results };
  });

  // PDF 操作：合并 / 加水印（用 pdf-lib）
  app.post('/api/toolbox/pdf-operate', {
    schema: {
      description: 'PDF 操作（merge 合并 / watermark 水印）',
      tags: ['工具箱'],
      body: {
        type: 'object',
        required: ['operation', 'files'],
        properties: {
          operation: { type: 'string', enum: ['merge', 'watermark'] },
          files: { type: 'array' },
          text: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as { operation: string; files: { name: string; data: string }[]; text?: string };
    const files = body.files || [];
    if (!Array.isArray(files) || files.length === 0) return reply.code(400).send({ error: '没有上传文件' });
    const dir = exportDir(config);

    try {
      if (body.operation === 'merge') {
        const buffers = files.map(f => {
          const base64 = (f.data || '').split(',')[1] || f.data || '';
          return Buffer.from(base64, 'base64');
        });
        const merged = await mergePdfs(buffers);
        const outName = `${randomUUID()}.pdf`;
        writeFileSync(resolve(dir, outName), merged);
        return { success: true, output: `/api/toolbox/download/${outName}` };
      }
      if (body.operation === 'watermark') {
        const base64 = (files[0].data || '').split(',')[1] || files[0].data || '';
        const buf = Buffer.from(base64, 'base64');
        const text = body.text || 'SAMPLE';
        const watermarked = await watermarkPdf(buf, text);
        const outName = `${randomUUID()}.pdf`;
        writeFileSync(resolve(dir, outName), watermarked);
        return { success: true, output: `/api/toolbox/download/${outName}` };
      }
      return reply.code(400).send({ error: `不支持的 PDF 操作: ${body.operation}` });
    } catch (e: unknown) {
      return reply.code(500).send({ error: `PDF 操作失败: ${(e instanceof Error ? e.message : String(e))}` });
    }
  });

  // 小工具：编码转换 / Base64 / 时间戳 / 颜色（纯计算，直接返回）
  app.post('/api/toolbox/utility', {
    schema: {
      description: '小工具（encoding/Base64/timestamp/color）',
      tags: ['工具箱'],
      body: { type: 'object', properties: { op: { type: 'string' }, input: { type: 'string' }, options: { type: 'object' } } },
    },
  }, async (request, reply) => {
    const body = request.body as { op: string; input?: string; options?: any };
    try {
      const result = await utilityOp(body.op, body.input, body.options);
      return result;
    } catch (e: unknown) {
      return reply.code(500).send({ error: `工具执行失败: ${(e instanceof Error ? e.message : String(e))}` });
    }
  });

  // PDF → 图片 / PDF 文字提取（pdfjs-dist + @napi-rs/canvas）
  app.post('/api/toolbox/pdf-read', {
    schema: {
      description: 'PDF 读取（to-image 渲染首页为 PNG / to-text 提取全文）',
      tags: ['工具箱'],
      body: { type: 'object', required: ['op', 'file'], properties: { op: { type: 'string', enum: ['to-image', 'to-text'] }, file: { type: 'object' } } },
    },
  }, async (request, reply) => {
    const body = request.body as { op: string; file: { data: string } };
    const f = body.file || {};
    const base64 = (f.data || '').split(',')[1] || f.data || '';
    const buf = Buffer.from(base64, 'base64');

    try {
      if (body.op === 'to-text') {
        const result = await pdfToText(buf);
        return { success: true, result };
      }

      // to-image：渲染第一页为 PNG
      const result = await pdfToImage(buf, config);
      return { success: true, ...result };
    } catch (e: unknown) {
      return reply.code(500).send({ error: `PDF 读取失败: ${(e instanceof Error ? e.message : String(e))}` });
    }
  });

  // PDF → DOCX：pdfjs-dist 提取每页文本，docx 库生成 Word 文档
  app.post('/api/toolbox/pdf-to-docx', {
    schema: {
      description: 'PDF → DOCX（提取文本生成 Word 文档）',
      tags: ['工具箱'],
      body: { type: 'object', required: ['file'], properties: { file: { type: 'object' } } },
    },
  }, async (request, reply) => {
    const body = request.body as { file: { data: string } };
    const f = body.file || {};
    const base64 = (f.data || '').split(',')[1] || f.data || '';
    const buf = Buffer.from(base64, 'base64');

    try {
      const result = await pdfToDocx(buf, config);
      return { success: true, ...result };
    } catch (e: unknown) {
      return reply.code(500).send({ error: `PDF → DOCX 失败: ${(e instanceof Error ? e.message : String(e))}` });
    }
  });

  // 音乐解锁：ncm 解密 → mp3/flac 音频流；qmc/kgm XOR 简化解密 → mp3
  app.post('/api/toolbox/unlock-music', {
    schema: {
      description: '解密加密音乐（网易云 ncm → mp3/flac，QQ音乐 qmc / 酷狗 kgm → mp3）',
      tags: ['工具箱'],
      body: { type: 'object', required: ['file'], properties: { file: { type: 'object' } } },
    },
  }, async (request, reply) => {
    const body = request.body as { file: { data: string } };
    const f = body.file || {};
    const base64 = (f.data || '').split(',')[1] || f.data || '';
    const buf = Buffer.from(base64, 'base64');

    try {
      const result = await unlockMusic(buf, config);
      return result;
    } catch (e: unknown) {
      return reply.code(500).send({ error: `音乐解锁失败: ${(e instanceof Error ? e.message : String(e))}` });
    }
  });

  // PDF 压缩（pdf-lib：移除未用对象+压缩）
  app.post('/api/toolbox/pdf-compress', {
    schema: { description: '压缩 PDF（移除未用对象，减小体积）', tags: ['工具箱'] },
  }, async (request, reply) => {
    const body = request.body as { files: { name: string; data: string }[] };
    const f = body.files?.[0];
    if (!f) return reply.code(400).send({ error: '没有上传文件' });
    const base64 = (f.data || '').split(',')[1] || f.data || '';
    const buf = Buffer.from(base64, 'base64');
    const dir = exportDir(config);
    try {
      const { compressed, originalSize, compressedSize } = await compressPdf(buf);
      const outName = `${randomUUID()}.pdf`;
      writeFileSync(resolve(dir, outName), compressed);
      return { success: true, output: `/api/toolbox/download/${outName}`, originalSize, compressedSize };
    } catch (e: unknown) {
      return reply.code(500).send({ error: `PDF 压缩失败: ${(e instanceof Error ? e.message : String(e))}` });
    }
  });

  // 编码转换：文本→编码 / 编码→文本 双向互转 + Base64 编解码 + 图片→Base64
  app.post('/api/toolbox/encode', {
    schema: {
      description: '编码转换（文本↔编码 双向互转 / base64 / 图片转base64）',
      tags: ['工具箱'],
      body: {
        type: 'object',
        required: ['op', 'input'],
        properties: {
          op: { type: 'string', enum: ['to-utf8', 'encode-text', 'decode-text', 'base64-encode', 'base64-decode', 'image-to-base64'] },
          input: { type: 'string' },
          // 编码方向：encode（文字→编码） / decode（编码→文字）
          // 目标编码：utf8 / gbk / big5 / gb18030 / unicode
          encoding: { type: 'string', default: 'utf8' },
          format: { type: 'string', enum: ['hex', 'unicode', 'base64'], default: 'hex' },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as { op: string; input: string; encoding?: string; format?: string };
    const op = body.op;
    const input = body.input || '';
    const encoding = body.encoding || 'utf8';
    const format = body.format || 'hex';
    try {
      const result = await encodeOp(op, input, encoding, format);
      return result;
    } catch (e: unknown) {
      return reply.code(500).send({ error: `编码转换失败: ${(e instanceof Error ? e.message : String(e))}` });
    }
  });
}

// 需要导入的额外依赖
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve, parse } from 'node:path';