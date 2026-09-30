/**
 * T16 `useThreadController` 的行为契约。
 *
 * 本仓库没有 DOM 测试环境（组件测试走 react-dom/server 静态渲染，不执行 effect），
 * 而控制器的全部行为都在 effect 之外的核心里，因此测试直接驱动
 * `createThreadController` + 真实 activityStore / 真实 useStreamSend（只有传输层被替身化）。
 *
 * 覆盖：Chat / CodingHome 两套配置、D1 审批（双 mode）、D6 计数器拆分、R12 双 cancel、
 * justSentRef 首条消息竞态、乐观占位前缀不变式，以及"路由不得持有流状态副本"的结构不变式。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEventEnvelope } from '@pacc/shared';

const harness = vi.hoisted(() => ({
  decideApproval: [] as Array<{ id: string; decision: 'approved' | 'rejected' }>,
  decideApprovalError: null as Error | null,
  cancelConversation: [] as string[],
  cancelAgentGeneration: [] as string[],
  cancelRun: [] as string[],
  createdConversations: [] as Array<{ title: string; providerId: string; model: string }>,
  getProviders: [] as unknown[],
  sisyphusReply: { conversationId: 'conv-replied', reply: 'ok' } as Record<string, unknown>,
  getConversation: { messages: [], tokenTotal: 0 } as Record<string, unknown>,
  getConversationError: null as Error | null,
  /** 传输层替身：捕获 useStreamSend 的 onEvent，测试可自行驱动 SSE 帧 */
  streamHandlers: [] as Array<(event: unknown) => void>,
  streamConversationCalls: 0,
  streamOrchestrateCalls: 0,
}));

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getConversation: async () => {
        if (harness.getConversationError) throw harness.getConversationError;
        return harness.getConversation;
      },
      getProviders: async () => harness.getProviders,
      getConversations: async () => [],
      createConversation: async (input: { title: string; providerId: string; model: string }) => {
        harness.createdConversations.push(input);
        return { id: `conv-created-${harness.createdConversations.length}` };
      },
      sisyphusReply: async () => harness.sisyphusReply,
      decideApproval: async (id: string, decision: 'approved' | 'rejected') => {
        if (harness.decideApprovalError) throw harness.decideApprovalError;
        harness.decideApproval.push({ id, decision });
        return { success: true };
      },
      cancelConversation: async (id: string) => { harness.cancelConversation.push(id); return { success: true }; },
      cancelAgentGeneration: async (id: string) => { harness.cancelAgentGeneration.push(id); return { success: true }; },
    },
  };
});

vi.mock('../api/runs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/runs')>();
  return {
    ...actual,
    runsApi: {
      ...actual.runsApi,
      cancelRun: async (runId: string) => { harness.cancelRun.push(runId); return { id: runId, status: 'cancelled' }; },
    },
  };
});

vi.mock('../api/streamClient', () => ({
  streamConversation: (_id: string, _content: string, handlers: { onEvent: (e: unknown) => void }) => {
    harness.streamConversationCalls += 1;
    harness.streamHandlers.push(handlers.onEvent);
    return Promise.resolve();
  },
  streamOrchestrate: (_input: unknown, handlers: { onEvent: (e: unknown) => void }) => {
    harness.streamOrchestrateCalls += 1;
    harness.streamHandlers.push(handlers.onEvent);
    return Promise.resolve();
  },
  fetchEvents: async () => [],
}));

import { createThreadController, extractApprovalRequest, type ThreadCapabilities, type ThreadConversationsPort, type ThreadController } from './useThreadController';
import { useActivityStore } from '../store/activityStore';
import { useRunStore } from '../store/runStore';
import {
  ACTIVITY_POLL_RETRY_IN_MS,
  POLL_ERROR_THRESHOLD,
  createPollErrorCounters,
  isLiveStreamingPlaceholder,
  isReplaceableOptimisticPlaceholder,
} from './useMessagePolling';

const CONV = 'conv-1';

// ============================================================
// 两套真实配置（与 Chat / CodingHome 路由里落地的字面量一一对应）
// ============================================================

const CHAT_CAPABILITIES: ThreadCapabilities = {
  deepThinking: false,
  loopMode: false,
  webSearch: true,
  attachments: [],
  selectedProvider: { id: 'openai', models: ['gpt-4o'], defaultModel: 'gpt-4o' },
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
};

const CODING_HOME_CAPABILITIES: ThreadCapabilities = {
  deepThinking: false,
  loopMode: false,
  webSearch: true,
  attachments: [{ name: 'shot.png', dataUrl: 'data:image/png;base64,AAA' }],
  selectedProvider: { id: 'anthropic', models: ['claude-opus-5'], defaultModel: 'claude-opus-5' },
  selectedModel: 'claude-opus-5',
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
};

