/**
 * T16 `useThreadController` —— 会话编排的唯一入口（Chat / CodingHome 共用）。
 *
 * ## 三层结构（每层一个文件，契约源头唯一）
 * - `threadContract.ts` —— 词汇表与边界解析（类型 + payload 收窄）
 * - `threadCore.ts` —— 控制器核心（与 React 解耦，可直接单测；useThreadController.test.ts 测它）
 * - `useThreadController.ts`（本文件）—— 极薄 React 绑定：把 useStreamSend / useMessagePolling
 *   接进控制器，并把两者的状态原样透出
 *
 * ## 单一状态源
 * `sending/thinking/streamTokens/retryInfo/liveReasoning` 全部来自 `useStreamSend`，
 * 本模块**不持有副本**；控制器只用它的 4 个方法（handleSend / stopGeneration /
 * setSending / setThinking）。setSending/setThinking 之所以必需，见 threadCore.ts 不变量 1。
 *
 * ## 为什么拆出 useComposerState 的答案是"不需要"
 * 输入区状态（input / plusMenu / 录音 / 附件 / provider 选择）由既有的 useVoiceInput、
 * useAttachments、useProviderSelection 三个 hook 分别拥有，页面只做转发；再包一层
 * useComposerState 只会把 props 搬家，不产生新行为。
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { useMessagePolling, type PollErrorInfo, type PollStatus } from './useMessagePolling';
import { useStreamSend, type StreamFailure, type UseStreamSendReturn } from './useStreamSend';
import type { ProviderOption } from './useProviderSelection';
import { useActivityStore } from '../store/activityStore';
import { createThreadController } from './threadCore';
import type {
  ThreadCapabilities,
  ThreadController,
  ThreadConversationsPort,
  ThreadMessage,
  ThreadState,
} from './threadContract';

// 契约源头分散在三个文件 —— 此处汇总 re-export，调用点只需认识 useThreadController
export { createThreadController } from './threadCore';
export { extractApprovalRequest, type ApprovalRequest, type ApprovalSnapshot } from './threadApproval';
export {
  parseThreadMessages,
  type ThreadCapabilities,
  type ThreadController,
  type ThreadControllerConfig,
  type ThreadConversationsPort,
  type ThreadLoopMetrics,
  type ThreadMessage,
  type ThreadRefs,
  type ThreadState,
  type ThreadStreamPort,
  type ThreadStreamProvider,
} from './threadContract';

export interface UseThreadControllerOptions {
  readonly capabilities: ThreadCapabilities;
  /** 初始会话（创建时消费）；之后的切换一律走 setActiveConversation / loadMessages / clearThread */
  readonly conversationId: string | null;
  readonly mode: 'normal' | 'super';
  readonly providers: readonly ProviderOption[];
  readonly autoSelectConversation: boolean;
  readonly conversations: ThreadConversationsPort;
}

export interface UseThreadControllerResult extends ThreadState {
  readonly sending: boolean;
  readonly thinking: boolean;
  readonly streamTokens: UseStreamSendReturn['streamTokens'];
  readonly retryInfo: UseStreamSendReturn['retryInfo'];
  /** SSE 活跃 reasoning 优先，回落轮询回读值（刷新页面后没有 SSE） */
  readonly liveReasoning: string;
  readonly failure: StreamFailure | null;
  readonly pollStatus: PollStatus;
  readonly pollErrorInfo: PollErrorInfo | null;
  readonly send: (content: string) => Promise<void>;
  readonly stop: () => void;
  readonly retryPolling: () => void;
  readonly decideApproval: (ok: boolean) => Promise<void>;
  readonly setActiveConversation: (id: string | null) => void;
  readonly loadMessages: (id: string) => Promise<void>;
  readonly loadConversations: () => Promise<void>;
  readonly clearThread: () => void;
  readonly reportError: (message: string | null) => void;
  readonly reportFailure: (failure: StreamFailure | null) => void;
  readonly appendUserMessage: (content: string) => void;
  readonly cancelStaleGeneration: () => void;
  readonly bootstrap: (search: string, homePath: string) => Promise<void>;
}

