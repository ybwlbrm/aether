/**
 * @deprecated 旧桌面通知工具 —— 已被 lib/notification-center.ts 取代（P2-011 通知收敛）。
 *
 * 唯一通知源：notification-center.ts（NotificationCenter）
 * - 终态事件驱动 + dedupeKey 幂等（run:{runId}:{terminalType}），SSE/Polling/Replay/重挂载只通知一次
 * - 用户设置 → 可见性 → Electron 桥接 → 浏览器通知 → 失败降级 → 点击 → 日志，单一链路
 * - 本模块无 dedupe 能力，且用 localStorage 记权限（与统一中心的 sessionStorage 不一致），
 *   保留只会造成"双通知系统"再次分叉。
 *
 * deprecatedSince: 2026-09-26
 * replacement: src/frontend/src/lib/notification-center.ts
 *   - requestNotificationPermission() → notification-center 的 requestNotificationPermission()
 *   - sendNotification(title, { body, icon, always }) → notification-center 的 sendNotification()
 *     （支持传 dedupeKey 以走幂等路径）
 *   - 新增业务通知请直接用 notificationCenter.notifyOnce({ type, title, dedupeKey, ... })
 * deletionTarget: 迁移完成后删除本文件（最后消费者 Layout.tsx 已于 2026-09-26 改引 notification-center）
 */

const PERMISSION_KEY = 'notification-permission';

/** @deprecated 用 notification-center 的 LegacyNotificationOptions 代替（无 dedupeKey 即无幂等）。 */
export interface NotificationOptions {
  body?: string;
  icon?: string;
  /** 即使页面聚焦也发送（重要事件） */
  always?: boolean;
}

/** 检测 Electron 环境是否暴露了系统通知桥接 */
function hasElectronBridge(): boolean {
  return typeof window !== 'undefined' && !!(window as any).electronAPI?.showNotification;
}

/**
 * 请求通知权限（首次使用时调用）。
 * - 已授权：直接返回 true
 * - 已拒绝：不再询问，返回 false（尊重用户选择）
 * - 未决定：弹出浏览器授权请求
 *
 * @deprecated 改用 notification-center 的 requestNotificationPermission()（唯一通知源）。
 */
export async function requestNotificationPermission(): Promise<boolean> {
  // Electron 系统通知不依赖浏览器权限
  if (hasElectronBridge()) return true;
  if (typeof Notification === 'undefined') return false;
  // 用户此前明确拒绝过 — 不再打扰
  if (localStorage.getItem(PERMISSION_KEY) === 'denied') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') {
    localStorage.setItem(PERMISSION_KEY, 'denied');
    return false;
  }
  try {
    const result = await Notification.requestPermission();
    if (result === 'granted') return true;
    localStorage.setItem(PERMISSION_KEY, 'denied');
    return false;
  } catch {
    return false;
  }
}

/**
 * 发送桌面通知。
 * 默认仅在页面处于后台时发送；重要事件传 always: true 强制发送。
 *
 * @deprecated 改用 notification-center 的 sendNotification()（支持 dedupeKey 幂等）
 *             或 notificationCenter.notifyOnce()（终态事件驱动）。本函数无去重，重复调用会重复通知。
 */
export function sendNotification(title: string, options: NotificationOptions = {}): void {
  const { body = '', icon, always = false } = options;
  // 页面聚焦且非重要事件 — 不打扰用户
  if (!always && !document.hidden) return;

  // Electron 优先：系统级通知
  if (hasElectronBridge()) {
    try {
      (window as any).electronAPI.showNotification(title, body);
      return;
    } catch {
      /* 桥接失败时回退到浏览器通知 */
    }
  }

  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, icon });
    // 点击通知聚焦窗口
    n.onclick = () => { window.focus(); n.close(); };
    // 自动关闭，避免堆积
    setTimeout(() => n.close(), 10000);
  } catch {
    /* ignore - intentional */
  }
}