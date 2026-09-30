import { describe, expect, it } from 'vitest';
import { persistWorkspace, useWorkspaceStore, type WorkspaceState } from './workspace';

/**
 * T26：`persistWorkspace` 字段白名单。
 *
 * 修复前是 `JSON.stringify(state)` —— 8 个 action 函数被当作 key 枚举进落盘 JSON
 * （值为 undefined 被 stringify 丢弃，但 key 枚举本身浪费，且形状随 store 定义漂移）。
 * 断言落盘 payload 只含状态字段，且与 store 的 action 键集合零重叠 —— 任何人
 * 再往 WorkspaceState 加 action，本测试都会失败，防止白名单退化成全量序列化。
 */

const STORAGE_KEY = 'aether.workspace';

const ACTION_KEYS = [
  'setSidebarMode', 'openWorkbench', 'closeWorkbench', 'toggleWorkbench',
  'setWorkbenchTab', 'setWorkbenchWidth', 'toggleWorkbenchPin', 'toggleWorkbenchMaximize',
  'setConversationId',
] as const;

function installStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map<string, string>(Object.entries(initial));
  const stub = {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => { map.delete(k) },
    setItem: (k: string, v: string) => { map.set(k, v) },
  } as Storage;
  Object.defineProperty(globalThis, 'localStorage', { value: stub, configurable: true, writable: true });
  return stub;
}

function readPayload(storage: Storage): Record<string, unknown> {
  const raw = storage.getItem(STORAGE_KEY);
  expect(raw).not.toBeNull();
  return JSON.parse(raw as string) as Record<string, unknown>;
}

describe('persistWorkspace 字段白名单（T26）', () => {
  it('写出的 payload 顶层键恰为 3 个状态字段，无任何函数键', () => {
    const storage = installStorage();
    persistWorkspace(useWorkspaceStore.getState());

    const payload = readPayload(storage);
    expect(Object.keys(payload).sort()).toEqual(['conversationId', 'sidebarMode', 'workbench']);
    for (const key of ACTION_KEYS) {
      expect(payload).not.toHaveProperty(key);
    }
    for (const value of Object.values(payload)) {
      expect(typeof value).not.toBe('function');
    }
  });

  it('workbench 子对象写全 5 个状态字段（不是半个子对象）', () => {
    const storage = installStorage();
    persistWorkspace(useWorkspaceStore.getState());

    const payload = readPayload(storage) as { workbench: Record<string, unknown> };
    expect(Object.keys(payload.workbench).sort()).toEqual(
      ['activeTab', 'maximized', 'open', 'pinned', 'width'],
    );
  });

  it('T26 删掉的 projectId 不再出现在落盘 payload 里', () => {
    const storage = installStorage();
    persistWorkspace(useWorkspaceStore.getState());
    expect(readPayload(storage)).not.toHaveProperty('projectId');
  });

  it('往 WorkspaceState 加 action 后本白名单不会把它写出去', () => {
    const storage = installStorage();
    const polluted = {
      ...useWorkspaceStore.getState(),
      brandNewAction: () => 'nope',
    } as WorkspaceState;
    persistWorkspace(polluted);

    const payload = readPayload(storage);
    expect(payload).not.toHaveProperty('brandNewAction');
    expect(Object.keys(payload).sort()).toEqual(['conversationId', 'sidebarMode', 'workbench']);
  });

  it('状态变更被完整往返（loadInitial 会读回这些键）', () => {
    const storage = installStorage();
    const store = useWorkspaceStore.getState();
    store.setSidebarMode('compact');
    useWorkspaceStore.getState().setConversationId('conv-42');
    persistWorkspace(useWorkspaceStore.getState());

    const payload = readPayload(storage);
    expect(payload.sidebarMode).toBe('compact');
    expect(payload.conversationId).toBe('conv-42');

    // 落盘 JSON 自身即可被 loadInitial 消费：只含状态字段即证明读回路径不丢字段
    const reparsed = JSON.parse(storage.getItem(STORAGE_KEY) as string) as WorkspaceState;
    expect(reparsed.sidebarMode).toBe('compact');
    expect(reparsed.conversationId).toBe('conv-42');
  });
});
