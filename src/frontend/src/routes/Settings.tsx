import { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Settings as SettingsIcon, Palette, Save, Image, Trash2, Plus, FolderOpen, FileText, Star, Check, Cloud, Upload, Download, RefreshCw, Link2, Unlink, Wrench, Search, BookOpen, Workflow, FolderKanban, Database, KeyRound, Globe, Activity, Shield, Compass } from 'lucide-react';
import { useSafeTimeout } from '../hooks/useSafeTimeout';
import { api } from '../api/client';
import { PageHeader } from '../components/PageHeader';
import { confirm as confirmDialog } from '../components/ui/confirm-dialog';
import { Tabs, TabList, TabTrigger } from '../components/ui/tabs';
import { Input } from '../components/ui/input';
import { useAppStore } from '../store/app';
// P2-3: 拆分子组件到独立文件
import { DataManage } from './settings/DataManage';

const tabs = [
  { id: 'general', label: 'General', icon: <SettingsIcon size={20} /> },
  { id: 'appearance', label: 'Appearance', icon: <Palette size={20} /> },
  { id: 'sync', label: '云同步', icon: <Cloud size={20} /> },
];

// Coding 模式下未在侧边栏展示的功能（按侧边栏分组组织）
const featureGroups = [
  { label: '工具', items: [
    { label: '工具箱', icon: Wrench, path: '/toolbox', color: 'var(--color-warning)' },
    { label: '搜索引擎', icon: Search, path: '/search', color: 'var(--color-success)' },
    { label: '知识库', icon: BookOpen, path: '/knowledge', color: 'var(--color-danger)' },
    { label: '工作流', icon: Workflow, path: '/workflows', color: '#60a5fa' },
  ]},
  { label: 'AI', items: [
    { label: 'AI Studio', icon: Palette, path: '/media', color: '#a78bfa' },
    { label: '文档生成', icon: FileText, path: '/documents', color: 'var(--color-success)' },
    { label: '项目管理', icon: FolderKanban, path: '/projects', color: 'var(--color-danger)' },
  ]},
  { label: '资源', items: [
    { label: '媒体库', icon: Database, path: '/library', color: '#60a5fa' },
    { label: '密码库', icon: KeyRound, path: '/vault', color: 'var(--color-warning)' },
    { label: '浏览器', icon: Globe, path: '/browser', color: 'var(--color-accent)' },
  ]},
  { label: '系统', items: [
    { label: '系统监控', icon: Activity, path: '/monitoring', color: 'var(--color-accent)' },
    { label: 'AI 自检', icon: Shield, path: '/selfcheck', color: '#a78bfa' },
  ]},
];

// 玻璃效果默认值
const DEFAULT_GLASS = { blurRadius: 26, saturate: 200, vibrancyOpacity: 0.06 };

function applyGlassToCSS(blur: number, saturate: number, opacity: number) {
  const root = document.documentElement;
  root.style.setProperty('--glass-blur-radius', `${blur}px`);
  root.style.setProperty('--glass-saturate', `${saturate}%`);
  root.style.setProperty('--glass-vibrancy-opacity', String(opacity));
}

function loadGlassFromStorage() {
  try {
    const saved = localStorage.getItem('glassEffect');
    if (saved) return JSON.parse(saved);
  } catch (_e: unknown) { /* ignore - intentional */ }
  return DEFAULT_GLASS;
}

