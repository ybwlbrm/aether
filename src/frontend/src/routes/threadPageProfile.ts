/**
 * T24 · ThreadPage 的能力档案（适配层）。
 *
 * ## 为什么独立成文件
 * `ThreadPage.tsx` 承载接线（hook → JSX），档案承载**决策**（这个表面开哪些能力）。
 * 两者混在一起时，"两条路由的能力差异"要靠横向对比几百行接线才能读出来；
 * 拆开后差异就是本文件里两个字面量的逐字段 diff —— 这正是 T16 要求的"每个 flag 都对应
 * 一处既有真实行为"能被审计的前提。
 *
 * ## 与 T16 的边界（不改已验收产物）
 * `ThreadCapabilities`（threadContract）是控制器的词汇表，本任务**一行不动**。
 * CodingHome 的页面级能力里还有五项**不进控制器**：语音（T11）、附件（T12）、
 * 模型选择（T13）、远程命令（T14）、权限等级。它们记在 `ThreadPageProfile` 的
 * 布尔字段里，由页面在渲染期逐个接线 —— 两个词汇表互不污染。
 */
import type { ThreadCapabilities } from '../hooks/useThreadController';

/**
 * 页面级能力档案。
 *
 * `capabilities` 是 T16 的词汇表；其余开关是**不进控制器**的页面能力，
 * 每一个都对应 CodingHome/Chat 的一处既有真实行为，不存在"为了配置而配置"的项。
 */
export interface ThreadPageProfile {
  /** 注入 T16 的能力集（运行时态 attachments / selectedProvider 由 hook 现填） */
  readonly capabilities: ThreadCapabilities;
  /** 语音输入（T11 useVoiceInput，经 T18 VoiceButton 渲染） */
  readonly voice: boolean;
  /** 附件（T12 useAttachments + T18 AttachmentTray） */
  readonly attachment: boolean;
  /** 模型选择（T13 useProviderSelection + T18 ProviderSelect） */
  readonly providerSelect: boolean;
  /** 远程命令宿主（T14 useRemoteCommandHost） */
  readonly remoteCommand: boolean;
  /** 权限等级循环（api.setPermissions） */
  readonly permissionLevel: boolean;
  /** 无 ?q 时是否自动新建一条会话（Chat 的 handleNew） */
  readonly autoSelectConversation: boolean;
  /** URL 意图回写目标（replaceState 的落点，必须与路由一致） */
  readonly homePath: string;
  /** 页头 */
  readonly title: string;
  readonly description: string;
  /** 线程空态提示语 */
  readonly emptyHint: string;
  /** 载入附件后的收尾动作（关掉 plus 菜单） */
  readonly onAttachmentPicked: 'close-plus' | 'none';
}

/** `/command-center`：全能力（CodingHome 的既有行为逐项保留） */
export const WORKBENCH_PROFILE: ThreadPageProfile = {
  capabilities: {
    deepThinking: false,
    loopMode: false,
    webSearch: true,
    attachments: [],
    selectedProvider: null,
    selectedModel: undefined,
    pollIntervalMs: 1000,
    pollActivityEvents: false,
    activityCursor: false,
    pollLiveReasoning: false,
    pollSyncsThinking: false,
    pollTokenTotal: 'max',
    inlineConversationList: false,
    refreshSidebarOnSendEnd: true,
    sisyphusDeepLink: false,
    promptTemplates: false,
    reasoningBar: false,
  },
  voice: true,
  attachment: true,
  providerSelect: true,
  remoteCommand: true,
  permissionLevel: true,
  autoSelectConversation: false,
  homePath: '/command-center',
  title: 'Aether',
  description: 'Describe your idea — vibe code it into reality.',
  emptyHint: 'What can I build for you? 描述你的想法 —— Aether 会把它变成现实。',
  onAttachmentPicked: 'close-plus',
};

/** `/chat`：最小能力 + 内联会话列表（Chat 的既有行为） */
export const CHAT_PROFILE: ThreadPageProfile = {
  capabilities: {
    deepThinking: false,
    loopMode: false,
    webSearch: true,
    attachments: [],
    selectedProvider: null,
    selectedModel: undefined,
    pollIntervalMs: 2000,
    pollActivityEvents: true,
    activityCursor: true,
    pollLiveReasoning: true,
    pollSyncsThinking: true,
    pollTokenTotal: 'replace',
    inlineConversationList: true,
    refreshSidebarOnSendEnd: false,
    sisyphusDeepLink: true,
    promptTemplates: true,
    reasoningBar: true,
  },
  voice: false,
  attachment: false,
  providerSelect: false,
  remoteCommand: false,
  permissionLevel: true,
  autoSelectConversation: true,
  homePath: '/chat',
  title: '对话',
  description: '与 AI 助手交流，管理多轮对话',
  emptyHint: '选择一个对话或新建一个 —— 与 AI 助手交流，完成任务。',
  onAttachmentPicked: 'none',
};

export type ThreadPageVariant = 'workbench' | 'chat';

export const THREAD_PAGE_PROFILES: Readonly<Record<ThreadPageVariant, ThreadPageProfile>> = {
  workbench: WORKBENCH_PROFILE,
  chat: CHAT_PROFILE,
};

// 能力关闭时的稳定替身：引用恒定，因此 useRemoteCommandHost 的 effect 不会每次渲染重订阅
export const IGNORE_USER_COMMAND = (): void => {};
export const IGNORE_OPEN_CONVERSATION = async (): Promise<void> => {};
export const IGNORE_FAILURE = (): void => {};

/** 权限等级的推进（1 → 2 → 3 → 1），与旧 ComposerToolbar 的循环语义一致 */
export function nextPermissionLevel(level: number): number {
  return level >= 3 ? 1 : level + 1;
}
