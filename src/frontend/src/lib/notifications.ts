/**
 * 桌面通知工具 — 统一封装浏览器 Notification API 与 Electron 系统通知。
 *
 * 优先级：
 *   1. Electron 环境（window.electronAPI.showNotification 存在）→ 系统级通知，无需浏览器权限
 *   2. 浏览器 Notification API → 需要用户授权
 *
 * 行为约定：
 *   - 默认仅在页面处于后台（document.hidden）时发送，避免打扰正在操作的用户
 *   - 重要事件可传 always: true 强制发送
 *   - 用户拒绝授权后不再重复询问（localStorage 持久化）
 */

const PERMISSION_KEY = 'notification-permission';

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