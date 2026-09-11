import type { FastifyReply } from 'fastify';
import { createEventBus } from '../../lib/event-bus.js';
import { SSE_CHUNK_TIMEOUT_MS, startHeartbeat, readChunkWithTimeout } from '../../lib/sse-utils.js';
import { randomUUID } from 'node:crypto';

export interface SseContext {
  reply: FastifyReply;
  sseSend: (event: string, payload: string) => void;
  eventBus: ReturnType<typeof createEventBus>;
  convId: string;
  runTaskId: string;
  clientAbort: AbortController;
  heartbeatInterval: ReturnType<typeof setInterval> | null;
}

export interface SetupSseOptions {
  /** 外部传入的统一 Run ID（P0-02：一次执行只创建一个 ID，此处不得自行生成） */
  runTaskId: string;
  /** 可选：外部传入的 AbortController（未传则内部创建） */
  abortController?: AbortController;
}

/**
 * 初始化 SSE 上下文。
 * P0-02 修复：runTaskId 必须由上层 createRunContext() 创建后传入，
 * 本函数不再自行 randomUUID —— 否则 task.started 用 ID A、其余事件用 ID B，
 * 产生幽灵数据。
 */
export function setupSse(
  reply: FastifyReply,
  conversationId: string | undefined,
  db: any,
  config: any,
  saveDb: () => void,
  options: SetupSseOptions,
): SseContext {
  const convId = conversationId || 'anonymous';
  const runTaskId = options.runTaskId;

  // SSE 响应头
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const sseSend = (event: string, payload: string) => {
    try {
      reply.raw.write(event === 'message' ? `data: ${payload}\n\n` : `event: ${event}\ndata: ${payload}\n\n`);
    } catch {
      // 客户端已断开
    }
  };

  // EventBus — 统一 Agent Event 协议（SSE 新事件名 + activity_events 落库）
  const eventBus = createEventBus(
    db,
    (event, data) => {
      try {
        reply.raw.write(`event: ${event}\ndata: ${data}\n\n`);
      } catch {
        // 客户端已断开
      }
    },
    saveDb,
  );

  // P0-02/P0-03: clientAbort 支持外部传入（上层 Run 生命周期共享同一个 AbortController，
  // 确保 registry.cancel(runId) 与 SSE 传输共用同一信号源）
  const clientAbort = options.abortController ?? new AbortController();

  // 心跳
  const heartbeatInterval = startHeartbeat(reply);

  // 任务开始（只有真实会话才落库；anonymous 跳过，避免垃圾数据）
  // P0-02 修复：task.started 使用上层传入的 runTaskId（与 run.created/agent/tool 事件一致）
  // P1-08: task.started 为关键生命周期事件 —— 写失败显式抛错（运行起点不可丢）
  if (conversationId) {
    eventBus.emit(convId, 'task.started', {
      taskId: runTaskId,
      agentId: 'sisyphus',
      agentType: 'orchestrator',
      content: '', // 将在外部填充
    }, { critical: true });
  }

  return {
    reply,
    sseSend,
    eventBus,
    convId,
    runTaskId,
    clientAbort,
    heartbeatInterval,
  };
}

export function cleanupSse(ctx: SseContext, conversationId: string | undefined): void {
  if (ctx.heartbeatInterval) {
    clearInterval(ctx.heartbeatInterval);
  }
  if (conversationId) {
    // activeRequests cleanup is handled externally
  }
  try {
    ctx.reply.raw.end();
  } catch {
    // ignore
  }
}

export function sendErrorAndEnd(
  ctx: SseContext,
  error: unknown,
  conversationId: string | undefined,
  clientAbort: AbortController
): void {
  try {
    ctx.sseSend('error', JSON.stringify({ message: (error instanceof Error ? error.message : String(error)) || '内部错误' }));
  } catch {
    // ignore
  }
  if (conversationId && !clientAbort.signal.aborted) {
    try {
      ctx.eventBus.emit(ctx.convId, 'task.failed', {
        taskId: ctx.runTaskId,
        agentId: 'sisyphus',
        agentType: 'orchestrator',
        status: 'error',
        content: (error instanceof Error ? error.message : String(error)) || '内部错误',
      });
    } catch {
      // ignore
    }
  }
  try {
    ctx.sseSend('message', '[DONE]');
  } catch {
    // ignore
  }
  try {
    ctx.reply.raw.end();
  } catch {
    // ignore
  }
}