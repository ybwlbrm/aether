/**
 * 统一消息模型 + merge 算法（§5 / §12 / §13 / §78）
 *
 * 所有 Mobile Chat 只使用这一套消息结构：
 *   id / role / content / created_at / tool_calls / tool_results
 * 角色：user / assistant / tool / system
 *
 * mergeMessages() 是唯一的消息合并入口：
 *   1. 按 id 去重
 *   2. 已存在 id → 更新内容（Streaming UPDATE 不产生重复）
 *   3. 新消息插入
 *   4. 按 created_at 升序排序（同秒按 id 二级排序，保证确定性）
 *
 * 消息来源统一走本函数：初始历史 / Realtime INSERT / Realtime UPDATE /
 * polling / optimistic message replacement。
 */

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

/** 统一消息结构（对应 messages_sync 行 + 本地乐观消息） */
export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  created_at: string;
  tool_calls?: string | null;
  tool_results?: string | null;
}

/** 本地乐观消息的发送状态（§9） */
export type LocalMessageState = 'sending' | 'queued' | 'sent' | 'failed';

/**
 * 消息排序：created_at 升序；同秒按 id 升序（确定性）。
 * 不依赖 Realtime/polling/state 到达顺序。
 */
export function compareMessages(a: ChatMessage, b: ChatMessage): number {
  const ta = new Date(a.created_at).getTime();
  const tb = new Date(b.created_at).getTime();
  if (ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 单条合并：已存在则覆盖（保留原位置），否则追加 */
export function upsertMessage(list: ChatMessage[], incoming: ChatMessage): ChatMessage[] {
  const idx = list.findIndex((m) => m.id === incoming.id);
  if (idx !== -1) {
    const next = list.slice();
    next[idx] = incoming;
    return next;
  }
  return [...list, incoming];
}

/**
 * 批量合并 + 排序（统一入口）。
 * @param existing 当前消息列表
 * @param incoming 新到的消息（可能包含已存在 id 的更新）
 * @param opts.sort 是否排序（默认 true；纯增量流式更新可传 false 提效，但最终应排序）
 */
export function mergeMessages(
  existing: ChatMessage[],
  incoming: ChatMessage[],
  opts: { sort?: boolean } = {},
): ChatMessage[] {
  const sort = opts.sort ?? true;
  const byId = new Map<string, ChatMessage>();
  for (const m of existing) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m); // 后到覆盖，天然去重
  const merged = Array.from(byId.values());
  return sort ? merged.sort(compareMessages) : merged;
}

/** 乐观消息替换：用真实消息替换 temp-/queued- 前缀的本地占位 */
export function replaceOptimistic(
  list: ChatMessage[],
  real: ChatMessage,
  optimisticIdPrefix: string = 'temp-',
): ChatMessage[] {
  const tempIdx = list.findIndex((m) => m.id.startsWith(optimisticIdPrefix));
  if (tempIdx !== -1) {
    const next = list.slice();
    next[tempIdx] = real;
    return next.sort(compareMessages);
  }
  return mergeMessages(list, [real]);
}

/**
 * 判断「当前请求」是否已有对应 assistant 产出（§14）。
 * 通过绑定 activeCommandId / 该命令对应的 conversation 最后一条 assistant
 * 的 created_at 是否晚于用户消息来判断 —— 不允许看到历史 assistant 就误判完成。
 */
export function hasAssistantAfter(
  list: ChatMessage[],
  userMsgCreatedAt: string,
): boolean {
  const userTs = new Date(userMsgCreatedAt).getTime();
  return list.some(
    (m) =>
      m.role === 'assistant' &&
      new Date(m.created_at).getTime() >= userTs,
  );
}