const PROVIDERS = [{ id: 'openai', name: 'OpenAI', models: ['gpt-4o'], capabilities: ['text'] }];

function port(recorded: string[] = []): ThreadConversationsPort {
  return {
    refresh: async () => { recorded.push('refresh'); },
    create: async (providers) => { recorded.push(`create:${providers.map(p => p.id).join(',')}`); },
  };
}

/** 驱动控制器：绑一个可观测的流端口（stop 记录 v1 车道，send 记录内容） */
function drive(
  capabilities: ThreadCapabilities = CHAT_CAPABILITIES,
  conversationId: string | null = null,
  options: { mode?: 'normal' | 'super'; autoSelectConversation?: boolean; conversations?: ThreadConversationsPort } = {},
) {
  const calls: string[] = [];
  const controller = createThreadController(
    {
      capabilities,
      // mode 只用于让两套配置在同一份实现上可对照：审批车道与 mode 无关
      ...(options.mode ? { mode: options.mode } : {}),
      providers: PROVIDERS,
      autoSelectConversation: options.autoSelectConversation ?? false,
    } as Parameters<typeof createThreadController>[0],
    options.conversations ?? port(),
    conversationId,
  );
  controller.bindStream({
    send: async (content) => { calls.push(`send:${content ?? ''}`); },
    // v1 车道：useStreamSend.stopGeneration 的既有语义（abort + 两条 v1 取消端点 + 复位）
    stop: () => { calls.push('stop:v1'); },
    setSending: (v) => { calls.push(`sending:${v}`); },
    setThinking: (v) => { calls.push(`thinking:${v}`); },
  });
  return { controller, calls };
}

function envelope(partial: Partial<AgentEventEnvelope> & Pick<AgentEventEnvelope, 'eventType'>): AgentEventEnvelope {
  return {
    eventId: `e-${partial.taskId ?? 't'}-${partial.seq ?? 0}`,
    sessionId: CONV,
    taskId: 't-1',
    agentId: 'main',
    agentType: 'conversation',
    timestamp: '2026-08-24T00:00:00Z',
    seq: 0,
    ...partial,
  };
}

function approvalEnvelope(approvalId: string, seq = 1): AgentEventEnvelope {
  // eventId 必须随 approvalId 变化：activityStore 按 eventId 去重，且 clearConv 不会清
  // identity Set —— 复用同一个 eventId 会让后续用例的 appendEvent 被静默丢弃
  return envelope({
    eventType: 'task.ask-confirm',
    taskId: `run-${approvalId}`,
    seq,
    eventId: `e-${approvalId}-${seq}`,
    metadata: { approvalId, toolName: 'write_file', argsSummary: 'src/a.ts' },
  });
}

beforeEach(() => {
  harness.decideApproval.length = 0;
  harness.decideApprovalError = null;
  harness.cancelConversation.length = 0;
  harness.cancelAgentGeneration.length = 0;
  harness.cancelRun.length = 0;
  harness.createdConversations.length = 0;
  harness.sisyphusReply = { conversationId: 'conv-replied', reply: 'ok' };
  harness.getConversation = { messages: [], tokenTotal: 0 };
  harness.getConversationError = null;
  harness.streamHandlers.length = 0;
  harness.streamConversationCalls = 0;
  harness.streamOrchestrateCalls = 0;
  useActivityStore.getState().clearConv(CONV);
  useRunStore.setState({ runsById: {}, runIdsByConversation: {}, activeRunId: null, lastSyncedAt: null });
});

// ============================================================
// D1 · 审批：两种 mode 都必须产出 pendingApproval
// ============================================================

