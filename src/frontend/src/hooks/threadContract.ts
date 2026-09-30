/**
 * T16 · 会话编排的**词汇表与边界**：类型契约 + 外来 payload 的唯一解析入口。
 *
 * 拆分的理由：本仓库既有约定是"契约源头在 X，消费者仅 re-export"（见 routes/CodingHome.tsx
 * 对 hooks/useRemoteCommandHost 的处理）。编排核心与 React 绑定都只消费这里的类型与解析函数，
 * 因此三者不可能各自长出一份形状。
 */
import type { StreamSendOptions } from './useStreamSend';
import type { ProviderOption } from './useProviderSelection';
import type { MutableRefObject } from 'react';
import type { ApprovalRequest, ApprovalSnapshot } from './threadApproval';
import type { StreamFailure } from './useStreamSend';

/** provider 形状直接取自 useStreamSend 的声明：形状永不走样（Chat 曾把它标成 any 绕过） */
export type ThreadStreamProvider = StreamSendOptions['selectedProvider'];

/** 会话消息（边界解析后的唯一形状） */
export interface ThreadMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly createdAt: string;
  readonly reasoning?: string | null;
  readonly toolCalls?: string | null;
}

/** 循环模式指标（来自 activityStore 终态事件） */
export interface ThreadLoopMetrics {
  readonly turnsUsed: number;
  readonly elapsedMs: number;
  readonly toolCalls: number;
  readonly budgetExceeded: string | null;
}

/**
 * 每条路由的配置。**每个 flag 都对应一处既有真实行为**，不存在"为了配置而配置"的开关。
 */
export interface ThreadCapabilities {
  // —— 发流参数（透传给 useStreamSend）——
  readonly deepThinking: boolean;
  readonly loopMode: boolean;
  readonly webSearch: boolean;
  readonly attachments: NonNullable<StreamSendOptions['attachments']>;
  readonly selectedProvider: ThreadStreamProvider;
  readonly selectedModel: string | undefined;
  // —— 轮询接线 ——
  /** 消息轮询间隔（Chat 2000 / CodingHome 1000） */
  readonly pollIntervalMs: number;
  /** 是否同时轮询 Activity 事件（Chat 回放活动流，CodingHome 不轮询） */
  readonly pollActivityEvents: boolean;
  /** Activity 游标取 activityStore.getLastSeq（会话内单调序号，必须取全会话最大值） */
  readonly activityCursor: boolean;
  /** 轮询到的最新消息 reasoning 是否参与渲染（Chat 的 ReasoningBar） */
  readonly pollLiveReasoning: boolean;
  /** 轮询 generating 时是否同步 thinking（Chat 同步两者，CodingHome 只同步 sending） */
  readonly pollSyncsThinking: boolean;
  /** 轮询 tokenTotal 的合并方式 */
  readonly pollTokenTotal: 'replace' | 'max';
  // —— 会话生命周期 ——
  /** 会话列表由页面内联渲染（Chat）；否则列表归 Layout 侧栏，页面只报错误 */
  readonly inlineConversationList: boolean;
  /** 发送成功后派发 conversations-changed，驱动侧栏刷新（CodingHome） */
  readonly refreshSidebarOnSendEnd: boolean;
  /** URL 直达 ?q 走 Sisyphus 一次性回复（Chat） */
  readonly sisyphusDeepLink: boolean;
  /** 提示词模板选择器（Chat） */
  readonly promptTemplates: boolean;
  /** 活跃 reasoning 渲染（Chat 的 ReasoningBar） */
  readonly reasoningBar: boolean;
}

/** 会话列表端口：两条路由的列表所有权不同，故抽象成端口而不是各自持一份列表 */
export interface ThreadConversationsPort {
  /** 刷新会话列表（内联 = useConversations.load；侧栏 = 只校验并把错误报给 loadError） */
  readonly refresh: () => Promise<void>;
  /** 新建会话（仅 autoSelectConversation 引导需要；无引导的路由不提供） */
  readonly create?: (providers: readonly ProviderOption[]) => Promise<void>;
}

/** 流端口：useStreamSend 的 10 字段中，控制器真正需要的 4 个 */
export interface ThreadStreamPort {
  readonly send: (content?: string) => Promise<void>;
  /** v1 停止车道：abort in-flight 流 + cancelConversation + cancelAgentGeneration + 复位 */
  readonly stop: () => void;
  readonly setSending: (value: boolean) => void;
  readonly setThinking: (value: boolean) => void;
}

/** 控制器对外状态（stream / poll 字段由 hook 从 useStreamSend、useMessagePolling 汇入） */
export interface ThreadState {
  readonly conversationId: string | null;
  readonly messages: ThreadMessage[];
  readonly tokenTotal: number;
  readonly loadError: string | null;
  /** 非流式失败（远程命令 / 语音 / URL 直达），渲染时取 failure ?? directFailure */
  readonly directFailure: StreamFailure | null;
  readonly loopMetrics: ThreadLoopMetrics | null;
  readonly pendingApproval: ApprovalRequest | null;
  readonly approvalError: string | null;
  /** 轮询回读到的最新消息 reasoning（SSE 之外的服务端真相，刷新页面后才有） */
  readonly polledReasoning: string;
}

/** 状态补丁：字段级更新（去掉 readonly，字段集合与取值类型仍由 ThreadState 约束） */
export type ThreadStatePatch = { -readonly [K in keyof ThreadState]?: ThreadState[K] };