// P1-11: SyncSettings 使用前端直连 Supabase（支持 realtime/auth 等高级功能），
// 后端 /api/sync 模块作为 legacy API 保留供未来后端化迁移使用。
function SyncSettings() {
  const [supabaseUrl, setSupabaseUrl] = useState('');
  const [supabaseKey, setSupabaseKey] = useState('');
  const [connected, setConnected] = useState(false);
  const [keyResolved, setKeyResolved] = useState(false); // FE-11: 显式跟踪 Key 是否已解析
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [lastSync, setLastSync] = useState<string | null>(null);
  // Realtime 实时同步
  const [realtimeEnabled, setRealtimeEnabled] = useState(false);
  const sbRef = useRef<any>(null);
  const realtimeChannelRef = useRef<any>(null);
  // 用户认证
  const [authUser, setAuthUser] = useState<{ email: string } | null>(null);
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authMsg, setAuthMsg] = useState('');
  const [showAuth, setShowAuth] = useState(false);
  // 文件存储
  const [uploadedFiles, setUploadedFiles] = useState<{ name: string; size: number; dataUrl: string; uploadedAt: string }[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 创建 Supabase 客户端 - FE-10: 抛出明确错误而非返回 null
  const getSupabase = async () => {
    if (!supabaseUrl) throw new Error('Supabase 未配置: 缺少 URL');
    const key = resolveSupabaseKey();
    if (!key) throw new Error('Supabase 未配置: 缺少 Key');
    const { createClient } = await import('@supabase/supabase-js');
    return createClient(supabaseUrl, key);
  };

  // 将远端数据写入 localStorage（兼容 string/object 两种格式）
  const applyRemoteData = (k: any) => {
    if (!k) return;
    // 如果 data 是字符串（旧版后端存储格式），先解析
    const data = typeof k === 'string' ? JSON.parse(k) : k;
    if (data.bookmarks) localStorage.setItem('knowledge_bookmarks', JSON.stringify(data.bookmarks));
    if (data.notes) localStorage.setItem('knowledge_notes', JSON.stringify(data.notes));
    if (data.wiki) localStorage.setItem('knowledge_wiki', JSON.stringify(data.wiki));
    if (data.conversations) localStorage.setItem('chat_conversations', JSON.stringify(data.conversations));
    if (data.searchHistory) localStorage.setItem('search_history', JSON.stringify(data.searchHistory));
    if (Array.isArray(data.files)) setUploadedFiles(data.files);
    // 标记数据已更新，通知其他页面
    localStorage.setItem('sync_data_updated', Date.now().toString());
    window.dispatchEvent(new CustomEvent('sync-data-changed', { detail: { time: Date.now() } }));
  };

  // 下载远端最新数据并应用到本地
  const downloadLatest = async (sb: any) => {
    const { data: dlData } = await sb.from('knowledge')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(1);
    if (dlData?.[0]?.data) applyRemoteData(dlData[0].data);

    const { data: dlSettings } = await sb.from('settings')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(1);
    if (dlSettings?.[0]?.data?.theme) {
      localStorage.setItem('uiTheme', dlSettings[0].data.theme);
    }
  };

  // 建立 Realtime 订阅（knowledge + settings 表）
  const setupRealtime = async (sb: any) => {
    const channel = sb.channel('schema-db-changes')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'knowledge' },
        async () => {
          try {
            await downloadLatest(sb);
            setSyncMsg('🔄 检测到云端变更，已自动同步');
          } catch (_e: unknown) { /* ignore - intentional */ }
        })
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'settings' },
        async () => {
          try {
            await downloadLatest(sb);
            setSyncMsg('🔄 检测到云端变更，已自动同步');
          } catch (_e: unknown) { /* ignore - intentional */ }
        })
      .subscribe((status: string) => {
        if (status === 'SUBSCRIBED') setRealtimeEnabled(true);
      });
    return channel;
  };

  useEffect(() => {
    // 优先从后端恢复已保存的同步配置（重启后 Key 不丢失的核心修复）
    fetch('/api/sync/config', {
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    }).then(r => r.json()).then((res: any) => {
      // P0-8 修复：后端不再回传明文 supabaseKey（凭证），只返回 hasKey。
      // URL 从后端恢复，Key 从本地 sessionStorage/localStorage 兜底。
      // FE-11 修复：仅在 URL 和 Key 均成功解析后才置 connected=true
      if (res?.configured && res?.supabaseUrl && res?.hasKey) {
        setSupabaseUrl(res.supabaseUrl);
        const localKey = resolveSupabaseKey();
        if (localKey) {
          setSupabaseKey(localKey);
          setKeyResolved(true);
          // 同时写入 localStorage，保证 Layout 轮询监听可用
          try { localStorage.setItem('syncConnection', JSON.stringify({ supabaseUrl: res.supabaseUrl, connected: true })); } catch { /* ignore */ }
          setConnected(true);
          setSyncMsg('✅ 已恢复同步配置');
        } else {
          // Key 缺失：标记需重新输入，不置 connected
          setKeyResolved(false);
          setConnected(false);
          setSyncMsg('⚠️ 检测到同步配置但本地缺少 Key，请重新输入');
        }
        return;
      }
      // 后端没有配置时，回退到本地恢复
      try {
        const saved = localStorage.getItem('syncConnection');
        if (saved) {
          const c = JSON.parse(saved);
          setSupabaseUrl(c.supabaseUrl || '');
          const localKey = resolveSupabaseKey();
          if (c.connected && localKey) {
            setSupabaseKey(localKey);
            setKeyResolved(true);
            setConnected(true);
          } else if (c.connected && !localKey) {
            // 本地标记为 connected 但 Key 缺失
            setKeyResolved(false);
            setConnected(false);
            setSyncMsg('⚠️ 本地配置缺少 Key，请重新输入');
          }
        }
      } catch (_e: unknown) { /* ignore - intentional */ }
    }).catch(() => {
      // 后端不可用，回退本地恢复
      try {
        const saved = localStorage.getItem('syncConnection');
        if (saved) {
          const c = JSON.parse(saved);
          setSupabaseUrl(c.supabaseUrl || '');
          const localKey = resolveSupabaseKey();
          if (c.connected && localKey) {
            setSupabaseKey(localKey);
            setKeyResolved(true);
            setConnected(true);
          } else if (c.connected && !localKey) {
            setKeyResolved(false);
            setConnected(false);
            setSyncMsg('⚠️ 本地配置缺少 Key，请重新输入');
          }
        }
      } catch (_e: unknown) { /* ignore - intentional */ }
    });
  }, []);

  // 获取有效的 Supabase key（state 优先，兜底 localStorage → sessionStorage）
  const resolveSupabaseKey = () => {
    if (supabaseKey) return supabaseKey;
    try {
      return localStorage.getItem('aether_supabase_key') || sessionStorage.getItem('aether_supabase_key') || '';
    } catch { return ''; }
  };

  const handleConnect = async () => {
    // 尝试从 localStorage/sessionStorage 恢复 Key（如果 state 为空）
    const resolvedKey = supabaseKey || resolveSupabaseKey();
    if (!supabaseUrl || !resolvedKey) { setSyncMsg('请输入 Supabase URL 和 Key'); return; }
    try {
      // 尝试直接连 Supabase
      const { createClient } = await import('@supabase/supabase-js');
      const sb = createClient(supabaseUrl, resolvedKey);
      const { error } = await sb.from('knowledge').select('count', { count: 'exact', head: true });
      if (error && error.code !== 'PGRST116') throw error;
      sbRef.current = sb;
      setConnected(true);
      setKeyResolved(true); // FE-11: 连接成功时标记 Key 已解析
      setSyncMsg('✅ 连接成功');
      // 持久化：URL 存 localStorage，Key 存后端 + localStorage（本地单用户应用可接受，重启后可靠恢复）
      try { localStorage.setItem('syncConnection', JSON.stringify({ supabaseUrl, connected: true })); } catch { /* ignore */ }
      try { localStorage.setItem('aether_supabase_key', resolvedKey); } catch { /* ignore */ }
      try { sessionStorage.setItem('aether_supabase_key', resolvedKey); } catch { /* ignore */ }
      // 恢复上次登录会话
      try {
        const savedAuth = localStorage.getItem('supabase_auth_session');
        if (savedAuth) {
          const a = JSON.parse(savedAuth);
          if (a?.email) setAuthUser({ email: a.email });
        }
      } catch (_e: unknown) { /* ignore - intentional */ }
      // 连接成功后自动开启实时同步
      realtimeChannelRef.current = await setupRealtime(sb);
      // 通知后端：保存同步配置（POST 为敏感写路径，Wave0-AM 后必须带 Authorization token）
      api.saveSyncConfig({ supabaseUrl, supabaseKey: resolvedKey }).catch((e: unknown) => console.warn('[Sync] 后端同步配置失败:', e));
    } catch (e: unknown) {
      setSyncMsg('❌ 连接失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  };

  // 断开时也通知后端
  const handleDisconnect = async () => {
    // 通知后端断开
    try {
      await fetch('/api/sync/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({}),
      });
    } catch { /* ignore */ }
    // 取消 Realtime 订阅
    if (sbRef.current && realtimeChannelRef.current) {
      sbRef.current.removeChannel(realtimeChannelRef.current).catch(() => {});
    }
    realtimeChannelRef.current = null;
    sbRef.current = null;
    setRealtimeEnabled(false);
    setConnected(false);
    setKeyResolved(false); // FE-11: 断开时重置 Key 解析状态
    setSupabaseUrl('');
    setSupabaseKey('');
    setSyncMsg('已断开连接');
    try { localStorage.removeItem('syncConnection'); } catch { /* ignore */ }
    try { localStorage.removeItem('aether_supabase_key'); } catch { /* ignore */ }
    try { sessionStorage.removeItem('aether_supabase_key'); } catch { /* ignore */ }
  };

  // 开启/关闭实时同步
  const handleToggleRealtime = async () => {
    if (realtimeEnabled) {
      if (sbRef.current && realtimeChannelRef.current) {
        await sbRef.current.removeChannel(realtimeChannelRef.current).catch(() => {});
      }
      realtimeChannelRef.current = null;
      setRealtimeEnabled(false);
      setSyncMsg('实时同步已关闭');
    } else {
      if (!sbRef.current) {
        const { createClient } = await import('@supabase/supabase-js');
        sbRef.current = createClient(supabaseUrl, resolveSupabaseKey());
      }
      realtimeChannelRef.current = await setupRealtime(sbRef.current);
      setSyncMsg('实时同步已开启');
    }
  };

  // 登录 / 注册
  const handleAuth = async () => {
    if (!authEmail || !authPassword) { setAuthMsg('请输入邮箱和密码'); return; }
    try {
      const { createClient } = await import('@supabase/supabase-js');
      const sb = sbRef.current || createClient(supabaseUrl, resolveSupabaseKey());
      if (!sbRef.current) sbRef.current = sb;
      let data: any;
      let error: any;
      // 先尝试登录
      const loginRes = await sb.auth.signInWithPassword({ email: authEmail, password: authPassword });
      data = loginRes.data;
      error = loginRes.error;
      if (error) {
        // 登录失败则尝试注册
        const signUpRes = await sb.auth.signUp({ email: authEmail, password: authPassword });
        if (signUpRes.error) throw signUpRes.error;
        data = signUpRes.data;
        setAuthMsg('✅ 注册成功，请检查邮箱确认（或直接登录）');
      } else {
        setAuthMsg('✅ 登录成功');
      }
      if (data?.user) {
        const user = { email: data.user.email || authEmail };
        setAuthUser(user);
        localStorage.setItem('supabase_auth_session', JSON.stringify(user));
        setShowAuth(false);
      }
    } catch (e: unknown) {
      setAuthMsg('❌ ' + (e instanceof Error ? e.message : String(e)));
    }
  };

  // 退出登录
  const handleLogout = async () => {
    try {
      if (sbRef.current) await sbRef.current.auth.signOut();
    } catch (_e: unknown) { /* ignore - intentional */ }
    setAuthUser(null);
    localStorage.removeItem('supabase_auth_session');
    setAuthMsg('已退出登录');
  };

  // 上传文件（base64 存入 knowledge 表）
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const dataUrl = ev.target?.result as string;
      const newFile = { name: file.name, size: file.size, dataUrl, uploadedAt: new Date().toISOString() };
      const updated = [...uploadedFiles, newFile];
      setUploadedFiles(updated);
      try {
        const { createClient } = await import('@supabase/supabase-js');
const sb = sbRef.current || createClient(supabaseUrl, resolveSupabaseKey());
        if (!sbRef.current) sbRef.current = sb;
        // 先取最新数据，合并 files 字段后上传，避免覆盖其他数据
        const { data: dlData } = await sb.from('knowledge')
          .select('*')
          .order('updated_at', { ascending: false })
          .limit(1);
        const existing = dlData?.[0]?.data || {};
        const merged = { ...existing, files: updated };
        const deviceId = getDeviceId();
        const now = new Date().toISOString();
        const { error: upErr } = await sb.from('knowledge').upsert({
          device_id: deviceId,
          data: merged,
          updated_at: now,
        }, { onConflict: 'device_id' });
        if (upErr) throw upErr;
        setSyncMsg('✅ 文件已上传');
      } catch (err: any) {
        setSyncMsg('❌ 文件上传失败: ' + err.message);
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  // 获取或创建固定设备 ID
  const getDeviceId = () => {
    let id = localStorage.getItem('sync_device_id');
    if (!id) {
      id = 'device-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      localStorage.setItem('sync_device_id', id);
    }
    return id;
  };

  const handleSync = async () => {
    setSyncing(true);
    setSyncMsg('同步中...');
    try {
      const { createClient } = await import('@supabase/supabase-js');
      const sb = createClient(supabaseUrl, resolveSupabaseKey());
      sbRef.current = sb;
      const deviceId = getDeviceId(); // 固定设备 ID，每次同步用同一个
      const now = new Date().toISOString();

      // 收集本地数据
      const conversations = JSON.parse(localStorage.getItem('chat_conversations') || '[]');
      const searchHistory = JSON.parse(localStorage.getItem('search_history') || '[]');
      const knowledge = {
        bookmarks: JSON.parse(localStorage.getItem('knowledge_bookmarks') || '[]'),
        notes: JSON.parse(localStorage.getItem('knowledge_notes') || '[]'),
        wiki: JSON.parse(localStorage.getItem('knowledge_wiki') || '[]'),
        conversations: conversations,
        searchHistory: searchHistory,
        files: uploadedFiles,
      };
      const settings = {
        theme: localStorage.getItem('uiTheme') || 'liquid-glass',
      };

      // 上传到 Supabase
      const { error: upErr } = await sb.from('knowledge').upsert({
        device_id: deviceId,
        data: knowledge,
        updated_at: now,
      }, { onConflict: 'device_id' });
      if (upErr) throw upErr;

      const { error: upErr2 } = await sb.from('settings').upsert({
        device_id: deviceId,
        data: settings,
        updated_at: now,
      }, { onConflict: 'device_id' });
      if (upErr2) throw upErr2;

      // 记录同步日志
      await sb.from('sync_log').insert({
        device_id: deviceId,
        action: 'sync',
        status: 'success',
        created_at: now,
      });

      setSyncMsg('✅ 上传成功');

      // 下载远端数据
      await downloadLatest(sb);

      setSyncMsg('✅ 同步完成');
      setLastSync(new Date().toLocaleString());
    } catch (e: unknown) {
      setSyncMsg('❌ 同步失败: ' + (e instanceof Error ? e.message : String(e)));
    }
    setSyncing(false);
  };

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
            {/* P0 修复：RLS 启用后 anon public key 无法访问任何表，必须使用 Service Role Key。
                存储策略：本地单用户应用，Key 仅保存在本机（后端 sync-config.json 权限 0600），
                重启后通过 /api/sync/config 恢复（后端不回传明文 Key）。 */}
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

// P2-3: DataManage 已拆分到 ./settings/DataManage.tsx

export function Settings() {
  const navigate = useNavigate();
  const { uiMode } = useAppStore();
  const [activeTab, setActiveTab] = useState('general');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  // 审计修复：安全 setTimeout，组件卸载时自动清理
  const safeTimeout = useSafeTimeout();
  const [port, setPort] = useState(3000);
  const [theme, setTheme] = useState('dark');
  const [activeTheme, setActiveTheme] = useState(() => localStorage.getItem('uiTheme') || 'liquid-glass');
  const [bgImage, setBgImage] = useState<string | null>(null);
  // 背景轮播
  const [bgFolder, setBgFolder] = useState<string>('');
  const [bgImages, setBgImages] = useState<string[]>([]);
  const [bgInterval, setBgInterval] = useState(10);
  const [bgIntervalInput, setBgIntervalInput] = useState('10'); // 字符串编辑态：清空时不回填，允许自由输入
  const [bgEnabled, setBgEnabled] = useState(false);
  // 背景来源模式：upload=上传 / dir=目录
  const [bgMode, setBgMode] = useState<'upload' | 'dir'>('upload');
  const [bgDirInput, setBgDirInput] = useState<string>('');
  const [bgDirInfo, setBgDirInfo] = useState<string>('');
  const [allowedDirs, setAllowedDirs] = useState<string[]>([]);
  const [defaultDir, setDefaultDir] = useState<string>('');
  const [newDir, setNewDir] = useState('');
  // 玻璃效果滑块
  const initialGlass = loadGlassFromStorage();
  const [glassBlur, setGlassBlur] = useState(initialGlass.blurRadius);
  const [glassSaturate, setGlassSaturate] = useState(initialGlass.saturate);
  const [glassOpacity, setGlassOpacity] = useState(initialGlass.vibrancyOpacity);
  const [glassEnabled, setGlassEnabled] = useState(() => localStorage.getItem('glassEnabled') !== 'false');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const filePickerRef = useRef<HTMLInputElement>(null);
  const bgFolderInputRef = useRef<HTMLInputElement>(null);

  // 初始化时应用已保存的玻璃参数
  useEffect(() => {
    applyGlassToCSS(glassBlur, glassSaturate, glassOpacity);
    // 从 localStorage 恢复 data-glass-off 状态
    if (localStorage.getItem('glassEnabled') === 'false') {
      document.documentElement.dataset.glassOff = 'true';
    }
  }, []);

  useEffect(() => {
    api.getSettings().then(data => {
      if (data) {
        if (data.port) setPort(data.port);
        if (data.theme) setTheme(data.theme);
        if (data.bgImage) setBgImage(data.bgImage);
        if (Array.isArray(data.allowedDirs)) setAllowedDirs(data.allowedDirs);
        if (data.defaultDir) setDefaultDir(data.defaultDir);
      }
    }).catch(() => {});
    const savedBg = localStorage.getItem('customBg');
    if (savedBg) setBgImage(savedBg);
  }, []);

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result as string;
      setBgImage(dataUrl);
      localStorage.setItem('customBg', dataUrl);
      // 触发 Layout 重新渲染背景（通过 storage 事件 + 自定义事件）
      window.dispatchEvent(new CustomEvent('custombg-change', { detail: dataUrl }));
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveBg = () => {
    setBgImage(null);
    localStorage.removeItem('customBg');
    localStorage.removeItem('bgImages');
    setBgImages([]);
    setBgEnabled(false);
    api.saveSettings({ bgImage: null }).catch(() => {});
    window.dispatchEvent(new CustomEvent('custombg-change', { detail: null }));
  };

  // 背景轮播：选择图片（多选）→ 上传到后端持久化
  const handleBgFolderSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const images = files
      .filter(f => /\.(jpg|jpeg|png)$/i.test(f.name))
      .slice(0, 999);
    if (images.length === 0) { alert('请选择 JPG/PNG 格式的图片'); return; }
    Promise.all(images.map(f => new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsDataURL(f);
    }))).then(async (dataUrls) => {
      setBgFolder(`上传中 ${images.length} 张图片...`);
      try {
        // 上传到后端持久化
        const res = await api.uploadBackgrounds(dataUrls);
        if (res?.images) {
          setBgEnabled(true);
          setBgFolder(`已上传 ${res.images.length} 张图片`);
          // 保存间隔到后端
          await api.setBackgroundInterval(bgInterval);
          // 刷新列表（更新 bgImages state 为完整列表）+ 触发轮播
          await loadBgImages();
          // 背景切换修复：必须派发「完整图片列表」而非仅本次上传的新图 res.images，
          // 否则 Layout 的轮播数组被覆盖成单张/部分图，定时器因 length<=1 不启动 → 背景永远不切换
          const fullImages = (await api.getBackgrounds()).images || bgImages;
          window.dispatchEvent(new CustomEvent('bg-slideshow-start', { detail: { images: fullImages, interval: bgInterval } }));
        }
      } catch (err: any) {
        alert('上传失败: ' + err.message);
      }
    });
  };

  // 从后端加载背景图片（上传模式 or 目录模式）
  const loadBgImages = async () => {
    try {
      const res = await api.getBackgrounds();
      setBgMode(res?.mode === 'dir' ? 'dir' : 'upload');
      setBgDirInput(res?.dir || '');
      if (res?.dir) setBgDirInfo(`已启用目录模式: ${res.dir}`);
      const interval = res?.interval || 10;
      setBgInterval(interval);
      setBgIntervalInput(String(interval));
      if (res?.images?.length > 0) {
        setBgImages(res.images);
        setBgEnabled(true);
      } else if (res?.mode === 'dir') {
        setBgImages([]);
        setBgEnabled(true); // 目录为空也保持启用状态（Layout 会自行处理空数组）
      }
    } catch (_e: unknown) { console.warn("[SilentCatch]", _e); }
  };
  useEffect(() => { loadBgImages(); }, []);

  // 启用目录模式：保存目录并切换到目录图片来源
  const handleEnableDirMode = async () => {
    const dir = bgDirInput.trim();
    if (!dir) { alert('请填写目录路径'); return; }
    try {
      const res = await api.setBackgroundSource('dir', dir);
      if (res?.error) { alert('启用失败: ' + res.error); return; }
      setBgDirInfo(`已启用目录模式: ${res.dir || dir}`);
      setBgMode('dir');
      setBgEnabled(true);
      // 同步 interval 到后端
      await api.setBackgroundInterval(bgInterval).catch(() => {});
      const images = res.images || (await api.getBackgrounds()).images || [];
      setBgImages(images);
      window.dispatchEvent(new CustomEvent('bg-slideshow-start', { detail: { images, interval: bgInterval } }));
    } catch (e: unknown) {
      alert('启用目录模式失败: ' + ((e instanceof Error ? e.message : String(e)) || '网络错误'));
    }
  };

  // 切回上传模式
  const handleSwitchToUpload = async () => {
    try {
      const res = await api.setBackgroundSource('upload');
      if (res?.error) { alert(res.error); return; }
      setBgMode('upload');
      setBgDirInfo('');
      const images = (await api.getBackgrounds()).images || [];
      setBgImages(images);
      window.dispatchEvent(new CustomEvent('bg-slideshow-start', { detail: { images, interval: bgInterval } }));
    } catch (e: unknown) {
      alert('切换失败: ' + ((e instanceof Error ? e.message : String(e)) || '网络错误'));
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const relPath = file.webkitRelativePath;
    const dirName = relPath ? relPath.split('/')[0] : file.name;
    setNewDir(dirName);
    e.target.value = '';
  };

  const handleAddDir = async () => {
    const dir = newDir.trim();
    if (!dir) return;
    if (allowedDirs.some(d => d === dir)) { setNewDir(''); return; }
    const prevDirs = allowedDirs;
    const prevDefault = defaultDir;
    const updated = [...allowedDirs, dir];
    setAllowedDirs(updated);
    setNewDir('');
    // 如果是第一个目录，自动设为默认工作目录
    const newDefaultDir = allowedDirs.length === 0 ? dir : defaultDir;
    if (allowedDirs.length === 0) setDefaultDir(dir);
    // P0-6 修复：allowedDirs/defaultDir 必须走 /api/settings/security 端点，不能走 /api/settings（会被 403 拒绝）
    // 审计修复：保存失败时回滚乐观更新并提示用户，不再静默吞错
    try {
      await api.saveSettings({ port, theme, bgImage });
      await api.saveSecuritySettings({ allowedDirs: updated, defaultDir: newDefaultDir });
    } catch (e: unknown) {
      setAllowedDirs(prevDirs);
      setDefaultDir(prevDefault);
      setMsg(`❌ 目录保存失败: ${e instanceof Error ? e.message : '网络错误'}`);
    }
  };

  const handleRemoveDir = async (dir: string) => {
    // P0-4 修复：删除可访问目录前二次确认
    if (!(await confirmDialog('确定删除此可访问目录？AI 将无法再访问该目录。'))) return;
    const prevDirs = allowedDirs;
    const prevDefault = defaultDir;
    const updated = allowedDirs.filter(d => d !== dir);
    setAllowedDirs(updated);
    let newDefaultDir = defaultDir;
    // 如果删除的是默认目录，用第一个剩余目录或清空
    if (defaultDir === dir) {
      newDefaultDir = updated.length > 0 ? updated[0] : '';
      setDefaultDir(newDefaultDir);
    }
    // 审计修复：保存失败时回滚乐观更新并提示用户
    try {
      await api.saveSettings({ port, theme, bgImage });
      await api.saveSecuritySettings({ allowedDirs: updated, defaultDir: newDefaultDir });
    } catch (e: unknown) {
      setAllowedDirs(prevDirs);
      setDefaultDir(prevDefault);
      setMsg(`❌ 目录删除失败: ${e instanceof Error ? e.message : '网络错误'}`);
    }
  };

  const handleSetDefault = async (dir: string) => {
    const prevDefault = defaultDir;
    setDefaultDir(dir);
    // 审计修复：保存失败时回滚乐观更新并提示用户
    try {
      await api.saveSettings({ port, theme, bgImage });
      await api.saveSecuritySettings({ allowedDirs, defaultDir: dir });
    } catch (e: unknown) {
      setDefaultDir(prevDefault);
      setMsg(`❌ 默认目录设置失败: ${e instanceof Error ? e.message : '网络错误'}`);
    }
  };

  const handleSave = async () => {
    setSaving(true); setMsg('');
    try {
      // P0-6 修复：allowedDirs/defaultDir 必须走 /api/settings/security，不能走 /api/settings（会 403）
      await api.saveSettings({
        port, theme, bgImage,
        glassEffect: { blurRadius: glassBlur, saturate: glassSaturate, vibrancyOpacity: glassOpacity },
      });
      await api.saveSecuritySettings({ allowedDirs, defaultDir });
      document.documentElement.setAttribute('data-theme', theme);
      setMsg('✅ Saved');
    } catch { setMsg('❌ Error'); }
    setSaving(false); safeTimeout(() => setMsg(''), 3000);
  };

  // 玻璃滑块处理：实时应用效果（模糊/饱和度始终生效，不依赖 Glass 开关）
  const handleGlassBlur = (v: number) => {
    setGlassBlur(v);
    localStorage.setItem('glassEffect', JSON.stringify({ blurRadius: v, saturate: glassSaturate, vibrancyOpacity: glassOpacity }));
    applyGlassToCSS(v, glassSaturate, glassOpacity);
  };
  const handleGlassSaturate = (v: number) => {
    setGlassSaturate(v);
    localStorage.setItem('glassEffect', JSON.stringify({ blurRadius: glassBlur, saturate: v, vibrancyOpacity: glassOpacity }));
    applyGlassToCSS(glassBlur, v, glassOpacity);
  };
  const handleGlassOpacity = (v: number) => {
    setGlassOpacity(v);
    localStorage.setItem('glassEffect', JSON.stringify({ blurRadius: glassBlur, saturate: glassSaturate, vibrancyOpacity: v }));
    applyGlassToCSS(glassBlur, glassSaturate, v);
  };
  const handleResetGlass = () => {
    setGlassBlur(DEFAULT_GLASS.blurRadius); setGlassSaturate(DEFAULT_GLASS.saturate); setGlassOpacity(DEFAULT_GLASS.vibrancyOpacity);
    applyGlassToCSS(DEFAULT_GLASS.blurRadius, DEFAULT_GLASS.saturate, DEFAULT_GLASS.vibrancyOpacity);
    localStorage.setItem('glassEffect', JSON.stringify(DEFAULT_GLASS));
  };
  // Glass 一键开关：仅控制 liquid-lens 折射特效，不影响 blur/saturate 滑块
  const handleToggleGlass = () => {
    const root = document.documentElement;
    if (glassEnabled) {
      setGlassEnabled(false);
      root.dataset.glassOff = 'true';
      localStorage.setItem('glassEnabled', 'false');
    } else {
      setGlassEnabled(true);
      delete root.dataset.glassOff;
      localStorage.setItem('glassEnabled', 'true');
    }
  };

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)', backgroundImage: 'var(--bg-gradient)' }}>
      <div style={{ maxWidth: 'min(1100px, 100%)', margin: '0 auto', padding: '0 16px' }}>
        <PageHeader title="设置" description="应用设置与外观定制" icon={<SettingsIcon size={22} />} color="var(--color-accent)" />
        {/* Coding 模式：功能导航（未在侧边栏展示的功能） */}
        {uiMode === 'coding' && (
          <div className="glass-card" style={{ padding: '24px', marginBottom: 24 }}>
            <div className="flex items-center gap-3">
              <div style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(94,158,255,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Compass size={18} style={{ color: 'var(--color-accent)' }} />
              </div>
              <div>
                <h2 style={{ fontSize: 'var(--font-module-title)', fontWeight: 600, color: 'var(--text-primary)' }}>功能导航</h2>
                <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: 2 }}>Coding 模式下未在侧边栏展示的功能，点击卡片快速进入</p>
              </div>
            </div>
            <div className="space-y-5" style={{ marginTop: 20 }}>
              {featureGroups.map(group => (
                <div key={group.label}>
                  <div className="flex items-center gap-2 mb-3">
                    <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{group.label}</span>
                    <div style={{ flex: 1, height: 1, background: 'var(--border-primary)' }} />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                    {group.items.map(item => {
                      const Icon = item.icon;
                      return (
                        <button key={item.label} onClick={() => navigate(item.path)}
                          className="glass-card"
                          style={{
                            padding: '14px 16px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10,
                            cursor: 'pointer',
                            border: '1px solid var(--card-border)',
                            borderRadius: 12,
                            textAlign: 'left',
                            transition: 'transform 0.15s ease, border-color 0.15s ease',
                          }}
                          onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.borderColor = item.color; }}
                          onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.borderColor = 'var(--card-border)'; }}>
                          <span style={{ width: 32, height: 32, borderRadius: 9, background: `${item.color}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            <Icon size={16} style={{ color: item.color }} />
                          </span>
                          <span className="truncate text-sm" style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{item.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <div className="flex gap-8">
            <div className="flex flex-col gap-1 flex-shrink-0" style={{ width: '200px' }}>
              <TabList className="flex flex-col items-stretch gap-1">
                {tabs.map(tab => (
                  <TabTrigger key={tab.id} value={tab.id} className="nav-item w-full justify-start">
                    {tab.icon}<span>{tab.label}</span>
                  </TabTrigger>
                ))}
              </TabList>
            </div>
          <div className="flex-1 space-y-6">
            {activeTab === 'general' && (
              <div className="glass-card">
                <h2 style={{ fontSize: 'var(--font-module-title)', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 20 }}>General</h2>
                <div className="space-y-5">
                  <div>
                    <label className="block text-sm" style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>Port</label>
                    {/* P1-6 修复：port 输入加 min/max 校验，空值不回退 NaN */}
                    <Input type="number" min={1} max={65535} value={port} onChange={e => {
                      const raw = parseInt(e.target.value, 10);
                      if (Number.isFinite(raw)) setPort(Math.min(65535, Math.max(1, raw)));
                    }} />
                  </div>
                  <div>
                    <label className="block text-sm" style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>可访问目录 (Allowed Dirs)</label>
                    <p className="text-xs" style={{ color: 'var(--text-tertiary)', marginBottom: 10 }}>
                      Agent 和 AI 工作流只能在这些目录内读写文件。添加后立即生效。
                    </p>
                    <div className="space-y-2">
                      {allowedDirs.map(dir => (
                        <div key={dir} className="flex items-center gap-2 p-2 rounded-lg"
                          style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)' }}>
                          <FolderOpen size={16} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                          <span className="flex-1 text-sm font-mono break-all" style={{ color: 'var(--text-primary)' }}>{dir}</span>
                          <button className="btn btn-ghost flex-shrink-0" onClick={() => handleSetDefault(dir)} title="设为默认工作目录"
                            style={{ color: defaultDir === dir ? 'var(--color-warning)' : 'var(--text-tertiary)' }}>
                            <Star size={15} fill={defaultDir === dir ? 'var(--color-warning)' : 'none'} />
                          </button>
                          <button className="btn btn-ghost flex-shrink-0" onClick={() => handleRemoveDir(dir)} title="删除该目录">
                            <Trash2 size={15} />
                          </button>
                        </div>
                      ))}
                      {allowedDirs.length === 0 && (
                        <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                          未配置可访问目录，AI 无法读写文件。请添加一个目录（如 D:\workspace）
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-2">
                      <input className="input" type="text" placeholder="输入目录路径，如 D:\projects"
                        value={newDir}
                        onChange={e => setNewDir(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter' && !(e.nativeEvent as any).isComposing) handleAddDir(); }} />
                      <input ref={(el) => { filePickerRef.current = el; if (el) el.webkitdirectory = true; }}
                        type="file" className="hidden" onChange={handleFileChange} />
                      <button className="btn btn-secondary flex-shrink-0" onClick={() => filePickerRef.current?.click()}>
                        <FolderOpen size={18} /> 浏览
                      </button>
                      <button className="btn btn-primary flex-shrink-0" onClick={handleAddDir}>
                        <Plus size={18} /> 添加
                      </button>
                    </div>
                    <p className="text-xs mt-2" style={{ color: 'var(--text-tertiary)' }}>
                      ① 直接输入路径（如 D:\projects）→ 点击「添加」  ② 或点击「浏览」选文件夹 → 再点击「添加」
                    </p>
                  </div>
                </div>
              </div>
            )}
            {activeTab === 'general' && <DataManage />}
            {activeTab === 'appearance' && (
              <div className="glass-card">
                <h2 style={{ fontSize: 'var(--font-module-title)', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 20 }}>Appearance</h2>
                <div className="space-y-5">
                  <div>
                    <label className="block text-sm" style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>Theme</label>
                    <select className="input select" value={theme} onChange={e => setTheme(e.target.value)}>
                      <option value="dark">Dark</option><option value="light">Light</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm" style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>Custom Background</label>
                    <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
                    <div className="flex items-center gap-3">
                      <button className="btn btn-primary" onClick={() => fileInputRef.current?.click()}>
                        <Image size={18} /> Upload Image
                      </button>
                      {bgImage && (
                        <button className="btn btn-ghost" onClick={handleRemoveBg}>
                          <Trash2 size={18} /> Remove
                        </button>
                      )}
                    </div>
                    {bgImage && (
                      <div className="mt-4 p-2 rounded-[14px]" style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)' }}>
                        <img src={bgImage} alt="Background preview" style={{ maxWidth: '100%', maxHeight: '200px', borderRadius: '8px', objectFit: 'cover' }} />
                      </div>
                    )}
                    <p className="text-xs mt-2" style={{ color: 'var(--text-tertiary)' }}>Upload an image to use as custom background. Apple Liquid Glass style will be applied automatically.</p>
                  </div>

                  {/* 背景轮播 */}
                  <div style={{ borderTop: '1px solid var(--border-primary)', paddingTop: 24, marginTop: 24 }}>
                    <div className="flex items-center justify-between mb-4">
                      <h3 style={{ fontSize: 'var(--font-card-title)', fontWeight: 600, color: 'var(--text-primary)' }}>背景轮播</h3>
                      <div className="flex items-center gap-2">
                        <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>启用</label>
                        <button onClick={() => { const next = !bgEnabled; setBgEnabled(next); if (next && bgImages.length > 0) window.dispatchEvent(new CustomEvent('bg-slideshow-start', { detail: { images: bgImages, interval: bgInterval } })); else window.dispatchEvent(new CustomEvent('bg-slideshow-stop', {})); }}
                          role="switch" aria-checked={bgEnabled} aria-label="背景轮播开关"
                          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: bgEnabled ? 'var(--color-accent)' : 'var(--text-tertiary)' }}>
                          {bgEnabled ? '🔵' : '⚪'}
                        </button>
                      </div>
                    </div>
                    <div className="space-y-4">
                      <div>
                        <label className="block text-sm" style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>选择文件夹上传（JPG/PNG）</label>
                        <input type="file" className="hidden" onChange={handleBgFolderSelect} multiple accept="image/jpeg,image/png" ref={(el) => { bgFolderInputRef.current = el; }} />
                        <div className="flex items-center gap-3">
                          <button className="btn btn-primary" onClick={() => bgFolderInputRef.current?.click()}
                            style={bgMode === 'dir' ? { opacity: 0.4, pointerEvents: 'none' } : undefined}
                            title={bgMode === 'dir' ? '目录模式下不可上传，请先切回上传模式' : undefined}>
                            <FolderOpen size={18} /> 选择文件夹
                          </button>
                          {bgMode === 'dir' && <span className="text-xs" style={{ color: 'var(--color-warning)' }}>目录模式下不可上传，请先切回上传模式</span>}
                          {bgFolder && <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{bgFolder}（{bgImages.length} 张）</span>}
                        </div>
                      </div>
                      {/* 目录模式：直接读取本地文件夹 */}
                      <div style={{ borderTop: '1px dashed var(--border-primary)', paddingTop: 16 }}>
                        <div className="flex items-center justify-between mb-2">
                          <label className="block text-sm" style={{ color: 'var(--text-secondary)' }}>目录模式（直接读取本地文件夹图片）</label>
                          {bgMode === 'dir' && (
                            <button className="btn btn-ghost btn-sm" onClick={handleSwitchToUpload} style={{ fontSize: 12 }}>
                              切回上传模式
                            </button>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <input className="input flex-1" type="text" placeholder="输入图片文件夹路径，如 D:\壁纸"
                            value={bgDirInput}
                            onChange={e => setBgDirInput(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter' && !(e.nativeEvent as any).isComposing) handleEnableDirMode(); }} />
                          <button className="btn btn-secondary flex-shrink-0" onClick={handleEnableDirMode} style={{ color: bgMode === 'dir' ? 'var(--color-accent)' : undefined }}>
                            {bgMode === 'dir' ? '重新扫描' : '启用目录模式'}
                          </button>
                        </div>
                        {bgDirInfo && <p className="text-xs mt-2" style={{ color: 'var(--color-accent)' }}>{bgDirInfo}</p>}
                        {bgMode === 'dir' && (
                          <div className="flex gap-2 overflow-x-auto" style={{ padding: '8px 0' }}>
                            {bgImages.slice(0, 10).map((img, i) => (
                              <img key={i} src={img} alt="" style={{ width: 60, height: 40, borderRadius: 4, objectFit: 'cover', border: '1px solid var(--card-border)' }} />
                            ))}
                            {bgImages.length === 0 && <span className="text-xs" style={{ color: 'var(--text-tertiary)', alignSelf: 'center' }}>该目录暂无图片（支持 png/jpg/jpeg/gif/webp/bmp/avif）</span>}
                            {bgImages.length > 10 && <span className="text-xs" style={{ color: 'var(--text-tertiary)', alignSelf: 'center' }}>+{bgImages.length - 10}</span>}
                          </div>
                        )}
                      </div>
                      {/* 背景轮播：切换秒数 —— 编辑态自由输入，interval 事件只更新时间不重建轮播 */}
                        <div>
                          <label className="block text-sm" style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>切换秒数</label>
                          <input className="input" type="number" min="3" max="60" value={bgIntervalInput}
                            onChange={e => {
                              setBgIntervalInput(e.target.value);
                              const raw = parseInt(e.target.value, 10);
                              if (!Number.isFinite(raw)) return; // 空/非数字：保持编辑态，不回填
                              const v = Math.min(60, Math.max(3, raw));
                              setBgInterval(v);
                              // 独立事件：只更新轮播间隔，不重建轮播/不重置索引
                              window.dispatchEvent(new CustomEvent('bg-slideshow-interval', { detail: { interval: v } }));
                            }}
                            onBlur={() => {
                              const raw = parseInt(bgIntervalInput, 10);
                              // 回退到最后有效值，而非硬编码 10（空输入时 user 可能只是误操作）
                              const v = Number.isFinite(raw) ? Math.min(60, Math.max(3, raw)) : bgInterval;
                              setBgInterval(v);
                              setBgIntervalInput(String(v));
                              window.dispatchEvent(new CustomEvent('bg-slideshow-interval', { detail: { interval: v } }));
                              api.setBackgroundInterval(v).catch(() => { console.warn('[Settings] 间隔持久化失败'); });
                            }}
                            onKeyDown={e => { if (e.key === 'Enter' && !(e.nativeEvent as any).isComposing) (e.target as HTMLInputElement).blur(); }} />
                        </div>
                      {bgMode !== 'dir' && bgImages.length > 0 && (
                        <div className="flex gap-2 overflow-x-auto" style={{ padding: '8px 0' }}>
                          {bgImages.slice(0, 10).map((img, i) => (
                            <img key={i} src={img} alt="" style={{ width: 60, height: 40, borderRadius: 4, objectFit: 'cover', border: '1px solid var(--card-border)' }} />
                          ))}
                          {bgImages.length > 10 && <span className="text-xs" style={{ color: 'var(--text-tertiary)', alignSelf: 'center' }}>+{bgImages.length - 10}</span>}
                        </div>
                      )}
                      {bgMode === 'upload' && bgImages.length > 0 && (
                        <button className="btn btn-ghost btn-sm" onClick={async () => {
                          // P0-4 修复：清除轮播图片前二次确认
                          if (!(await confirmDialog('确定清除所有轮播图片？此操作不可撤销。'))) return;
                          setBgImages([]); setBgFolder(''); setBgEnabled(false);
                          try { await api.clearBackgrounds(); } catch (_e: unknown) { console.warn("[SilentCatch]", _e); }
                          window.dispatchEvent(new CustomEvent('bg-slideshow-clear', {}));
                        }}
                          style={{ color: 'var(--color-danger)' }}>清除轮播图片</button>
                      )}
                    </div>
                  </div>

                  {/* 玻璃效果滑块 */}
                  <div style={{ borderTop: '1px solid var(--border-primary)', paddingTop: 24, marginTop: 24 }}>
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <h3 style={{ fontSize: 'var(--font-card-title)', fontWeight: 600, color: 'var(--text-primary)' }}>Liquid Glass 效果</h3>
                        <button onClick={handleToggleGlass}
                          role="switch" aria-checked={glassEnabled} aria-label="Liquid Glass 效果开关"
                          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: glassEnabled ? 'var(--color-accent)' : 'var(--text-tertiary)' }}>
                          {glassEnabled ? '🔵' : '⚪'}
                        </button>
                      </div>
                      <div className="flex items-center gap-2">
                        <button className="btn btn-ghost btn-sm" onClick={handleResetGlass} style={{ fontSize: 12 }}>重置默认</button>
                      </div>
                    </div>
                    <div className="space-y-5">
                      {/* 模糊半径 */}
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <label style={{ fontSize: 13, color: 'var(--text-secondary)' }}>模糊半径</label>
                          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', minWidth: 50, textAlign: 'right' }}>{glassBlur}px</span>
                        </div>
                        <input type="range" min="0" max="60" value={glassBlur} onChange={e => handleGlassBlur(parseInt(e.target.value))}
                          style={{ width: '100%', height: 6, borderRadius: 3, appearance: 'none', WebkitAppearance: 'none', background: 'linear-gradient(to right, var(--color-accent) ' + (glassBlur / 60 * 100) + '%, rgba(255,255,255,0.1) ' + (glassBlur / 60 * 100) + '%)', outline: 'none', cursor: 'pointer' }} />
                        <div className="flex justify-between text-xs" style={{ color: 'var(--text-tertiary)', marginTop: 4 }}><span>0px</span><span>60px</span></div>
                      </div>

                      {/* 饱和度 */}
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <label style={{ fontSize: 13, color: 'var(--text-secondary)' }}>饱和度</label>
                          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', minWidth: 50, textAlign: 'right' }}>{glassSaturate}%</span>
                        </div>
                        <input type="range" min="50" max="400" value={glassSaturate} onChange={e => handleGlassSaturate(parseInt(e.target.value))}
                          style={{ width: '100%', height: 6, borderRadius: 3, appearance: 'none', WebkitAppearance: 'none', background: 'linear-gradient(to right, var(--color-accent) ' + ((glassSaturate - 50) / 350 * 100) + '%, rgba(255,255,255,0.1) ' + ((glassSaturate - 50) / 350 * 100) + '%)', outline: 'none', cursor: 'pointer' }} />
                        <div className="flex justify-between text-xs" style={{ color: 'var(--text-tertiary)', marginTop: 4 }}><span>50%</span><span>400%</span></div>
                      </div>

                      {/* 透明度 */}
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <label style={{ fontSize: 13, color: 'var(--text-secondary)' }}>透明度</label>
                          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', minWidth: 50, textAlign: 'right' }}>{glassOpacity.toFixed(2)}</span>
                        </div>
                        <input type="range" min="0.02" max="0.30" step="0.01" value={glassOpacity} onChange={e => handleGlassOpacity(parseFloat(e.target.value))}
                          style={{ width: '100%', height: 6, borderRadius: 3, appearance: 'none', WebkitAppearance: 'none', background: 'linear-gradient(to right, var(--color-accent) ' + ((glassOpacity - 0.02) / 0.28 * 100) + '%, rgba(255,255,255,0.1) ' + ((glassOpacity - 0.02) / 0.28 * 100) + '%)', outline: 'none', cursor: 'pointer' }} />
                        <div className="flex justify-between text-xs" style={{ color: 'var(--text-tertiary)', marginTop: 4 }}><span>0.02</span><span>0.30</span></div>
                      </div>
                    </div>
                  </div>

                  {/* UI 主题选择 */}
                  <div style={{ borderTop: '1px solid var(--border-primary)', paddingTop: 24, marginTop: 24 }}>
                    <h3 style={{ fontSize: 'var(--font-card-title)', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 16 }}>UI 主题</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                      {[
                        { id: 'liquid-glass', label: 'Liquid Glass', desc: 'Apple 毛玻璃', colors: ['var(--color-accent)', '#a78bfa', '#0a0b10'] },
                        { id: 'shadcn', label: 'shadcn/ui', desc: '简洁中性', colors: ['#3b82f6', '#09090b', '#18181b'] },
                        { id: 'geist', label: 'Geist', desc: 'Vercel 极简', colors: ['#0070f3', '#000000', '#1a1a1a'] },
                        { id: 'magic', label: 'Magic UI', desc: '渐变光效', colors: ['#a78bfa', '#0a0a0f', '#1a1a2e'] },
                        { id: 'origin', label: 'Origin UI', desc: '圆润柔和', colors: ['#6366f1', '#0c0c10', '#1c1c24'] },
                        { id: 'dark-minimal', label: '简约暗色', desc: '纯黑低对比', colors: ['#666666', '#000000', '#111111'] },
                        { id: 'light', label: '简约亮色', desc: '纯白高对比', colors: ['#3b82f6', '#fafafa', '#ffffff'] },
                      ].map(t => (
                        <button
                          key={t.id}
                          onClick={() => {
                            setActiveTheme(t.id);
                            localStorage.setItem('uiTheme', t.id);
                            document.documentElement.setAttribute('data-theme', t.id === 'liquid-glass' ? 'dark' : t.id);
                            // 重置玻璃滑块到主题默认值（清除 inline 样式，让 CSS 变量生效）
                            const root = document.documentElement;
                            root.style.removeProperty('--glass-blur-radius');
                            root.style.removeProperty('--glass-saturate');
                            root.style.removeProperty('--glass-vibrancy-opacity');
                            const cs = getComputedStyle(root);
                            const newBlur = parseInt(cs.getPropertyValue('--glass-blur-radius').trim()) || 26;
                            const newSat = parseInt(cs.getPropertyValue('--glass-saturate').trim()) || 200;
                            const newOp = parseFloat(cs.getPropertyValue('--glass-vibrancy-opacity').trim()) || 0.06;
                            setGlassBlur(newBlur);
                            setGlassSaturate(newSat);
                            setGlassOpacity(newOp);
                            const effect = { blurRadius: newBlur, saturate: newSat, vibrancyOpacity: newOp };
                            localStorage.setItem('glassEffect', JSON.stringify(effect));
// 强制重绘所有玻璃卡片（刷新 backdrop-filter GPU 缓存）
                            const repaintEls = document.querySelectorAll<HTMLElement>('.glass-card, .sidebar-glass, .input, .select, .btn');
                            repaintEls.forEach(el => {
                                el.style.transform = 'translateZ(0.001px)';
                                el.style.backdropFilter = 'none';
                              });
                              setTimeout(() => {
                                repaintEls.forEach(el => {
                                  el.style.transform = '';
                                  el.style.backdropFilter = '';
                                });
                              }, 50);
                          }}
                          className="rounded-[14px] transition-all"
                          style={{
                            padding: 12,
                            background: activeTheme === t.id ? `${t.colors[0]}15` : 'var(--card-bg)',
                            border: activeTheme === t.id ? `2px solid ${t.colors[0]}` : '1px solid var(--card-border)',
                            borderRadius: 14,
                            display: 'flex', flexDirection: 'column', gap: 10,
                          }}
                        >
                          <div style={{ display: 'flex', gap: 5 }}>
                            {t.colors.map((c, ci) => (
                              <span key={ci} style={{ width: 26, height: 18, borderRadius: 5, background: c, border: '1px solid rgba(255,255,255,0.15)', flexShrink: 0 }} />
                            ))}
                          </div>
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 600, color: activeTheme === t.id ? t.colors[0] : 'var(--text-primary)' }}>{t.label}</div>
                            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>{t.desc}</div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
            {activeTab === 'sync' && (
              <SyncSettings />
            )}
            <div className="flex items-center gap-3 pt-4">
              <button onClick={handleSave} disabled={saving} className="btn btn-primary">
                <Save size={18} /> {saving ? 'Saving...' : 'Save Settings'}
              </button>
              {msg && <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{msg}</span>}
            </div>
            </div>
        </div>
          </Tabs>
      </div>
    </div>
  );
}