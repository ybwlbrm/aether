import type { FastifyReply } from 'fastify';
import { startHeartbeat, SSE_CHUNK_TIMEOUT_MS } from '../../lib/sse-utils.js';
import { parseSse, withChunkTimeout, SseStreamError } from '../../lib/sse-parser.js';
import { translate } from '../../lib/stream-translate.js';
import type { StreamChunk } from '@pacc/shared';

export interface SseSender {
  (event: string, payload: string): void;
}

export interface SseStreamContext {
  sseSend: SseSender;
  heartbeat: ReturnType<typeof startHeartbeat> | null;
  reader: AsyncGenerator<Uint8Array> | null;
}

/**
 * 初始化 SSE 响应头
 */
export function initSseHeaders(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

/**
 * 创建 SSE 发送函数（忽略客户端已断开的写入错误）
 */
export function createSseSender(reply: FastifyReply): SseSender {
  return (event: string, payload: string) => {
    try {
      reply.raw.write(event === 'message' ? `data: ${payload}\n\n` : `event: ${event}\ndata: ${payload}\n\n`);
    } catch {
      // 客户端已断开
    }
  };
}

/**
 * 启动 SSE 心跳 — 防止长操作时连接超时
 * BE-08: 心跳在 try 内启动，finally 保证必清理，防止早退路径泄漏 interval
 */
export function startSseHeartbeat(reply: FastifyReply): ReturnType<typeof startHeartbeat> {
  return startHeartbeat(reply);
}

/**
 * 清理 SSE 心跳
 */
export function clearSseHeartbeat(heartbeat: ReturnType<typeof startHeartbeat> | null): void {
  if (heartbeat) clearInterval(heartbeat);
}

/**
 * 创建带超时的 SSE 流读取器
 */
export function createSseReader(
  response: Response,
  abortSignal: AbortSignal
): AsyncGenerator<Uint8Array> {
  return withChunkTimeout(response.body!.getReader(), SSE_CHUNK_TIMEOUT_MS, abortSignal);
}

/**
 * 解析 SSE 流并翻译为统一协议块
 */
export async function* parseAndTranslateSse(
  chunks: AsyncIterable<Uint8Array>,
  abortSignal: AbortSignal
): AsyncGenerator<StreamChunk> {
  const parser = parseSse(chunks);
  const translator = translate(parser);
  for await (const chunk of translator) {
    yield chunk;
  }
}

/**
 * 发送 SSE 错误事件
 */
export function sendSseError(sseSend: SseSender, message: string): void {
  sseSend('error', JSON.stringify({ message }));
}

/**
 * 发送 SSE 完成标记
 */
export function sendSseDone(sseSend: SseSender): void {
  sseSend('message', '[DONE]');
}

/**
 * 结束 SSE 响应
 */
export function endSseResponse(reply: FastifyReply): void {
  reply.raw.end();
}