/**
 * T16 · 会话编排**核心**（与 React 解耦，可直接单测）。
 *
 * 控制器拥有：会话 id 与 refs、`loadMessages`、流状态复位、审批、停止（R12 双车道）、
 * 循环指标、URL 直达意图的接线。**不持有** sending/thinking/streamTokens/retryInfo/
 * liveReasoning 的副本（那 5 个字段的唯一真相是 useStreamSend），只通过 ThreadStreamPort
 * 用它的 4 个方法。
 *
 * 三条不变量（逐条写进 useThreadController.test.ts）：
 * 1. **单一状态源** —— setSending/setThinking 之所以必需：发送后的 `loadMessages` 会走
 *    `setActiveConversation`（中断并清空 abortRef），于是 useStreamSend 的 finally 守卫
 *    `abortRef.current === sendController` 必然落空，复位责任落到 onSendEnd。
 * 2. **ref 先行** —— 切换/新建会话时 `currentConvRef.current` 与 state 同步落定，否则
 *    "新建后立刻发送"会被 `currentConvRef.current !== sendConvId` 守卫丢弃首条消息。
 * 3. **审批与 mode 无关** —— 审批来自 activityStore（两种 mode 的 envelope 都在那里汇聚），
 *    见 threadApproval.ts。
 */
import { api } from '../api/client';
import { runsApi } from '../api/runs';
import { fetchEvents } from '../api/streamClient';
import { dispatchAppEvent } from '../lib/events';
import { useActivityStore } from '../store/activityStore';
import { useRunStore } from '../store/runStore';
import { createStreamFailure } from './useStreamSend';
import { resolveModel } from './useProviderSelection';
import { createApprovalTracker } from './threadApproval';
import { applyUrlIntent } from './threadUrlIntent';
import { createActivitySync } from './threadActivity';
import {
  isSameMessages,
  isSameState,
  parseThreadMessages,
  readField,
  readFieldList,
  readNumberField,
  type ThreadController,
  type ThreadControllerConfig,
  type ThreadConversationsPort,
  type ThreadMessage,
  type ThreadRefs,
  type ThreadState,
  type ThreadStatePatch,
  type ThreadStreamPort,
} from './threadContract';

const IDLE_STREAM_PORT: ThreadStreamPort = { send: async () => undefined, stop: () => {}, setSending: () => {}, setThinking: () => {} };

