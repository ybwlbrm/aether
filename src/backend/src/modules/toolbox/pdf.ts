import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { exportDir, getDocx } from './utils.js';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** PDF 操作相关路由：合并、水印、压缩、读取、PDF→DOCX、PDF→图片 */
export function registerPdfRoutes(app: FastifyInstance, config: BackendConfig): void {
  // PDF 操作在 /api/toolbox/pdf-operate, /api/toolbox/pdf-read, /api/toolbox/pdf-to-docx, /api/toolbox/pdf-compress 中处理
  // 这里导出供相关端点使用的核心函数
}

/** PDF 合并 */
export async function mergePdfs(buffers: Buffer[]): Promise<Buffer> {
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  for (const buf of buffers) {
    const src = await PDFDocument.load(buf);
    const pages = await pdf.copyPages(src, src.getPageIndices());
    for (const p of pages) pdf.addPage(p);
  }
  return Buffer.from(await pdf.save());
}

/** PDF 加水印 */
export async function watermarkPdf(buf: Buffer, text: string): Promise<Buffer> {
  const { PDFDocument } = await import('pdf-lib');
  const { createCanvas } = await import('@napi-rs/canvas');
  const pdf = await PDFDocument.load(buf);
  const pages = pdf.getPages();
  for (const page of pages) {
    const { width, height } = page.getSize();
    // 创建小图用于水印
    const wmCanvas = createCanvas(Math.ceil(width * 0.4), Math.ceil(height * 0.08));
    const ctx = wmCanvas.getContext('2d');
    ctx.fillStyle = 'rgba(180, 180, 180, 0.3)';
    ctx.font = '24px sans-serif';
    ctx.rotate(-0.4);
    ctx.fillText(text, 10, 30);
    const wmPng = wmCanvas.toBuffer('image/png');
    const wmImg = await pdf.embedPng(wmPng);
    page.drawImage(wmImg, { x: width * 0.3, y: height * 0.45, width: wmImg.width * 0.5, height: wmImg.height * 0.5, opacity: 0.3 });
  }
  return Buffer.from(await pdf.save());
}

/** PDF 压缩 */
export async function compressPdf(buf: Buffer): Promise<{ compressed: Buffer; originalSize: number; compressedSize: number }> {
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.load(buf, { ignoreEncryption: true });
  // 重新保存 PDF（pdf-lib 会自动压缩和移除未用对象）
  const compressed = await pdf.save({ useObjectStreams: true });
  return { compressed: Buffer.from(compressed), originalSize: buf.length, compressedSize: compressed.length };
}

/** PDF → 文本提取 */
export async function pdfToText(buf: Buffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  let full = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    full += content.items.map((it: any) => it.str || '').join(' ') + '\n';
  }
  return full.trim();
}

/** PDF → 图片（渲染首页为 PNG） */
export async function pdfToImage(buf: Buffer, config: BackendConfig): Promise<{ output: string }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = await import('@napi-rs/canvas');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: 1.5 });
  const canvas = createCanvas(viewport.width, viewport.height);
  const ctx = canvas.getContext('2d');
  await page.render({ canvas, canvasContext: ctx, viewport } as any).promise;
  const png = canvas.toBuffer('image/png');
  const dir = exportDir(config);
  const outName = `${randomUUID()}.png`;
  writeFileSync(resolve(dir, outName), png);
  return { output: `/api/toolbox/download/${outName}` };
}

/** PDF → DOCX */
export async function pdfToDocx(buf: Buffer, config: BackendConfig): Promise<{ output: string; pageCount: number }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;

  // docx 生成
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await getDocx();
  const children: InstanceType<typeof Paragraph>[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((it: any) => it.str || '').join(' ');
    children.push(new Paragraph({
      text: `第 ${i} 页`,
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 240, after: 120 },
    }));
    text.split('\n').forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      children.push(new Paragraph({
        children: [new TextRun({ text: trimmed, size: 24 })],
        spacing: { after: 120 },
      }));
    });
  }

  const docxDoc = new Document({
    creator: 'Aether',
    title: 'PDF 转换文档',
    sections: [{ children }],
  });
  const outBuf = await Packer.toBuffer(docxDoc);
  const dir = exportDir(config);
  const outName = `${randomUUID()}.docx`;
  writeFileSync(resolve(dir, outName), outBuf);
  return { output: `/api/toolbox/download/${outName}`, pageCount: doc.numPages };
}

/** 导出目录工具 */
export { exportDir };