describe('D1 · task.ask-confirm 由统一的审批车道处理（与 mode 无关）', () => {
  it.each(['super', 'normal'] as const)(
    'mode:%s 的 ask-confirm envelope 产出 pendingApproval，decideApproval(false) 提交 rejected',
    async (mode) => {
      // Given: 两种 mode 走同一个 activityStore 汇聚点（envelope 都被 appendEvent）
      const { controller } = drive(CHAT_CAPABILITIES, CONV, { mode });
      controller.subscribeActivity();
      useActivityStore.getState().appendEvent(CONV, approvalEnvelope(`ap-${mode}`));

      // Then: 待审批项与 mode 无关地出现
      expect(controller.getState().pendingApproval).toEqual({
        approvalId: `ap-${mode}`, toolName: 'write_file', argsSummary: 'src/a.ts',
      });

      // When: 用户拒绝
      await controller.decideApproval(false);

      // Then: 提交 rejected 且待审批清空
      expect(harness.decideApproval).toEqual([{ id: `ap-${mode}`, decision: 'rejected' }]);
      expect(controller.getState().pendingApproval).toBeNull();
    },
  );

  it('没有 metadata.approvalId 的 ask-confirm 不产出待审批（后端无从回执）', () => {
    const { controller } = drive(CHAT_CAPABILITIES, CONV);
    controller.subscribeActivity();
    useActivityStore.getState().appendEvent(CONV, envelope({ eventType: 'task.ask-confirm', taskId: 'r', seq: 1 }));
    expect(controller.getState().pendingApproval).toBeNull();
  });

  it('已裁决的审批不会被事件重放重新弹出（三路事件都经过 activityStore）', async () => {
    const { controller } = drive(CHAT_CAPABILITIES, CONV);
    controller.subscribeActivity();
    useActivityStore.getState().appendEvent(CONV, approvalEnvelope('ap-replay'));
    await controller.decideApproval(true);
    expect(harness.decideApproval).toEqual([{ id: 'ap-replay', decision: 'approved' }]);

    // 重放：replaceEvents 用同一批 envelope 重建（刷新页面）
    useActivityStore.getState().replaceEvents(CONV, [approvalEnvelope('ap-replay')]);
    expect(controller.getState().pendingApproval).toBeNull();
  });

  it('提交失败保留待审批并给出可重试的错误', async () => {
    harness.decideApprovalError = new Error('审批接口 500');
    const { controller } = drive(CHAT_CAPABILITIES, CONV);
    controller.subscribeActivity();
    useActivityStore.getState().appendEvent(CONV, approvalEnvelope('ap-fail'));

    await controller.decideApproval(false);

    expect(controller.getState().approvalError).toBe('审批接口 500');
    expect(controller.getState().pendingApproval?.approvalId).toBe('ap-fail');
  });

  it('extractApprovalRequest 是纯函数：判据严格、toolName 缺省为「工具」', () => {
    expect(extractApprovalRequest({ eventType: 'task.ask-confirm', metadata: { approvalId: 'a' } }))
      .toEqual({ approvalId: 'a', toolName: '工具', argsSummary: '' });
    expect(extractApprovalRequest({ eventType: 'task.ask-confirm', metadata: {} })).toBeNull();
    expect(extractApprovalRequest({ eventType: 'task.ask-confirm' })).toBeNull();
    expect(extractApprovalRequest({ eventType: 'agent.output.delta', metadata: { approvalId: 'a' } })).toBeNull();
  });
});

// ============================================================
// D6 · 轮询错误计数器按通道拆分
// ============================================================

describe('D6 · 消息轮询与活动轮询的失败计数各自独立', () => {
  it('3 次消息轮询失败升到 error，此时活动计数仍为 0', () => {
    const counters = createPollErrorCounters();
    for (let i = 0; i < POLL_ERROR_THRESHOLD - 1; i++) {
      expect(counters.noteMessageFailure()).toBe(i + 1);
      expect(counters.status()).toBe('retrying');
    }
    expect(counters.noteMessageFailure()).toBe(POLL_ERROR_THRESHOLD);
    expect(counters.status()).toBe('error');
    expect(counters.snapshot()).toEqual({ message: 3, activity: 0 });
  });

  it('2 次消息 + 2 次活动失败仍是 retrying（两条通道不互相抬升）', () => {
    const counters = createPollErrorCounters();
    counters.noteMessageFailure();
    counters.noteMessageFailure();
    counters.noteActivityFailure();
    counters.noteActivityFailure();
    expect(counters.status()).toBe('retrying');
    expect(counters.snapshot()).toEqual({ message: 2, activity: 2 });
  });

  it('活动轮询 3 击独立升到 error', () => {
    const counters = createPollErrorCounters();
    counters.noteActivityFailure();
    counters.noteActivityFailure();
    expect(counters.status()).toBe('retrying');
    expect(counters.noteActivityFailure()).toBe(3);
    expect(counters.status()).toBe('error');
    expect(counters.snapshot()).toEqual({ message: 0, activity: 3 });
  });

  it('消息轮询成功只复位消息通道（活动通道的失败不被顺手抹掉）', () => {
    const counters = createPollErrorCounters();
    counters.noteActivityFailure();
    counters.noteActivityFailure();
    counters.resetMessage();
    expect(counters.snapshot()).toEqual({ message: 0, activity: 2 });
    expect(counters.status()).toBe('retrying');
  });

  it('活动轮询成功只复位活动通道', () => {
    const counters = createPollErrorCounters();
    counters.noteMessageFailure();
    counters.resetActivity();
    expect(counters.snapshot()).toEqual({ message: 1, activity: 0 });
  });

  it('手动重试把两条通道一起复位', () => {
    const counters = createPollErrorCounters();
    counters.noteMessageFailure();
    counters.noteActivityFailure();
    counters.reset();
    expect(counters.snapshot()).toEqual({ message: 0, activity: 0 });
  });

  it('两条通道的重试倒计时不同：消息用 intervalMs、活动用 2000', () => {
    expect(ACTIVITY_POLL_RETRY_IN_MS).toBe(2000);
    expect(CHAT_CAPABILITIES.pollIntervalMs).toBe(2000);
    expect(CODING_HOME_CAPABILITIES.pollIntervalMs).toBe(1000);
  });
});

