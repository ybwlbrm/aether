/**
 * Error Taxonomy — 错误分类与错误码常量表（AEX-P1-003 / P1-085）
 *
 * 本文件是 backend 错误码与错误分类的**唯一事实源**（见 docs/SOURCE_OF_TRUTH.md
 * §1「错误分类」行）。任何控制流判断必须写 `err.code === ErrorCode.MODEL_TIMEOUT`，
 * **禁止** `err.message.includes('timeout')`（P1-085：message 是给 人 看的文案，
 * code 是给程序看的契约；文案会改，契约不能改）。
 *
 * 表中的字面量全部沿用仓库里已经在跑的 wire 值（provider-adapter / retry-policy /
 * execution-retry / tool-executor 已硬编码的那些），因此引入常量表**不改变任何
 * 线上行为**，只是把散落的字面量收敂到一处。
 *
 * Transport-agnostic：纯 TypeScript，零运行时依赖。
 */

/**
 * 错误分类。
 *
 * 规范要求的 5 个分类：`model` / `tool` / `execution` / `workflow` / `sync`。
 * 第 6 个 `runtime` 是**向后兼容桶**：仓库里约 25 处 legacy `RuntimeError`
 * 抛点（TOOL_EXISTS / sequence 分配 / checkpoint / permissions / artifacts /
 * agents …）并不属于上述任何一类，把它们硬塞进 5 个分类里是撒谎；保留
 * `runtime` 让它们显式地"未分类"，比伪造分类更诚实。收敛到具体分类是后续
 * P2 的迁移工作，不在本次范围内。
 */
export const ERROR_CATEGORIES = [
  'model',
  'tool',
  'execution',
  'workflow',
  'sync',
  'runtime',
] as const

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number]

/**
 * 统一错误码常量表。
 *
 * 用 `const` + 同名 `type`（而非 `enum`）导出：
 * - 值侧：`ErrorCode.MODEL_TIMEOUT` 得到字面量类型 `'MODEL_TIMEOUT'`
 * - 类型侧：`code: ErrorCode` 得到可穷尽的联合类型
 * 这样新增一个错误码时，未处理它的 `switch` 会在编译期报错（穷尽性由类型系统
 * 保证），而 `enum` 做不到。
 */
export const ErrorCode = {
  // ── Model 层 ────────────────────────────────────────────────────────────
  /** ModelError 基类默认码 */
  MODEL_ERROR: 'MODEL_ERROR',
  /** 可重试的模型瞬时故障（网络抖动、5xx、熔断冷却后恢复） */
  MODEL_TRANSIENT: 'MODEL_TRANSIENT',
  /** 不可重试的模型永久故障（鉴权失败、上下文超限、请求非法） */
  MODEL_PERMANENT: 'MODEL_PERMANENT',
  /** 模型请求超时 */
  MODEL_TIMEOUT: 'MODEL_TIMEOUT',
  /**
   * 流被截断 / 连接重置（EOF 未见 `[DONE]` 或 `finish_reason`）。
   *
   * 注意：wire 值沿用既有的 `'STREAM_CLOSED'` 字面量——`retry-policy.ts` 的
   * `defaultRetryable` 与 `execution-retry.ts` 的 `RETRYABLE_TOOL_CODES` 都按
   * 这个字面量分类。规范名是 `MODEL_STREAM_CLOSED`，wire 值不能改（会静默
   * 改变重试行为），所以这里让常量名对齐规范、值对齐既有契约。
   */
  MODEL_STREAM_CLOSED: 'STREAM_CLOSED',
  /** Provider 429 限流 */
  RATE_LIMIT: 'RATE_LIMIT',
  /** Provider 5xx / 不可用 */
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  /** 出站网络错误 */
  NETWORK_ERROR: 'NETWORK_ERROR',
  /** 熔断器打开（连续失败达阈值，暂拒请求） */
  CIRCUIT_OPEN: 'CIRCUIT_OPEN',
  /** Provider 鉴权失败 */
  AUTH: 'AUTH',
  /** 上下文窗口超限 */
  CONTEXT_WINDOW: 'CONTEXT_WINDOW',
  /** Provider 凭据无法解密（DPAPI 派生密钥不匹配 / 密文损坏） */
  PROVIDER_CREDENTIAL_ERROR: 'PROVIDER_CREDENTIAL_ERROR',

  // ── Tool 层 ─────────────────────────────────────────────────────────────
  /** ToolError 基类默认码 */
  TOOL_ERROR: 'TOOL_ERROR',
  /** 可重试的工具瞬时故障 */
  TOOL_TRANSIENT: 'TOOL_TRANSIENT',
  /** 不可重试的工具永久故障（参数非法、权限拒绝、文件不存在） */
  TOOL_PERMANENT: 'TOOL_PERMANENT',
  /** 工具执行超时 */
  TOOL_TIMEOUT: 'TOOL_TIMEOUT',
  /** 工具执行被取消（Run cancel / 上游 abort） */
  TOOL_CANCELLED: 'TOOL_CANCELLED',
  /** 工具未注册 */
  TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',
  /** 工具被权限策略拒绝 */
  TOOL_DENIED: 'TOOL_DENIED',
  /** 工具注册重名 */
  TOOL_EXISTS: 'TOOL_EXISTS',
  /** 工具入参非法 */
  INVALID_INPUT: 'INVALID_INPUT',

  // ── Execution 层 ────────────────────────────────────────────────────────
  /** ExecutionError 基类默认码 */
  EXECUTION_ERROR: 'EXECUTION_ERROR',
  /** 验证未通过（判定不通过 → 不可重试；验证未完成 → 可重试，见 VerificationError.verdict） */
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
  /** 预算耗尽（token / 金额 / 时长）——终态 */
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  /** 单次尝试失败（多尝试循环中的一次） */
  ATTEMPT_FAILED: 'ATTEMPT_FAILED',
  /** 进入重试（信号语义） */
  RETRY_ERROR: 'RETRY_ERROR',
  /** 重试次数耗尽——终态 */
  RETRY_EXHAUSTED: 'RETRY_EXHAUSTED',

  // ── Workflow 层 ─────────────────────────────────────────────────────────
  /** WorkflowError 默认码（节点图非法、节点执行失败等） */
  WORKFLOW_ERROR: 'WORKFLOW_ERROR',

  // ── Sync 层 ─────────────────────────────────────────────────────────────
  /** SyncError 默认码（云同步冲突 / 推送失败 / 远端命令下发失败） */
  SYNC_ERROR: 'SYNC_ERROR',
} as const

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]
