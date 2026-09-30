import { create } from 'zustand';

type UIMode = 'normal' | 'coding';

/**
 * T26：`uiMode` 已离开渲染路径（T24），但 `NavModel` 的 `action:ui-mode`
 * 与 `NavModel.test.ts` 仍真实消费，故本 store 保留。删除的 4 个字段
 * （sidebarOpen / currentRoute / setCurrentRoute / setUiMode）grep 全仓 0 外部引用。
 */
interface AppState {
  uiMode: UIMode;
  toggleUiMode: () => void;
}

function loadUiMode(): UIMode {
  try {
    return (localStorage.getItem('uiMode') as UIMode) || 'normal';
  } catch {
    return 'normal';
  }
}

export const useAppStore = create<AppState>((set, get) => ({
  uiMode: loadUiMode(),
  toggleUiMode: () => {
    const next = get().uiMode === 'normal' ? 'coding' : 'normal';
    try {
      localStorage.setItem('uiMode', next);
    } catch {
      /* ignore - intentional */
    }
    set({ uiMode: next });
  },
}));
