import { useCallback, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Sidebar } from './shell/Sidebar';
import { ContextBar } from './shell/ContextBar';
import { WorkspaceFrame } from './shell/WorkspaceFrame';
import { WallpaperLayer } from './shell/WallpaperLayer';
import { CommandPalette } from './CommandPalette';
import { LiquidGlassFilter } from './LiquidGlassFilter';
import { api, authHeaders } from '../api/client';
import { requestNotificationPermission } from '../lib/notification-center';
import { useAppStore } from '../store/app';
import { useAppearanceStore, persistAppearance } from '../store/appearance';
import { useWorkspaceStore, persistWorkspace } from '../store/workspace';
import { Trash2 } from 'lucide-react';
import { confirm as confirmDialog } from './ui/confirm-dialog';

export function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const setUiMode = useAppStore((s) => s.setUiMode);

  const appearance = useAppearanceStore();
  const workspace = useWorkspaceStore();
  const sidebarMode = useWorkspaceStore((s) => s.sidebarMode);

  // 首次访问请求通知权限
  useEffect(() => {
    requestNotificationPermission();
  }, []);

  // ============================================================
  // Appearance 应用：colorScheme / uiTheme / material / glass 参数 → DOM
  // ============================================================
  useEffect(() => {
    const root = document.documentElement;
    // shadcn 兼容：始终加 .dark class（修复白框历史问题）
    root.classList.add('dark');
    // data-theme：uiTheme 映射（liquid-glass 为默认 dark）
    if (appearance.colorScheme === 'light') {
      root.setAttribute('data-theme', 'light');
    } else if (appearance.uiTheme !== 'liquid-glass') {
      root.setAttribute('data-theme', appearance.uiTheme);
    } else {
      root.removeAttribute('data-theme');
    }
    // 材质开关
    root.setAttribute('data-material', appearance.material.mode);
    // Glass 参数（克制默认由 themes.css 保证，滑块可覆盖）
    root.style.setProperty('--glass-blur-radius', `${appearance.material.blur}px`);
    root.style.setProperty('--glass-saturate', `${appearance.material.saturation}%`);
    root.style.setProperty('--glass-brightness', String(appearance.material.brightness));
    persistAppearance(appearance);
  }, [appearance]);

  // ============================================================
  // Workspace 应用：sidebar 宽度 / 持久化
  // ============================================================
  useEffect(() => {
    const root = document.documentElement;
    const width =
      sidebarMode === 'expanded' ? '224px' : sidebarMode === 'compact' ? '52px' : '0px';
    root.style.setProperty('--sidebar-width', width);
    persistWorkspace(workspace);
  }, [sidebarMode, workspace]);

  // ============================================================
  // 远程命令实时监听：手机端发指令 → 自动跳转 coding 对话
  // ============================================================
  useEffect(() => {
    const abortController = new AbortController();
    let cancelled = false;
    let lastId: string | null = null;

    const poll = async () => {
      if (cancelled) return;
      try {
        const res = await fetch('/api/sync/latest-command', {
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
          signal: abortController.signal,
        });
        if (cancelled) return;
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (data.hasNew && data.command) {
          const cmd = data.command;
          if ((cmd.status === 'pending' || cmd.status === 'processing') && cmd.id !== lastId) {
            lastId = cmd.id;
            window.dispatchEvent(new CustomEvent('remote-command', {
              detail: { content: cmd.content, id: cmd.id, conversationId: cmd.conversationId },
            }));
            try {
              sessionStorage.setItem('aether_pending_remote', JSON.stringify({
                content: cmd.content,
                commandId: cmd.id,
                conversationId: cmd.conversationId || null,
                receivedAt: Date.now(),
              }));
            } catch { /* ignore */ }
            setUiMode('coding');
            navigate(`/command-center?remote=${Date.now()}`);
          }
        }
      } catch {
        // 后端未启动或未配置同步，静默忽略
      }
    };

    poll();
    const interval = setInterval(poll, 1500);
    return () => {
      cancelled = true;
      abortController.abort();
      clearInterval(interval);
    };
  }, [navigate, setUiMode]);

  // ============================================================
  // 对话记录面板：全局状态（保留原功能）
  // ============================================================
  const [sidebarConvOpen, setSidebarConvOpen] = useState(false);
  const [conversations, setConversations] = useState<Array<{ id: string; title: string; updatedAt: string }>>([]);

  const loadConversations = useCallback(async () => {
    try {
      const convs = await api.getConversations();
      setConversations(convs || []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    const handler = () => loadConversations();
    window.addEventListener('conversations-changed', handler);
    return () => window.removeEventListener('conversations-changed', handler);
  }, [loadConversations]);

  const handleSelectConv = useCallback(async (id: string) => {
    setSidebarConvOpen(false);
    const path = window.location.pathname;
    if (path === '/command-center' || path === '/') {
      window.dispatchEvent(new CustomEvent('select-conversation', { detail: { conversationId: id } }));
    } else {
      navigate(`/command-center?selectConv=${id}`);
    }
  }, [navigate]);

  const handleDeleteConv = useCallback(async (id: string) => {
    if (!(await confirmDialog('确定删除此对话？'))) return;
    try {
      await api.deleteConversation(id);
      await fetch('/api/sync/delete-conversation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', ...authHeaders() },
        body: JSON.stringify({ conversationId: id }),
      }).catch(() => {});
      loadConversations();
    } catch (e: unknown) {
      alert('删除失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  }, [loadConversations]);

  useEffect(() => {
    const handler = () => setSidebarConvOpen((prev) => !prev);
    window.addEventListener('toggle-conv-panel', handler);
    return () => window.removeEventListener('toggle-conv-panel', handler);
  }, []);

  const glassOn = appearance.material.mode === 'glass';

  return (
    <div
      className="aether-app min-h-screen"
      style={{ background: 'var(--bg-base)', backgroundImage: 'var(--bg-gradient)' }}
    >
      {/* Level 0 — Environment */}
      <WallpaperLayer />

      {/* Liquid Glass SVG 滤镜（Glass ON 时才挂载） */}
      {glassOn && <LiquidGlassFilter />}

      {/* Level 4 — Overlay */}
      <CommandPalette />

      {/* Level 1 — Shell: Sidebar */}
      {sidebarMode !== 'hidden' && <Sidebar />}

      {/* Level 1 — Shell: 内容区（ContextBar + Workspace） */}
      <div
        className="aether-main-col"
        style={{
          marginLeft: 'var(--sidebar-width)',
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
          zIndex: 1,
          transition: 'margin-left 0.2s var(--anim-ease)',
        }}
      >
        <ContextBar />
        <WorkspaceFrame>
          <motion.div
            key={location.pathname}
            style={{ maxWidth: 'none', margin: '0 auto', flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
          >
            <Outlet />
          </motion.div>
        </WorkspaceFrame>
      </div>

      {/* 对话记录面板 — 全局可用（保留） */}
      <AnimatePresence>
        {sidebarConvOpen && (
          <motion.div
            initial={{ x: -300, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: -300, opacity: 0 }}
            transition={{ duration: 0.2 }}
            style={{
              position: 'fixed',
              left: 'var(--sidebar-width)',
              top: 36,
              bottom: 0,
              width: 260,
              zIndex: 40,
              display: 'flex',
              flexDirection: 'column',
              background: 'var(--bg-elevated)',
              borderRight: '1px solid var(--border-primary)',
              borderRadius: 0,
            }}
          >
            <div
              style={{
                padding: '10px 14px',
                borderBottom: '1px solid var(--border-primary)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span style={{ fontSize: 12, fontWeight: 600 }}>Chat History</span>
              <button
                onClick={() => setSidebarConvOpen(false)}
                aria-label="Close"
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--text-tertiary)',
                  padding: 6,
                  borderRadius: 6,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minWidth: 28,
                  minHeight: 28,
                  fontSize: 16,
                  lineHeight: 1,
                }}
              >
                ✕
              </button>
            </div>
            <div
              style={{
                overflowY: 'auto',
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                padding: 8,
              }}
            >
              {conversations.map((conv) => (
                <div
                  key={conv.id}
                  onClick={() => handleSelectConv(conv.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSelectConv(conv.id); }}
                  style={{
                    padding: '8px 10px',
                    borderRadius: 6,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    justifyContent: 'space-between',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {conv.title}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                      {new Date(conv.updatedAt).toLocaleString()}
                    </div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDeleteConv(conv.id); }}
                    aria-label="Delete conversation"
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: 'var(--text-tertiary)',
                      flexShrink: 0,
                      padding: 4,
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
              {conversations.length === 0 && (
                <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-tertiary)', fontSize: 12 }}>
                  No conversations yet
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
