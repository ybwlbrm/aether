/**
 * ask-user 交互审批 — 对齐 DeepSeek Harness `packages/interaction` 的 approval 语义。
 *
 * 机制：
 * - 工具执行前若需用户确认（敏感操作 + 权限级别要求），产生一个 pending approval；
 * - 通过回调把「需要确认」事件推给前端（SSE），后端挂起 await 该 approval；
 * - 前端用户确认/拒绝后 POST 回决定，resolve/reject 挂起的执行；
 * - 超时（默认 60s）自动拒绝，防止前端失联导致执行永久挂起。
 *
 * 本模块为无状态库：approval 表由调用方（executeTool 路径）持有。
 */

export type ApprovalDecision = 'approved' | 'rejected' | 'timeout';

export interface ApprovalRequest {
  /** 全局唯一 approval id */
  id: string;
  /** 工具名 */
  toolName: string;
  /** 工具参数摘要（展示用） */
  argsSummary: string;
  /** 创建时间 */
  createdAt: number;
  /** 等待决议的时间上限（ms） */
  timeoutMs: number;
  /** 决议回调（含超时决议） */
  onDecision: (decision: ApprovalDecision) => void;
  /** 内部清理器 */
  cleanup: () => void;
}

export interface ApprovalToken {
  /** 结束等待并给出决议（approved/rejected）；超时会自动调用 timeout） */
  settle: (decision: 'approved' | 'rejected') => void;
  dispose: () => void;
}

/**
 * 创建一次审批：立即触发 prompt（SSE 事件），等待 settle/timeout。
 * @returns 承诺：返回 { approved: boolean, decision }；被拒绝或超时 resolves false（不 throw）。
 */
export function createApproval(opts: {
  id: string;
  toolName: string;
  argsSummary: string;
  /** 触发前端「需要确认」事件 */
  prompt: () => void;
  timeoutMs?: number;
}): { request: ApprovalRequest; token: ApprovalToken; promise: Promise<{ approved: boolean; decision: ApprovalDecision }> } {
  const timeoutMs = opts.timeoutMs ?? 60_000;

  let settle: (d: 'approved' | 'rejected') => void = () => {};
  let cleanup: () => void = () => {};
  const promise = new Promise<{ approved: boolean; decision: ApprovalDecision }>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ approved: false, decision: 'timeout' });
      cleanup = () => {};
    }, timeoutMs);

    settle = (d: 'approved' | 'rejected') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      cleanup = () => {};
      resolve({ approved: d === 'approved', decision: d });
    };
    cleanup = () => clearTimeout(timer);
  });

  // 触发前端提示（在 promise 建立后立即发出）
  opts.prompt();

  const request: ApprovalRequest = {
    id: opts.id,
    toolName: opts.toolName,
    argsSummary: opts.argsSummary,
    createdAt: Date.now(),
    timeoutMs,
    onDecision: (d) => settle(d === 'approved' ? 'approved' : d === 'rejected' ? 'rejected' : 'rejected'),
    cleanup,
  };

  return {
    request,
    token: {
      settle: (d) => settle(d),
      dispose: () => cleanup(),
    },
    promise,
  };
}

/** 从参数对象生成展示摘要 */
export function summarizeArgs(args: Record<string, unknown>, max = 120): string {
  if (!args || Object.keys(args).length === 0) return '(无参数)';
  const preview = Object.entries(args)
    .slice(0, 3)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 60) : JSON.stringify(v).slice(0, 60)}`)
    .join(', ');
  return preview.length > max ? preview.slice(0, max) + '…' : preview;
}

/** 判断工具是否需要用户确认（Level 1 只读模式 + 敏感操作） */
export function requiresApproval(toolName: string, permissionLevel: number): boolean {
  if (permissionLevel !== 1) return false; // Level 2/3 不拦截（对齐现有文件/MCP 语义）
  const SENSITIVE = new Set([
    'execute_command', 'write_file', 'edit_file', 'delete_file',
    'create_directory', 'web_fetch',
  ]);
  return SENSITIVE.has(toolName);
}

/** 持久键（sql.js 场景由调用方决定；此处仅生成 stable id 前缀便于排查） */
export function approvalKey(id: string): string {
  return `approval:${id}`;
}