import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import {
  saveConfig,
  signIn,
  signUp,
  registerDevice,
  SupabaseApiError,
  classifyError,
} from '../api/supabase';
import { createClient } from '@supabase/supabase-js';
import AetherMark from './AetherMark';

type AuthMode = 'signin' | 'signup';

interface Props {
  initialUrl?: string;
  initialAnonKey?: string;
  onAuthenticated: () => void;
}

export default function LoginPage({ initialUrl, initialAnonKey, onAuthenticated }: Props) {
  const [url, setUrl] = useState(initialUrl ?? '');
  const [anonKey, setAnonKey] = useState(initialAnonKey ?? '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authMode, setAuthMode] = useState<AuthMode>('signin');
  const [statusMsg, setStatusMsg] = useState('');
  const [statusTone, setStatusTone] = useState<'success' | 'error' | 'warning' | 'info'>('info');
  const [busy, setBusy] = useState(false);
  const [serverOpen, setServerOpen] = useState(false);
  // §44：连接测试状态
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState('');
  const [testTone, setTestTone] = useState<'success' | 'error' | 'info'>('info');

  // §44：连接测试 — 用临时 client 预检 Supabase 连通性（不保存配置）
  const handleTestConnection = async () => {
    if (!url.trim() || !anonKey.trim()) {
      setTestMsg('请先填写服务器地址和 Anon Key');
      setTestTone('error');
      return;
    }
    setTesting(true);
    setTestMsg('');
    try {
      const temp = createClient(url.trim(), anonKey.trim(), {
        auth: { persistSession: false },
        realtime: { heartbeatIntervalMs: 15000 },
      });
      // 轻量连通性探测：查 knowledge 表 head（存在性查询）
      const { error } = await temp.from('knowledge').select('device_id', { count: 'exact', head: true });
      if (error) {
        const err = classifyError(error);
        setTestMsg(`连接失败：${err.message}`);
        setTestTone('error');
      } else {
        setTestMsg('连接成功，服务器可用');
        setTestTone('success');
      }
      void temp.realtime.removeAllChannels();
    } catch (e) {
      const err = classifyError(e);
      setTestMsg(`连接失败：${err.message}`);
      setTestTone('error');
    } finally {
      setTesting(false);
    }
  };

  const handleSubmitAuth = async () => {
    // 四字段校验（URL/Key 在 Sheet 内，仍参与校验）— 业务逻辑原样
    if (!url.trim() || !anonKey.trim() || !email.trim() || !password) {
      setStatusMsg('请填写完整的 Supabase URL、Anon Key、邮箱和密码');
      setStatusTone('error');
      return;
    }
    setBusy(true);
    setStatusMsg(authMode === 'signin' ? '登录中...' : '注册中...');
    setStatusTone('info');

    try {
      saveConfig(url.trim(), anonKey.trim());

      if (authMode === 'signin') {
        await signIn(email.trim(), password);
      } else {
        const result = await signUp(email.trim(), password);
        if (result.needsEmailConfirm) {
          setStatusMsg('注册成功，请前往邮箱完成验证后再登录');
          setStatusTone('success');
          setAuthMode('signin');
          setBusy(false);
          return;
        }
      }

      const registered = await registerDevice();
      if (!registered) {
        setStatusMsg('设备注册失败，远程命令可能无法下发');
        setStatusTone('warning');
      } else {
        setStatusMsg(authMode === 'signin' ? '登录成功' : '注册成功');
        setStatusTone('success');
      }
      setPassword('');
      onAuthenticated();
    } catch (e: unknown) {
      const msg = e instanceof SupabaseApiError ? e.message : (e instanceof Error ? e.message : String(e));
      setStatusMsg(msg);
      setStatusTone('error');
    } finally {
      setBusy(false);
    }
  };

  const switchMode = () => {
    setAuthMode(authMode === 'signin' ? 'signup' : 'signin');
    setStatusMsg('');
  };

  return (
    <div className="login-page fade-in">
      <AetherMark size={56} className="login-mark" />
      <h1 className="login-title">Aether</h1>
      <p className="login-subtitle">远程连接你的 AI 工作站</p>

      <form
        className="login-form"
        onSubmit={(e) => { e.preventDefault(); handleSubmitAuth(); }}
      >
        {/* Grouped Input Surface — iOS 设置分组输入 */}
        <div className="login-group">
          <div className="login-group-item">
            <span className="login-field-label">邮箱</span>
            <input
              className="login-input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="email"
              disabled={busy}
            />
          </div>
          <div className="login-group-item">
            <span className="login-field-label">密码</span>
            <input
              className="login-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete={authMode === 'signin' ? 'current-password' : 'new-password'}
              disabled={busy}
            />
          </div>
        </div>

        <button
          className="btn-primary login-submit"
          type="submit"
          disabled={busy || !email.trim() || !password}
        >
          {busy ? '处理中…' : authMode === 'signin' ? '登录' : '注册'}
        </button>

        <button
          type="button"
          className="login-toggle"
          onClick={switchMode}
          disabled={busy}
        >
          {authMode === 'signin' ? '注册账号' : '已有账号？去登录'}
        </button>

        {statusMsg && (
          <p className="login-status" data-tone={statusTone}>
            {statusMsg}
          </p>
        )}

        {/* 次要设置入口 */}
        <button
          type="button"
          className="login-server-link"
          onClick={() => setServerOpen(true)}
          disabled={busy}
        >
          <span>服务器连接设置</span>
          <ChevronRight size={16} />
        </button>
      </form>

      {serverOpen && (
        <div className="sheet-backdrop" onClick={() => setServerOpen(false)}>
          <div className="sheet login-server-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-handle" />
            <h3 className="sheet-title">服务器连接设置</h3>
            <label className="login-field">
              <span className="login-field-label">服务器地址</span>
              <input
                className="login-input"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://xxx.supabase.co"
                autoCapitalize="none"
                autoCorrect="off"
                disabled={busy}
              />
            </label>
            <label className="login-field">
              <span className="login-field-label">公开密钥（Anon Key）</span>
              <input
                className="login-input"
                type="password"
                value={anonKey}
                onChange={(e) => setAnonKey(e.target.value)}
                placeholder="eyJhbGciOiJIUzI1NiIs..."
                autoCapitalize="none"
                autoCorrect="off"
                disabled={busy}
              />
            </label>
            <p className="login-sheet-hint">
              Anon Key 可公开（用于建立加密连接），数据访问由登录账号 + 行级安全策略控制。请勿填写 Service Role Key。
            </p>
            <button
              className="btn-ghost"
              onClick={handleTestConnection}
              disabled={testing}
              style={{ width: '100%', marginBottom: 8 }}
            >
              {testing ? '测试中…' : '测试连接'}
            </button>
            {testMsg && (
              <p className="login-status" data-tone={testTone} style={{ marginBottom: 8 }}>
                {testMsg}
              </p>
            )}
            <button className="btn-primary sheet-done" onClick={() => setServerOpen(false)} disabled={busy}>
              完成
            </button>
          </div>
        </div>
      )}
    </div>
  );
}