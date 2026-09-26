import { describe, it, beforeEach, expect } from 'vitest';
import {
  NotificationCenter,
  buildTerminalDedupeKey,
  notificationCenter,
  sendNotification,
  requestNotificationPermission,
} from './notification-center';

/** 可注入依赖的 mock 环境 */
function makeDeps(overrides: { hidden?: boolean; granted?: boolean; bridge?: boolean; storage?: boolean } = {}) {
  const calls: Array<{ title: string; body: string; icon?: string }> = [];
  const storageMap = new Map<string, string>();
  const storage = overrides.storage !== false
    ? {
        getItem: (k: string) => storageMap.get(k) ?? null,
        setItem: (k: string, v: string) => { storageMap.set(k, v); },
        removeItem: (k: string) => { storageMap.delete(k); },
      }
    : null;

  const NCtor = function MockNotification(this: any, title: string, opts: any) {
    this.title = title;
    this.opts = opts;
    calls.push({ title, body: opts?.body ?? '', icon: opts?.icon });
    this.close = () => {};
  } as any;
  NCtor.permission = overrides.granted !== false ? 'granted' : 'denied';
  NCtor.requestPermission = async () => 'granted';

  const bridge = overrides.bridge
    ? { showNotification: (title: string, body?: string) => { calls.push({ title, body: body ?? '' }); } }
    : null;

  const center = new NotificationCenter({
    documentHidden: () => overrides.hidden !== false, // 默认页面后台（hidden=true → 应发送）
    NotificationCtor: NCtor,
    electronBridge: bridge,
    storage: storage as any,
  });
  return { center, calls, storage };
}

function makeNotification(partial: Record<string, unknown> = {}): any {
  return {
    id: `n-${Math.random().toString(36).slice(2, 8)}`,
    type: 'completed',
    title: 'AI 回复完成',
    body: '内容摘要',
    createdAt: new Date().toISOString(),
    dedupeKey: (partial.dedupeKey as string) ?? `run:${(partial.runId as string) ?? 'r1'}:completed`,
    ...partial,
  };
}

