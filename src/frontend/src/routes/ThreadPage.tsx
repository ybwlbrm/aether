/**
 * T24 `ThreadPage` —— 唯一的 Thread 表面（`/command-center` 与 `/chat` 共用）。
 *
 * ## 为什么要这一个组件
 * T16 之前 `/command-center` 走 CodingHome、`/chat` 走 Chat：两套页面级接线
 * （轮询参数、侧栏刷新、URL 意图、审批、停止车道各写一份），行为随时间漂移。
 * 本组件把两份接线收敛成**两个 profile 常量 + 一个 `ThreadSurface`**：
 * `variant` 只决定"这个表面开哪些能力"，不决定"用哪套实现"。
 *
 * ## 本文件 vs 它的两个同目录模块
 * - `threadPageProfile.ts`  —— **决策**：两条路由各开哪些能力（两个字面量的 diff）
 * - `threadPageComposer.tsx` —— **输入区接线**：T18 Composer + 五个次级动作的门控
 * - 本文件 —— **编排**：会话 / run / 事件 → JSX
 *
 * ## 适配层（重要）
 * T16 的 `ThreadCapabilities` 是**已验收产物**，本任务不改它。而 CodingHome 的
 * 页面级能力里还有五项**不进控制器**的开关：语音（T11）、附件（T12）、模型选择（T13）、
 * 远程命令（T14）、权限等级。它们记在 `ThreadPageProfile` 里由本页逐个接线 ——
 * 不污染 T16 的词汇表，也不需要改它。
 *
 * ## 事件契约（T7 观测的 16 个 app 级事件中与本页相关的 6 个）
 * 1. `select-conversation` —— 从 T19 ConversationsDrawer 选中会话
 * 2. `remote-command`     —— 从 T14 远程命令宿主接收桌面端指令
 * 3. `conversations-changed` —— 发送成功后由控制器派发，驱动侧栏刷新
 * 4. `toggle-conv-panel`  —— T19 dispatcher（Shell 侧），本页只消费结果
 * 5. `aether-open-approvals` —— T23 dispatcher（Shell 侧），本页只提供审批视图
 * 6. `workbench-open` / `workbench-toggle` —— T22（Shell 侧）
 *
 * 路由切换后 ①② 的落点从 CodingHome 迁到本页（此前 /command-center 渲染的是
 * 会被 `uiMode` 闸门吃掉的 dashboard —— 事件落到一个会忽略它的表面上）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Plus, Sparkles } from 'lucide-react';

import { api } from '../api/client';
import { PageHeader, PageShell, Panel } from '../components/ui';
import { ReasoningBar } from '../components/ReasoningBar';
import { PollStatusBanner, StreamFailureState, ThinkingDots } from '../components/conversation';
import { ChatConversationList } from '../components/chat/chat-conversation-list';
import { Thread } from '../components/thread';
import {
  useRetryLastSend,
  useThreadController,
  type ThreadConversationsPort,
} from '../hooks/useThreadController';
import { useThreadProjection } from '../hooks/useThreadProjection';
import { useAttachments } from '../hooks/useAttachments';
import { useConversations } from '../hooks/useConversations';
import { toSelectOptions, useProviderSelection, type ProviderOption } from '../hooks/useProviderSelection';
import { useRemoteCommandHost } from '../hooks/useRemoteCommandHost';
import { createStreamFailure } from '../hooks/useStreamSend';
import { subscribeAppEvent } from '../lib/events';
import { useWorkspaceStore } from '../store/workspace';
import { ThreadComposerSlot, ThreadStatsBar } from './threadPageComposer';
import {
  IGNORE_FAILURE,
  IGNORE_OPEN_CONVERSATION,
  IGNORE_USER_COMMAND,
  THREAD_PAGE_PROFILES,
  type ThreadPageProfile,
  type ThreadPageVariant,
} from './threadPageProfile';

// 契约源头在 hooks/useRemoteCommandHost（载荷源头是 lib/events）—— 此处仅 re-export，
// 既有 import 处（页面测试、lib/events 测试）不受影响
export {
  createRemoteCommandHost,
  REMOTE_COMMAND_MAX_AGE_MS,
  REMOTE_COMMAND_POLL_INTERVAL_MS,
  REMOTE_COMMAND_TIMEOUT_MS,
  REMOTE_COMMAND_TIMEOUT_MESSAGE,
  type RemoteCommandHost,
  type RemoteCommandHostOptions,
  type RemoteCommandStatus,
} from '../hooks/useRemoteCommandHost';

// 载荷类型契约源头在 lib/events（app 事件注册表）—— 此处仅 re-export
export type { RemoteCommandPayload } from '../lib/events';
// 消息类型契约源头在 T16 控制器（threadContract）—— 此处仅 re-export
export type { ThreadMessage as CodingHomeMessage } from '../hooks/threadContract';
// 能力档案契约源头在 threadPageProfile —— 此处仅 re-export（调用方只需认识 ThreadPage）
export type { ThreadPageProfile, ThreadPageVariant } from './threadPageProfile';

/**
 * 会话列表插槽的绑定：列表的**数据**归 variant（useConversations），
 * 而**会话状态**归 ThreadSurface（thread）。这条渲染函数就是把两者接起来的显式接缝，
 * 因此不出现任何状态提升或 ref 反向读取。
 */
