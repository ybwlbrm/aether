/**
 * Chat —— `/chat` 路由的薄组合。
 *
 * ## T24：本文件为何只剩组合
 * 此前 Chat 自带一整套页面级接线（会话列表 / 流状态 / 审批 / 模板 / 权限工具条），
 * 与 CodingHome 并列维护两份。现在 `/chat` 只是 **ThreadPage 的 chat 能力档案**：
 * 最小能力集 + 内联会话列表，渲染的实现与 `/command-center` 逐行相同。
 * 行为差异全部集中在 `routes/ThreadPage.tsx` 的 `CHAT_PROFILE` 常量里。
 *
 * 保留 `ChatStreamFailure` 导出：既有 import 处（Chat.test.tsx）依赖这个名字。
 */
import { ThreadPage } from './ThreadPage';
import { StreamFailureState } from '../components/conversation';

/** 失败态渲染统一走共享 conversation 组件（保留既有导出名，避免调用方破坏） */
export const ChatStreamFailure = StreamFailureState;

export function Chat() {
  return <ThreadPage variant="chat" />;
}