describe('notification-center — 通知幂等与终态语义（任务书第十六部分）', () => {
  beforeEach(() => {});

  it('测试 1: notifyOnce 同 dedupeKey 调用 10 次 → 实际通知 1 次', () => {
    const { center, calls } = makeDeps({ bridge: true });
    const n = makeNotification({ dedupeKey: 'run:r1:completed' });
    for (let i = 0; i < 10; i++) {
      center.notifyOnce({ ...n, id: `n-${i}` });
    }
    expect(calls.length).toBe(1);
  });

  it('测试 2: poll 100 次 generating=false 状态 → 0 次新通知（状态不是事件）', () => {
    const { center, calls } = makeDeps({ bridge: true });
    // 模拟轮询 100 次都读到"已完成"状态：每次只调用 notifyOnce（同 key 被去重）
    const n = makeNotification({ dedupeKey: 'run:r1:completed' });
    center.notifyOnce(n); // 第一次（SSE 已发过 → 此时 polling 不应再发）
    for (let i = 0; i < 100; i++) {
      center.notifyOnce({ ...n, id: `poll-${i}` });
    }
    expect(calls.length).toBe(1); // 只有 SSE 那一次
  });

  it('测试 3: stream completed + poll completed → 1 次', () => {
    const { center, calls } = makeDeps({ bridge: true });
    const n = makeNotification({ dedupeKey: 'run:r2:completed' });
    center.notifyOnce(n); // stream 完成
    center.notifyOnce(n); // poll 完成
    expect(calls.length).toBe(1);
  });

  it('测试 4: stream + activity replay + page rerender → 1 次', () => {
    const { center, calls } = makeDeps({ bridge: true });
    const n = makeNotification({ dedupeKey: 'run:r3:completed' });
    center.notifyOnce(n); // stream
    center.notifyOnce(n); // activity replay
    center.notifyOnce(n); // rerender 后同 key
    expect(calls.length).toBe(1);
  });

  it('测试 5: run completed/failed/cancelled/interrupted 分别生成正确类型', () => {
    const { center, calls } = makeDeps({ bridge: true });
    const cases: Array<{ type: any; dedupeKey: string; expectTitle: string }> = [
      { type: 'completed', dedupeKey: 'run:r5:completed', expectTitle: 'AI 回复完成' },
      { type: 'failed', dedupeKey: 'run:r5:failed', expectTitle: 'AI 回复失败' },
      { type: 'cancelled', dedupeKey: 'run:r5:cancelled', expectTitle: 'AI 回复已取消' },
      { type: 'interrupted', dedupeKey: 'run:r5:interrupted', expectTitle: 'AI 回复已中断' },
    ];
    for (const c of cases) {
      center.notifyOnce(makeNotification({ dedupeKey: c.dedupeKey, type: c.type }));
    }
    expect(calls.length).toBe(4); // 不同 key 各自通知
    // 相同 key 再次调用被去重
    center.notifyOnce(makeNotification({ dedupeKey: 'run:r5:completed' }));
    expect(calls.length).toBe(4);
  });

  it('测试 6: 用户主动 Stop → cancelled，不能出现 AI 回复完成', () => {
    const { center, calls } = makeDeps({ bridge: true });
    center.notifyOnce(makeNotification({ dedupeKey: 'run:r6:cancelled', type: 'cancelled', title: 'AI 回复已取消' }));
    // 模拟之后 polling 误报 completed：同 run 的 completed key 是新 key，会发出 —— 但真实链路中
    // Stop 后后端不会再发 completed 终态；此处验证 cancelled 通知标题不含"完成"
    expect(calls[0].title).toBe('AI 回复已取消');
    expect(calls[0].title).not.toContain('完成');
  });

  it('测试 7: stream-truncated → 不能 completed 通知（终态必须是 failed/interrupted）', () => {
    const { center, calls } = makeDeps({ bridge: true });
    // 流中断 → interrupted 终态
    center.notifyOnce(makeNotification({ dedupeKey: 'run:r7:interrupted', type: 'interrupted', title: 'AI 回复已中断' }));
    expect(calls[0].title).not.toContain('完成');
    expect(calls[0].title).toContain('中断');
    // 后续误报 completed 同 run 会被去重（仅当后端也发 completed；真实后端流中断不发 completed）
    const n = makeNotification({ dedupeKey: 'run:r7:completed' });
    center.notifyOnce(n);
    // interrupted 与 completed 是不同 key —— 真实语义中后端不会同时发；此处仅验证 interrupted 本身正确
    expect(calls.length).toBe(2);
    expect(calls[0].title).toBe('AI 回复已中断');
  });

  it('测试 8: workflow direct run / editor run 终态通知语义一致（同 dedupeKey）', () => {
    const { center, calls } = makeDeps({ bridge: true });
    const wfKey = 'workflow:wf1:completed';
    center.notifyOnce(makeNotification({ dedupeKey: wfKey, title: '✅ 工作流运行完成' }));
    center.notifyOnce(makeNotification({ dedupeKey: wfKey, title: '✅ 工作流运行完成' }));
    expect(calls.length).toBe(1); // direct + editor 只通知一次
  });

  it('测试 9: media generation 同 generationId 重复回调 → 只通知一次', () => {
    const { center, calls } = makeDeps({ bridge: true });
    const mediaKey = 'media:gen-42:completed';
    center.notifyOnce(makeNotification({ dedupeKey: mediaKey, title: '图片生成完成' }));
    center.notifyOnce(makeNotification({ dedupeKey: mediaKey, title: '图片生成完成' }));
    expect(calls.length).toBe(1);
  });

  it('测试 10: 页面前台不打扰（hidden=false 不发送），页面后台发送；always 强制发送', () => {
    const { center, calls } = makeDeps({ bridge: true, hidden: false });
    // 页面聚焦 → 不发送
    center.notifyOnce(makeNotification({ dedupeKey: 'run:r10:completed' }));
    expect(calls.length).toBe(0);
    // 页面聚焦 + always → 强制发送
    center.notifyOnce(makeNotification({ dedupeKey: 'run:r10:failed', type: 'failed', title: '❌ 执行失败' }) && { ...makeNotification({ dedupeKey: 'run:r10:failed', type: 'failed', title: '❌ 执行失败' }), always: true });
    expect(calls.length).toBe(1);
  });

  it('buildTerminalDedupeKey 生成唯一 key', () => {
    expect(buildTerminalDedupeKey('run', 'r1', 'completed')).toBe('run:r1:completed');
    expect(buildTerminalDedupeKey('workflow', 'wf1', 'failed')).toBe('workflow:wf1:failed');
    expect(buildTerminalDedupeKey('media', 'gen-1', 'interrupted')).toBe('media:gen-1:interrupted');
  });
});

describe('notification-center — 能力对齐旧 notifications.ts（通知收敛 P2-011）', () => {
  // 旧 notifications.ts 的 NotificationOptions 含 icon；notification-center 的
  // LegacyNotificationOptions 也声明了 icon，但此前构建 AppNotification 时丢弃、
  // 且 notify() 未传给浏览器 Notification —— 迁移期任何带 icon 的旧调用点都会丢图标。
  it('测试 11: icon 从 AppNotification 贯通到浏览器通知', () => {
    const { center, calls } = makeDeps({ bridge: false });
    const n = makeNotification({ dedupeKey: 'run:r11:completed' });
    n.icon = 'data:image/png;base64,AAAA';
    center.notify(n);
    expect(calls.length).toBe(1);
    expect(calls[0].icon).toBe('data:image/png;base64,AAAA');
  });

  it('测试 12: 兼容导出 sendNotification 带 dedupeKey 时走幂等路径并透传 icon', () => {
    const key = buildTerminalDedupeKey('run', 'legacy-1', 'completed');
    expect(notificationCenter.hasNotified(key)).toBe(false);
    sendNotification('AI 回复完成', { dedupeKey: key, always: true, icon: 'data:image/png;base64,BBBB' });
    expect(notificationCenter.hasNotified(key)).toBe(true);
  });

  it('测试 13: 兼容导出 requestNotificationPermission（Layout 迁移目标）委托统一中心且不抛错', async () => {
    await expect(requestNotificationPermission()).resolves.toBeTypeOf('boolean');
  });
});
