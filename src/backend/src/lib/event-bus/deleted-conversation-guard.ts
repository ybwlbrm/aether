/**
 * Deleted Conversation Guard — AEX-P0-21
 *
 * 会话删除后，任何仍在后台运行的执行线程（Run/Task/Event emitter）都不得
 * 再向已删除的 conversation 写入 message/event/activity。此前取消是"尽力而为"
 * （abort signal），不观察 abort 的 run 或排队中的迟到事件仍会写入 activity_events，
 * 形成"删除后复活"的幽灵数据。
 *
 * 本模块提供进程内注册表：删除路由在级联删除前登记；event sink 写入前检查。
 * 命中 guard 的事件被丢弃（best-effort 语义，非 critical 不抛错），避免 FK
 * 失败异常打断事件发射链。
 */

/** 已删除的 conversationId 集合（模块级，进程生命周期内有效） */
const deletedConversations = new Set<string>()

/** 登记一个已删除的会话（删除路由在 cascade delete 前调用） */
export function markConversationDeleted(conversationId: string): void {
  deletedConversations.add(conversationId)
}

/** 会话是否已删除（event sink 写入前检查） */
export function isConversationDeleted(conversationId: string): boolean {
  return deletedConversations.has(conversationId)
}

/** 解除登记（撤销删除 / 测试隔离；一般不会在生产路径调用） */
export function unmarkConversationDeleted(conversationId: string): void {
  deletedConversations.delete(conversationId)
}

/** 清空全部登记（测试隔离） */
export function clearDeletedConversations(): void {
  deletedConversations.clear()
}
