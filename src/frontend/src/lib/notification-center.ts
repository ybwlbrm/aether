/**
 * Unified Notification Center（P0 — 通知幂等化）
 *
 * 唯一通知入口：所有业务页面/钩子必须经 notificationCenter.notifyOnce() 发通知，
 * 禁止直接 new Notification() / 直接 electronAPI.showNotification() / 自行拼接通知链路。
 *
 * 核心语义（任务书第二部分）：
 * - 通知必须绑定"终态事件"（run.completed/failed/cancelled/interrupted、workflow.*、media.*），
 *   禁止用 generating=false / polling 返回 / messages.length 变化 / stream EOF 推导"刚完成"。
 * - 唯一 dedupeKey（如 run:{runId}:completed）+ memory Set + sessionStorage 双重幂等保护：
 *   同一 runId + 终态事件 经 SSE / Polling / Activity Replay / Page Remount 只能产生 1 次通知。
 * - 统一：dedupe → visibility 判断 → 用户设置 → Browser/Electron → 失败降级 → 点击 → 日志。
 *
 * 依赖注入（便于测试）：可注入 document/Notification/electronAPI，默认取全局。
 */

export type NotificationTerminalType =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'budget_exceeded'
  | 'timeout';

export interface AppNotification {
  /** 业务唯一 ID（随机或由调用方指定） */
  id: string;
  /** 终态类型（completed/failed/cancelled/interrupted/budget_exceeded/timeout） */
  type: NotificationTerminalType;
  title: string;
  body?: string;

  conversationId?: string;
  runId?: string;
  taskId?: string;

  /** 触发通知的源事件 ID（可选，便于审计溯源） */
  sourceEventId?: string;
  createdAt: string;

  /** 唯一去重键：run:{runId}:completed / workflow:{runId}:failed / media:{jobId}:completed */
  dedupeKey: string;

  priority?: 'low' | 'normal' | 'high';
  /** 即使页面聚焦也发送（关键失败/高风险事件），默认 false */
  always?: boolean;
}

export interface NotificationCenterDeps {
  /** 页面可见性（可注入 mock） */
  documentHidden?: () => boolean;
  /** 浏览器 Notification API（可注入 mock） */
  NotificationCtor?: any;
  /** Electron 桥接（可注入 mock） */
  electronBridge?: { showNotification: (title: string, body?: string) => void } | null;
  /** storage（可注入 mock；默认 sessionStorage） */
  storage?: Storage | null;
  /** 通知开关设置（可注入；默认开启） */
  isEnabled?: () => boolean;
  /** 日志（可注入；默认 console） */
  log?: Pick<Console, 'warn' | 'info' | 'error'>;
}

const SESSION_KEY_PREFIX = 'aether:notifications:';
const PERMISSION_KEY = 'notification-permission';

export function buildTerminalDedupeKey(scope: 'run' | 'workflow' | 'media', id: string, type: NotificationTerminalType): string {
  return `${scope}:${id}:${type}`;
}

export class NotificationCenter {
  private readonly notifiedKeys = new Set<string>();
  private readonly deps: Required<NotificationCenterDeps>;
  private permissionInitialized = false;

  constructor(deps: NotificationCenterDeps = {}) {
    this.deps = {
      documentHidden: deps.documentHidden ?? (() => typeof document !== 'undefined' && document.hidden),
      NotificationCtor: deps.NotificationCtor ?? (typeof Notification !== 'undefined' ? Notification : undefined),
      electronBridge: deps.electronBridge !== undefined
        ? deps.electronBridge
        : (typeof window !== 'undefined' ? (window as any).electronAPI?.showNotification ?? null : null),
      storage: deps.storage !== undefined ? deps.storage : (typeof sessionStorage !== 'undefined' ? sessionStorage : null),
      isEnabled: deps.isEnabled ?? (() => true),
      log: deps.log ?? console,
    };
  }

  /** 幂等查询：该 dedupeKey 是否已通知过（内存 + sessionStorage） */
  hasNotified(dedupeKey: string): boolean {
    if (this.notifiedKeys.has(dedupeKey)) return true;
    const storage = this.deps.storage;
    if (storage) {
      try {
        if (storage.getItem(SESSION_KEY_PREFIX + dedupeKey)) return true;
      } catch { /* storage 不可用则仅内存 */ }
    }
    return false;
  }

  /** 标记已通知（内存 + sessionStorage） */
  markNotified(dedupeKey: string): void {
    this.notifiedKeys.add(dedupeKey);
    const storage = this.deps.storage;
    if (storage) {
      try { storage.setItem(SESSION_KEY_PREFIX + dedupeKey, new Date().toISOString()); } catch { /* ignore */ }
    }
  }

