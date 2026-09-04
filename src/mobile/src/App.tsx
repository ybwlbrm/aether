import { useState, useEffect, useCallback } from 'react';
import {
  isConfigured,
  saveConfig,
  loadConfig,
  registerDevice,
  disconnect,
  getClient,
  getStoredUrl,
} from './api/supabase';
import ConversationList from './components/ConversationList';
import MessageView from './components/MessageView';
import NewCommand from './components/NewCommand';
import AppearanceSettings from './components/AppearanceSettings';
import { LiquidGlassFilter } from './components/LiquidGlassFilter';
import './App.css';

// 页面类型
type Page = 'config' | 'list' | 'chat' | 'new-command' | 'appearance';

interface Conversation {
  id: string;
  title: string;
  model?: string;
  message_count?: number;
  updated_at: string;
  created_at: string;
}

export default function App() {
  const [page, setPage] = useState<Page>('config');
  const [selectedConv, setSelectedConv] = useState<Conversation | null>(null);
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [statusMsg, setStatusMsg] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (isConfigured()) {
      setConnected(true);
      setPage('list');
      registerDevice().catch(() => {});
    } else {
      // 密钥不再持久化：重启后预填 URL，要求重新输入 Key
      const storedUrl = getStoredUrl();
      if (storedUrl) {
        setUrl(storedUrl);
        setStatusMsg('出于安全，密钥不再持久保存，请重新输入 Key');
      }
    }
  }, []);

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

  // 全局挂载 Liquid Glass SVG 滤镜（供 backdrop-filter: url(#liquid-lens) 引用）
  const glassFilter = <LiquidGlassFilter />;

  const handleConnect = async () => {
    if (!url.trim() || !key.trim()) {
      setStatusMsg('请输入 Supabase URL 和 Key');
      return;
    }
    setConnecting(true);
    setStatusMsg('连接中...');

    try {
      saveConfig(url.trim(), key.trim());
      const registered = await registerDevice();
      if (registered) {
        setConnected(true);
        setStatusMsg('✅ 连接成功');
        setTimeout(() => {
          setPage('list');
          setStatusMsg('');
        }, 500);
      } else {
        setStatusMsg('❌ 设备注册失败，请检查配置');
      }
    } catch (e: unknown) {
      setStatusMsg(`❌ 连接失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = () => {
    disconnect();
    setConnected(false);
    setPage('config');
    setSelectedConv(null);
    setUrl('');
    setKey('');
    setStatusMsg('已断开连接');
  };

  const handleSelectConv = (conv: Conversation) => {
    setSelectedConv(conv);
    setPage('chat');
  };

  const handleBack = () => {
    setSelectedConv(null);
    setPage('list');
  };

  // 配置页面
  if (page === 'config') {
    return (
      <>
        {glassFilter}
        <div className="config-page">
        <h1>Aether</h1>
        <p>连接你的 Supabase 项目<br />以远程控制桌面端 Aether</p>
        <div className="config-form">
          <div>
            <label>Supabase URL</label>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://xxx.supabase.co"
              autoCapitalize="none"
              autoCorrect="off"
            />
          </div>
          <div>
            <label>Supabase Service Role Key（非 anon key）</label>
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="eyJhbGciOiJIUzI1NiIs..."
              autoCapitalize="none"
              autoCorrect="off"
            />
            <p style={{ fontSize: 11, marginTop: 4, color: 'var(--text-tertiary)' }}>
              安全提示：Key 仅保存在内存中，不会写入设备存储，重启 App 需重新输入。
              请在 Supabase 控制台 → Settings → API 中复制 Service Role Key。
            </p>
          </div>
          <button className="btn-primary" onClick={handleConnect} disabled={connecting || !url.trim() || !key.trim()}>
            {connecting ? '连接中...' : '连接'}
          </button>
          {statusMsg && <div className="status-msg" style={{ color: statusMsg.includes('✅') ? 'var(--success)' : statusMsg.includes('❌') ? 'var(--danger)' : 'var(--text-secondary)' }}>{statusMsg}</div>}
        </div>
        </div>
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
        <button onClick={handleDisconnect}>
          <span className="nav-icon">⚙️</span>
          断开
        </button>
      </div>
    </>
  );
}