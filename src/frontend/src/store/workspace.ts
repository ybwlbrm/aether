import { create } from 'zustand';

/**
 * WorkspaceState — 工作区状态（spec §78）。
 *
 * 空间模型：Main（思考/编辑/阅读）| Workbench（执行：Browser/Code/Files/Terminal/Preview）。
 */

export type WorkbenchTab = 'browser' | 'code' | 'files' | 'terminal' | 'preview';

export interface WorkbenchState {
  open: boolean;
  activeTab: WorkbenchTab;
  /** 宽度 px，默认 480 */
  width: number;
  pinned: boolean;
  maximized: boolean;
}

export interface WorkspaceState {
  /** 侧边栏模式：expanded | compact | hidden */
  sidebarMode: 'expanded' | 'compact' | 'hidden';
  conversationId: string | null;
  workbench: WorkbenchState;

  setSidebarMode: (mode: 'expanded' | 'compact' | 'hidden') => void;
  openWorkbench: (tab?: WorkbenchTab) => void;
  closeWorkbench: () => void;
  toggleWorkbench: () => void;
  setWorkbenchTab: (tab: WorkbenchTab) => void;
  setWorkbenchWidth: (width: number) => void;
  toggleWorkbenchPin: () => void;
  toggleWorkbenchMaximize: () => void;
  setConversationId: (id: string | null) => void;
}

const STORAGE_KEY = 'aether.workspace';

/**
 * T26：读回路径与 `persistWorkspace` 白名单共用 `WorkspaceSnapshot` ——
 * 落盘对象永远只有状态字段，解析结果不可能含 action。
 */
function loadInitial(): WorkspaceSnapshot {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as WorkspaceSnapshot;
  } catch {
    /* ignore - intentional */
  }
  return {};
}

const initial = loadInitial();

// T26：删 projectId / setProjectId / toggleSidebar（grep 全仓 0 外部引用）。
// 保留 conversationId / setConversationId：T21 useActiveRunId 与 ThreadPage 真实消费。
export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  sidebarMode: initial.sidebarMode ?? 'expanded',
  conversationId: initial.conversationId ?? null,
  workbench: {
    open: initial.workbench?.open ?? false,
    activeTab: initial.workbench?.activeTab ?? 'browser',
    width: initial.workbench?.width ?? 480,
    pinned: initial.workbench?.pinned ?? false,
    maximized: initial.workbench?.maximized ?? false,
  },

  setSidebarMode: (sidebarMode) => set({ sidebarMode }),
  openWorkbench: (tab) =>
    set({
      workbench: {
        ...get().workbench,
        open: true,
        maximized: false,
        activeTab: tab ?? get().workbench.activeTab,
      },
    }),
  closeWorkbench: () =>
    set({
      workbench: { ...get().workbench, open: false, maximized: false },
    }),
  toggleWorkbench: () =>
    set({
      workbench: { ...get().workbench, open: !get().workbench.open },
    }),
  setWorkbenchTab: (activeTab) => set({ workbench: { ...get().workbench, activeTab } }),
  setWorkbenchWidth: (width) =>
    set({
      workbench: { ...get().workbench, width: Math.max(320, Math.min(960, width)) },
    }),
  toggleWorkbenchPin: () =>
    set({
      workbench: { ...get().workbench, pinned: !get().workbench.pinned },
    }),
  toggleWorkbenchMaximize: () =>
    set({
      workbench: { ...get().workbench, maximized: !get().workbench.maximized },
    }),
  setConversationId: (conversationId) => set({ conversationId }),
}));

/**
 * 持久化 —— T26 显式字段白名单：原写法 `JSON.stringify(state)` 会把 8 个 action
 * 枚举成 key（值 undefined 被丢弃），落盘体积翻倍且形状随 store 定义漂移。
 * 白名单只写回 loadInitial 会读回的状态字段。
 */
export function persistWorkspace(state: WorkspaceState): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        sidebarMode: state.sidebarMode,
        conversationId: state.conversationId,
        workbench: {
          open: state.workbench.open,
          activeTab: state.workbench.activeTab,
          width: state.workbench.width,
          pinned: state.workbench.pinned,
          maximized: state.workbench.maximized,
        },
      } satisfies WorkspaceSnapshot),
    );
  } catch {
    /* ignore - intentional */
  }
}

/** 落盘快照形态：顶层与 workbench 子对象均可缺字段（历史版本写过的形状）。 */
export type WorkspaceSnapshot = Partial<
  Pick<WorkspaceState, 'sidebarMode' | 'conversationId' | 'workbench'>
> & {
  workbench?: Partial<WorkbenchState>;
};