  /**
   * 幂等通知：同 dedupeKey 只产生 1 次实际通知。
   * @returns 是否真正发送（false = 已被去重或未满足发送条件）
   */
  notifyOnce(notification: AppNotification): boolean {
    if (!notification || !notification.dedupeKey) {
      this.deps.log.warn('[NotificationCenter] notifyOnce 缺少 dedupeKey，已忽略:', notification);
      return false;
    }
    if (this.hasNotified(notification.dedupeKey)) {
      this.deps.log.info('[NotificationCenter] 去重（已通知过）:', notification.dedupeKey);
      return false;
    }
    this.markNotified(notification.dedupeKey);
    return this.notify(notification);
  }

  /** 直接发送（不做去重；调用方必须自行保证幂等，绝大多数场景应使用 notifyOnce） */
  notify(notification: AppNotification): boolean {
    // 1. 用户通知设置
    if (!this.deps.isEnabled()) return false;

    // 2. 可见性判断：页面聚焦且非 always → 不打扰用户
    if (!notification.always && !this.deps.documentHidden()) return false;

    // 3. Electron 优先：系统级通知（单一桥接，业务页不再自己拼 IPC）
    const bridge = this.deps.electronBridge;
    if (bridge && typeof bridge.showNotification === 'function') {
      try {
        bridge.showNotification(notification.title, notification.body ?? '');
        return true;
      } catch {
        /* 桥接失败 → 回退浏览器通知 */
      }
    }

    // 4. 浏览器 Notification
    const NCtor = this.deps.NotificationCtor;
    if (typeof NCtor === 'undefined' || typeof NCtor !== 'function') return false;
    if (NCtor.permission !== 'granted') return false;
    try {
      const n = new NCtor(notification.title, { body: notification.body ?? '', icon: undefined });
      n.onclick = () => { if (typeof window !== 'undefined') window.focus(); n.close(); };
      setTimeout(() => n.close(), 10000);
      return true;
    } catch (e) {
      this.deps.log.warn('[NotificationCenter] 浏览器通知发送失败（降级忽略）:', e);
      return false;
    }
  }

  /** 请求通知权限（统一入口：仅 App Shell/Layout 与设置页调用，业务页禁止散调） */
  async requestPermission(): Promise<boolean> {
    if (this.permissionInitialized) return true;
    // Electron 系统通知不依赖浏览器权限
    if (this.deps.electronBridge) { this.permissionInitialized = true; return true; }
    const NCtor = this.deps.NotificationCtor;
    if (typeof NCtor === 'undefined') { this.permissionInitialized = true; return false; }
    const storage = this.deps.storage;
    if (storage) {
      try { if (storage.getItem(PERMISSION_KEY) === 'denied') { this.permissionInitialized = true; return false; } } catch { /* ignore */ }
    }
    if (NCtor.permission === 'granted') { this.permissionInitialized = true; return true; }
    if (NCtor.permission === 'denied') {
      if (storage) { try { storage.setItem(PERMISSION_KEY, 'denied'); } catch { /* ignore */ } }
      this.permissionInitialized = true;
      return false;
    }
    try {
      const result = await NCtor.requestPermission();
      if (result === 'granted') { this.permissionInitialized = true; return true; }
      if (storage) { try { storage.setItem(PERMISSION_KEY, 'denied'); } catch { /* ignore */ } }
      this.permissionInitialized = true;
      return false;
    } catch {
      this.permissionInitialized = true;
      return false;
    }
  }

  /** 测试辅助：清空内存去重表（sessionStorage 不受影响） */
  clearMemoryDedupe(): void {
    this.notifiedKeys.clear();
    this.permissionInitialized = false;
  }
}

// ============================================================
// 单例（生产使用）；测试可 new NotificationCenter(deps) 独立实例
// ============================================================
export const notificationCenter = new NotificationCenter();

// ============================================================
// 兼容导出：旧 sendNotification / requestNotificationPermission 委托到统一中心。
// 业务代码应逐步迁移到 notificationCenter.notifyOnce()，这两个函数仅作兼容过渡。
// ============================================================
export interface LegacyNotificationOptions {
  body?: string;
  icon?: string;
  /** 即使页面聚焦也发送（重要事件） */
  always?: boolean;
  /** 可选 dedupeKey —— 提供后走 notifyOnce（幂等）；缺省则每次直接发送（兼容旧行为） */
  dedupeKey?: string;
  /** 终态类型（默认 completed，仅用于构建通知语义） */
  type?: NotificationTerminalType;
}

export function sendNotification(title: string, options: LegacyNotificationOptions = {}): void {
  const { body = '', always = false, dedupeKey, type = 'completed' } = options;
  const notification: AppNotification = {
    id: `legacy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    title,
    body,
    createdAt: new Date().toISOString(),
    dedupeKey: dedupeKey ?? `legacy:${title}:${Date.now()}`,
    always,
  };
  if (dedupeKey) {
    notificationCenter.notifyOnce(notification);
  } else {
    notificationCenter.notify(notification);
  }
}

export function requestNotificationPermission(): Promise<boolean> {
  return notificationCenter.requestPermission();
}
