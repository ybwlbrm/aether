import { useState, useEffect, useCallback, useRef } from 'react';
import {
  getStoredUrl,
  getStoredAnonKey,
  signOut,
  getSession,
  onAuthStateChange,
  registerDevice,
  cleanup,
} from './api/supabase';
import ConversationList from './components/ConversationList';
import MessageView from './components/MessageView';
import NewCommand from './components/NewCommand';
import AppearanceSettings from './components/AppearanceSettings';
import LoginPage from './components/LoginPage';
import { LiquidGlassFilter } from './components/LiquidGlassFilter';
import './App.css';

// 页面类型
type Page = 'auth' | 'list' | 'chat' | 'new-command' | 'appearance';

interface Conversation {
  id: string;
  title: string;
  model?: string;
  message_count?: number;
  updated_at: string;
  created_at: string;
}

export default function App() {
  const [page, setPage] = useState<Page>('auth');
  const [booting, setBooting] = useState(true);
  const [selectedConv, setSelectedConv] = useState<Conversation | null>(null);
  const [statusMsg, setStatusMsg] = useState('');
  const authUnsubRef = useRef<(() => void) | null>(null);

  // 全局恢复：应用启动时从 localStorage 恢复自定义背景
  useEffect(() => {
    try {
      const savedBg = localStorage.getItem('aether_mobile_bg');
      if (savedBg) {
        const bgValue = `url(${savedBg})`;
        document.body.style.backgroundImage = bgValue;
        document.body.style.backgroundSize = 'cover';
        document.body.style.backgroundPosition = 'center';
        document.body.style.backgroundAttachment = 'fixed';
        const layout = document.querySelector('.app-layout') as HTMLElement | null;
        if (layout) {
          layout.style.backgroundImage = bgValue;
          layout.style.backgroundSize = 'cover';
          layout.style.backgroundPosition = 'center';
          layout.style.backgroundAttachment = 'fixed';
        }
      }
    } catch { /* ignore */ }
  }, []);

  // 注册认证状态监听（单一订阅，client 重建后可重入）
  const subscribeAuth = useCallback(() => {
    if (authUnsubRef.current) {
      authUnsubRef.current();
      authUnsubRef.current = null;
    }
    authUnsubRef.current = onAuthStateChange((event, session) => {
      // 初始事件（读取持久化 session）不处理，由启动流程决定页面
      if (event === 'INITIAL_SESSION') return;
      // 登出 / session 失效 → 回到登录页
      if (!session || event === 'SIGNED_OUT') {
        setPage('auth');
        setSelectedConv(null);
        setStatusMsg('已退出登录');
      }
    });
  }, []);

  // 启动流（任务 §21）：load auth session → validate → device registration → 主界面
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const session = await getSession();
      if (cancelled) return;
      subscribeAuth();

      if (session) {
        // 已登录：注册设备后进入主界面（注册失败不阻断，记录警告）
        const registered = await registerDevice();
        if (cancelled) return;
        if (!registered) {
          setStatusMsg('⚠️ 设备注册失败，远程命令可能无法下发');
        }
        setPage('list');
      }
      setBooting(false);
    })();
    return () => { cancelled = true; };
  }, [subscribeAuth]);

  // 全局挂载 Liquid Glass SVG 滤镜（供 backdrop-filter: url(#liquid-lens) 引用）
  const glassFilter = <LiquidGlassFilter />;

  const handleAuthenticated = useCallback(() => {
    // 认证成功后确保 auth 监听已挂载（client 此时已创建）
    subscribeAuth();
    setPage('list');
    setTimeout(() => setStatusMsg(''), 1200);
  }, [subscribeAuth]);

  const handleSignOut = async () => {
    try {
      await signOut();
    } catch (e: unknown) {
      console.warn('登出失败:', e instanceof Error ? e.message : e);
    } finally {
      cleanup();
      setPage('auth');
      setSelectedConv(null);
      setStatusMsg('已退出登录');
    }
  };

  const handleSelectConv = (conv: Conversation) => {
    setSelectedConv(conv);
    setPage('chat');
  };

  const handleBack = () => {
    setSelectedConv(null);
    setPage('list');
  };

  // 启动中：显示加载页
  if (booting) {
    return (
      <>
        {glassFilter}
        <div className="config-page">
          <h1>Aether</h1>
          <div className="loading">
            <div className="spinner" />
            正在恢复会话...
          </div>
        </div>
      </>
    );
  }

  // 登录 / 注册页面（P0-A01/A02：不再手填 Service Role Key）
  if (page === 'auth') {
    return (
      <>
        {glassFilter}
        <LoginPage
          initialUrl={getStoredUrl() ?? undefined}
          initialAnonKey={getStoredAnonKey() ?? undefined}
          onAuthenticated={handleAuthenticated}
        />
      </>
    );
  }

  // 聊天页面
  if (page === 'chat' && selectedConv) {
    return (
      <>
        {glassFilter}
        <MessageView
          conversationId={selectedConv.id}
          conversationTitle={selectedConv.title}
          onBack={handleBack}
        />
      </>
    );
  }

  // 新命令页面
  if (page === 'new-command') {
    return (
      <>
        {glassFilter}
        <NewCommand onBack={handleBack} />
      </>
    );
  }

  // 外观设置页面
  if (page === 'appearance') {
    return (
      <>
        {glassFilter}
        <AppearanceSettings onBack={handleBack} />
      </>
    );
  }

  // 对话列表页面（默认）
  return (
    <>
      {glassFilter}
      <ConversationList
        onSelect={handleSelectConv}
        onNewCommand={() => setPage('new-command')}
      />
      {/* 底部导航 */}
      <div className="bottom-nav">
        <button className="active" onClick={() => setPage('list')}>
          <span className="nav-icon">💬</span>
          对话
        </button>
        <button onClick={() => setPage('new-command')}>
          <span className="nav-icon">✏️</span>
          新指令
        </button>
        <button onClick={() => setPage('appearance')}>
          <span className="nav-icon">🎨</span>
          外观
        </button>
        <button onClick={handleSignOut}>
          <span className="nav-icon">🚪</span>
          登出
        </button>
      </div>
      {statusMsg && (
        <div className="status-msg" style={{ position: 'fixed', bottom: 72, left: 16, right: 16, textAlign: 'center', color: statusMsg.includes('⚠️') ? 'var(--warning, #f59e0b)' : 'var(--text-secondary)' }}>
          {statusMsg}
        </div>
      )}
    </>
  );
}