export interface ThreadListBindings {
  readonly activeId: string | null;
  /** 清空当前线程（新建 / 删除当前会话后归零） */
  readonly onClear: () => void;
  /** 选中一个会话并载入其消息 */
  readonly onSelect: (id: string) => void;
  /** provider 列表：新建会话时用来挑默认模型 */
  readonly providers: readonly ProviderOption[];
}

interface ThreadSurfaceProps {
  readonly profile: ThreadPageProfile;
  readonly conversations: ThreadConversationsPort;
  /** 内联会话列表插槽（仅 capabilities.inlineConversationList 为真时渲染） */
  readonly renderList?: (bindings: ThreadListBindings) => ReactNode;
}

/**
 * ThreadSurface —— 全部能力接线的唯一实现。
 *
 * 只做两件事：把 T11/T12/T13/T14/T16/T17/T18/T8/T15 的出参接到 JSX 上，
 * 以及把 URL 意图与 6 个 app 级事件的监听挂到 effect 里。
 */
function ThreadSurface({ profile, conversations, renderList }: ThreadSurfaceProps) {
  const location = useLocation(); // 监听 remote / selectConv 参数变化
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [input, setInput] = useState('');
  const [permissionLevel, setPermissionLevel] = useState(2);
  const [mode, setMode] = useState<'normal' | 'super'>('normal');
  const [deepThinking, setDeepThinking] = useState(false);
  const [webSearch, setWebSearch] = useState(true);
  const [loopMode, setLoopMode] = useState(false);
  const [workspacePath, setWorkspacePath] = useState('');
  const [templateOpen, setTemplateOpen] = useState(false);
  const plusRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);

  // 附件：state 供渲染，同步读供 submitMessage 在同一 tick 内取用（见 useAttachments 不变量）
  const attachment = useAttachments({
    onPicked: () => { if (profile.onAttachmentPicked === 'close-plus') setPlusMenuOpen(false); },
  });
  // 模型选择器：provider 列表、当前选中的 provider/model、load 永不覆盖手动选择
  const provider = useProviderSelection({ conversationId: null });

  /**
   * `?selectConv=xxx` 在**渲染期**就作为初始会话交给控制器 —— 此前它只在 effect 里
   * `setTimeout(loadMessages)`，于是首帧的 Run 状态条 / 工具活动 / Activity 流全部按
   * "空会话"渲染一帧再跳。URL 已经说明了要打开哪个会话，没有理由让首帧说谎。
   */
  const urlConversationId = useMemo(
    () => new URLSearchParams(location.search).get('selectConv'),
    [location.search],
  );

  const thread = useThreadController({
    capabilities: {
      ...profile.capabilities,
      deepThinking,
      loopMode,
      webSearch,
      attachments: profile.attachment ? attachment.attachments : [],
      selectedProvider: provider.selected,
      selectedModel: provider.selectedModel,
    },
    conversationId: urlConversationId,
    mode,
    providers: provider.providers,
    autoSelectConversation: profile.autoSelectConversation,
    conversations,
  });

  // 当前会话发布到 workspace store：Workbench（T21 useActiveRunId）与本页读**同一个** run，
  // 因此状态条与工作台不可能指向不同的 run。
  const setWorkspaceConversationId = useWorkspaceStore((s) => s.setConversationId);
  useEffect(() => { setWorkspaceConversationId(thread.conversationId); }, [setWorkspaceConversationId, thread.conversationId]);

  const retryLastSend = useRetryLastSend(thread.messages, thread.send);

  // ---- 页面数据刷新入口：会话列表 + 权限 + 工作目录 + provider 选择 ----
  const load = useCallback(async () => {
    await thread.loadConversations();
    api.getPermissions().then((res) => { setPermissionLevel(res?.level ?? 2); }).catch(() => {});
    api.getWorkspace().then((res) => { setWorkspacePath(typeof res?.defaultDir === 'string' ? res.defaultDir : ''); }).catch(() => {});
    void provider.load();
  }, [provider, thread]);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    void load();
  }, [load]);

  // ---- URL 意图：?new / ?q（sisyphusDeepLink）/ autoSelect 全部在控制器内 ----
  useEffect(() => {
    // `?new=true`（EXE 启动 / "新建对话"）：清掉上一次远程命令留下的入站标记。
    // 语义逐字沿用旧 CodingHome —— 意图本身由控制器内的 applyUrlIntent 落定。
    if (new URLSearchParams(window.location.search).get('new') === 'true') {
      sessionStorage.removeItem('aether_pending_remote');
    }
    void thread.bootstrap(window.location.search, profile.homePath);
  }, [profile.homePath, thread]);

  // ---- ?selectConv=xxx：Recent Work / 抽屉跨路由跳转带过来的目标会话（载入消息）----
  useEffect(() => {
    if (urlConversationId === null) return;
    window.history.replaceState({}, '', profile.homePath);
    void thread.loadMessages(urlConversationId);
  }, [profile.homePath, thread, urlConversationId]);

  // ---- 事件 ①：select-conversation（T19 ConversationsDrawer 派发）----
  useEffect(() => subscribeAppEvent('select-conversation', (detail) => {
    if (detail?.conversationId) void thread.loadMessages(detail.conversationId);
  }), [thread]);

  // ---- 事件 ②：remote-command（T14 远程命令宿主；失败只经 reportFailure 进失败卡）----
  useRemoteCommandHost({
    onUserCommand: profile.remoteCommand ? thread.appendUserMessage : IGNORE_USER_COMMAND,
    onOpenConversation: profile.remoteCommand ? thread.loadMessages : IGNORE_OPEN_CONVERSATION,
    onFailure: profile.remoteCommand ? thread.reportFailure : IGNORE_FAILURE,
  });

  // 会话切换后清掉上一个会话残留的生成（控制器内含 justSentRef 首条消息竞态守卫）
  useEffect(() => { thread.cancelStaleGeneration(); }, [thread, thread.conversationId]);

  useEffect(() => {
    if (!plusMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (plusRef.current && !plusRef.current.contains(e.target as Node)) setPlusMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [plusMenuOpen]);

  /**
   * 发送入口 —— 唯一职责是"确保会话存在"（首条消息建会话），
   * 流式 / 停止 / 失败 / Activity 全交给控制器。附件在同一次事件处理内由
   * takeForSend() 原子「取走 + 清空」。
   */
  const submitMessage = useCallback(async () => {
    if (thread.sending) return;
    const content = input.trim();
    const picked = profile.attachment ? attachment.takeForSend() : [];
    if (!content && picked.length === 0) return;
    setInput('');
    await thread.send(content);
  }, [attachment, input, profile.attachment, thread]);

  // ============================================================
  // 投影：Run 状态条 / 内联工具活动 / 审批态（T8 + T15 + T9 + T16 → T17）
  // ============================================================
  const { run: runStrip, toolActivities, approval } = useThreadProjection(thread);

  // ---- 统计读数（与 CodingHome 逐字同源）----
  const hasMessages = thread.messages.length > 0;
  const contextTokens = Math.round(thread.messages
    .filter((m) => m.role !== 'tool')
    .reduce((sum, m) => sum + m.content.length, 0) / 4);
  const providerSelectOptions = useMemo(() => toSelectOptions(provider.textProviders), [provider.textProviders]);
  const reasoning = profile.capabilities.reasoningBar && thread.liveReasoning.trim() !== ''
    ? <ReasoningBar content={thread.liveReasoning} />
    : null;
  const retryLine = thread.retryInfo === null
    ? null
    : `请求失败 (${thread.retryInfo.status})，${thread.retryInfo.attempt}/${thread.retryInfo.maxRetries} 次重试中…`;

  const newConversation = thread.clearThread;

  return (
    <PageShell
      className="h-screen px-4!"
      contentClassName="flex flex-col overflow-hidden! p-0!"
      style={{ maxWidth: 'var(--content-wide)', margin: '0 auto', background: 'var(--bg-base)', backgroundImage: 'var(--bg-gradient)' }}
      header={(
        <PageHeader
          title={profile.title}
          description={profile.description}
          icon={<Sparkles size={22} />}
          actions={(
            <button type="button" className="btn btn-primary" onClick={newConversation} title="新建对话">
              <Plus size={18} /> 新建对话
            </button>
          )}
        />
      )}
    >
      {/* 加载错误 banner：thread.loadError 与 provider.error 并入同一处（替代静默吞错） */}
      {(thread.loadError ?? provider.error) !== null && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '0 24px 8px' }}>
          <ErrorBanner
            message={thread.loadError ?? provider.error ?? ''}
            onRetry={() => { thread.reportError(null); void load(); }}
          />
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-row" style={{ gap: 0 }}>
        {profile.capabilities.inlineConversationList && renderList !== undefined && renderList({
          activeId: thread.conversationId,
          onClear: newConversation,
          onSelect: (id) => { void thread.loadMessages(id); },
          providers: provider.providers,
        })}

        <Panel className="flex min-h-0 flex-1 flex-col p-4!">
          {/* 轮询失败显式状态机 —— pollStatus / pollErrorInfo / retryPolling 三个返回值全部消费 */}
          <PollStatusBanner
            status={thread.pollStatus}
            errorInfo={thread.pollErrorInfo}
            onRetry={() => { thread.reportError(null); thread.retryPolling(); }}
            layout="banner"
          />

          {/* 失败态与"处理中"：T17 Thread 不含这两块（它的滚动容器刻意零副作用），故并到 Thread 之上 */}
          <div data-slot="thread-status-strip" className="flex flex-col">
            {thread.failure !== null && (
              <StreamFailureState failure={thread.failure} onRetry={retryLastSend} />
            )}
            {(thread.sending || thread.thinking) && <ThinkingDots />}
          </div>

          <Thread
            conversationId={thread.conversationId}
            messages={thread.messages}
            capabilities={{
              reasoning: profile.capabilities.reasoningBar,
              toolActivity: true,
              runStatus: true,
            }}
            reasoning={reasoning}
            run={runStrip}
            approval={{
              state: approval,
              onApprove: () => { void thread.decideApproval(true); },
              onReject: () => { void thread.decideApproval(false); },
            }}
            toolActivities={toolActivities}
            emptyHint={profile.emptyHint}
          >
            <ThreadComposerSlot
              profile={profile}
              input={input}
              onInputChange={setInput}
              onSubmit={() => { void submitMessage(); }}
              onStop={thread.stop}
              sending={thread.sending}
              retryLine={retryLine}
              templateOpen={templateOpen}
              onTemplateOpenChange={setTemplateOpen}
              voiceError={(message) => { thread.reportFailure(createStreamFailure(message)); }}
              attachment={attachment}
              plusMenuOpen={plusMenuOpen}
              onPlusMenuToggle={() => { setPlusMenuOpen((open) => !open); }}
              onPlusMenuDismiss={() => { setPlusMenuOpen(false); }}
              onNewConversation={newConversation}
              plusRef={plusRef}
              providerSelect={{
                selectedProviderId: profile.providerSelect ? (provider.selected?.id ?? null) : null,
                options: providerSelectOptions,
                onProviderChange: (providerId) => {
                  const picked = provider.providers.find((p) => p.id === providerId);
                  if (picked) provider.setSelected(picked);
                },
              }}
              toolbar={{
                mode,
                onModeChange: setMode,
                deepThinking,
                onDeepThinkingToggle: () => { setDeepThinking((d) => !d); },
                webSearch,
                onWebSearchToggle: () => { setWebSearch((w) => !w); },
                loopMode,
                onLoopModeToggle: () => { setLoopMode((l) => !l); },
              }}
              permissionLevel={permissionLevel}
              onPermissionLevelChange={setPermissionLevel}
            />

            <ThreadStatsBar
              hasMessages={hasMessages}
              messageCount={thread.messages.length}
              contextTokens={contextTokens}
              conversationTokenTotal={thread.tokenTotal}
              streamTokens={thread.streamTokens === null ? null : thread.streamTokens.total_tokens}
              loopMode={loopMode}
              sending={thread.sending}
              loopMetrics={thread.loopMetrics}
              workspacePath={workspacePath}
            />
          </Thread>
        </Panel>
      </div>
    </PageShell>
  );
}

