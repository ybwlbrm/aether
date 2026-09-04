/**
 * Inbox 指令队列 — 参考 DeepSeek Harness `packages/core/agent/src/inbox.ts` 的 followup/steer 语义。
 *
 * 能力：任务运行中，用户可随时通过补充指令（directive）干预当前生成流程——
 * - followup：把指令作为一条 user 消息注入到 Agent 的下一轮上下文（不会打断当前轮，下轮生效）；
 * - steer：任务里改变方向（本实现与 followup 共享注入点：下一轮 fc-loop 前 drain）。
 *
 * 实现：sessionId → string[] 队列。业务方（conversations/agents）在进入 while(fcTurns)
 * 前 drain 全部待办指令并作为 user 消息 push 进 apiMessages；端口语义由事件
 * `agent.inbox.directive` 向前端广播已收到的指令。
 */
import { randomUUID } from 'node:crypto';

/** 会话级待办指令队列 */
const inboxQueue = new Map<string, Array<{ id: string; text: string }>>();

/** 往会话 inbox 投递一条补充指令（返回指令 id） */
export function pushDirective(sessionId: string, text: string): { id: string; text: string } {
  const item = { id: `dir-${randomUUID().slice(0, 8)}`, text: text.trim() };
  if (!item.text) return item;
  const list = inboxQueue.get(sessionId) ?? [];
  list.push(item);
  inboxQueue.set(sessionId, list);
  return item;
}

/** 取走某会话全部待办指令（drain 一次） */
export function drainDirectives(sessionId: string): Array<{ id: string; text: string }> {
  const list = inboxQueue.get(sessionId);
  if (!list || list.length === 0) return [];
  inboxQueue.delete(sessionId);
  return list;
}

/** 是否有待办指令 */
export function hasPendingDirectives(sessionId: string): boolean {
  return (inboxQueue.get(sessionId)?.length ?? 0) > 0;
}

/** 测试辅助：清空 */
export function clearInbox(sessionId?: string): void {
  if (sessionId) inboxQueue.delete(sessionId);
  else inboxQueue.clear();
}