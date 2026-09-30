import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { writeFileSync, unlinkSync, existsSync, mkdirSync, readdirSync, statSync, lstatSync, readFileSync } from 'node:fs';
import { resolve, basename, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getSettings, saveSettings } from '../../lib/dal.js';
import { assertMagicMatches } from '../../lib/magic-bytes.js';

// 目录模式允许的图片扩展名（小写，不含点）
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif']);
const MAX_IMAGE_SIZE = 50 * 1024 * 1024; // 单张最大 50MB（与 dir-img 一致）
const MIME_MAP: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif',
};

/** 扫描目录，返回图片 URL 列表（仅顶层常规文件，跳过子目录/符号链接/隐藏文件/非图片/超大文件） */
function scanDir(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return []; // 目录不存在/不可读 → 空列表，不崩溃
  }
  const urls: string[] = [];
  for (const name of entries) {
    if (name.startsWith('.')) continue; // 跳过隐藏文件
    const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
    if (!IMAGE_EXTS.has(ext)) continue;
    try {
      const st = lstatSync(resolve(dir, name));
      if (!st.isFile() || st.isSymbolicLink()) continue; // 跳过子目录与符号链接
      if (st.size > MAX_IMAGE_SIZE) continue; // 跳过超大文件（与 dir-img 的 413 一致）
    } catch {
      continue;
    }
    urls.push(`/api/backgrounds/dir-img?file=${encodeURIComponent(name)}`);
  }
  return urls.sort(); // 稳定顺序
}