// ============================================================
// 两个 variant：各自拥有"会话列表归谁"的答案，共享 ThreadSurface
// ============================================================

/** `/command-center`：会话列表归 T19 抽屉 / 侧栏，页面只校验列表可达 */
function WorkbenchThreadVariant() {
  const conversations = useMemo<ThreadConversationsPort>(
    () => ({ refresh: async () => { await api.getConversations(); } }),
    [],
  );
  return <ThreadSurface profile={THREAD_PAGE_PROFILES.workbench} conversations={conversations} />;
}

/** `/chat`：会话列表由本页内联渲染，因此这里才引入 useConversations */
function ChatThreadVariant() {
  const [listCollapsed, setListCollapsed] = useState(false);

  const conversations = useConversations({ onChange: () => {} });

  const port = useMemo<ThreadConversationsPort>(
    () => ({ refresh: conversations.load, create: (list) => conversations.handleNew([...list]) }),
    [conversations],
  );

  return (
    <ThreadSurface
      profile={THREAD_PAGE_PROFILES.chat}
      conversations={port}
      renderList={(bindings) => (
        <ChatConversationList
          conversations={conversations.conversations}
          loading={conversations.convLoading}
          collapsed={listCollapsed}
          activeId={bindings.activeId}
          onToggleCollapsed={() => { setListCollapsed((value) => !value); }}
          onNew={() => { void conversations.handleNew([...bindings.providers]); }}
          onSelect={(id) => { bindings.onSelect(id); }}
          onDelete={(id) => {
            void conversations.handleDelete(id).then(() => {
              if (bindings.activeId === id) bindings.onClear();
            });
          }}
          onRename={(id, title) => { void conversations.handleRename(id, title); }}
        />
      )}
    />
  );
}

/**
 * 路由入口。
 *
 * `variant` 是唯一差异：全能力（`/command-center`）或最小能力 + 内联列表（`/chat`）。
 * 两者渲染的是同一个 `ThreadSurface`，因此"行为漂移"在结构上不可能发生。
 */
export function ThreadPage({ variant }: { readonly variant: ThreadPageVariant }) {
  return variant === 'chat' ? <ChatThreadVariant /> : <WorkbenchThreadVariant />;
}

/** 加载失败 banner（可重试） */
function ErrorBanner({ message, onRetry }: { readonly message: string; readonly onRetry: () => void }) {
  return (
    <div style={{ width: '100%', maxWidth: 720, padding: '8px 16px', borderRadius: 8, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: 'var(--color-danger)', fontSize: 13, textAlign: 'center' }}>
      ⚠️ {message}
      <button type="button" onClick={onRetry} style={{ marginLeft: 8, background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', textDecoration: 'underline' }}>重试</button>
    </div>
  );
}
