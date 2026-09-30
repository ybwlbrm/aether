import { useEffect, useState, useCallback, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import {
  Diamond, MessageSquare, FolderKanban, Search, Workflow,
  Globe, Terminal as TerminalIcon, ArrowRight, ShieldCheck, Clock,
} from 'lucide-react';

/**
 * Dashboard（spec §13）—— 旧 CommandCenter 原样移入。
 *
 * 用户打开 Aether 时最重要的问题不是"我的 CPU 是多少"，而是"我要继续什么"。
 *   → 大输入框 + Recent Work + Quick 入口 + 一行 System health。
 *
 * ## T24：为什么它不再是首页
 * 此前本组件同时扮演两个角色：既是"首页"，又靠 `uiMode === 'coding'` 闸门
 * 切换成 CodingHome（伪造的模式 flag）。路由切换后"哪个表面"由 URL 表达：
 *   - `/command-center` → ThreadPage（真实路由）
 *   - `/dashboard`      → 本组件（旧 dashboard 原样保留）
 * 因此 `useAppStore` 的 `uiMode` 已离开渲染路径；`?new=true`（EXE 启动意图）
 * 直接 `navigate('/command-center')`，不再经模式 flag 中转。
 */

interface RecentItem {
  id: string;
  title: string;
  updatedAt: string;
}

/** 草稿发送的落点：Thread 主线的 ?q 直达 */
function threadDeepLink(prompt: string): string {
  return `/chat?q=${encodeURIComponent(prompt)}&new=true`;
}

export function Dashboard() {
  const navigate = useNavigate();
  const [healthFailed, setHealthFailed] = useState(false);
  const [providers, setProviders] = useState<Array<{ id: string }>>([]);
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    api.health().catch(() => setHealthFailed(true));
    api.getProviders().then(setProviders).catch(() => {});
    // Recent work：最近对话
    api.getConversations()
      .then((convs) => {
        const list = (convs ?? []).slice(0, 5).map((c: { id: string; title: string; updatedAt: string }) => ({
          id: c.id,
          title: c.title || 'Untitled conversation',
          updatedAt: c.updatedAt,
        }));
        setRecent(list);
      })
      .catch(() => {});

    // Q1 彻底修复：检测 URL ?new=true 参数（EXE 启动时 main.js 传入）。
    // T24：不再 setUiMode('coding')，而是直接导航到真实路由。
    const params = new URLSearchParams(window.location.search);
    if (params.get('new') === 'true') {
      window.history.replaceState({}, '', '/dashboard');
      navigate('/command-center');
    }
  }, [navigate]);

  const handleSend = useCallback((message: string) => {
    const trimmed = message.trim();
    if (!trimmed) return;
    navigate(threadDeepLink(trimmed));
  }, [navigate]);

  const handleDraftKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !(e.nativeEvent as unknown as { isComposing?: boolean }).isComposing) {
      e.preventDefault();
      handleSend(draft);
      setDraft('');
    }
  };

  const quickItems = [
    { label: 'New Chat', icon: <MessageSquare size={15} />, onClick: () => navigate('/chat') },
    { label: 'Open Project', icon: <FolderKanban size={15} />, onClick: () => navigate('/projects') },
    { label: 'Search', icon: <Search size={15} />, onClick: () => navigate('/search') },
    { label: 'Run Workflow', icon: <Workflow size={15} />, onClick: () => navigate('/workflows') },
    { label: 'Browser', icon: <Globe size={15} />, onClick: () => navigate('/browser') },
    { label: 'Terminal', icon: <TerminalIcon size={15} />, onClick: () => navigate('/terminal') },
  ];

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ maxWidth: 'var(--content-readable)', width: '100%', margin: '0 auto', padding: '56px 24px 0', flex: 1 }}>
        {/* Brand */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 40 }}>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 26,
              height: 26,
              borderRadius: 7,
              background: 'var(--accent-brand-subtle)',
              color: 'var(--accent-brand)',
            }}
          >
            <Diamond size={15} />
          </span>
          <span style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
            Aether
          </span>
        </div>

        {/* What are you working on? */}
        <h1
          style={{
            fontSize: 'var(--font-size-display)',
            fontWeight: 650,
            color: 'var(--text-primary)',
            letterSpacing: '-0.03em',
            marginBottom: 20,
          }}
        >
          What are you working on?
        </h1>

        {/* Composer */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '0 14px',
            height: 48,
            borderRadius: 'var(--radius-surface)',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-primary)',
            marginBottom: 48,
          }}
        >
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleDraftKeyDown}
            placeholder="让 Aether 帮我完成……"
            aria-label="What are you working on?"
            style={{
              flex: 1,
              outline: 'none',
              border: 'none',
              background: 'transparent',
              fontSize: 14,
              color: 'var(--text-primary)',
              fontFamily: 'inherit',
            }}
          />
          <button
            onClick={() => { handleSend(draft); setDraft(''); }}
            aria-label="Send"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 30,
              height: 30,
              borderRadius: 7,
              border: 'none',
              background: 'var(--accent-interactive)',
              color: '#fff',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <ArrowRight size={15} />
          </button>
        </div>

        {/* Recent Work */}
        <section style={{ marginBottom: 40 }}>
          <h2 style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-tertiary)', marginBottom: 10 }}>
            Recent Work
          </h2>
          {recent.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>No recent work yet — start with a new chat.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {recent.map((item) => (
                <button
                  key={item.id}
                  onClick={() => navigate(`/command-center?selectConv=${item.id}`)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '9px 10px',
                    borderRadius: 'var(--radius-control)',
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    textAlign: 'left',
                    color: 'var(--text-secondary)',
                    fontSize: 13,
                  }}
                >
                  <Clock size={14} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.title}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text-tertiary)', flexShrink: 0 }}>
                    {new Date(item.updatedAt).toLocaleString()}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* Quick */}
        <section style={{ marginBottom: 48 }}>
          <h2 style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-tertiary)', marginBottom: 10 }}>
            Quick
          </h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {quickItems.map((item) => (
              <button
                key={item.label}
                onClick={item.onClick}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  height: 34,
                  padding: '0 12px',
                  borderRadius: 'var(--radius-control)',
                  border: '1px solid var(--border-primary)',
                  background: 'var(--bg-surface)',
                  color: 'var(--text-secondary)',
                  fontSize: 12.5,
                  cursor: 'pointer',
                }}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </div>
        </section>

        {/* System health（spec §13.3） */}
        <section style={{ paddingBottom: 40 }}>
          <h2 style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-tertiary)', marginBottom: 10 }}>
            System
          </h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-secondary)' }}>
            <ShieldCheck size={15} style={{ color: 'var(--color-success)' }} />
            {healthFailed ? 'Backend unreachable' : providers.length > 0 ? 'All systems ready' : 'All systems ready'}
            {providers.length > 0 && (
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>· {providers.length} provider(s)</span>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
