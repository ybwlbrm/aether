import { useEffect, useState, useRef, useCallback } from 'react';
import { Link2, Unlink, RefreshCw, Upload, Download, FileText, Cloud } from 'lucide-react';
import { api } from '../../api/client';
import { confirm as confirmDialog } from '../../components/ui/confirm-dialog';

interface SyncSettingsProps {
  supabaseUrl: string;
  setSupabaseUrl: (url: string) => void;
  supabaseKey: string;
  setSupabaseKey: (key: string) => void;
  connected: boolean;
  setConnected: (connected: boolean) => void;
  keyResolved: boolean;
  setKeyResolved: (resolved: boolean) => void;
  syncing: boolean;
  setSyncing: (syncing: boolean) => void;
  syncMsg: string;
  setSyncMsg: (msg: string) => void;
  lastSync: string | null;
  setLastSync: (sync: string | null) => void;
  realtimeEnabled: boolean;
  setRealtimeEnabled: (enabled: boolean) => void;
  authUser: { email: string } | null;
  setAuthUser: (user: { email: string } | null) => void;
  authEmail: string;
  setAuthEmail: (email: string) => void;
  authPassword: string;
  setAuthPassword: (password: string) => void;
  authMsg: string;
  setAuthMsg: (msg: string) => void;
  showAuth: boolean;
  setShowAuth: (show: boolean) => void;
  uploadedFiles: { name: string; size: number; dataUrl: string; uploadedAt: string }[];
  setUploadedFiles: (files: { name: string; size: number; dataUrl: string; uploadedAt: string }[]) => void;
  fileInputRef: React.RefObject<HTMLInputElement>;
  handleConnect: () => Promise<void>;
  handleDisconnect: () => Promise<void>;
  handleToggleRealtime: () => Promise<void>;
  handleAuth: () => Promise<void>;
  handleLogout: () => Promise<void>;
  handleFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleSync: () => Promise<void>;
}

