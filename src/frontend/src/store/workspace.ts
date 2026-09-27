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
  projectId: string | null;
  conversationId: string | null;
  workbench: WorkbenchState;

  setSidebarMode: (mode: 'expanded' | 'compact' | 'hidden') => void;
  toggleSidebar: () => void;
  openWorkbench: (tab?: WorkbenchTab) => void;
  closeWorkbench: () => void;
  toggleWorkbench: () => void;
  setWorkbenchTab: (tab: WorkbenchTab) => void;
  setWorkbenchWidth: (width: number) => void;
  toggleWorkbenchPin: () => void;
  toggleWorkbenchMaximize: () => void;
  setProjectId: (id: string | null) => void;
  setConversationId: (id: string | null) => void;
}

const STORAGE_KEY = 'aether.workspace';

function loadInitial(): Partial<WorkspaceState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Partial<WorkspaceState>;
  } catch {
    /* ignore - intentional */
  }
  return {};
}

const initial = loadInitial();

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  sidebarMode: initial.sidebarMode ?? 'expanded',
  projectId: initial.projectId ?? null,
  conversationId: initial.conversationId ?? null,
  workbench: {
    open: initial.workbench?.open ?? false,
    activeTab: initial.workbench?.activeTab ?? 'browser',
    width: initial.workbench?.width ?? 480,
    pinned: initial.workbench?.pinned ?? false,
    maximized: initial.workbench?.maximized ?? false,
  },

  setSidebarMode: (sidebarMode) => set({ sidebarMode }),
  toggleSidebar: () =>
    set({
      sidebarMode: get().sidebarMode === 'hidden' ? 'expanded' : 'hidden',
    }),
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
  setProjectId: (projectId) => set({ projectId }),
  setConversationId: (conversationId) => set({ conversationId }),
}));

/** 持久化 */
export function persistWorkspace(state: WorkspaceState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore - intentional */
  }
}