/** 审批快照（re-export 契约，供路由只依赖本模块） */
export type { ApprovalRequest, ApprovalSnapshot };

/** 竞态守卫用的 refs：会话 id 与 AbortController 必须是 ref（useStreamSend 的守卫读 ref） */
export interface ThreadRefs {
  readonly currentConv: MutableRefObject<string | null>;
  readonly abort: MutableRefObject<AbortController | null>;
  readonly mounted: MutableRefObject<boolean>;
  readonly msgPollReqId: MutableRefObject<number>;
  readonly activityPollReqId: MutableRefObject<number>;
}

export interface ThreadControllerConfig {
  readonly capabilities: ThreadCapabilities;
  readonly providers: readonly ProviderOption[];
  readonly autoSelectConversation: boolean;
}

export interface ThreadController {
  readonly getState: () => ThreadState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly refs: ThreadRefs;
  /** 渲染期调用：把本轮配置喂进来（配置随 provider 载入而变化，不能冻在创建时） */
  readonly configure: (config: ThreadControllerConfig) => void;
  /** 渲染期调用：注入 useStreamSend 的 4 个方法（控制器必须在 useStreamSend 之后绑定） */
  readonly bindStream: (port: ThreadStreamPort) => void;
  /** 订阅 activityStore：审批与循环指标都从事件流派生 */
  readonly subscribeActivity: () => () => void;
  // —— 动作 ——
  readonly setActiveConversation: (id: string | null) => void;
  readonly loadMessages: (id: string) => Promise<void>;
  readonly loadConversations: () => Promise<void>;
  readonly clearThread: () => void;
  readonly send: (content: string) => Promise<void>;
  readonly stop: () => void;
  readonly decideApproval: (ok: boolean) => Promise<void>;
  readonly setMessages: (updater: (prev: ThreadMessage[]) => ThreadMessage[]) => void;
  readonly noteSendStart: () => void;
  readonly noteSendEnd: (success: boolean) => void;
  readonly notePolled: (patch: { reasoning?: string; tokenTotal?: number; sending?: boolean }) => void;
  readonly reportError: (message: string | null) => void;
  readonly reportFailure: (failure: StreamFailure | null) => void;
  readonly appendUserMessage: (content: string) => void;
  readonly cancelStaleGeneration: () => void;
  readonly bootstrap: (search: string, homePath: string) => Promise<void>;
}

// ============================================================
// 边界：外来 payload 一律经此收窄，内部不再复验
// ============================================================

function toRole(value: unknown): ThreadMessage['role'] {
  return value === 'assistant' || value === 'tool' ? value : 'user';
}

/** 从 toolResults JSON 提取 reasoning（非 JSON / 无字段一律视为无 reasoning） */
function readReasoning(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const reasoning = (parsed as { readonly reasoning?: unknown }).reasoning;
    return typeof reasoning === 'string' && reasoning !== '' ? reasoning : null;
  } catch { return null; }
}

export function parseThreadMessages(value: unknown): ThreadMessage[] {
  if (!Array.isArray(value)) return [];
  const out: ThreadMessage[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const m = raw as Record<string, unknown>;
    out.push({
      id: typeof m.id === 'string' ? m.id : '',
      role: toRole(m.role),
      content: typeof m.content === 'string' ? m.content : '',
      createdAt: typeof m.createdAt === 'string' ? m.createdAt : '',
      reasoning: typeof m.reasoning === 'string' ? m.reasoning : readReasoning(m.toolResults),
      toolCalls: typeof m.toolCalls === 'string' ? m.toolCalls : null,
    });
  }
  return out;
}

/** 读对象上的一个字符串字段（api 返回 any，此处做结构化收窄） */
export function readField(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === 'string' && raw !== '' ? raw : null;
}

/** 读对象上的数组字段 */
export function readFieldList(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return [];
  return (value as Record<string, unknown>)[key];
}

/** 读对象上的数字字段 */
export function readNumberField(value: unknown, key: string): number | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/**
 * 引用稳定是 useSyncExternalStore 的前提：无变化时不得产生新 state 对象（否则每轮轮询
 * 都多一次渲染）。逐字段比较，字段集合与 ThreadState 一一对应。
 */
export function isSameState(a: ThreadState, b: ThreadState): boolean {
  return a.conversationId === b.conversationId
    && a.messages === b.messages
    && a.tokenTotal === b.tokenTotal
    && a.loadError === b.loadError
    && a.directFailure === b.directFailure
    && a.loopMetrics === b.loopMetrics
    && a.pendingApproval === b.pendingApproval
    && a.approvalError === b.approvalError
    && a.polledReasoning === b.polledReasoning;
}

/**
 * 消息列表的无变化检测。
 * 轮询每秒一次而消息通常不变 —— 此时必须沿用同一个数组引用，否则每轮都产生新 state，
 * 滚动 effect 被反复触发（与 useMessagePolling 合并逻辑里的同款约束）。
 */
export function isSameMessages(a: ThreadMessage[], b: ThreadMessage[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((message, index) => {
    const other = b[index];
    return other !== undefined
      && message.id === other.id
      && message.role === other.role
      && message.content === other.content
      && message.createdAt === other.createdAt
      && message.reasoning === other.reasoning
      && message.toolCalls === other.toolCalls;
  });
}
