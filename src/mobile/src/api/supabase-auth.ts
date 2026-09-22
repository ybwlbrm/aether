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
// §27 / §28 Client Manager：
// - saveConfig 比较 URL + Anon Key，任一变化 → 销毁旧 client + 重建
// - getClient 惰性创建，配置变化自动重建
// - disposeClient 显式销毁（登出时调用），避免旧 client 残留
// - registerDevice 缓存成功状态（§54），避免每次命令重复注册
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
let currentAnonKey: string | null = null;
let currentUser: User | null = null;
// §54: 设备注册成功缓存（配置变化时重置）
let deviceRegisteredCached = false;
let cachedDeviceIdForUser: string | null = null;

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
 * 使用 UUID（非 Date.now+random），并持久化 —— 同一设备始终复用同一 ID。
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
 * §27 修复：URL 或 anonKey 任一变化 → 销毁旧 client + 重置注册缓存。
 * 不能出现「UI 已保存新配置，但请求仍使用旧 client」。
 */
export function saveConfig(url: string, anonKey: string): void {
  const nextUrl = url.trim();
  const nextKey = anonKey.trim();
  localStorage.setItem(URL_STORAGE_KEY, nextUrl);
  localStorage.setItem(ANON_KEY_STORAGE_KEY, nextKey);

  const urlChanged = sbClient && currentUrl !== nextUrl;
  const keyChanged = sbClient && currentAnonKey !== nextKey;
  if (urlChanged || keyChanged) {
    disposeClient();
  }
}

/**
 * 显式销毁当前 client（§28 dispose）。
 * 登出 / 配置变更时调用：释放 Realtime channel、auth listener 引用。
 */
export function disposeClient(): void {
  if (sbClient) {
    try {
      void sbClient.realtime.removeAllChannels();
    } catch { /* ignore */ }
  }
  sbClient = null;
  currentUrl = null;
  currentAnonKey = null;
  currentUser = null;
  deviceRegisteredCached = false;
  cachedDeviceIdForUser = null;
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
// Client Manager（§28）
// ============================================================

/** 获取 Supabase 客户端（anon key，含 Auth 能力）。配置变化自动重建。 */
export function getClient(): SupabaseClient | null {
  const cfg = loadConfig();
  if (!cfg) return null;
  if (!sbClient || currentUrl !== cfg.supabaseUrl || currentAnonKey !== cfg.anonKey) {
    disposeClient();
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
    currentAnonKey = cfg.anonKey;
    // 从持久化 session 同步内存用户缓存
    void sbClient.auth.getSession().then(({ data }) => {
      currentUser = data.session?.user ?? null;
    }).catch(() => { currentUser = null; });
  }
  return sbClient;
}

// ============================================================
// Supabase Auth
// ============================================================

/** 邮箱密码登录。成功返回 Session，失败抛分类后的 SupabaseApiError */
export async function signIn(email: string, password: string): Promise<Session> {
  const sb = getClient();
  if (!sb) throw new SupabaseApiError('auth', '未配置 Supabase，请先填写 URL 和 Anon Key');
  const { data, error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
  if (error) throw new SupabaseApiError('auth', error.message, { status: error.status, code: error.code });
  currentUser = data.user;
  deviceRegisteredCached = false;
  cachedDeviceIdForUser = null;
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
  deviceRegisteredCached = false;
  cachedDeviceIdForUser = null;
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
  deviceRegisteredCached = false;
  cachedDeviceIdForUser = null;
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
// 设备注册（§54：登录/初始化时注册一次，缓存成功状态）
// ============================================================

/**
 * 注册设备到 Supabase，device 记录绑定当前登录用户（user_id）。
 * §54 修复：同用户同设备缓存成功状态，避免每次命令重复注册。
 * 配置变化（saveConfig 触发 disposeClient）或登录用户变化时自动重置。
 */
export async function registerDevice(force = false): Promise<boolean> {
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
  // 缓存命中：同一用户同一设备已注册成功 → 直接返回
  if (!force && deviceRegisteredCached && cachedDeviceIdForUser === user.id) {
    return true;
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
    deviceRegisteredCached = true;
    cachedDeviceIdForUser = user.id;
    return true;
  } catch (e) {
    const err = classifyError(e);
    console.error(`[supabase] 设备注册失败 (${err.kind}):`, err.message);
    deviceRegisteredCached = false;
    return false;
  }
}

/** 断开连接（保留设备 ID，同一设备再次登录身份不变） */
export function disconnect(): void {
  disposeClient();
  localStorage.removeItem(URL_STORAGE_KEY);
  localStorage.removeItem(ANON_KEY_STORAGE_KEY);
}
