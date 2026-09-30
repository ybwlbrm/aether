import { useEffect } from 'react';
import { motion } from 'framer-motion';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { AppShell } from './shell/AppShell';
import { WorkspaceFrame } from './shell/WorkspaceFrame';
import { dispatchAppEvent } from '../lib/events';

/** 远程指令轮询间隔（ms） */
const REMOTE_POLL_INTERVAL_MS = 1500;

/**
 * Layout — 路由壳（T20 拆分后仅剩「远程指令轮询 + 路由出口」）。
 *
 * DOM 副作用全部下沉到 AppShell（唯一 documentElement 写入者）；
 * 分栏与响应式在 WorkspaceFrame；会话抽屉在 ConversationsDrawer。
 */
export function Layout() {
  const location = useLocation();
  const navigate = useNavigate();

  // ============================================================
  // 远程命令实时监听：手机端发指令 → 自动跳转 Thread 主线
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
        if (cancelled || !res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (data.hasNew && data.command) {
          const cmd = data.command;
          if ((cmd.status === 'pending' || cmd.status === 'processing') && cmd.id !== lastId) {
            lastId = cmd.id;
            dispatchAppEvent('remote-command', {
              content: cmd.content,
              id: cmd.id,
              conversationId: cmd.conversationId,
            });
            try {
              sessionStorage.setItem('aether_pending_remote', JSON.stringify({
                content: cmd.content,
                commandId: cmd.id,
                conversationId: cmd.conversationId || null,
                receivedAt: Date.now(),
              }));
            } catch { /* ignore */ }
            // T24：目标表面由真实路由表达，不再经 uiMode 模式 flag 中转
            navigate(`/command-center?remote=${Date.now()}`);
          }
        }
      } catch {
        // 后端未启动或未配置同步，静默忽略
      }
    };

    poll();
    const interval = setInterval(poll, REMOTE_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      abortController.abort();
      clearInterval(interval);
    };
  }, [navigate]);

  return (
    <AppShell>
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
    </AppShell>
  );
}