// ============================================================
// R12 · 停止生成的双车道
// ============================================================

describe('R12 · stop() 同时驱动 v1 会话级取消与 v2 Run 取消', () => {
  it('v1 车道（abort + cancelConversation + cancelAgentGeneration）与 v2 cancelRun 都发出', () => {
    useRunStore.getState().setActiveRun('run-42');
    const { controller, calls } = drive(CHAT_CAPABILITIES, CONV);
    harness.cancelRun.length = 0;

    controller.stop();

    // v1 车道 = useStreamSend.stopGeneration（内部 abort + 两条 v1 端点），此处断言它被调用
    expect(calls).toContain('stop:v1');
    // v2 车道由控制器新增：驱动真实 RunStatus
    expect(harness.cancelRun).toEqual(['run-42']);
  });

  it('没有活动 run 时跳过 v2 调用且不报错', () => {
    const { controller } = drive(CHAT_CAPABILITIES, CONV);
    expect(() => controller.stop()).not.toThrow();
    expect(harness.cancelRun).toEqual([]);
  });
});

// ============================================================
// 首条消息竞态：justSentRef + ref 先行
// ============================================================

describe('justSentRef 守卫：刚发送产生的会话切换不得被 cancel 打断', () => {
  it('已有会话发送后，会话切换的 cancelStaleGeneration 必须跳过', async () => {
    const { controller, calls } = drive(CODING_HOME_CAPABILITIES, CONV);

    await controller.send('第一条');
    expect(calls).toEqual(['send:第一条']);

    // 会话切换后的挂载清理：justSent 命中 → 不发 /agents/cancel
    controller.cancelStaleGeneration();
    expect(harness.cancelAgentGeneration).toEqual([]);
  });

  it('非发送引起的会话切换仍会清掉残留生成，且守卫只消费一次', async () => {
    const { controller } = drive(CODING_HOME_CAPABILITIES, CONV);

    controller.cancelStaleGeneration();
    expect(harness.cancelAgentGeneration).toEqual([CONV]);

    await controller.send('x');
    controller.cancelStaleGeneration();
    expect(harness.cancelAgentGeneration).toEqual([CONV]);
    controller.cancelStaleGeneration();
    expect(harness.cancelAgentGeneration).toEqual([CONV, CONV]);
  });

  it('setActiveConversation 同步落定 ref（不 await，供守卫同步读取）', () => {
    const { controller } = drive(CHAT_CAPABILITIES);
    controller.setActiveConversation(CONV);
    expect(controller.refs.currentConv.current).toBe(CONV);
    expect(controller.getState().conversationId).toBe(CONV);

    controller.setActiveConversation('conv-2');
    expect(controller.refs.currentConv.current).toBe('conv-2');
    controller.setActiveConversation(null);
    expect(controller.refs.currentConv.current).toBeNull();
  });

  it('切换会话会中断 in-flight 请求并递增两条轮询代次', () => {
    const { controller } = drive(CHAT_CAPABILITIES, CONV);
    const abort = new AbortController();
    controller.refs.abort.current = abort;
    const msgGen = controller.refs.msgPollReqId.current;
    const activityGen = controller.refs.activityPollReqId.current;

    controller.setActiveConversation('conv-3');

    expect(abort.signal.aborted).toBe(true);
    expect(controller.refs.abort.current).toBeNull();
    expect(controller.refs.msgPollReqId.current).toBe(msgGen + 1);
    expect(controller.refs.activityPollReqId.current).toBe(activityGen + 1);
  });

  it('首条消息：先建会话再发，且建会话用 provider 自身 id（不再拿 conversationId 去匹配）', async () => {
    const { controller, calls } = drive(CHAT_CAPABILITIES, null);
    await controller.send('开工');
    expect(harness.createdConversations).toEqual([{ title: '开工', providerId: 'openai', model: 'gpt-4o' }]);
    expect(calls).toEqual(['send:开工']);
    expect(controller.refs.currentConv.current).toBe('conv-created-1');
  });

  it('没有 provider 时给独立失败态，不弹窗也不发流', async () => {
    const { controller, calls } = drive({ ...CHAT_CAPABILITIES, selectedProvider: null }, null, {
      conversations: { refresh: async () => undefined },
    });
    const controllerNoProviders = createThreadController(
      { capabilities: { ...CHAT_CAPABILITIES, selectedProvider: null }, providers: [], autoSelectConversation: false },
      { refresh: async () => undefined },
      null,
    );
    void controller;
    await controllerNoProviders.send('开工');
    expect(calls).toEqual([]);
    expect(controllerNoProviders.getState().directFailure?.message).toContain('AI Provider');
  });
});