export function SyncSettings({
  supabaseUrl,
  setSupabaseUrl,
  supabaseKey,
  setSupabaseKey,
  connected,
  setConnected,
  keyResolved,
  setKeyResolved,
  syncing,
  setSyncing,
  syncMsg,
  setSyncMsg,
  lastSync,
  setLastSync,
  realtimeEnabled,
  setRealtimeEnabled,
  authUser,
  setAuthUser,
  authEmail,
  setAuthEmail,
  authPassword,
  setAuthPassword,
  authMsg,
  setAuthMsg,
  showAuth,
  setShowAuth,
  uploadedFiles,
  setUploadedFiles,
  fileInputRef,
  handleConnect,
  handleDisconnect,
  handleToggleRealtime,
  handleAuth,
  handleLogout,
  handleFileUpload,
  handleSync,
}: SyncSettingsProps) {
  return (
    <div className="glass-card" style={{ padding: '24px' }}>
      <h2 style={{ fontSize: 'var(--font-module-title)', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 20 }}>
        <Cloud size={20} style={{ display: 'inline', marginRight: 8 }} />云同步
      </h2>
      <p style={{ fontSize: '13px', color: 'var(--text-tertiary)', marginBottom: 20 }}>
        通过 Supabase 同步知识库和设置到云端，支持多设备间同步（密码库不同步）
      </p>

      {!connected ? (
        <div className="space-y-4">
          <div>
            <label className="block text-sm" style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>Supabase URL</label>
            <input className="input" value={supabaseUrl} onChange={e => setSupabaseUrl(e.target.value)} placeholder="https://xxx.supabase.co" />
          </div>
          <div>
            <label className="block text-sm" style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>Supabase Service Role Key（非 anon key）</label>
            <input className="input" type="password" value={supabaseKey} onChange={e => setSupabaseKey(e.target.value)} placeholder="eyJhbGciOiJIUzI1NiIs..." />
            <p style={{ fontSize: '12px', color: 'var(--text-warning)', marginTop: 6 }}>
              ⚠️ 为保护数据安全，云端已启用行级安全策略，仅 Service Role Key 可读写数据。
              请在 Supabase 控制台 → Settings → API → Service Role Key 中复制（非 anon public key）。
            </p>
          </div>
          <button className="btn btn-primary" onClick={handleConnect} disabled={!supabaseUrl || !supabaseKey}>
            <Link2 size={18} /> 连接 Supabase
          </button>
          {syncMsg && <p className="text-sm" style={{ color: syncMsg.includes('✅') ? 'var(--color-success)' : syncMsg.includes('❌') ? 'var(--color-danger)' : 'var(--text-secondary)' }}>{syncMsg}</p>}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="p-4 rounded-lg" style={{ background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.2)' }}>
            <div className="flex items-center gap-2">
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-success)', display: 'block' }} />
              <span style={{ fontSize: '14px', color: 'var(--color-success)', fontWeight: 600 }}>已连接</span>
            </div>
            {lastSync && <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: 4 }}>上次同步: {lastSync}</p>}
          </div>

          {/* 实时同步 */}
          <div className="p-4 rounded-lg" style={{ background: realtimeEnabled ? 'rgba(94,158,255,0.1)' : 'var(--card-bg)', border: realtimeEnabled ? '1px solid rgba(94,158,255,0.3)' : '1px solid var(--card-border)' }}>
            <div className="flex items-center justify-between">
              <div>
                <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)' }}>自动实时同步</div>
                <div style={{ fontSize: '12px', color: realtimeEnabled ? 'var(--color-accent)' : 'var(--text-tertiary)', marginTop: 2 }}>
                  {realtimeEnabled ? '实时同步已开启' : '实时同步已关闭'}
                </div>
              </div>
              <button className="btn btn-secondary" onClick={handleToggleRealtime} disabled={!connected}>
                {realtimeEnabled ? '关闭实时同步' : '开启实时同步'}
              </button>
            </div>
          </div>

          {/* 用户登录 */}
          <div className="p-4 rounded-lg" style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)' }}>
            {authUser ? (
              <div className="flex items-center justify-between">
                <div>
                  <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)' }}>已登录: {authUser.email}</div>
                  <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: 2 }}>登录后可同步个人数据</div>
                </div>
                <button className="btn btn-ghost" onClick={handleLogout}>退出登录</button>
              </div>
            ) : (
              <>
                <button className="btn btn-secondary w-full" onClick={() => setShowAuth(!showAuth)}>
                  {showAuth ? '收起登录表单' : '登录 Supabase'}
                </button>
                {showAuth && (
                  <div className="space-y-3 mt-3">
                    <div>
                      <label className="block text-sm" style={{ color: 'var(--text-secondary)', marginBottom: 6 }}>邮箱</label>
                      <input className="input" type="email" value={authEmail} onChange={e => setAuthEmail(e.target.value)} placeholder="user@example.com" />
                    </div>
                    <div>
                      <label className="block text-sm" style={{ color: 'var(--text-secondary)', marginBottom: 6 }}>密码</label>
                      <input className="input" type="password" value={authPassword} onChange={e => setAuthPassword(e.target.value)} placeholder="••••••••"
                        onKeyDown={e => { if (e.key === 'Enter' && !(e.nativeEvent as any).isComposing) handleAuth(); }} />
                    </div>
                    <button className="btn btn-primary w-full" onClick={handleAuth} disabled={!authEmail || !authPassword}>
                      登录/注册
                    </button>
                    {authMsg && <p className="text-sm" style={{ color: authMsg.includes('✅') ? 'var(--color-success)' : authMsg.includes('❌') ? 'var(--color-danger)' : 'var(--text-secondary)' }}>{authMsg}</p>}
                  </div>
                )}
              </>
            )}
          </div>

          {/* 文件存储 */}
          <div className="p-4 rounded-lg" style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)' }}>
            <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>文件存储</div>
            <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginBottom: 12 }}>上传文件到云端（base64 存储于 knowledge 表）</div>
            <div className="flex items-center gap-3">
              <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileUpload} />
              <button className="btn btn-secondary" onClick={() => fileInputRef.current?.click()}>
                <Upload size={18} /> 上传文件
              </button>
            </div>
            {uploadedFiles.length > 0 && (
              <div className="mt-3 space-y-2">
                {uploadedFiles.map((f, i) => (
                  <div key={i} className="flex items-center gap-2 p-2 rounded-lg"
                    style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)' }}>
                    <FileText size={16} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                    <span className="flex-1 text-sm truncate" style={{ color: 'var(--text-primary)' }}>{f.name}</span>
                    <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{(f.size / 1024).toFixed(1)} KB</span>
                    <a className="btn btn-ghost btn-sm" href={f.dataUrl} download={f.name} style={{ fontSize: 12 }}>
                      <Download size={14} /> 下载
                    </a>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex gap-3">
            <button className="btn btn-primary" onClick={handleSync} disabled={syncing}>
              <RefreshCw size={18} className={syncing ? 'animate-spin' : ''} /> {syncing ? '同步中...' : '立即同步'}
            </button>
            <button className="btn btn-ghost" onClick={handleDisconnect}>
              <Unlink size={18} /> 断开连接
            </button>
          </div>
          {syncMsg && <p className="text-sm" style={{ color: syncMsg.includes('✅') ? 'var(--color-success)' : syncMsg.includes('❌') ? 'var(--color-danger)' : 'var(--text-secondary)' }}>{syncMsg}</p>}
        </div>
      )}
    </div>
  );
}