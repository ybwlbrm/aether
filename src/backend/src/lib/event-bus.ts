/**
 * EventBus — Agent Activity Event 的统一发射点（SSE 推送 + 数据库落库）
 *
 * 设计要点（对齐 DeepSeek Harness 的 event-sourced session）：
 * - 会话的事件日志是唯一事实源；SSE 只是实时投递通道，数据库保存可回放日志
 * - seq 在会话内单调递增，由本模块唯一分配，杜绝并发重复
 * - 业务代码只需调用 emit()，无需关心写盘与推送细节
 * - chunk-rows 打包（对齐 harness）：高频 delta 事件（reasoning/message/output）
 *   落库前按「会话+类型」聚合为打包行，减少行数（存储行 ≠ 会话事件）；回放时解包
 *   为完整事件序列。SSE 实时投递不受打包影响。
 */
// Re-export all public API from split modules
export * from './event-bus/index.js';