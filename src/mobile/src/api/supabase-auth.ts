import {
  createClient,
  type SupabaseClient,
  type Session,
  type User,
  type AuthChangeEvent,
} from '@supabase/supabase-js';
import { SupabaseApiError, classifyError } from './supabase-errors';

// ============================================================
// Supabase Auth 层 — anon key + Supabase Auth（P0-A01/A02/A03/A05 修复）
//
// 安全设计（2026-09-06）：
// - 移动端只持有「anon key」（可公开安全），绝不再接触 service_role key。
// - 身份由 Supabase Auth（邮箱/密码登录）建立；RLS 按 user_id 行级隔离，
//   未登录（anon）无法读写任何同步数据。
// - Supabase URL 与 anon key 持久化到 localStorage（均为公开信息）；
//   Auth session 由 supabase-js 自动持久化并刷新（refresh token）。
// - 设备 ID 使用 UUID（crypto.randomUUID()）且同一设备持久化，
//   不再使用 Date.now()+Math.random 的可预测 ID。
// - 设备注册绑定当前登录用户（devices.user_id），device 与身份强关联。
// - 错误分类：认证/权限/网络等错误抛 SupabaseApiError（见 supabase-errors.ts）。
// ============================================================

// ============================================================
// 配置与存储
// ============================================================

const URL_STORAGE_KEY = 'aether_supabase_url';
const ANON_KEY_STORAGE_KEY = 'aether_supabase_anon_key';
const DEVICE_ID_KEY = 'aether_device_id';

interface SyncConfig {
  supabaseUrl: string;
  /** anon key（可公开），不再存储 service_role key */
  anonKey: string;
  deviceId: string;
  deviceName?: string;
}

let sbClient: SupabaseClient | null = null;
let currentUrl: string | null = null;
let currentUser: User | null = null;

/** 生成 UUID（crypto.randomUUID），兼容不支持的环境时回退到随机串 */
function generateUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // RFC 4122 v4 回退实现（WebView 旧内核）
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * 获取或创建设备 ID。
 * 使用 UUID（非 Date.now+random），并持久化 —— 同一设备始终复用同一 ID，
 * 重新安装/登出登录不改变设备身份。
 */
function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = generateUuid();
    try {
      localStorage.setItem(DEVICE_ID_KEY, id);
    } catch { /* storage 满时忽略，本次会话仍可用 */ }
  }
  return id;
}

/**
 * 保存连接配置（URL + anon key）。
 * anon key 为公开密钥，可安全持久化；service_role key 不再需要。
 */
export function saveConfig(url: string, anonKey: string): void {
  localStorage.setItem(URL_STORAGE_KEY, url.trim());
  localStorage.setItem(ANON_KEY_STORAGE_KEY, anonKey.trim());
  // 配置变化后强制重建客户端
  if (sbClient && currentUrl !== url.trim()) {
    sbClient = null;
    currentUrl = null;
  }
}

/** 加载配置 */
export function loadConfig(): SyncConfig | null {
  const url = localStorage.getItem(URL_STORAGE_KEY);
  const anonKey = localStorage.getItem(ANON_KEY_STORAGE_KEY);
  if (!url || !anonKey) return null;
  return {
    supabaseUrl: url,
    anonKey,
    deviceId: getDeviceId(),
    deviceName: 'Aether 手机端',
  };
}

/** 是否已配置连接（URL + anon key 均已保存） */
export function isConfigured(): boolean {
  return !!localStorage.getItem(URL_STORAGE_KEY) && !!localStorage.getItem(ANON_KEY_STORAGE_KEY);
}

/** 是否已登录（存在有效会话） */
export function isAuthed(): boolean {
  return !!currentUser;
}

/** 读取已持久化的 URL（供重启后预填表单） */
export function getStoredUrl(): string | null {
  return localStorage.getItem(URL_STORAGE_KEY);
}

/** 读取已持久化的 anon key（供重启后预填表单） */
export function getStoredAnonKey(): string | null {
  return localStorage.getItem(ANON_KEY_STORAGE_KEY);
}

/** 获取当前登录用户（内存缓存） */
export function getCurrentUser(): User | null {
  return currentUser;
}

// ============================================================
// 客户端管理
// ============================================================

/** 获取 Supabase 客户端（anon key，含 Auth 能力） */
export function getClient(): SupabaseClient | null {
  const cfg = loadConfig();
  if (!cfg) return null;
  if (!sbClient || currentUrl !== cfg.supabaseUrl) {
    sbClient = createClient(cfg.supabaseUrl, cfg.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // Capacitor WebView 中 URL 不含回调参数，避免误解析
        detectSessionInUrl: false,
        storageKey: 'aether-mobile-auth',
      },
      realtime: { heartbeatIntervalMs: 15000 },
    });
    currentUrl = cfg.supabaseUrl;
    // 从持久化 session 同步内存用户缓存
    void sbClient.auth.getSession().then(({ data }) => {
      currentUser = data.session?.user ?? null;
    }).catch(() => { currentUser = null; });
  }
  return sbClient;
}

