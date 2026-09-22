import { useState, useEffect, useCallback, useRef } from 'react';
import { Home, MessageSquare, User } from 'lucide-react';
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
import AppearanceSettings from './components/AppearanceSettings';
import LoginPage from './components/LoginPage';
import MinePage from './components/MinePage';
import './App.css';

// 页面类型（list 拆为 home / conversations，复用同一组件 variant）
type Page = 'auth' | 'home' | 'conversations' | 'chat' | 'appearance' | 'mine';

interface Conversation {
  id: string;
  title: string;
  model?: string;
  message_count?: number;
  updated_at: string;
  created_at: string;
}

// §29 Auth 启动状态
type AuthState = 'checking' | 'authenticated' | 'unauthenticated' | 'error';

function generateConvId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : 'remote-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

export default function App() {
  const [page, setPage] = useState<Page>('auth');
  const [authState, setAuthState] = useState<AuthState>('checking');
  const [booting, setBooting] = useState(true);
  const [selectedConv, setSelectedConv] = useState<Conversation | null>(null);
  const [statusMsg, setStatusMsg] = useState('');
  const authUnsubRef = useRef<(() => void) | null>(null);

  // §46 全局恢复：应用启动时从 localStorage 恢复自定义背景（单一 DOM 入口）
  useEffect(() => {
    try {
      const savedBg = localStorage.getItem('aether_mobile_bg');
      if (savedBg) {
        document.body.style.backgroundImage = `url(${savedBg})`;
        document.body.style.backgroundSize = 'cover';
        document.body.style.backgroundPosition = 'center';
        document.body.style.backgroundAttachment = 'fixed';
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
        setAuthState('unauthenticated');
        setSelectedConv(null);
        setStatusMsg('已退出登录');
      }
    });
  }, []);

  // §29 启动流：区分 checking / authenticated / unauthenticated / error
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const session = await getSession();
        if (cancelled) return;
        subscribeAuth();

        if (session) {
          setAuthState('authenticated');
          // 已登录：注册设备后进入主界面（注册失败不阻断，记录警告）
          const registered = await registerDevice();
          if (cancelled) return;
          if (!registered) {
            setStatusMsg('设备注册失败，远程命令可能无法下发');
          }
          setPage('home');
        } else {
          setAuthState('unauthenticated');
        }
      } catch (e: unknown) {
        // 网络异常不要伪装成未登录（§29）
        console.warn('启动恢复会话失败:', e instanceof Error ? e.message : e);
        setAuthState('error');
        setStatusMsg('无法连接服务器，请检查网络后重试');
      } finally {
        setBooting(false);
      }
    })();
    return () => { cancelled = true; };
  }, [subscribeAuth]);

  const handleAuthenticated = useCallback(() => {
    // 认证成功后确保 auth 监听已挂载（client 此时已创建）
    subscribeAuth();
    setAuthState('authenticated');
    setPage('home');
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
      setAuthState('unauthenticated');
      setSelectedConv(null);
      setStatusMsg('已退出登录');
    }
  };

  const handleSelectConv = (conv: Conversation) => {
    setSelectedConv(conv);
    setPage('chat');
  };

  // §4：统一新指令入口 → 创建新 conversation 进入统一 Chat（不再进旧 NewCommand）
  const handleNewCommand = () => {
    const now = new Date().toISOString();
    const newConv: Conversation = {
      id: generateConvId(),
      title: '新对话',
      created_at: now,
      updated_at: now,
    };
    setSelectedConv(newConv);
    setPage('chat');
  };

  const handleBack = () => {
    setSelectedConv(null);
    setPage('home');
  };

  // Floating Bottom Navigation（仅 home / conversations / mine 三页显示）
  const showNav = page === 'home' || page === 'conversations' || page === 'mine';
  const navTab: 'home' | 'conversations' | 'mine' =
    page === 'home' ? 'home' : page === 'conversations' ? 'conversations' : page === 'mine' ? 'mine' : 'home';

  // 启动中：显示加载页（§29 checking 态）
  if (booting) {
    return (
      <div className="config-page">
        <AetherTitle />
        {authState === 'error' ? (
          <div className="empty-state">
            <h3 className="empty-state-title">无法连接服务器</h3>
            <p className="empty-state-desc">请检查网络后重试</p>
            <button className="btn-primary" onClick={() => { setBooting(true); setAuthState('checking'); window.location.reload(); }} style={{ marginTop: 16, width: 'auto', padding: '0 28px' }}>
              重新连接
            </button>
          </div>
        ) : (
          <div className="loading">
            <div className="spinner" />
            正在恢复会话...
          </div>
        )}
      </div>
    );
  }

  // 登录 / 注册页面（含 error 提示）
  if (page === 'auth') {
    return (
      <>
        <LoginPage
          initialUrl={getStoredUrl() ?? undefined}
          initialAnonKey={getStoredAnonKey() ?? undefined}
          onAuthenticated={handleAuthenticated}
        />
        {statusMsg && <div className="status-toast">{statusMsg}</div>}
      </>
    );
  }

  // 聊天页面（沉浸，无底部导航）— 统一 Chat（含新对话）
  if (page === 'chat' && selectedConv) {
    return (
      <MessageView
        conversationId={selectedConv.id}
        conversationTitle={selectedConv.title}
        onBack={handleBack}
      />
    );
  }

  // 外观设置页面
  if (page === 'appearance') {
    return (
      <>
        <AppearanceSettings onBack={handleBack} />
      </>
    );
  }

  // 我的页面
  if (page === 'mine') {
    return (
      <>
        <MinePage
          onOpenAppearance={() => setPage('appearance')}
          onSignOut={handleSignOut}
        />
        <FloatingNav tab={navTab} onTab={(t) => setPage(t)} />
        {statusMsg && <div className="status-toast">{statusMsg}</div>}
      </>
    );
  }

  // 首页 / 对话列表（复用 ConversationList，variant 控制）
  const isHome = page === 'home';
  return (
    <div className="page-shell">
      <ConversationList
        onSelect={handleSelectConv}
        onNewCommand={handleNewCommand}
        variant={isHome ? 'home' : 'conversations'}
      />
      {showNav && <FloatingNav tab={navTab} onTab={(t) => setPage(t)} />}
      {statusMsg && <div className="status-toast">{statusMsg}</div>}
    </div>
  );
}

// ============================================================
// Floating Liquid Glass Island（§36）
// ============================================================
function FloatingNav({
  tab,
  onTab,
}: {
  tab: 'home' | 'conversations' | 'mine';
  onTab: (t: 'home' | 'conversations' | 'mine') => void;
}) {
  const items = [
    { key: 'home' as const, icon: Home, label: '首页' },
    { key: 'conversations' as const, icon: MessageSquare, label: '对话' },
    { key: 'mine' as const, icon: User, label: '我的' },
  ];
  return (
    <nav className="floating-nav" aria-label="主导航">
      {items.map((it) => {
        const Icon = it.icon;
        return (
          <button
            key={it.key}
            className={`floating-nav-item ${tab === it.key ? 'active' : ''}`}
            onClick={() => onTab(it.key)}
          >
            <Icon size={18} className="floating-nav-icon" />
            <span className="floating-nav-label">{it.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

// 品牌标题（启动页）
function AetherTitle() {
  return <h1 style={{ fontSize: 30, fontWeight: 700, marginBottom: 10, color: 'var(--text-primary)' }}>Aether</h1>;
}