export function useThreadController(options: UseThreadControllerOptions): UseThreadControllerResult {
  const { capabilities, conversationId, mode, providers, autoSelectConversation, conversations } = options;
  const controllerRef = useRef<ThreadController | null>(null);
  controllerRef.current ??= createThreadController(
    { capabilities, providers, autoSelectConversation },
    conversations,
    conversationId,
  );
  const controller = controllerRef.current;
  // 渲染期接线：配置随 provider 载入而变化，不能冻在创建时
  controller.configure({ capabilities, providers, autoSelectConversation });
  const thread = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);

  const stream = useStreamSend({
    conversationId: thread.conversationId,
    mode,
    messages: thread.messages,
    deepThinking: capabilities.deepThinking,
    webSearch: capabilities.webSearch,
    loopMode: capabilities.loopMode,
    selectedProvider: capabilities.selectedProvider,
    selectedModel: capabilities.selectedModel,
    attachments: capabilities.attachments,
    onSendStart: () => { controller.noteSendStart(); },
    onSendEnd: (success) => { controller.noteSendEnd(success); },
    onMessagesUpdate: controller.setMessages,
    onLoadMessages: (id) => controller.loadMessages(id),
    onLoadConversations: () => controller.loadConversations(),
    currentConvRef: controller.refs.currentConv,
    abortRef: controller.refs.abort,
    mountedRef: controller.refs.mounted,
  });
  controller.bindStream({
    send: stream.handleSend,
    stop: stream.stopGeneration,
    setSending: (value) => { stream.setSending(value); },
    setThinking: (value) => { stream.setThinking(value); },
  });

  // 轮询回调必须引用稳定：`poll` 的 useCallback 依赖它们，一旦每次渲染都换新身份，
  // 主轮询 effect 会跟着每次渲染重启（setInterval 被反复拆建，退化成"每次渲染都请求"）。
  const noteTokenTotal = useCallback((total: number) => { controller.notePolled({ tokenTotal: total }); }, [controller]);
  const noteGenerating = useCallback((generating: boolean) => { controller.notePolled({ sending: generating }); }, [controller]);
  const notePolledReasoning = useCallback((reasoning: string) => { controller.notePolled({ reasoning }); }, [controller]);

  // 轮询的 3 个返回值全部消费：pollStatus/pollErrorInfo 供 UI 显式状态机，retry 供"立即重试"
  const { pollStatus, pollErrorInfo, retry: retryPolling } = useMessagePolling({
    conversationId: thread.conversationId,
    enabled: thread.conversationId !== null,
    intervalMs: capabilities.pollIntervalMs,
    onMessagesUpdate: controller.setMessages,
    onTokenTotalUpdate: noteTokenTotal,
    onSendingUpdate: noteGenerating,
    onLiveReasoningUpdate: capabilities.pollLiveReasoning ? notePolledReasoning : undefined,
    currentConvRef: controller.refs.currentConv,
    msgPollReqIdRef: controller.refs.msgPollReqId,
    activityPollReqIdRef: controller.refs.activityPollReqId,
    mountedRef: controller.refs.mounted,
    pollActivityEvents: capabilities.pollActivityEvents,
    getLastSeq: capabilities.activityCursor
      ? (convId) => useActivityStore.getState().getLastSeq(convId)
      : undefined,
  });

  // 外部驱动的会话 id 变更。只在**入参真的变了**时才落定：控制器自己也会改会话
  // （loadMessages / send / clearThread），拿入参和内部状态比会把控制器自己的选择抹掉。
  const lastExternalIdRef = useRef(conversationId);
  useEffect(() => {
    if (lastExternalIdRef.current === conversationId) return;
    lastExternalIdRef.current = conversationId;
    controller.setActiveConversation(conversationId);
  }, [conversationId, controller]);

  useEffect(() => {
    controller.refs.mounted.current = true;
    const unsubscribe = controller.subscribeActivity();
    return () => { unsubscribe(); controller.refs.mounted.current = false; };
  }, [controller]);

  // SSE 活跃 reasoning 优先，回落轮询回读值（刷新页面后没有 SSE）；
  // reasoningBar 能力位为假时本页不渲染活跃思考 —— 归零，避免"有数据没人渲染"
  const liveReasoning = capabilities.reasoningBar
    ? (stream.liveReasoning.trim() !== '' ? stream.liveReasoning : thread.polledReasoning)
    : '';

  return {
    ...thread,
    sending: stream.sending,
    thinking: stream.thinking,
    streamTokens: stream.streamTokens,
    retryInfo: stream.retryInfo,
    liveReasoning,
    failure: stream.failure ?? thread.directFailure,
    pollStatus,
    pollErrorInfo,
    send: controller.send,
    stop: controller.stop,
    retryPolling,
    decideApproval: controller.decideApproval,
    setActiveConversation: controller.setActiveConversation,
    loadMessages: controller.loadMessages,
    loadConversations: controller.loadConversations,
    clearThread: controller.clearThread,
    reportError: controller.reportError,
    reportFailure: controller.reportFailure,
    appendUserMessage: controller.appendUserMessage,
    cancelStaleGeneration: controller.cancelStaleGeneration,
    bootstrap: controller.bootstrap,
  };
}

/** 失败重试：重新发送最后一条用户指令（共享失败态按钮的实际语义） */
export function useRetryLastSend(
  messages: readonly ThreadMessage[],
  send: (content: string) => Promise<void>,
): () => void {
  return useCallback(() => {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    const content = lastUser?.content.trim() ?? '';
    if (!content) return;
    void send(content);
  }, [messages, send]);
}
