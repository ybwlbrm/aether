import { useState } from 'react';
import {
  saveConfig,
  signIn,
  signUp,
  registerDevice,
  SupabaseApiError,
} from '../api/supabase';

// 认证表单模式
type AuthMode = 'signin' | 'signup';

interface Props {
  initialUrl?: string;
  initialAnonKey?: string;
  /** 登录/注册成功且设备注册完成后回调（由 App 切换页面） */
  onAuthenticated: () => void;
}

/**
 * 登录 / 注册页面（P0-A01/A02/A03 修复）。
 * 替代原「手填 Supabase Service Role Key」配置页：
 * 使用公开 Anon Key + 邮箱密码登录建立用户身份，RLS 按 user_id 行级隔离。
 */
export default function LoginPage({ initialUrl, initialAnonKey, onAuthenticated }: Props) {
  const [url, setUrl] = useState(initialUrl ?? '');
  const [anonKey, setAnonKey] = useState(initialAnonKey ?? '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authMode, setAuthMode] = useState<AuthMode>('signin');
  const [statusMsg, setStatusMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmitAuth = async () => {
    if (!url.trim() || !anonKey.trim() || !email.trim() || !password) {
      setStatusMsg('请填写完整的 Supabase URL、Anon Key、邮箱和密码');
      return;
    }
    setBusy(true);
    setStatusMsg(authMode === 'signin' ? '登录中...' : '注册中...');

    try {
      // 保存连接配置（anon key 公开安全，可持久化）
      saveConfig(url.trim(), anonKey.trim());

      if (authMode === 'signin') {
        await signIn(email.trim(), password);
      } else {
        const result = await signUp(email.trim(), password);
        if (result.needsEmailConfirm) {
          setStatusMsg('✅ 注册成功，请前往邮箱完成验证后再登录');
          setAuthMode('signin');
          setBusy(false);
          return;
        }
      }

      // 设备注册绑定当前 userId（P0-A05）
      const registered = await registerDevice();
      if (!registered) {
        setStatusMsg('⚠️ 设备注册失败，远程命令可能无法下发');
      } else {
        setStatusMsg(authMode === 'signin' ? '✅ 登录成功' : '✅ 注册成功');
      }
      setPassword('');
      onAuthenticated();
    } catch (e: unknown) {
      const msg = e instanceof SupabaseApiError ? e.message : (e instanceof Error ? e.message : String(e));
      setStatusMsg(`❌ ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="config-page">
      <h1>Aether</h1>
      <p>登录你的 Supabase 账号<br />以远程控制桌面端 Aether</p>
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
          <label>Supabase Anon Key（公开密钥）</label>
          <input
            type="password"
            value={anonKey}
            onChange={(e) => setAnonKey(e.target.value)}
            placeholder="eyJhbGciOiJIUzI1NiIs..."
            autoCapitalize="none"
            autoCorrect="off"
          />
          <p style={{ fontSize: 11, marginTop: 4, color: 'var(--text-tertiary)' }}>
            Anon Key 可公开（用于建立加密连接），数据访问由登录账号 + 行级安全策略控制。
            请勿填写 Service Role Key。
          </p>
        </div>
        <div>
          <label>邮箱</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="email"
          />
        </div>
        <div>
          <label>密码</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete={authMode === 'signin' ? 'current-password' : 'new-password'}
          />
        </div>
        <button className="btn-primary" onClick={handleSubmitAuth} disabled={busy || !url.trim() || !anonKey.trim() || !email.trim() || !password}>
          {busy ? '处理中...' : authMode === 'signin' ? '登录' : '注册'}
        </button>
        <button className="btn-ghost" onClick={() => setAuthMode(authMode === 'signin' ? 'signup' : 'signin')} disabled={busy}>
          {authMode === 'signin' ? '没有账号？去注册' : '已有账号？去登录'}
        </button>
        {statusMsg && (
          <div className="status-msg" style={{ color: statusMsg.includes('✅') ? 'var(--success)' : statusMsg.includes('❌') ? 'var(--danger)' : 'var(--text-secondary)' }}>
            {statusMsg}
          </div>
        )}
      </div>
    </div>
  );
}