export function registerBackgroundRoutes(app: FastifyInstance, config: BackendConfig): void {
  const bgDir = resolve(config.dataDir, 'backgrounds');
  if (!existsSync(bgDir)) mkdirSync(bgDir, { recursive: true });

  // 上传背景图片（base64）
  app.post('/api/backgrounds/upload', {
    schema: { description: '上传背景图片', tags: ['背景'] },
  }, async (request) => {
    const body = request.body as { images: string[] };
    if (!body.images || !Array.isArray(body.images) || body.images.length === 0) {
      return { error: '请选择图片' };
    }
    const saved: string[] = [];
    for (const dataUrl of body.images.slice(0, 999)) {
      const match = dataUrl.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/);
      if (!match) continue;
      const ext = match[1] === 'jpeg' ? 'jpg' : 'png';
      const raw = Buffer.from(match[2], 'base64');
      // SEC-002: magic bytes 校验 — 拒绝伪装图片（evil.exe 改名 .png 等）
      const magicOk = assertMagicMatches(raw, ext);
      if (!magicOk.ok) continue;
      const name = `${randomUUID()}.${ext}`;
      writeFileSync(resolve(bgDir, name), raw);
      saved.push(`/data/backgrounds/${name}`);
    }
    // 保存到 settings
    const settings = await getSettings();
    const existing = settings.bgImages || [];
    settings.bgImages = [...existing, ...saved];
    await saveSettings(settings);
    return { images: saved };
  });

  // 获取背景图片列表
  app.get('/api/backgrounds', {
    schema: { description: '获取背景图片列表', tags: ['背景'] },
  }, async () => {
    const settings = await getSettings();
    const mode = settings.bgMode || 'upload';
    const interval = settings.bgInterval || 10;
    if (mode === 'dir') {
      const dir = settings.bgDir || '';
      return { images: scanDir(dir), interval, mode, dir };
    }
    return { images: settings.bgImages || [], interval, mode: 'upload' };
  });

  // 目录模式：反代读取目录中的图片文件（安全校验防路径穿越）
  app.get('/api/backgrounds/dir-img', {
    schema: { description: '读取目录模式下的图片文件', tags: ['背景'] },
  }, async (request, reply) => {
    const { file } = request.query as { file?: string };
    // Fastify 无 schema 时重复参数会解析为数组，拦截非字符串
    if (typeof file !== 'string' || !file) return reply.code(400).send({ error: '缺少 file 参数' });
    // 路径穿越防护：文件名必须是纯 basename，不能包含路径分隔符
    if (basename(file) !== file) return reply.code(400).send({ error: '非法文件名' });
    // 隐藏文件拒绝（与 scanDir 行为一致，防读取随目录混入的 .env/.git 等）
    if (file.startsWith('.')) return reply.code(404).send({ error: '文件不存在' });
    const settings = await getSettings();
    const dir = settings.bgDir || '';
    if (!dir) return reply.code(400).send({ error: '未设置背景目录' });
    const absPath = resolve(dir, file);
    if (!absPath.startsWith(resolve(dir))) return reply.code(400).send({ error: '非法路径' });
    let st;
    try {
      st = lstatSync(absPath);
    } catch {
      return reply.code(404).send({ error: '文件不存在' });
    }
    if (st.isSymbolicLink()) return reply.code(400).send({ error: '不支持符号链接' });
    if (!st.isFile()) return reply.code(400).send({ error: '非法文件' });
    if (st.size > MAX_IMAGE_SIZE) return reply.code(413).send({ error: '文件过大' });
    const ext = file.includes('.') ? file.split('.').pop()!.toLowerCase() : '';
    if (!IMAGE_EXTS.has(ext)) return reply.code(404).send({ error: '文件不存在' }); // 与 scanDir 白名单一致
    reply.type(MIME_MAP[ext]);
    reply.header('Cache-Control', 'private, max-age=60'); // 短缓存：目录文件更新后 1 分钟内生效
    try {
      return readFileSync(absPath);
    } catch {
      return reply.code(404).send({ error: '文件不存在' }); // 竞态：文件在检查后被删除
    }
  });

  // 设置图片来源：上传模式 or 目录模式
  app.post('/api/backgrounds/source', {
    schema: {
      description: '设置背景图片来源（upload=上传 / dir=目录）',
      tags: ['背景'],
      body: {
        type: 'object',
        required: ['mode'],
        properties: {
          mode: { type: 'string', enum: ['upload', 'dir'] },
          dir: { type: 'string' },
        },
      },
    },
  }, async (request) => {
    const body = request.body as { mode: 'upload' | 'dir'; dir?: string };
    const settings = await getSettings();
    if (body.mode === 'dir') {
      const dir = (body.dir || '').trim();
      if (!dir) return { error: '请填写目录路径' };
      const absDir = resolve(dir); // 相对路径转绝对，避免重启后 cwd 变化失效
      if (!existsSync(absDir)) return { error: `目录不存在: ${absDir}` };
      settings.bgMode = 'dir';
      settings.bgDir = absDir;
    } else {
      settings.bgMode = 'upload';
      delete settings.bgDir; // 清空目录残留，避免前端误读旧值
    }
    await saveSettings(settings);
    return { mode: body.mode, dir: settings.bgDir || '', images: body.mode === 'dir' ? scanDir(settings.bgDir || '') : settings.bgImages || [] };
  });

  // 设置间隔
  app.post('/api/backgrounds/interval', {
    schema: { description: '设置背景轮播间隔', tags: ['背景'] },
  }, async (request) => {
    const body = request.body as { interval: number };
    const settings = await getSettings();
    settings.bgInterval = body.interval || 10;
    await saveSettings(settings);
    return { interval: body.interval };
  });

  // 清除所有背景图片
  app.post('/api/backgrounds/clear', {
    schema: { description: '清除所有背景图片', tags: ['背景'] },
  }, async () => {
    const settings = await getSettings();
    const images = settings.bgImages || [];
    for (const img of images) {
      // 修复：用 resolve + relative 校验路径，防止构造恶意路径绕过
      const imgName = img.replace('/data/backgrounds/', '');
      const filePath = resolve(bgDir, imgName);
      const rel = relative(bgDir, filePath);
      if (rel.startsWith('..') || rel.startsWith('/') || rel.startsWith('\\')) continue;
      try { unlinkSync(filePath); } catch (_e: unknown) { /* ignore - intentional */ }
    }
    settings.bgImages = [];
    settings.bgInterval = 10;
    await saveSettings(settings);
    return { success: true };
  });
}