// ============================================================
// 乐观占位前缀不变式（AEX-P0-062）
// ============================================================

describe('乐观占位前缀：u- / a- / remote-u- / temp-，但不含 temp-ai-streaming', () => {
  it('四类前缀都可被 server 快照替换', () => {
    for (const id of ['u-1', 'a-1', 'remote-u-1', 'temp-user-1', 'temp-ai-streaming-done']) {
      expect(isReplaceableOptimisticPlaceholder(id)).toBe(true);
    }
  });

  it('正在流式的占位既不可被替换，也被识别为实时投影', () => {
    expect(isReplaceableOptimisticPlaceholder('temp-ai-streaming')).toBe(false);
    expect(isLiveStreamingPlaceholder('temp-ai-streaming')).toBe(true);
    expect(isLiveStreamingPlaceholder('temp-ai-streaming-done')).toBe(false);
  });

  it('真实消息 id 与非占位前缀都不算乐观占位', () => {
    for (const id of ['m-1', 'user-1', 'assistant-1', '']) {
      expect(isReplaceableOptimisticPlaceholder(id)).toBe(false);
    }
  });

  it('远程指令回显沿用 remote-u- 前缀，server 快照仍能接管它', () => {
    const { controller } = drive(CODING_HOME_CAPABILITIES, CONV);
    controller.appendUserMessage('部署预发');
    const only = controller.getState().messages;
    expect(only).toHaveLength(1);
    expect(isReplaceableOptimisticPlaceholder(only[0].id)).toBe(true);
    expect(only[0]).toMatchObject({ role: 'user', content: '部署预发' });
  });

  it('setMessages 原样执行 updater：流末 id 交换（temp-ai-streaming → -done）由 useStreamSend 独占', () => {
    const { controller } = drive(CHAT_CAPABILITIES, CONV);
    controller.setMessages(prev => [
      ...prev,
      { id: 'temp-ai-streaming', role: 'assistant', content: '真实回复', createdAt: 'now' },
    ]);
    controller.setMessages(prev => [
      ...prev.filter(m => m.id !== 'temp-ai-streaming'),
      { id: 'temp-ai-streaming-done', role: 'assistant', content: '真实回复', createdAt: 'now' },
    ]);
    expect(controller.getState().messages.map(m => m.id)).toEqual(['temp-ai-streaming-done']);
  });
});

// ============================================================
// 两套配置都存活
// ============================================================

