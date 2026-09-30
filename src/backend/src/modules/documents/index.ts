import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { getDb } from '../../db/client.js';
import { documents } from '../../db/schema/index.js';
import { eq, desc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
// P2-4 修复：大依赖改为懒加载，减少启动时内存占用
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFirstAvailableProvider } from '../../lib/provider.js';
import { getSettings } from '../../lib/dal.js';
import { buildModelRuntime, type ModelRequest } from '../../core/models/index.js';

// 懒加载 pptxgenjs 和 docx
let _pptxgen: typeof import('pptxgenjs')['default'] | null = null;
export async function getPptxgen() {
  if (!_pptxgen) _pptxgen = (await import('pptxgenjs')).default;
  return _pptxgen;
}
let _docx: typeof import('docx') | null = null;
export async function getDocx() {
  if (!_docx) _docx = await import('docx');
  return _docx;
}

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// P1-9: UUID 格式校验 — id 会拼进 preview 文件路径，非 UUID 输入（如 ../../data/settings）可造成路径穿越
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Oracle-1: 纵深防御 — 下载/预览/删除路径必须在 allowedDirs 内 */
interface SlideItem { title: string; content: string; }
interface SectionItem { heading: string; body: string; }

export function registerDocumentRoutes(app: FastifyInstance, config: BackendConfig): void {
  const db = getDb();
  const docDir = resolve(config.dataDir, 'documents');
  if (!existsSync(docDir)) mkdirSync(docDir, { recursive: true });

  // 获取所有文档
  app.get('/api/documents', {
    schema: { description: '获取所有文档', tags: ['文档'] },
  }, async () => {
    return db.select().from(documents).orderBy(desc(documents.updatedAt)).all();
  });

  // 生成 PPT
  app.post('/api/documents/ppt', {
    schema: {
      description: '生成 PPT',
      tags: ['文档'],
      body: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string' },
          slides: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' } } } },
        },
      },
    },
  }, async (request) => {
    const body = request.body as { title: string; slides?: SlideItem[] };
    const now = new Date().toISOString();
    const id = randomUUID();
    const fileName = `${id}.pptx`;
    const filePath = resolve(docDir, fileName);

    // 有幻灯片内容时直接用，否则调用 AI 自动生成
    let slides = Array.isArray(body.slides) && body.slides.length > 0 ? body.slides : [];
    let aiGenerated = false;
    if (slides.length === 0) {
      slides = await generateSlidesWithAI(body.title, config.encryptionKey);
      aiGenerated = true;
    }

    // 生成真正的 PPTX 二进制文件
    const buffer = await buildPptxBuffer(slides, body.title);
    writeFileSync(filePath, buffer);

    // 保存预览数据（供网页内查看）
    await writePreviewData(config, id, 'ppt', body.title, slides);

    db.insert(documents).values({
      id,
      type: 'ppt',
      name: body.title,
      path: filePath,
      status: 'completed',
      createdAt: now,
      updatedAt: now,
    }).run();

    return { id, type: 'ppt', name: body.title, status: 'completed', slideCount: slides.length, aiGenerated };
  });

  // 生成 DOC
  app.post('/api/documents/doc', {
    schema: {
      description: '生成文档',
      tags: ['文档'],
      body: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string' },
          content: { type: 'string' },
          sections: { type: 'array', items: { type: 'object', properties: { heading: { type: 'string' }, body: { type: 'string' } } } },
        },
      },
    },
  }, async (request) => {
    const body = request.body as { title: string; content?: string; sections?: SectionItem[] };
    const now = new Date().toISOString();
    const id = randomUUID();
    const fileName = `${id}.docx`;
    const filePath = resolve(docDir, fileName);

    // 有章节内容时直接用，否则调用 AI 自动生成
    let sections = Array.isArray(body.sections) && body.sections.length > 0 ? body.sections : [];
    let aiGenerated = false;
    if (sections.length === 0) {
      sections = await generateSectionsWithAI(body.title, body.content || '', config.encryptionKey);
      aiGenerated = true;
    }

    // 生成真正的 DOCX 二进制文件
    const buffer = await buildDocxBuffer(sections, body.title);
    writeFileSync(filePath, buffer);

    // 保存预览数据（供网页内查看）
    await writePreviewData(config, id, 'doc', body.title, sections);

    db.insert(documents).values({
      id,
      type: 'doc',
      name: body.title,
      path: filePath,
      status: 'completed',
      createdAt: now,
      updatedAt: now,
    }).run();

    return { id, type: 'doc', name: body.title, status: 'completed', sectionCount: sections.length, aiGenerated };
  });

  // 下载文档文件
  app.get('/api/documents/:id/download', {
    schema: {
      description: '下载文档文件',
      tags: ['文档'],
      params: { type: 'object', properties: { id: { type: 'string' } } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    // SEC-004: 校验 UUID 格式，防止路径穿越
    if (!UUID_PATTERN.test(id)) return reply.code(404).send({ error: '文档不存在' });
    const doc = db.select().from(documents).where(eq(documents.id, id)).get();
    if (!doc) return reply.code(404).send({ error: '文档不存在' });
    // SEC-004: 运行时从 id 重建文件路径，不信任 DB 中的 doc.path
    // 根据文档类型确定预期扩展名
    const expectedExt = doc.type === 'ppt' ? '.pptx' : '.docx';
    const filePath = resolve(docDir, `${id}${expectedExt}`);
    // SEC-004: 校验重建路径在 docDir 内
    const docDirResolved = resolve(docDir);
    if (!filePath.startsWith(docDirResolved + sep)) {
      return reply.code(403).send({ error: '路径不在允许目录内' });
    }
    // 兼容旧数据：若重建路径不存在，尝试另一种扩展名（迁移场景）
    let finalPath = filePath;
    if (!existsSync(finalPath)) {
      const altExt = doc.type === 'ppt' ? '.docx' : '.pptx';
      const altPath = resolve(docDir, `${id}${altExt}`);
      if (existsSync(altPath) && altPath.startsWith(docDirResolved + sep)) {
        finalPath = altPath;
      }
    }
    try {
      const buffer = readFileSync(finalPath);
      const mime = doc.type === 'ppt' ? PPTX_MIME : DOCX_MIME;
      const ext = doc.type === 'ppt' ? 'pptx' : 'docx';
      reply.header('Content-Type', mime);
      reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(doc.name)}.${ext}`);
      reply.header('Content-Length', buffer.length);
      return reply.send(buffer);
    } catch (e: unknown) {
      console.error('下载文档失败:', (e instanceof Error ? e.message : String(e)));
      return reply.code(404).send({ error: '文件不存在或已损坏' });
    }
  });

  // 预览文档（网页内查看）
  app.get('/api/documents/:id/preview', {
    schema: {
      description: '预览文档内容（PPT 幻灯片 / DOC 章节）',
      tags: ['文档'],
      params: { type: 'object', properties: { id: { type: 'string' } } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    // P1-9: 非 UUID 格式直接 404，防止路径穿越
    if (!UUID_PATTERN.test(id)) return reply.code(404).send({ error: '文档不存在' });
    const doc = db.select().from(documents).where(eq(documents.id, id)).get();
    if (!doc) return { error: '文档不存在' };
    const previewPath = resolve(docDir, `${id}.preview.json`);
    if (existsSync(previewPath)) {
      try {
        return JSON.parse(readFileSync(previewPath, 'utf-8'));
      } catch { /* fall through */ }
    }
    // 没有预览数据 — 返回文档基本信息 + 提示
    return { id, type: doc.type, name: doc.name, slides: [], sections: [], empty: true, message: '该文档暂无预览数据（请重新生成）' };
  });

  // 重命名文档
  app.put('/api/documents/:id', {
    schema: { description: '更新文档', tags: ['文档'] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    // P1-9: 非 UUID 格式直接 404，防止路径穿越
    if (!UUID_PATTERN.test(id)) return reply.code(404).send({ error: '文档不存在' });
    const body = request.body as any;
    try {
      db.update(documents).set({ name: body.name, updatedAt: new Date().toISOString() }).where(eq(documents.id, id)).run();
      // 同步更新 preview.json 中的名称，避免预览弹窗标题不一致
      const previewPath = resolve(docDir, `${id}.preview.json`);
      if (existsSync(previewPath)) {
        try {
          const preview = JSON.parse(readFileSync(previewPath, 'utf-8'));
          preview.name = body.name;
          writeFileSync(previewPath, JSON.stringify(preview, null, 2));
        } catch { /* preview 文件损坏时忽略 */ }
      }
      return { success: true };
    } catch (e: unknown) { console.error('[Documents] 操作失败:', (e instanceof Error ? e.message : String(e)) || e); return { error: '操作失败，请重试' }; }
  });

  // 删除文档
  app.delete('/api/documents/:id', {
    schema: {
      description: '删除文档',
      tags: ['文档'],
      params: { type: 'object', properties: { id: { type: 'string' } } },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    // SEC-004: 校验 UUID 格式，防止路径穿越
    if (!UUID_PATTERN.test(id)) return { error: '文档不存在' };
    try {
      // 先查行获取类型信息（用于确定扩展名）
      const row = db.select().from(documents).where(eq(documents.id, id)).get();
      db.delete(documents).where(eq(documents.id, id)).run();
      // 清理预览文件
      const previewPath = resolve(docDir, `${id}.preview.json`);
      if (existsSync(previewPath)) {
        try { unlinkSync(previewPath); } catch (_e: unknown) { /* ignore - intentional */ }
      }
      // SEC-004: 运行时从 id 重建文件路径，不信任 DB 中的 row.path
      if (row) {
        const expectedExt = row.type === 'ppt' ? '.pptx' : '.docx';
        const filePath = resolve(docDir, `${id}${expectedExt}`);
        const docDirResolved = resolve(docDir);
        if (filePath.startsWith(docDirResolved + sep) && existsSync(filePath)) {
          try { unlinkSync(filePath); } catch (_e: unknown) { /* ignore - intentional */ }
        } else {
          // 兼容旧数据：尝试另一种扩展名
          const altExt = row.type === 'ppt' ? '.docx' : '.pptx';
          const altPath = resolve(docDir, `${id}${altExt}`);
          if (altPath.startsWith(docDirResolved + sep) && existsSync(altPath)) {
            try { unlinkSync(altPath); } catch (_e: unknown) { /* ignore - intentional */ }
          }
        }
      }
      return { success: true };
    } catch (e: unknown) { console.error('删除文档失败:', (e instanceof Error ? e.message : String(e)) || e); return { error: '删除失败，请重试' }; }
  });

  // ---------- 辅助函数 ----------

  /** 保存预览数据（供网页内查看 DOC/PPT 内容） */
  async function writePreviewData(config: BackendConfig, id: string, type: string, name: string, items: any[]) {
    const previewDir = resolve(config.dataDir, 'documents');
    if (!existsSync(previewDir)) mkdirSync(previewDir, { recursive: true });
    const previewPath = resolve(previewDir, `${id}.preview.json`);
    const previewData = type === 'ppt'
      ? { id, type, name, slides: items, sections: [] }
      : { id, type, name, sections: items, slides: [] };
    writeFileSync(previewPath, JSON.stringify(previewData, null, 2));
  }
}

// ---------- AI 自动生成 ----------

/** 从 AI 返回文本中提取 JSON 对象（兼容 markdown 代码块包裹） */
export function extractJson(text: string): any {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch { /* 继续尝试下面的方式 */ }
  }
  const arrStart = cleaned.indexOf('[');
  const arrEnd = cleaned.lastIndexOf(']');
  if (arrStart >= 0 && arrEnd > arrStart) {
    try {
      return JSON.parse(cleaned.slice(arrStart, arrEnd + 1));
    } catch { /* 忽略 */ }
  }
  return null;
}

/** 调用配置的 AI provider 生成幻灯片 */
async function generateSlidesWithAI(title: string, encryptionKey: string): Promise<SlideItem[]> {
  try {
    const provider = getFirstAvailableProvider(encryptionKey);
    if (provider?.apiKey) {
      const systemPrompt = '你是专业的演示文稿内容策划。根据用户给出的标题，生成一份结构完整的 PPT 幻灯片大纲。' +
        '只返回一个 JSON 对象，不要包含任何其他文字或 markdown，格式如下：' +
        '{"slides":[{"title":"幻灯片标题","content":"该页详细内容（可多行，用\\n分隔要点")}]}。' +
        '第一页为封面，最后一页为结束页。内容用简体中文，每页 3-6 个要点。';

      const providerConfig = {
        id: provider.id,
        name: provider.name,
        type: provider.type,
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
        defaultModel: provider.defaultModel,
        models: provider.models,
        capabilities: provider.capabilities,
      };
      const runtime = buildModelRuntime(providerConfig);

      const request: ModelRequest = {
        provider: provider.id,
        model: provider.defaultModel || 'gpt-4o',
        systemPrompt,
        messages: [{ role: 'user', content: `演示文稿标题：${title}` }],
        maxTokens: 2048,
        signal: AbortSignal.timeout(30000),
      };

      const response = await runtime.complete(request);
      const raw = response.content.trim();
      const parsed = extractJson(raw);
      if (parsed && Array.isArray(parsed.slides)) {
        const slides = parsed.slides
          .filter((s: any) => s && typeof s.title === 'string' && s.title.trim())
          .map((s: any) => ({ title: s.title.trim(), content: typeof s.content === 'string' ? s.content : '' }));
        if (slides.length > 0) return slides;
      }
    }
  } catch (e: unknown) {
    console.error('AI 生成 PPT 内容失败，使用默认内容:', (e instanceof Error ? e.message : String(e)));
  }
  return fallbackSlides(title);
}

/** 调用配置的 AI provider 生成文档章节 */
async function generateSectionsWithAI(title: string, description: string, encryptionKey: string): Promise<SectionItem[]> {
  try {
    const provider = getFirstAvailableProvider(encryptionKey);
    if (provider?.apiKey) {
      const systemPrompt = '你是专业的文档撰写助手。根据用户给出的标题和描述，生成一篇结构完整的文章大纲。' +
        '只返回一个 JSON 对象，不要包含任何其他文字或 markdown，格式如下：' +
        '{"sections":[{"heading":"章节标题","body":"章节正文内容"}]}。' +
        '内容用简体中文，每个章节正文 3-6 句话或要点。';
      const userContent = `文档标题：${title}${description ? `\n描述要求：${description}` : ''}`;

      const providerConfig = {
        id: provider.id,
        name: provider.name,
        type: provider.type,
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
        defaultModel: provider.defaultModel,
        models: provider.models,
        capabilities: provider.capabilities,
      };
      const runtime = buildModelRuntime(providerConfig);

      const request: ModelRequest = {
        provider: provider.id,
        model: provider.defaultModel || 'gpt-4o',
        systemPrompt,
        messages: [{ role: 'user', content: userContent }],
        maxTokens: 2048,
        signal: AbortSignal.timeout(30000),
      };

      const response = await runtime.complete(request);
      const raw = response.content.trim();
      const parsed = extractJson(raw);
      if (parsed && Array.isArray(parsed.sections)) {
        const sections = parsed.sections
          .filter((s: any) => s && typeof s.heading === 'string' && s.heading.trim())
          .map((s: any) => ({ heading: s.heading.trim(), body: typeof s.body === 'string' ? s.body : '' }));
        if (sections.length > 0) return sections;
      }
    }
  } catch (e: unknown) {
    console.error('AI 生成 DOC 内容失败，使用默认内容:', (e instanceof Error ? e.message : String(e)));
  }
  return fallbackSections(title, description);
}

function fallbackSlides(title: string): SlideItem[] {
  return [
    { title: title || '未命名演示文稿', content: '由 Aether 自动生成' },
    { title: '目录', content: '1. 概述\n2. 详情\n3. 总结' },
    { title: '概述', content: '本演示文稿围绕「' + title + '」主题展开。\n涵盖背景、核心要点与实践价值。' },
    { title: '详情', content: '核心内容展示：\n· 关键观点一\n· 关键观点二\n· 关键观点三' },
    { title: '总结', content: '· 回顾核心要点\n· 明确下一步行动\n· 感谢聆听' },
  ];
}

function fallbackSections(title: string, description: string): SectionItem[] {
  return [
    { heading: title || '未命名文档', body: '' },
    { heading: '概述', body: description || '本文档由 Aether 自动生成。' },
    { heading: '核心内容', body: '要点一：主题背景与意义。\n要点二：核心方法与步骤。\n要点三：实践案例与效果。' },
    { heading: '总结', body: '回顾全文核心要点，明确后续行动方向。' },
  ];
}

// ---------- 二进制文件生成 ----------

/** 用 pptxgenjs 生成 PPTX buffer — P2-4: 懒加载 */
async function buildPptxBuffer(slides: SlideItem[], title: string): Promise<Buffer> {
  const pptx = new (await getPptxgen())();
  pptx.layout = 'LAYOUT_16x9';
  pptx.author = 'Aether';
  pptx.title = title;

  slides.forEach((item, index) => {
    const slide = pptx.addSlide();
    slide.background = { color: 'F3F4F6' };
    // 标题
    slide.addText(item.title || `第 ${index + 1} 页`, {
      x: 0.5, y: 0.4, w: 9, h: 0.9,
      fontSize: index === 0 ? 36 : 28,
      bold: true,
      color: '1F2937',
      fontFace: 'Microsoft YaHei',
    });
    // 内容
    slide.addText(item.content || '', {
      x: 0.6, y: 1.5, w: 8.8, h: 4.9,
      fontSize: index === 0 ? 20 : 16,
      color: '374151',
      fontFace: 'Microsoft YaHei',
      valign: 'top',
    });
    // 页码
    slide.addText(`${index + 1} / ${slides.length}`, {
      x: 7.5, y: 6.75, w: 2, h: 0.4,
      fontSize: 10, color: '9CA3AF', align: 'right',
    });
  });

  // pptxgenjs 运行时支持 write('nodebuffer')，但类型定义仅列出 WriteProps，此处做精确窄化断言
  const buffer = await (pptx as unknown as { write(format: 'nodebuffer'): Promise<Buffer> }).write('nodebuffer');
  return buffer;
}

/** 用 docx 生成 DOCX buffer — P2-4: 懒加载 */
async function buildDocxBuffer(sections: SectionItem[], title: string): Promise<Buffer> {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await getDocx();
  const children: InstanceType<typeof Paragraph>[] = [];

  // 文档主标题
  children.push(new Paragraph({
    text: title || '未命名文档',
    heading: HeadingLevel.TITLE,
    spacing: { after: 300 },
  }));

  sections.forEach((section) => {
    children.push(new Paragraph({
      text: section.heading || '未命名章节',
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 240, after: 120 },
    }));
    const body = section.body || '待补充内容';
    body.split('\n').forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      children.push(new Paragraph({
        children: [new TextRun({ text: trimmed, size: 24 })],
        spacing: { after: 120 },
      }));
    });
  });

  const doc = new Document({
    creator: 'Aether',
    title,
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}
