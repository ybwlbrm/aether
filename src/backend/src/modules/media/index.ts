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
import { logger } from '../../lib/logger.js';

// ---- AI 供应商响应解析辅助（AEX-P2-002：异构 JSON 响应统一 unknown + 守卫）----
function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? v as Record<string, unknown> : null;
}

/** 多路径取值：data?.url / output?.url / data.url 等异构供应商字段 */
function pickUrl(v: unknown): string {
  const r = asRecord(v);
  if (!r) return '';
  for (const key of ['video_url', 'url']) {
    if (typeof r[key] === 'string') return r[key] as string;
  }
  const data = asRecord(r.data);
  if (data && typeof data.url === 'string') return data.url as string;
  const output = asRecord(r.output);
  if (output && typeof output.url === 'string') return output.url as string;
  return '';
}

function pickId(v: unknown): string {
  const r = asRecord(v);
  if (!r) return '';
  if (typeof r.task_id === 'string') return r.task_id as string;
  if (typeof r.id === 'string') return r.id as string;
  const data = asRecord(r.data);
  return data && typeof data.id === 'string' ? data.id as string : '';
}

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
    } catch {
      // AEX-P2-004 分类：intentional fallback —— providerBaseUrl 非法/缺失时按「非本地」处理，
      // 从而走更严格的私网拒绝分支（fail-closed），解析错误不改变安全结论。
    }

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
    } catch {
      // AEX-P2-004 分类：intentional fallback —— 纯字符串解析的防御性 try；
      // 失败时跳过十进制/八进制混淆检查，host 判定仍由上面的正则分支兜底。
    }

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

            const data = asRecord(await response.json());
            // 优先检查直接返回的视频 URL（支持 URL 与 Base64 data: 两种格式）
            const directRaw = pickUrl(data)
              || (data && typeof data.b64_json === 'string' ? `data:video/mp4;base64,${data.b64_json}` : '');
            if (directRaw) {
              if (directRaw.startsWith('data:')) {
                // P2-3 修复：支持 data:video/mp4;base64,... 直接返回（此前抛"格式不支持"）
                const b64 = directRaw.split(',')[1];
                fileBuffer = Buffer.from(b64, 'base64');
              } else {
                // SEC-009: SSRF 校验 — 验证 AI 返回的 URL 安全性
                if (!isSafeProviderUrl(directRaw, provider.baseUrl)) {
                  throw new Error('AI 返回的视频 URL 被拒绝：不安全的地址（疑似 SSRF）');
                }
                // P1-3 修复：下载携带 Provider Authorization（此前裸 fetch 无鉴权头）
                const downloadHeaders: Record<string, string> = {};
                if (provider.apiKey) downloadHeaders['Authorization'] = `Bearer ${provider.apiKey}`;
                const videoRes = await fetch(directRaw, { headers: downloadHeaders, signal: AbortSignal.timeout(120000) });
                if (!videoRes.ok) throw new Error(`视频下载失败: ${videoRes.status}`);
                fileBuffer = Buffer.from(await videoRes.arrayBuffer());
              }
            } else {
              // 视频任务可能返回 task_id，需要轮询结果
              const taskId = pickId(data);
              if (taskId) {
                // 轮询视频结果（最多 5 分钟）
                let videoUrl: string | null = null;
                // P1-2 修复：轮询路径与创建路径保持一致（不再错误去掉 /v1）——
                // 创建用 ${baseUrl}/videos，轮询同样用 ${baseUrl}/videos/{taskId}。
                for (let poll = 0; poll < 60; poll++) {
                  if (request.raw.destroyed) break;
                  await new Promise(r => setTimeout(r, 5000));
                  try {
                    // 通用轮询：先尝试标准格式，再试 Agnes 专用格式
                    let queryUrl = `${baseUrl}/videos/${encodeURIComponent(taskId)}`;
                    let pollRes = await fetch(queryUrl, {
                      headers: { 'Authorization': `Bearer ${provider.apiKey}` },
                      signal: AbortSignal.timeout(10000),
                    });
                    if (!pollRes.ok) {
                      // 回退到 Agnes 格式
                      queryUrl = `${baseUrl}/agnesapi?video_id=${encodeURIComponent(taskId)}&model_name=${encodeURIComponent(body.model || 'agnes-video-v2.0')}`;
                      pollRes = await fetch(queryUrl, {
                        headers: { 'Authorization': `Bearer ${provider.apiKey}` },
                        signal: AbortSignal.timeout(10000),
                      });
                    }
                    if (pollRes.ok) {
                      const pollData = asRecord(await pollRes.json());
                      if ((pollData?.status === 'completed' || pollData?.state === 'completed')) {
                        const pollRaw = pickUrl(pollData)
                          || (pollData && typeof pollData.b64_json === 'string' ? `data:video/mp4;base64,${pollData.b64_json}` : '');
                        if (pollRaw.startsWith('data:')) {
                          // P2-3 修复：轮询结果也支持 Base64
                          const b64 = pollRaw.split(',')[1];
                          fileBuffer = Buffer.from(b64, 'base64');
                          videoUrl = pollRaw; // 标记已拿到数据
                          break;
                        }
                        videoUrl = pollRaw || null;
                        // SEC-009: SSRF 校验 — 验证轮询返回的视频 URL 安全性
                        if (videoUrl && !isSafeProviderUrl(videoUrl, provider.baseUrl)) {
                          throw new Error('AI 返回的视频 URL 被拒绝：不安全的地址（疑似 SSRF）');
                        }
                        break;
                      } else if (pollData?.status === 'failed' || pollData?.state === 'failed') {
                        throw new Error(`视频生成失败: ${typeof pollData.error === 'string' ? pollData.error : '未知错误'}`);
                      }
                    }
                  } catch {
                    // AEX-P2-004 分类：intentional fallback —— 单次轮询请求失败（网络抖动/Provider
                    // 短暂不可用）不终止轮询，由外层 deadline 与次数上限收敛；超时后走「视频生成超时」。
                  }
                }
                if (!videoUrl) throw new Error('视频生成超时，请检查 Provider 是否支持视频生成');
                if (fileBuffer) {
                  // 已通过 Base64 分支拿到数据，无需再下载
                } else {
                  // SEC-009: SSRF 校验 — 验证轮询返回的视频 URL 安全性（二次校验，防御深度）
                  if (!isSafeProviderUrl(videoUrl, provider.baseUrl)) {
                    throw new Error('AI 返回的视频 URL 被拒绝：不安全的地址（疑似 SSRF）');
                  }
                  // P1-3 修复：下载携带 Provider Authorization（此前裸 fetch 无鉴权头）
                  const downloadHeaders: Record<string, string> = {};
                  if (provider.apiKey) downloadHeaders['Authorization'] = `Bearer ${provider.apiKey}`;
                  const videoRes = await fetch(videoUrl, { headers: downloadHeaders, signal: AbortSignal.timeout(120000) });
                  if (!videoRes.ok) throw new Error(`视频下载失败: ${videoRes.status}`);
                  fileBuffer = Buffer.from(await videoRes.arrayBuffer());
                }
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

            const data = asRecord(await response.json());
            const dataArr = data && Array.isArray(data.data) ? data.data : [];
            const firstItem = asRecord(dataArr[0]);
            const imageUrl = (firstItem && typeof firstItem.url === 'string' ? firstItem.url as string : '')
              || (firstItem && typeof firstItem.b64_json === 'string' ? `data:image/png;base64,${firstItem.b64_json}` : '')
              || (data && typeof data.url === 'string' ? data.url as string : '');
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
        if (body.type === 'video') {
          // P0-3 修复（审计）：视频生成失败时绝不把 SVG 假图伪装成 .mp4。
          // 返回失败态（results 不含该资产 + status=failed），前端不得显示"生成成功"。
          logger.warn({ event: 'media.video.generate_failed', reason: apiError || 'no_api_key' }, '视频生成失败，跳过伪产物生成');
          continue;
        }
        // 图片生成失败 → 保留 SVG 占位图（图片可无损展示失败占位，语义正确）
        const placeholderText = apiError
          ? `API 调用失败: ${apiError}`
          : `未配置 API Key (${provider?.name || 'default'})`;
        fileBuffer = svgToBuffer(generatePlaceholderSVG(body.type as 'image' | 'video', placeholderText));
      }

      // P2-5 修复（审计）：视频输出必须做真实格式验证 —— 防止错误页面/JSON/HTML 被存成 .mp4。
      // 魔数检查：MP4 = 前 32 字节内出现 'ftyp' 盒（offset 4 或前导 free/mdat 后），
      // WebM/Matroska = EBML 头 0x1A 0x45 0xDF 0xA3。搜索范围放宽避免误伤合法视频。
      if (body.type === 'video' && fileBuffer) {
        const buf = fileBuffer as Buffer;
        const head = buf.subarray(0, Math.min(64, buf.length)).toString('latin1');
        const isMp4 = buf.length >= 12 && head.includes('ftyp');
        const isWebM = buf.length >= 4 && buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3;
        if (!isMp4 && !isWebM) {
          const preview = buf.toString('utf8', 0, Math.min(200, buf.length));
          logger.warn({ event: 'media.video.invalid_payload', preview: preview.slice(0, 120) }, '视频响应内容不是有效视频（疑似错误页/JSON），已拒绝保存');
          apiError = apiError || 'Provider 返回的内容不是有效视频文件';
          continue;
        }
      }

      writeFileSync(filePath, fileBuffer);

      db.insert(mediaAssets).values({
        id: itemId,
        type: body.type === 'video' ? 'video' : body.type === 'audio' ? 'audio' : 'image',
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
      // P0-3/Oracle 复审修复：全部失败且无任何成功结果 → status='failed'（非 partial），
      // 前端据 status !== 'success' 显式报错，不会误显示"生成成功"。
      status: apiError ? (results.length > 0 ? 'partial' : 'failed') : 'success',
      error: apiError,
    };
  });

  // 更新媒体（重命名等）
  app.put('/api/media/:id', {
    schema: { description: '更新媒体资产', tags: ['媒体'] },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      const name = typeof body.name === 'string' ? body.name : '';
      db.update(mediaAssets).set({ name }).where(eq(mediaAssets.id, id)).run();
      return { success: true };
    } catch (e: unknown) {
      logger.error({ event: 'media.update_failed', err: e, mediaId: id }, '更新媒体资产失败');
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
        try {
          await import('node:fs/promises').then(fsp => fsp.unlink(row.path!));
        } catch {
          // AEX-P2-004 分类：ignored —— 文件已被用户/清理工具移走（ENOENT 等）时 DB 行仍需删除；
          // 删除失败不影响「资源消失」这一预期终态，故只记 debug 不阻断。
          logger.debug({ event: 'media.file_unlink_ignored', mediaId: id, path: row.path }, '媒体文件删除失败，仅移除 DB 行');
        }
      }
      db.delete(mediaAssets).where(eq(mediaAssets.id, id)).run();
      return { success: true };
    } catch (e: unknown) {
      logger.error({ event: 'media.delete_failed', err: e, mediaId: id }, '删除媒体资产失败');
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
          try {
            await import('node:fs/promises').then(fsp => fsp.unlink(row.path!));
          } catch {
            // AEX-P2-004 分类：ignored —— 同单条删除：文件已不存在时仅移除 DB 行。
            logger.debug({ event: 'media.file_unlink_ignored', mediaId: id, path: row.path }, '媒体文件删除失败，仅移除 DB 行');
          }
        }
        db.delete(mediaAssets).where(eq(mediaAssets.id, id)).run();
        if (row) deleted++;
      } catch (e: unknown) {
        logger.error({ event: 'media.batch_delete_item_failed', err: e, mediaId: id }, '批量删除单项失败，继续处理其余项');
      }
    }
    // 持久化到 JSON 数据层（与 conversations 模块一致）
    try {
      saveDb(config);
    } catch (e: unknown) {
      // AEX-P2-004 分类：recoverable —— SQLite 已提交的删除不因 JSON 快照落盘失败而回滚，
      // 记录后交由下一次 saveDb 自然补齐。
      logger.error({ event: 'media.persist_failed', err: e }, '媒体数据持久化失败');
    }
    return { success: true, deleted };
  });
}