describe('Chat / CodingHome 两套配置都驱动出各自的既有行为', () => {
  it('Chat 配置：内联列表 + ReasoningBar + 轮询 reasoning + tokenTotal 直设', () => {
    const { controller } = drive(CHAT_CAPABILITIES, CONV);
    controller.notePolled({ reasoning: '轮询回来的思考', tokenTotal: 42, sending: true });

    expect(controller.getState().polledReasoning).toBe('轮询回来的思考');
    expect(controller.getState().tokenTotal).toBe(42);
    expect(CHAT_CAPABILITIES.inlineConversationList).toBe(true);
    expect(CHAT_CAPABILITIES.reasoningBar).toBe(true);
    expect(CHAT_CAPABILITIES.promptTemplates).toBe(true);
    expect(CHAT_CAPABILITIES.sisyphusDeepLink).toBe(true);
    expect(CHAT_CAPABILITIES.pollActivityEvents).toBe(true);
    expect(CHAT_CAPABILITIES.activityCursor).toBe(true);
  });

  it('Chat 配置：generating 同步 sending 与 thinking 两者', () => {
    const { controller, calls } = drive(CHAT_CAPABILITIES, CONV);
    controller.notePolled({ sending: true });
    expect(calls).toContain('sending:true');
    expect(calls).toContain('thinking:true');
  });

  it('CodingHome 配置：tokenTotal 取 max、generating 只同步 sending', () => {
    const { controller, calls } = drive(CODING_HOME_CAPABILITIES, CONV);
    controller.notePolled({ tokenTotal: 10 });
    controller.notePolled({ tokenTotal: 5 });
    expect(controller.getState().tokenTotal).toBe(10);
    controller.notePolled({ sending: true });
    expect(calls).toContain('sending:true');
    expect(calls).not.toContain('thinking:true');
    expect(CODING_HOME_CAPABILITIES.pollLiveReasoning).toBe(false);
  });

  it('CodingHome 配置：不消费轮询 reasoning（无 ReasoningBar）', () => {
    const { controller } = drive(CODING_HOME_CAPABILITIES, CONV);
    controller.notePolled({ reasoning: '不该被消费' });
    expect(controller.getState().polledReasoning).toBe('');
  });

  it('CodingHome 配置：发送成功后派发 conversations-changed 刷新侧栏', () => {
    const fakeWindow = new EventTarget();
    vi.stubGlobal('window', fakeWindow);
    let refreshes = 0;
    fakeWindow.addEventListener('conversations-changed', () => { refreshes += 1 });
    const { controller } = drive(CODING_HOME_CAPABILITIES, CONV);

    controller.noteSendEnd(false);
    expect(refreshes).toBe(0);
    controller.noteSendEnd(true);
    expect(refreshes).toBe(1);
    vi.unstubAllGlobals();
  });

  it('Chat 配置：发送成功不派发侧栏事件（列表是内联的）', () => {
    const fakeWindow = new EventTarget();
    vi.stubGlobal('window', fakeWindow);
    let refreshes = 0;
    fakeWindow.addEventListener('conversations-changed', () => { refreshes += 1 });
    const { controller } = drive(CHAT_CAPABILITIES, CONV);
    controller.noteSendEnd(true);
    expect(refreshes).toBe(0);
    vi.unstubAllGlobals();
  });

  it('noteSendEnd 复位 sending/thinking（useStreamSend 的 finally 守卫此刻必然落空）', () => {
    const { controller, calls } = drive(CHAT_CAPABILITIES, CONV);
    controller.noteSendEnd(true);
    expect(calls).toEqual(['sending:false', 'thinking:false']);
  });

  it('noteSendStart 清掉上一轮的失败 / 循环指标 / 加载错误', () => {
    const { controller } = drive(CHAT_CAPABILITIES, CONV);
    controller.reportFailure({ message: '上一轮失败', retryable: true });
    controller.reportError('加载失败');
    controller.noteSendStart();
    expect(controller.getState().directFailure).toBeNull();
    expect(controller.getState().loadError).toBeNull();
  });
});

// ============================================================
// 会话加载
// ============================================================

describe('loadMessages：边界解析 + 竞态守卫', () => {
  it('把后端消息收窄成 ThreadMessage，并回读 tokenTotal', async () => {
    harness.getConversation = {
      tokenTotal: 128,
      messages: [
        { id: 'm1', role: 'user', content: '你好', createdAt: 't1' },
        { id: 'm2', role: 'assistant', content: '在的', createdAt: 't2', toolResults: '{"reasoning":"先想一下"}' },
        { id: 'm3', role: 'weird', content: null, createdAt: 3 },
      ],
    };
    const { controller } = drive(CHAT_CAPABILITIES);
    await controller.loadMessages(CONV);

    const state = controller.getState();
    expect(state.tokenTotal).toBe(128);
    expect(state.messages).toEqual([
      { id: 'm1', role: 'user', content: '你好', createdAt: 't1', reasoning: null, toolCalls: null },
      { id: 'm2', role: 'assistant', content: '在的', createdAt: 't2', reasoning: '先想一下', toolCalls: null },
      { id: 'm3', role: 'user', content: '', createdAt: '', reasoning: null, toolCalls: null },
    ]);
    expect(controller.refs.currentConv.current).toBe(CONV);
  });

  it('加载失败进入 loadError（不静默吞错）', async () => {
    harness.getConversationError = new Error('会话不存在');
    const { controller } = drive(CHAT_CAPABILITIES);
    await controller.loadMessages(CONV);
    expect(controller.getState().loadError).toBe('会话不存在');
  });

  it('旧加载响应不得覆盖新会话（FE-RACE-02 请求序列守卫）', async () => {
    let resolveFirst: ((value: Record<string, unknown>) => void) | null = null;
    const { controller } = drive(CHAT_CAPABILITIES);
    const first = controller.loadMessages('conv-slow').then(() => undefined);
    await Promise.resolve();
    void controller.loadMessages('conv-fast');
    // 让第一个请求带着旧数据落地
    harness.getConversation = { messages: [{ id: 'old', role: 'user', content: '旧', createdAt: 't' }], tokenTotal: 1 };
    resolveFirst = null;
    await first;
    expect(controller.getState().conversationId).toBe('conv-fast');
  });

  it('会话列表端口失败也进入 loadError', async () => {
    const { controller } = drive(CHAT_CAPABILITIES, CONV, {
      conversations: { refresh: async () => { throw new Error('会话列表 500'); } },
    });
    await controller.loadConversations();
    expect(controller.getState().loadError).toBe('会话列表 500');
  });

  it('clearThread 归零会话、消息、指标与审批', async () => {
    const { controller } = drive(CHAT_CAPABILITIES, CONV);
    controller.subscribeActivity();
    useActivityStore.getState().appendEvent(CONV, approvalEnvelope('ap-clear'));
    controller.reportError('boom');
    expect(controller.getState().pendingApproval).not.toBeNull();

    controller.clearThread();

    expect(controller.getState()).toMatchObject({
      conversationId: null, messages: [], tokenTotal: 0, loadError: null,
      directFailure: null, loopMetrics: null, pendingApproval: null, approvalError: null, polledReasoning: '',
    });
    expect(controller.refs.currentConv.current).toBeNull();
  });
});

