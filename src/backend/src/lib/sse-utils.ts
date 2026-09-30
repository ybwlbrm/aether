/**
 * SSE 公共工具 — 心跳 + 单块超时读取（消除 conversations/agents/sync 三处重复实现）
 */
import type { FastifyReply } from 'fastify';

/** SSE 单块读取超时（毫秒）— fetch 超时只覆盖响应头，body 停滞时 reader.read() 会永久挂起 */
export const SSE_CHUNK_TIMEOUT_MS = 60_000;

/**
 * 心跳定时器 — 防止长操作时代理/网关超时断连。
 * @returns 定时器；调用方在结束时 clearInterval
 */
export function startHeartbeat(reply: FastifyReply | { raw: { write: (chunk: string) => boolean } }): NodeJS.Timeout {
  return setInterval(() => {
    try { reply.raw.write(': heartbeat\n\n'); } catch { /* 客户端已断开 */ }
  }, 15_000);
}

/**
 * 单块读取加超时保护（供同步读取场景使用；流式管线优先用 sse-parser 的 withChunkTimeout）。
 * 若 AI provider 发送响应头后不再发送数据，read() 会永久挂起；超时后取消底层流并抛错。
 */
export async function readChunkWithTimeout(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs = SSE_CHUNK_TIMEOUT_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    reader.read().finally(() => { if (timer !== undefined) clearTimeout(timer); }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void reader.cancel().catch(() => {});
        reject(new Error(`AI 响应流读取超时：${timeoutMs / 1000} 秒内未收到新数据`));
      }, timeoutMs);
    }),
  ]);
}