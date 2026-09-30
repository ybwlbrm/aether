import { create } from 'zustand';

type UIMode = 'normal' | 'coding';

interface AppState {
  sidebarOpen: boolean;
  currentRoute: string;
  uiMode: UIMode;
  setSidebarOpen: (open: boolean) => void;
  setCurrentRoute: (route: string) => void;
  setUiMode: (mode: UIMode) => void;
  toggleUiMode: () => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  sidebarOpen: true,
  currentRoute: 'dashboard',
  uiMode: (() => {
    try { return (localStorage.getItem('uiMode') as UIMode) || 'normal'; } catch { return 'normal'; }
  })(),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setCurrentRoute: (route) => set({ currentRoute: route }),
  setUiMode: (mode) => {
    try { localStorage.setItem('uiMode', mode); } catch { /* ignore */ }
    set({ uiMode: mode });
  },
  toggleUiMode: () => {
    const next = get().uiMode === 'normal' ? 'coding' : 'normal';
    try { localStorage.setItem('uiMode', next); } catch { /* ignore */ }
    set({ uiMode: next });
  },
}));