export function createThreadController(
  initialConfig: ThreadControllerConfig,
  conversations: ThreadConversationsPort,
  initialConversationId: string | null = null,
): ThreadController {
  let config: ThreadControllerConfig = initialConfig;
  let stream: ThreadStreamPort = IDLE_STREAM_PORT;
  const approvals = createApprovalTracker(api);
  const activitySync = createActivitySync(approvals);
  const refs: ThreadRefs = {
    currentConv: { current: initialConversationId },
    abort: { current: null },
    mounted: { current: true },
    msgPollReqId: { current: 0 },
    activityPollReqId: { current: 0 },
  };
  /** 首条消息竞态守卫：标记"刚由用户发送产生的会话切换" */
  const justSent = { current: false };
  /** 会话加载请求序列守卫（FE-RACE-02：快速切换时旧响应不得覆盖新数据） */
  const loadReqId = { current: 0 };
  const listeners = new Set<() => void>();
  let state: ThreadState = {
    conversationId: initialConversationId,
    messages: [],
    tokenTotal: 0,
    loadError: null,
    directFailure: null,
    loopMetrics: null,
    pendingApproval: null,
    approvalError: null,
    polledReasoning: '',
  };

  const publish = (patch: ThreadStatePatch): void => {
    const next: ThreadState = { ...state, ...patch };
    if (isSameState(state, next)) return;
    state = next;
    for (const listener of listeners) listener();
  };

  const setActiveConversation = (id: string | null): void => {
    // ref 先行：不变量 2 —— 新建后立刻发送时守卫依赖 ref，不是 state
    refs.currentConv.current = id;
    if (refs.abort.current) {
      try { refs.abort.current.abort(); } catch { /* ignore */ }
      refs.abort.current = null;
    }
    refs.msgPollReqId.current += 1;
    refs.activityPollReqId.current += 1;
    publish({ conversationId: id });
  };

  const loadMessages = async (id: string): Promise<void> => {
    const reqId = ++loadReqId.current;
    activitySync.invalidate();
    setActiveConversation(id);
    approvals.clear();
    publish({ loadError: null, directFailure: null, tokenTotal: 0, polledReasoning: '' });
    try {
      const conv: unknown = await api.getConversation(id);
      if (reqId !== loadReqId.current) return;
      publish({
        messages: parseThreadMessages(readFieldList(conv, 'messages')),
        tokenTotal: readNumberField(conv, 'tokenTotal') ?? 0,
      });
      // Event Log 回放：刷新/切会话后从 activity_events 重建 Activity Stream
      try {
        const events = await fetchEvents(id);
        if (reqId !== loadReqId.current) return;
        useActivityStore.getState().replaceEvents(id, events);
      } catch { /* 无事件表数据时静默，降级为纯消息视图 */ }
      publish(activitySync.sync(id));
    } catch (cause: unknown) {
      if (reqId !== loadReqId.current) return;
      publish({ loadError: cause instanceof Error ? cause.message : '加载消息失败' });
    }
  };

  const loadConversations = async (): Promise<void> => {
    try {
      await conversations.refresh();
      publish({ loadError: null });
    } catch (cause: unknown) {
      publish({ loadError: cause instanceof Error ? cause.message : '加载数据失败' });
    }
  };

  const clearThread = (): void => {
    loadReqId.current += 1;
    activitySync.invalidate();
    setActiveConversation(null);
    approvals.clear();
    publish({
      messages: [], tokenTotal: 0, loadError: null, directFailure: null, loopMetrics: null,
      pendingApproval: null, approvalError: null, polledReasoning: '',
    });
  };

  const send = async (content: string): Promise<void> => {
    if (refs.currentConv.current !== null) {
      justSent.current = true;
      await stream.send(content);
      return;
    }
    // 首条消息：先创建会话（provider 缺失时给独立失败态，不弹窗）
    const provider = config.capabilities.selectedProvider ?? config.providers[0];
    if (!provider) {
      publish({ directFailure: createStreamFailure('请先在「设置 → AI Provider」中配置 API Key 后再发送。') });
      return;
    }
    let created: string | null = null;
    try {
      created = readField(await api.createConversation({
        title: (content || '图片消息').slice(0, 30),
        providerId: provider.id,
        model: resolveModel(provider, config.capabilities.selectedModel ?? ''),
      }), 'id');
    } catch (cause: unknown) {
      publish({ directFailure: createStreamFailure(cause) });
      return;
    }
    if (created === null) {
      publish({ directFailure: createStreamFailure('创建会话失败：后端未返回会话 id。') });
      return;
    }
    justSent.current = true;
    setActiveConversation(created);
    void loadConversations();
    dispatchAppEvent('conversations-changed');
    await stream.send(content);
  };

  const stop = (): void => {
    // v1 车道：abort in-flight 流 + 停会话级/Agent 级生成 + 复位 sending/thinking
    stream.stop();
    // v2 车道：驱动真实 RunStatus。无活动 run 时跳过（v1 仍是权威，不报错）
    const runId = useRunStore.getState().activeRunId;
    if (runId === null) return;
    void runsApi.cancelRun(runId).catch(() => {});
  };

  const reportFailure = (failure: ThreadState['directFailure']): void => { publish({ directFailure: failure }); };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    refs,
    configure: (next) => { config = next; },
    bindStream: (port) => { stream = port; },
    subscribeActivity: () => {
      const rerun = (): void => { publish(activitySync.sync(refs.currentConv.current)); };
      rerun();
      return useActivityStore.subscribe(rerun);
    },
    setActiveConversation,
    loadMessages,
    loadConversations,
    clearThread,
    send,
    stop,
    // 决策后必须重新发布：审批跟踪器自己更新了快照，控制器状态要跟着落定
    decideApproval: (ok) => approvals.decide(ok).then(() => { publish(activitySync.sync(refs.currentConv.current)); }),
    setMessages: (updater) => {
      const messages = parseThreadMessages(updater(state.messages));
      if (isSameMessages(state.messages, messages)) return;
      publish({ messages });
    },
    noteSendStart: () => { publish({ directFailure: null, loopMetrics: null, loadError: null, polledReasoning: '' }); },
    // 复位责任在此：见文件头不变量 1（useStreamSend 的 finally 守卫必然落空）
    noteSendEnd: (success) => {
      stream.setSending(false);
      stream.setThinking(false);
      if (success && config.capabilities.refreshSidebarOnSendEnd) dispatchAppEvent('conversations-changed');
    },
    notePolled: (patch) => {
      const next: ThreadStatePatch = {};
      if (patch.reasoning !== undefined && config.capabilities.pollLiveReasoning) next.polledReasoning = patch.reasoning;
      if (patch.tokenTotal !== undefined) {
        next.tokenTotal = config.capabilities.pollTokenTotal === 'max'
          ? Math.max(state.tokenTotal, patch.tokenTotal)
          : patch.tokenTotal;
      }
      if (patch.sending !== undefined) {
        stream.setSending(patch.sending);
        if (config.capabilities.pollSyncsThinking) stream.setThinking(patch.sending);
      }
      if (Object.keys(next).length > 0) publish(next);
    },
    reportError: (message) => { publish({ loadError: message }); },
    reportFailure,
    appendUserMessage: (content) => {
      publish({ messages: [{ id: `remote-u-${Date.now()}`, role: 'user', content, createdAt: new Date().toISOString() }] });
    },
    /**
     * 会话切换后清掉上一个会话残留的生成。
     * justSent 守卫：刚由用户发送产生的会话切换必须跳过，否则刚注册的 run 被误杀
     * （首条消息不回复，AI 生成中断 "This operation was aborted"）。
     */
    cancelStaleGeneration: () => {
      const conversationId = refs.currentConv.current;
      if (conversationId === null) return;
      if (justSent.current) {
        justSent.current = false;
        return;
      }
      void api.cancelAgentGeneration(conversationId).catch(() => {});
    },
    bootstrap: async (search, homePath) => {
      await loadConversations();
      await applyUrlIntent(
        {
          clearThread,
          sisyphusDeepLink: () => config.capabilities.sisyphusDeepLink,
          autoSelectConversation: () => config.autoSelectConversation,
          createConversation: async (providers) => { await conversations.create?.(providers); },
        },
        search,
        homePath,
        { setActiveConversation, loadMessages, reportFailure },
      );
    },
  };
}
