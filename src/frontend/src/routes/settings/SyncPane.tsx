import { useEffect, useState, useRef } from 'react';
import { api } from '../../api/client';
import { SyncSettings } from './SyncSettings';

/**
 * SyncPane — 云同步 tab 的**容器**（T25a）。
 *
 * 逻辑逐字迁出自 routes/Settings.tsx 内联的同名组件（未作任何行为改动），
 * 视图交给既有的 ./SyncSettings 展示组件。T25 之前这里和 500 行旧 glass 实现
 * 共处一个文件，导致双轨并存；现在 Settings.tsx 退化为纯 shell。
 *
 * P1-11: SyncSettings 使用前端直连 Supabase（支持 realtime/auth 等高级功能），
 * 后端 /api/sync 模块作为 legacy API 保留供未来后端化迁移使用。
 */
export function SyncPane() {
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
  // SyncSettings 的 prop 类型写的是 RefObject<HTMLInputElement>（React 19 下 current 必为
  // HTMLInputElement | null）；SyncSettings.tsx 本任务内保持原样，故只在调用点收敛一次。
  const fileInputProp = fileInputRef as React.RefObject<HTMLInputElement>;

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

  // AEX-P1-017：原先这段"回退本地恢复"逻辑在 .then 与 .catch 两个分支里各抄了一份
  // （14 行完全重复），抽成单一来源；后端不可用与"后端无配置"共用它。
  const restoreSyncFromLocal = () => {
    try {
      const saved = localStorage.getItem('syncConnection');
      if (!saved) return;
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
    } catch (_e: unknown) { /* ignore - intentional */ }
  };

  useEffect(() => {
    // 优先从后端恢复已保存的同步配置（重启后 Key 不丢失的核心修复）
    // AEX-P1-017：经 api.result.syncConfig() 统一契约 —— 原先裸 fetch + .then 链把
    // 非 2xx 响应也当成功 JSON 解析，且加载失败与"未配置"呈现完全相同的界面。
    void (async () => {
      const res = await api.result.syncConfig();
      // P0-8 修复：后端不再回传明文 supabaseKey（凭证），只返回 hasKey。
      // URL 从后端恢复，Key 从本地 sessionStorage/localStorage 兜底。
      // FE-11 修复：仅在 URL 和 Key 均成功解析后才置 connected=true
      if (res.ok && res.data.configured && res.data.supabaseUrl && res.data.hasKey) {
        const { supabaseUrl: url } = res.data;
        setSupabaseUrl(url);
        const localKey = resolveSupabaseKey();
        if (localKey) {
          setSupabaseKey(localKey);
          setKeyResolved(true);
          // 同时写入 localStorage，保证 Layout 轮询监听可用
          try { localStorage.setItem('syncConnection', JSON.stringify({ supabaseUrl: url, connected: true })); } catch { /* ignore */ }
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
      if (!res.ok) setSyncMsg('⚠️ 同步配置加载失败，已回退本地配置：' + res.error.message);
      restoreSyncFromLocal();
    })();
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
    // AEX-P1-017：经 api.result.disconnectSync()（无响应体端点用 requestResultVoid）。
    // 断开是本地优先操作，后端通知失败不阻断，但需如实告知用户云端仍处连接态。
    const res = await api.result.disconnectSync();
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
    setSyncMsg(res.ok ? '已断开连接' : '⚠️ 本地已断开，但通知后端失败：' + res.error.message);
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
    <SyncSettings
      supabaseUrl={supabaseUrl}
      setSupabaseUrl={setSupabaseUrl}
      supabaseKey={supabaseKey}
      setSupabaseKey={setSupabaseKey}
      connected={connected}
      setConnected={setConnected}
      keyResolved={keyResolved}
      setKeyResolved={setKeyResolved}
      syncing={syncing}
      setSyncing={setSyncing}
      syncMsg={syncMsg}
      setSyncMsg={setSyncMsg}
      lastSync={lastSync}
      setLastSync={setLastSync}
      realtimeEnabled={realtimeEnabled}
      setRealtimeEnabled={setRealtimeEnabled}
      authUser={authUser}
      setAuthUser={setAuthUser}
      authEmail={authEmail}
      setAuthEmail={setAuthEmail}
      authPassword={authPassword}
      setAuthPassword={setAuthPassword}
      authMsg={authMsg}
      setAuthMsg={setAuthMsg}
      showAuth={showAuth}
      setShowAuth={setShowAuth}
      uploadedFiles={uploadedFiles}
      setUploadedFiles={setUploadedFiles}
      fileInputRef={fileInputProp}
      handleConnect={handleConnect}
      handleDisconnect={handleDisconnect}
      handleToggleRealtime={handleToggleRealtime}
      handleAuth={handleAuth}
      handleLogout={handleLogout}
      handleFileUpload={handleFileUpload}
      handleSync={handleSync}
    />
  );
}