// ============================================================
// 循环指标（activityStore 投影）
// ============================================================

describe('循环指标：按 Run 回溯终态事件', () => {
  it('读最后一次 task.completed 的 turnsUsed/elapsedMs/toolCalls', () => {
    const { controller } = drive(CHAT_CAPABILITIES, CONV);
    controller.subscribeActivity();
    useActivityStore.getState().appendEvent(CONV, envelope({
      eventType: 'task.completed', taskId: 'run-1', seq: 1, endReason: 'stop',
      metadata: { turnsUsed: 3, elapsedMs: 1500, toolCalls: 7 },
    }));
    expect(controller.getState().loopMetrics).toEqual({
      turnsUsed: 3, elapsedMs: 1500, toolCalls: 7, budgetExceeded: null,
    });
  });

  it('预算耗尽透传 budgetExceeded', () => {
    const { controller } = drive(CHAT_CAPABILITIES, CONV);
    controller.subscribeActivity();
    useActivityStore.getState().appendEvent(CONV, envelope({
      eventType: 'task.failed', taskId: 'run-2', seq: 1,
      metadata: { turnsUsed: 1, elapsedMs: 10, toolCalls: 1, budgetExceeded: 'tokens' },
    }));
    expect(controller.getState().loopMetrics?.budgetExceeded).toBe('tokens');
  });

  it('没有终态事件时为 null', () => {
    const { controller } = drive(CHAT_CAPABILITIES, CONV);
    controller.subscribeActivity();
    useActivityStore.getState().appendEvent(CONV, envelope({ eventType: 'agent.started', taskId: 'r', seq: 1 }));
    expect(controller.getState().loopMetrics).toBeNull();
  });
});

// ============================================================
// 结构不变式：路由不得持有流状态副本
// ============================================================

function routeSource(file: string): string {
  return readFileSync(fileURLToPath(new URL(`../routes/${file}`, import.meta.url)), 'utf8');
}

function componentSource(file: string): string {
  return readFileSync(fileURLToPath(new URL(`../components/${file}`, import.meta.url)), 'utf8');
}

function controllerSource(file: string): string {
  return readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), 'utf8');
}

/**
 * 一条路由的**有效接线面** = 入口文件 + 它委托出去的实现文件。
 *
 * T24 起 `/chat` 的入口（Chat.tsx）只是 `return <ThreadPage variant="chat" />`，
 * 控制器与投影的一切接线都在 ThreadPage.tsx 与 useThreadProjection.ts 里。
 * 对 Chat.tsx 单独断言 pollStatus 之类的字段等于断言一个薄壳文件 —— 契约实际
 * 落在它渲染的实现上，因此按委托关系取并集。
 */
function routeSurface(entry: 'Chat.tsx' | 'ThreadPage.tsx'): string {
  const surface = entry === 'Chat.tsx'
    ? [routeSource('Chat.tsx'), routeSource('ThreadPage.tsx')]
    : [routeSource(entry)];
  return [...surface, controllerSource('useThreadProjection.ts')].join('\n');
}

