/** 节点执行的机器可读失败码（AEX-P0-017）—— 供引擎判定重试与前端展示 */
export type NodeFailureCode =
  | 'TOOL_ERROR'
  | 'TOOL_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'SECURITY_BLOCKED'
  | 'COMMAND_ERROR'
  | 'MEDIA_ERROR'
  | 'DOCUMENT_ERROR'
  | 'MODEL_ERROR'
  | 'NODE_UNSTRUCTURED_OUTPUT'
  | 'NODE_INVALID_RESULT'
  | (string & {});

export interface NodeExecutionResult {
  readonly output: string
  readonly data?: unknown
  /**
   * 结构化失败标志。历史上 tool/system 节点把失败写进 output 字符串而 error 留空，
   * 导致引擎判为 completed（AEX-P0-017）。error 非空即表示节点失败。
   */
  readonly error?: string
  /** 机器可读失败码（与 isToolRetryable 的 code 词表对齐） */
  readonly code?: NodeFailureCode
  /** 上游 HTTP 状态码（429/5xx 判为可重试） */
  readonly statusCode?: number
  /** 是否可重试；缺省时由引擎按 code/statusCode 推断 */
  readonly retryable?: boolean
}

export interface WorkflowNode {
  id: string;
  type: 'tool' | 'agent' | 'media' | 'document' | 'condition' | 'system';
  label: string;
  config: Record<string, unknown>;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  /**
   * §42 修复：条件边显式化 —— 不再依赖"第一条边=true / 第二条边=false"的隐式约定。
   * condition: 可选布尔表达式语义（'passed' = data.passed 为真时走此边；'failed' = 为假时走此边）。
   * 缺省 = 无条件（总是走此边）。
   */
  condition?: 'passed' | 'failed';
}

/** workflow_node_runs 表的对外投影（AEX-P0-015） */
export interface WorkflowNodeRun {
  nodeId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  attempt: number;
  retryCount: number;
  output?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}
