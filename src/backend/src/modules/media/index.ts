import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { getDb, saveDb } from '../../db/client.js';
import { mediaAssets } from '../../db/schema/index.js';
import { eq, desc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { getProviderById, getProviderByCapability, type ResolvedProvider } from '../../lib/provider.js';
import { getSettings } from '../../lib/dal.js';
import { isPathSafe } from '../../lib/path-guard.js';

/** W4-3: isPathSafe 统一至 lib/path-guard.ts（布尔版），下方调用点不变 */

/** P1-10: XML 转义 — apiError/prompt 等外部文本拼入 SVG <text> 前必须转义，防止存储型 XSS（SVG 以 image/svg+xml 提供） */
function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, c => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&apos;'
  ));
}

/**
 * 生成一个简单的 SVG 占位图（当 API 不可用时使用）
 */
function generatePlaceholderSVG(type: 'image' | 'video', text: string): string {
  const isVideo = type === 'video';
  const icon = isVideo ? '▶' : '🖼';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
    <rect width="1024" height="1024" fill="#1a1a2e"/>
    <rect x="32" y="32" width="960" height="960" rx="24" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="2"/>
    <text x="512" y="420" text-anchor="middle" font-size="80" fill="rgba(255,255,255,0.15)">${icon}</text>
    <text x="512" y="500" text-anchor="middle" font-size="20" fill="rgba(255,255,255,0.35)" font-family="sans-serif">${escapeXml(text)}</text>
    <text x="512" y="540" text-anchor="middle" font-size="14" fill="rgba(255,255,255,0.2)" font-family="sans-serif">请检查 API 配置后重试</text>
  </svg>`;
}

function svgToBuffer(svg: string): Buffer {
  return Buffer.from(svg);
}

/**
 * SEC-009: SSRF 防护 — 校验 AI provider 返回的 URL 是否安全可访问
 * 规则：
 *  - 仅允许 http/https 协议
 *  - 禁止 link-local (169.254.0.0/16) 和 0.0.0.0
 *  - 允许公网主机
 *  - 仅当 provider 自身的 baseUrl 也是 loopback/private 时，才允许访问 loopback/private 地址（本地 provider 如 Ollama）
 */
function isSafeProviderUrl(url: string, providerBaseUrl: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();

    // 判断 provider 自身是否为本地/私有地址
    let providerIsLocal = false;
    try {
      const p = new URL(providerBaseUrl);
      const phost = p.hostname.toLowerCase();
      if (phost === '127.0.0.1' || phost === 'localhost' || phost === '::1' || phost === '0.0.0.0') {
        providerIsLocal = true;
      } else if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(phost)) {
        providerIsLocal = true;
      } else if (phost.endsWith('.local') || phost.endsWith('.internal')) {
        providerIsLocal = true;
      }
    } catch { /* providerBaseUrl 解析失败视为非本地 */ }

    // 禁止 link-local 和 0.0.0.0（无论 provider 是否本地）
    if (host === '0.0.0.0' || /^169\.254\./.test(host)) return false;

    // 云元数据地址
    if (host === '169.254.169.254' || host.endsWith('.metadata.google.internal') || host === 'metadata.google.internal') return false;

    // 私网段 / 回环 / 本地域名后缀
    const isPrivateOrLoopback =
      host === '127.0.0.1' ||
      host === 'localhost' ||
      host === '::1' ||
      /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(host) ||
      host.endsWith('.local') ||
      host.endsWith('.internal');

    // 仅当 provider 自身也是本地/私有时，才允许访问私网/回环地址
    if (isPrivateOrLoopback && !providerIsLocal) return false;

    // 防止十进制/八进制混淆 IP
    try {
      const ip = u.hostname.startsWith('[') ? u.hostname.slice(1, -1) : u.hostname;
      if (/^\d+$/.test(ip.replace(/\./g, '')) && ip.includes('.')) {
        if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(ip)) {
          if (!providerIsLocal) return false;
        }
      }
    } catch { /* 忽略解析失败 */ }

    return true;
  } catch {
    return false;
  }
}

export function registerMediaRoutes(app: FastifyInstance, config: BackendConfig): void {
  const db = getDb();
  const mediaDir = resolve(config.dataDir, 'media');
  if (!existsSync(mediaDir)) mkdirSync(mediaDir, { recursive: true });

  // 提供静态媒体文件访问
  app.get('/api/media/file/:filename', {
    schema: { description: '获取媒体文件', tags: ['媒体'], hide: true },
  }, async (request, reply) => {
    const { filename } = request.params as { filename: string };
    // SEC-005: 拒绝包含路径分隔符的文件名，防止路径穿越
    if (filename.includes('/') || filename.includes('\\')) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    const filePath = resolve(mediaDir, filename);
    // SEC-005: 使用 startsWith 校验，替代有缺陷的 relative() 逻辑
    const mediaDirResolved = resolve(mediaDir);
    if (!filePath.startsWith(mediaDirResolved + sep)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    if (!existsSync(filePath)) {
      return reply.status(404).send({ error: 'File not found' });
    }
    const ext = filename.split('.').pop()?.toLowerCase();
    const mimeMap: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
      mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
      mp3: 'audio/mpeg', wav: 'audio/wav',
    };
    const contentType = mimeMap[ext || ''] || 'application/octet-stream';
    return reply.type(contentType).send(readFileSync(filePath));
  });

  // 获取所有媒体资产
  app.get('/api/media', {
    schema: { description: '获取所有媒体资产', tags: ['媒体'] },
  }, async () => {
    const items = db.select().from(mediaAssets).orderBy(desc(mediaAssets.createdAt)).all();
    return items.map(m => ({
      ...m,
      url: m.path ? `/api/media/file/${m.path.split(/[\\/]/).pop()}` : '',
      metadata: JSON.parse(m.metadata || '{}'),
    }));
  });

  // 生成媒体
  app.post('/api/media/generate', {
    schema: {
      description: '生成媒体内容',
      tags: ['媒体'],
      body: {
        type: 'object',
        required: ['type', 'prompt'],
        properties: {
          type: { type: 'string', enum: ['image', 'video'] },
          prompt: { type: 'string' },
          negativePrompt: { type: 'string' },
          model: { type: 'string' },
          name: { type: 'string' },
          providerId: { type: 'string' },
          size: { type: 'string' },
          num: { type: 'integer', minimum: 1, maximum: 10 },
          image: { type: 'string' }, // base64 image for image-to-image / image-to-video
          numFrames: { type: 'integer' },
          frameRate: { type: 'integer' },
        },
      },
    },
  }, async (request) => {
    const body = request.body as {
      type: string; prompt: string; negativePrompt?: string; model?: string;
      name?: string; providerId?: string; size?: string; num?: number;
      image?: string; numFrames?: number; frameRate?: number;
    };
    // 从 SQLite 读取 provider（用户通过 Providers 页面添加的）
    let provider: ResolvedProvider | null = null;
    if (body.providerId) {
      provider = getProviderById(body.providerId, config.encryptionKey);
    }
    if (!provider) {
      provider = getProviderByCapability(body.type === 'video' ? 'video' : 'image', config.encryptionKey);
    }
    const now = new Date().toISOString();
    const id = randomUUID();

    const results: Array<{ url: string; id: string; type: string; prompt: string; model: string; size: string; createdAt: string }> = [];
    const count = body.num || 1;
    let apiError: string | null = null;

    for (let i = 0; i < count; i++) {
      const itemId = count > 1 ? `${id}_${i}` : id;
      const ext = body.type === 'image' ? 'png' : 'mp4';
      const fileName = `${itemId}.${ext}`;
      const filePath = resolve(mediaDir, fileName);
      let fileBuffer: Buffer | null = null;

      if (provider?.apiKey) {
        try {
          const baseUrl = provider.baseUrl?.replace(/\/+$/, '') || '';
          const isVideo = body.type === 'video';
          const isImageToImage = isVideo ? false : !!body.image;
          const isImageToVideo = isVideo && !!body.image;

          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${provider.apiKey}`,
          };

          if (isVideo) {
            // 视频生成 API
            const apiBody: Record<string, unknown> = {
              model: body.model || provider.defaultModel || 'agnes-video-v2.0',
              prompt: body.prompt,
              num_frames: body.numFrames || 121,
              frame_rate: body.frameRate || 24,
            };
            if (body.size) {
              const [w, h] = body.size.split('x').map(Number);
              if (w) apiBody.width = w;
              if (h) apiBody.height = h;
            }
            if (body.negativePrompt) apiBody.negative_prompt = body.negativePrompt;
            if (body.image) apiBody.image = body.image;

            // 视频生成超时 120s（部分提供商标记为异步任务但返回慢）
            const response = await fetch(`${baseUrl}/videos`, {
              method: 'POST',
              headers,
              body: JSON.stringify(apiBody),
              signal: AbortSignal.timeout(120000),
            });

            if (!response.ok) {
              const errText = await response.text().catch(() => '');
              throw new Error(`视频 API 返回错误: ${response.status} ${errText}`);
            }

            const data = await response.json() as any;
            // 优先检查直接返回的视频 URL
            const directUrl = data?.video_url || data?.url || data?.data?.url || data?.output?.url;
            if (directUrl) {
              // SEC-009: SSRF 校验 — 验证 AI 返回的 URL 安全性
              if (!isSafeProviderUrl(directUrl, provider.baseUrl)) {
                throw new Error('AI 返回的视频 URL 被拒绝：不安全的地址（疑似 SSRF）');
              }
              // 直接下载
              const videoRes = await fetch(directUrl, { signal: AbortSignal.timeout(120000) });
              if (!videoRes.ok) throw new Error(`视频下载失败: ${videoRes.status}`);
              fileBuffer = Buffer.from(await videoRes.arrayBuffer());
            } else {
              // 视频任务可能返回 task_id，需要轮询结果
              const taskId = data.task_id || data.id || data.data?.id;
              if (taskId) {
                // 轮询视频结果（最多 5 分钟）
                let videoUrl: string | null = null;
                const rootUrl = baseUrl.replace(/\/v1\/?$/, '');
                for (let poll = 0; poll < 60; poll++) {
                  if (request.raw.destroyed) break;
                  await new Promise(r => setTimeout(r, 5000));
                  try {
                    // 通用轮询：先尝试标准格式，再试 Agnes 专用格式
                    let queryUrl = `${rootUrl}/videos/${encodeURIComponent(taskId)}`;
                    let pollRes = await fetch(queryUrl, {
                      headers: { 'Authorization': `Bearer ${provider.apiKey}` },
                      signal: AbortSignal.timeout(10000),
                    });
                    if (!pollRes.ok) {
                      // 回退到 Agnes 格式
                      queryUrl = `${rootUrl}/agnesapi?video_id=${encodeURIComponent(taskId)}&model_name=${encodeURIComponent(body.model || 'agnes-video-v2.0')}`;
                      pollRes = await fetch(queryUrl, {
                        headers: { 'Authorization': `Bearer ${provider.apiKey}` },
                        signal: AbortSignal.timeout(10000),
                      });
                    }
                    if (pollRes.ok) {
                      const pollData = await pollRes.json() as any;
                      if (pollData.status === 'completed' || pollData.state === 'completed') {
                        videoUrl = pollData.video_url || pollData.url || pollData.data?.url || pollData.output?.url;
                        // SEC-009: SSRF 校验 — 验证轮询返回的视频 URL 安全性
                        if (videoUrl && !isSafeProviderUrl(videoUrl, provider.baseUrl)) {
                          throw new Error('AI 返回的视频 URL 被拒绝：不安全的地址（疑似 SSRF）');
                        }
                        break;
                      } else if (pollData.status === 'failed' || pollData.state === 'failed') {
                        throw new Error(`视频生成失败: ${pollData.error || '未知错误'}`);
                      }
                    }
                  } catch { /* continue polling */ }
                }
                if (!videoUrl) throw new Error('视频生成超时，请检查 Provider 是否支持视频生成');
                // SEC-009: SSRF 校验 — 验证轮询返回的视频 URL 安全性（二次校验，防御深度）
                if (!isSafeProviderUrl(videoUrl, provider.baseUrl)) {
                  throw new Error('AI 返回的视频 URL 被拒绝：不安全的地址（疑似 SSRF）');
                }
                // 下载视频
                const videoRes = await fetch(videoUrl, { signal: AbortSignal.timeout(120000) });
                if (!videoRes.ok) throw new Error(`视频下载失败: ${videoRes.status}`);
                fileBuffer = Buffer.from(await videoRes.arrayBuffer());
              } else {
                // 直接返回视频数据（部分 API 直接返回 base64）
                throw new Error('视频 API 响应格式不支持，请检查 Provider 配置');
              }
            }
          } else {
            // 图片生成 API
            const apiBody: Record<string, unknown> = {
              model: body.model || provider.defaultModel || 'dall-e-3',
              prompt: body.prompt,
              n: 1,
              size: body.size || '1024x1024',
            };
            if (body.negativePrompt) apiBody.negative_prompt = body.negativePrompt;

            if (isImageToImage && body.image) {
              // 图生图：通过 extra_body 传递图片
              apiBody.extra_body = { image: [body.image] };
            }

            const response = await fetch(`${baseUrl}/images/generations`, {
              method: 'POST',
              headers,
              body: JSON.stringify(apiBody),
              signal: AbortSignal.timeout(300000),
            });

            if (!response.ok) {
              const errText = await response.text().catch(() => '');
              throw new Error(`图片 API 返回错误: ${response.status} ${errText}`);
            }

            const data = await response.json() as any;
            const imageUrl = data?.data?.[0]?.url || data?.data?.[0]?.b64_json || data?.url;
            if (!imageUrl) throw new Error('API 未返回图片数据');

            if (imageUrl.startsWith('data:')) {
              const b64 = imageUrl.split(',')[1];
              fileBuffer = Buffer.from(b64, 'base64');
            } else {
              // SEC-009: SSRF 校验 — 验证 AI 返回的图片 URL 安全性
              if (!isSafeProviderUrl(imageUrl, provider.baseUrl)) {
                throw new Error('AI 返回的图片 URL 被拒绝：不安全的地址（疑似 SSRF）');
              }
              const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(60000) });
              if (!imgRes.ok) throw new Error(`图片下载失败: ${imgRes.status}`);
              fileBuffer = Buffer.from(await imgRes.arrayBuffer());
            }
          }
        } catch (e: unknown) {
          apiError = (e instanceof Error ? e.message : String(e));
        }
      }

      if (!fileBuffer) {
        // 生成 SVG 占位图
        const placeholderText = apiError
          ? `API 调用失败: ${apiError}`
          : `未配置 API Key (${provider?.name || 'default'})`;
        fileBuffer = svgToBuffer(generatePlaceholderSVG(body.type as 'image' | 'video', placeholderText));
      }

      writeFileSync(filePath, fileBuffer);

      db.insert(mediaAssets).values({
        id: itemId,
        type: body.type as any,
        name: body.name || `${body.type}_${now}`,
        path: filePath,
        mimeType: body.type === 'image' ? 'image/png' : 'video/mp4',
        size: fileBuffer.byteLength,
        metadata: JSON.stringify({
          prompt: body.prompt,
          negativePrompt: body.negativePrompt || '',
          model: body.model || '',
          provider: provider?.name || 'unknown',
          status: apiError ? 'failed' : 'generated',
          error: apiError,
          size: body.size,
          numFrames: body.numFrames,
          frameRate: body.frameRate,
          hasImage: !!body.image,
        }),
        createdAt: now,
      }).run();

      results.push({
        url: `/api/media/file/${fileName}`,
        id: itemId,
        type: body.type,
        prompt: body.prompt,
        model: body.model || '',
        size: body.size || '',
        createdAt: now,
      });
    }

    return {
      results,
      status: apiError ? 'partial' : 'success',
      error: apiError,
    };
  });

  // 更新媒体（重命名等）
  app.put('/api/media/:id', {
    schema: { description: '更新媒体资产', tags: ['媒体'] },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as any;
    try {
      db.update(mediaAssets).set({ name: body.name }).where(eq(mediaAssets.id, id)).run();
      return { success: true };
    } catch (e: unknown) {
      console.error('[Media] 更新失败:', (e instanceof Error ? e.message : String(e)) || e);
      return { error: '更新失败，请重试' };
    }
  });

  // 删除媒体
  app.delete('/api/media/:id', {
    schema: { description: '删除媒体资产', tags: ['媒体'] },
  }, async (request) => {
    const { id } = request.params as { id: string };
    try {
      // P2-11: 删 DB 行同时删文件，防孤儿文件
      const row = db.select().from(mediaAssets).where(eq(mediaAssets.id, id)).get();
      // Oracle-2: 运行时路径校验 — 防 DB 中 path 被篡改后删除任意文件
      // P1-5 修复：媒体文件存储在 dataDir/media，需将其加入安全目录集合
      // B3 修复：合并动态 settings.allowedDirs（用户设置的目录），统一数据源
      const dynSettings = await getSettings().catch(() => null);
      const dynDirs = (dynSettings?.allowedDirs || []).map((d: string) => resolve(d));
      const safeDirs = [...config.allowedDirs, ...dynDirs, mediaDir];
      if (row?.path && isPathSafe(row.path, safeDirs)) {
        try { await import('node:fs/promises').then(fsp => fsp.unlink(row.path!)); } catch (_e: unknown) { /* ignore - intentional */ }
      }
      db.delete(mediaAssets).where(eq(mediaAssets.id, id)).run();
      return { success: true };
    } catch (e: unknown) {
      console.error('删除媒体失败:', (e instanceof Error ? e.message : String(e)) || e);
      return { error: '删除失败，请重试' };
    }
  });

  // 批量删除媒体
  app.post('/api/media/batch-delete', {
    schema: {
      description: '批量删除媒体资产',
      tags: ['媒体'],
      body: {
        type: 'object',
        required: ['ids'],
        properties: {
          ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
        },
      },
    },
  }, async (request) => {
    const body = request.body as { ids: string[] };
    const ids = Array.isArray(body?.ids) ? body.ids : [];
    let deleted = 0;
    // B3 修复：合并动态 settings.allowedDirs（统一数据源）
    const dynSettings = await getSettings().catch(() => null);
    const dynDirs = (dynSettings?.allowedDirs || []).map((d: string) => resolve(d));
    const safeDirs = [...config.allowedDirs, ...dynDirs, mediaDir];
    for (const id of ids) {
      try {
        // 与单条删除一致：删 DB 行同时删文件，防孤儿文件
        const row = db.select().from(mediaAssets).where(eq(mediaAssets.id, id)).get();
        // Oracle-2: 运行时路径校验 — 防 DB 中 path 被篡改后删除任意文件
        // P1-5 修复：媒体文件存储在 dataDir/media，需将其加入安全目录集合
        if (row?.path && isPathSafe(row.path, safeDirs)) {
          try { await import('node:fs/promises').then(fsp => fsp.unlink(row.path!)); } catch (_e: unknown) { /* ignore - intentional */ }
        }
        db.delete(mediaAssets).where(eq(mediaAssets.id, id)).run();
        if (row) deleted++;
      } catch (e: unknown) {
        console.error(`[Media] 批量删除失败 (${id}):`, (e instanceof Error ? e.message : String(e)) || e);
      }
    }
    // 持久化到 JSON 数据层（与 conversations 模块一致）
    try { saveDb(config); } catch (e: unknown) { console.error('[Media] 持久化失败:', (e instanceof Error ? e.message : String(e)) || e); }
    return { success: true, deleted };
  });
}