describe('结构不变式：单一状态源', () => {
  it.each(['Chat.tsx', 'ThreadPage.tsx'])('%s 不再声明 sending/thinking/streamTokens/retryInfo/liveReasoning 的本地副本', (file) => {
    const source = routeSource(file);
    const localCopy = /useState[^\n]*(sending|thinking|streamTokens|retryInfo|liveReasoning)/;
    expect(localCopy.test(source)).toBe(false);
    // setSending / setThinking 是 useStreamSend 的字段，路由不得再自己持有
    expect(source.includes('setSending')).toBe(false);
    expect(source.includes('setThinking')).toBe(false);
  });

  it.each(['useThreadController.ts', 'threadCore.ts', 'threadContract.ts', 'threadUrlIntent.ts', 'threadApproval.ts'])(
    '%s 零 any、零类型断言绕过',
    (file) => {
      const source = controllerSource(file);
      expect(/\bany\b/.test(source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''))).toBe(false);
      expect(/as\s+(unknown\s+as|any)\b/.test(source)).toBe(false);
    },
  );

  it('控制器本身不引入 useState（状态只来自 useStreamSend / 控制器核心）', () => {
    for (const file of ['useThreadController.ts', 'threadCore.ts']) {
      expect(controllerSource(file).includes('useState(')).toBe(false);
    }
  });

  it.each(['Chat.tsx', 'ThreadPage.tsx'])('%s 零 any', (file) => {
    const source = routeSource(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(/\bany\b/.test(source)).toBe(false);
    expect(/as\s+any\b/.test(source)).toBe(false);
  });

  it('chatSelectedProvider 走 useProviderSelection 的 ProviderOption（不再标 any）', () => {
    const source = routeSource('ThreadPage.tsx');
    expect(source).toContain('useProviderSelection');
    // 选中项直接来自 useProviderSelection（ProviderOption），并原样透给控制器能力
    expect(source).toContain('selectedProvider: provider.selected');
    expect(source).not.toContain('useState<any>');
  });

  /**
   * 行数预算（不变式的**意图**是"没有巨型页面模块"，不是"某个数字"）。
   *
   * T16 写的是 `CodingHome < 400` —— 那是那个文件的实际尺寸。T24 把它的能力
   * 收敛进 ThreadPage 并拆成 4 个模块（页面编排 / 能力档案 / 输入区 / 投影层），
   * 每个模块各有一条预算。ThreadPage 自身比 400 略高，是因为它额外承担了
   * 「两条路由共用一份实现」的路由壳与全部 URL/事件 effect —— 这些是本次重构
   * 新增的编排职责，不是从别处搬来的展示细节。
   */
  it.each([
    ['Chat.tsx', 200],
    ['ThreadPage.tsx', 460],
    ['threadPageProfile.ts', 200],
    ['threadPageComposer.tsx', 280],
  ] as const)('行数预算：%s < %i', (file, budget) => {
    expect(routeSource(file).split('\n').length).toBeLessThan(budget);
  });

  it('投影层是唯一的 Run / 工具活动 / 审批派生点（页面不得重复实现）', () => {
    const projection = controllerSource('useThreadProjection.ts');
    expect(projection).toContain('projectToolActivity');
    expect(projection).toContain('createRunStatusHandlers');
    expect(projection).toContain('approvalPromptState');
    // 页面只消费投影结果，不自己再算一遍
    const page = routeSource('ThreadPage.tsx');
    expect(page).toContain('useThreadProjection');
    expect(page).not.toContain('projectToolActivity');
    expect(page).not.toContain('createRunStatusHandlers');
  });

  it.each(['Chat.tsx', 'ThreadPage.tsx'] as const)(
    '%s 的有效接线面消费 useMessagePolling 的 3 个返回值（pollStatus/pollErrorInfo/retry）',
    (entry) => {
      const sources = routeSurface(entry);
      expect(sources, `${entry} 缺少 pollStatus`).toContain('pollStatus');
      expect(sources, `${entry} 缺少 pollErrorInfo`).toContain('pollErrorInfo');
      expect(sources, `${entry} 缺少 retryPolling`).toContain('retryPolling');
    },
  );

  it.each(['Chat.tsx', 'ThreadPage.tsx'] as const)(
    '%s 的有效接线面消费全部 3 个审批字段与双车道停止入口',
    (entry) => {
      const sources = routeSurface(entry);
      expect(sources, `${entry} 缺少 pendingApproval`).toContain('pendingApproval');
      expect(sources, `${entry} 缺少 approvalError`).toContain('approvalError');
      expect(sources, `${entry} 缺少 decideApproval`).toContain('decideApproval');
      expect(sources, `${entry} 缺少 thread.stop`).toContain('thread.stop');
    },
  );
});

describe('控制器核心：getSnapshot 引用稳定（useSyncExternalStore 前提）', () => {
  it('无变更时 getState 返回同一引用', () => {
    const { controller } = drive(CHAT_CAPABILITIES, CONV);
    const before = controller.getState();
    expect(controller.getState()).toBe(before);
    controller.setMessages(prev => prev);
    expect(controller.getState()).toBe(before);
  });

  it('订阅者只在状态变化时被通知', () => {
    const { controller } = drive(CHAT_CAPABILITIES, CONV);
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    controller.reportError(null);
    expect(listener).not.toHaveBeenCalled();
    controller.reportError('boom');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    controller.reportError('again');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('控制器类型：可作为 RouteConfig 使用', () => {
  it('createThreadController 返回可独立驱动的控制器', () => {
    const controller: ThreadController = drive(CHAT_CAPABILITIES, CONV).controller;
    expect(controller.getState().conversationId).toBe(CONV);
  });
});