// ============================================================
// Supabase Auth（P0-A03：登录 / 注册 / 登出 / 会话）
// ============================================================

/** 邮箱密码登录。成功返回 Session，失败抛出分类后的 SupabaseApiError */
export async function signIn(email: string, password: string): Promise<Session> {
  const sb = getClient();
  if (!sb) throw new SupabaseApiError('auth', '未配置 Supabase，请先填写 URL 和 Anon Key');
  const { data, error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
  if (error) throw new SupabaseApiError('auth', error.message, { status: error.status, code: error.code });
  currentUser = data.user;
  return data.session;
}

/** 邮箱密码注册。返回是否需邮箱确认（needsEmailConfirm）。失败抛分类错误 */
export async function signUp(
  email: string,
  password: string,
): Promise<{ session: Session | null; user: User | null; needsEmailConfirm: boolean }> {
  const sb = getClient();
  if (!sb) throw new SupabaseApiError('auth', '未配置 Supabase，请先填写 URL 和 Anon Key');
  const { data, error } = await sb.auth.signUp({ email: email.trim(), password });
  if (error) throw new SupabaseApiError('auth', error.message, { status: error.status, code: error.code });
  currentUser = data.user ?? null;
  return {
    session: data.session,
    user: data.user ?? null,
    needsEmailConfirm: data.session === null && !!data.user,
  };
}

/** 登出。失败抛分类错误 */
export async function signOut(): Promise<void> {
  const sb = getClient();
  if (!sb) return;
  const { error } = await sb.auth.signOut();
  if (error) throw new SupabaseApiError('auth', error.message, { status: error.status, code: error.code });
  currentUser = null;
}

/** 获取当前会话（从持久化存储恢复 session 后调用） */
export async function getSession(): Promise<Session | null> {
  const sb = getClient();
  if (!sb) return null;
  const { data, error } = await sb.auth.getSession();
  if (error) {
    console.error('[supabase] 获取会话失败:', error.message);
    return null;
  }
  currentUser = data.session?.user ?? null;
  return data.session;
}

/** 手动刷新会话（supabase-js 通常自动刷新；token 过期时调用） */
export async function refreshSession(): Promise<Session | null> {
  const sb = getClient();
  if (!sb) return null;
  const { data, error } = await sb.auth.refreshSession();
  if (error) {
    console.error('[supabase] 刷新会话失败:', error.message);
    return null;
  }
  currentUser = data.session?.user ?? null;
  return data.session;
}

/** 订阅认证状态变化。返回取消订阅函数 */
export function onAuthStateChange(callback: (event: AuthChangeEvent, session: Session | null) => void): () => void {
  const sb = getClient();
  if (!sb) return () => {};
  const { data } = sb.auth.onAuthStateChange((event, session) => {
    currentUser = session?.user ?? null;
    callback(event, session);
  });
  return () => data.subscription.unsubscribe();
}

// ============================================================
// 设备注册（P0-A05：UUID 设备 ID + 绑定 userId）
// ============================================================

/**
 * 注册设备到 Supabase，device 记录绑定当前登录用户（user_id）。
 * 返回是否成功；失败时记录分类错误（不静默吞掉）。
 */
export async function registerDevice(): Promise<boolean> {
  const sb = getClient();
  const cfg = loadConfig();
  if (!sb || !cfg) {
    console.warn('[supabase] 设备注册跳过：Supabase 未配置');
    return false;
  }
  const user = currentUser ?? (await sb.auth.getUser()).data.user;
  if (!user) {
    console.warn('[supabase] 设备注册失败：未登录（需先通过 Supabase Auth 登录）');
    return false;
  }
  try {
    const { error } = await sb.from('devices').upsert({
      id: cfg.deviceId,
      user_id: user.id,
      name: cfg.deviceName || 'Aether 手机端',
      type: 'mobile',
      last_seen_at: new Date().toISOString(),
    }, { onConflict: 'id' });
    if (error) throw error;
    return true;
  } catch (e) {
    const err = classifyError(e);
    console.error(`[supabase] 设备注册失败 (${err.kind}):`, err.message);
    return false;
  }
}

/** 断开连接（保留设备 ID，同一设备再次登录身份不变） */
export function disconnect(): void {
  sbClient = null;
  currentUrl = null;
  currentUser = null;
  localStorage.removeItem(URL_STORAGE_KEY);
  localStorage.removeItem(ANON_KEY_STORAGE_KEY);
}
