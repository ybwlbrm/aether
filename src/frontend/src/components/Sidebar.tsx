import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Bot, Palette, FileText,
  FolderKanban, Cable, Globe, Github,
  Settings, Search, Sparkles, ChevronDown, Database, Maximize2, Minimize2, PanelLeftClose, PanelLeftOpen,
  Wrench, BookOpen, Brain, KeyRound, Server, Activity, Shield,
  Code2, MessageSquare, Terminal as TerminalIcon,
  type LucideIcon,
} from 'lucide-react';
import { api } from '../api/client';
import { GradientShimmer } from './ui/gradient-shimmer';
import { useAppStore } from '../store/app';

interface NavItem { label: string; icon: LucideIcon; path: string; external?: boolean; action?: 'toggle-conv-panel'; }
interface NavGroup { label: string; items: NavItem[]; }

const SIDEBAR_FULL = 260;
const SIDEBAR_COLLAPSED = 60;

const navGroups: NavGroup[] = [
  { label: '工作区', items: [
    { label: '控制台', icon: LayoutDashboard, path: '/command-center' },
    { label: 'AI 对话', icon: Bot, path: '/chat' },
    { label: 'Agent 工作室', icon: Brain, path: '/agent-settings' },
    { label: '工作流', icon: Activity, path: '/workflows' },
  ]},
  { label: '工具', items: [
    { label: '工具箱', icon: Wrench, path: '/toolbox' },
    { label: '终端', icon: TerminalIcon, path: '/terminal' },
    { label: '搜索引擎', icon: Search, path: '/search' },
    { label: '知识库', icon: BookOpen, path: '/knowledge' },
  ]},
  { label: 'AI', items: [
    { label: 'AI Studio', icon: Palette, path: '/media' },
    { label: '文档生成', icon: FileText, path: '/documents' },
    { label: '项目管理', icon: FolderKanban, path: '/projects' },
  ]},
  { label: '资源', items: [
    { label: '媒体库', icon: Database, path: '/library' },
    { label: '密码库', icon: KeyRound, path: '/vault' },
    { label: 'AI Providers', icon: Cable, path: '/providers' },
    { label: '浏览器', icon: Globe, path: '/browser' },
  ]},
  { label: '系统', items: [
    { label: '系统监控', icon: Activity, path: '/monitoring' },
    { label: 'AI 自检', icon: Shield, path: '/selfcheck' },
    { label: 'MCP 管理中心', icon: Server, path: '/mcp' },
    { label: '设置', icon: Settings, path: '/settings' },
    { label: 'GitHub', icon: Github, path: 'https://github.com/personal-ai-command-center', external: true },
  ]},
];

// Coding 模式下的导航：聚焦 AI 对话相关功能
const codingNavGroups: NavGroup[] = [
  { label: 'AI', items: [
    { label: 'AI 对话', icon: Bot, path: '/command-center' },
    { label: '终端', icon: TerminalIcon, path: '/terminal' },
    { label: 'AI Providers', icon: Cable, path: '/providers' },
    { label: '对话记录', icon: MessageSquare, path: '', action: 'toggle-conv-panel' },
    { label: 'Agent 工作室', icon: Brain, path: '/agent-settings' },
    { label: 'MCP 管理中心', icon: Server, path: '/mcp' },
  ]},
];

export function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { uiMode, toggleUiMode } = useAppStore();
  // P1-8: 修复 collapsed 初始集合 — 使用实际存在的分组 label
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(['系统']));
  const [isFullscreen, setIsFullscreen] = useState(false);
  // 侧边栏收起状态（只留图标）：默认展开，localStorage 持久化
  const [mini, setMini] = useState<boolean>(() => {
    try { return localStorage.getItem('sidebarMini') === 'true'; } catch { return false; }
  });

  const activeNavGroups = uiMode === 'coding' ? codingNavGroups : navGroups;

  const handleItemClick = (item: NavItem) => {
    if (item.action === 'toggle-conv-panel') {
      window.dispatchEvent(new CustomEvent('toggle-conv-panel'));
      return;
    }
    if (item.external) { window.open(item.path, '_blank'); return; }
    navigate(item.path);
  };

  const handleToggleMode = () => {
    const switchingToCoding = uiMode === 'normal';
    toggleUiMode();
    if (switchingToCoding) navigate('/command-center');
  };

  // 同步 CSS 变量 --sidebar-width，让 Layout 内容区跟随
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--sidebar-width', `${mini ? SIDEBAR_COLLAPSED : SIDEBAR_FULL}px`);
    try { localStorage.setItem('sidebarMini', String(mini)); } catch (_e: unknown) { /* ignore - intentional */ }
  }, [mini]);

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
    }
  }, []);

  const toggleGroup = (label: string) => {
    setCollapsed(prev => { const next = new Set(prev); if (next.has(label)) next.delete(label); else next.add(label); return next; });
  };
  const isActive = (path: string) => location.pathname === path;

  // 收起模式：只显示图标，点击图标展开对应分组对应的第一个有效页面
  if (mini) {
    const miniItems: NavItem[] = uiMode === 'coding'
      ? [...codingNavGroups.flatMap(g => g.items), { label: '设置', icon: Settings, path: '/settings' }]
      : navGroups.flatMap(g => g.items);
    return (
      <aside className="fixed left-0 top-0 h-screen flex flex-col z-50 sidebar-glass" style={{ width: SIDEBAR_COLLAPSED }}>
        <div className="flex items-center justify-center border-b" style={{ height: 72, borderColor: 'var(--sidebar-border)', borderBottomWidth: 1, borderBottomStyle: 'solid' }}>
          <div className="w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{ background: 'linear-gradient(135deg, var(--color-accent), color-mix(in oklab, var(--color-accent) 60%, white))', filter: 'drop-shadow(0 0 20px rgba(100,150,255,0.25))' }}>
            <Sparkles size={16} style={{ color: 'var(--on-accent)' }} />
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-3 flex flex-col gap-1">
          {miniItems.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.path);
            return (
              <button key={`${item.label}-${item.path}`}
                onClick={() => handleItemClick(item)}
                title={item.label}
                aria-label={item.label}
                className="nav-item w-full"
                style={{
                  justifyContent: 'center',
                  background: active ? 'var(--sidebar-item-active)' : 'transparent',
                  color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                  boxShadow: active ? 'inset 0 1px 20px rgba(255,255,255,0.08)' : 'none',
                }}>
                <Icon size={18} className="flex-shrink-0" style={{ opacity: active ? 1 : 0.7 }} />
              </button>
            );
          })}
        </nav>

        <div className="px-2 py-4 border-t flex flex-col gap-1" style={{ borderColor: 'var(--sidebar-border)', borderTopWidth: 1, borderTopStyle: 'solid' }}>
          <button onClick={() => setMini(false)} aria-label="展开侧边栏" className="nav-item w-full" style={{ justifyContent: 'center', color: 'var(--text-tertiary)' }} title="展开侧边栏">
            <PanelLeftOpen size={18} />
          </button>
          <button onClick={handleToggleMode} className="nav-item w-full"
            style={{
              justifyContent: 'center',
              color: uiMode === 'coding' ? 'var(--color-accent)' : 'var(--text-secondary)',
              border: '1px solid ' + (uiMode === 'coding' ? 'rgba(94,158,255,0.4)' : 'var(--sidebar-border)'),
              borderRadius: 8,
            }}
            title={uiMode === 'coding' ? '切换到普通模式' : '切换到 Coding 模式'}>
            <Code2 size={18} />
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="fixed left-0 top-0 h-screen flex flex-col z-50 sidebar-glass" style={{ width: SIDEBAR_FULL }}>
      <div className="flex items-center gap-3 px-5 border-b" style={{ height: '72px', borderColor: 'var(--sidebar-border)', borderBottomWidth: 1, borderBottomStyle: 'solid' }}>
        <div className="w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{ background: 'linear-gradient(135deg, var(--color-accent), color-mix(in oklab, var(--color-accent) 60%, white))', filter: 'drop-shadow(0 0 20px rgba(100,150,255,0.25))' }}>
          <Sparkles size={16} className="text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold truncate" style={{ color: 'transparent' }}>
            <GradientShimmer gradient="mint" duration={2} pauseBetween={2000} baseColor="var(--text-primary)">
              Aether
            </GradientShimmer>
          </h1>
          <p className="text-xs truncate" style={{ color: 'transparent' }}>
            <GradientShimmer gradient="mint" duration={2} pauseBetween={2000} baseColor="var(--text-secondary)" style={{ fontSize: 12 }}>
              Aether Workspace
            </GradientShimmer>
          </p>
        </div>
        <button
          onClick={toggleFullscreen}
          className="p-1.5 rounded-lg transition-colors duration-200 hover:bg-[var(--sidebar-item-hover)] flex-shrink-0"
          style={{ color: 'var(--text-tertiary)', border: '1px solid var(--sidebar-border)' }}
          title={isFullscreen ? '退出全屏' : '全屏'}
        >
          {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 pt-4">
        {activeNavGroups.map((group) => {
          const isCollapsed = collapsed.has(group.label);
          return (
            <div key={group.label} className="mb-1">
              <button onClick={() => toggleGroup(group.label)}
                className="w-full flex items-center justify-between px-3 py-2 text-[11px] font-semibold transition-colors duration-150"
                style={{ color: 'var(--text-tertiary)' }}>
                <span>{group.label}</span>
                <ChevronDown size={12} className={`transition-transform duration-150 ${isCollapsed ? '' : 'rotate-180'}`} />
              </button>
              {!isCollapsed && (
                <div className="flex flex-col gap-1 mb-1">
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    const active = isActive(item.path);
                    return (
                      <button key={`${item.label}-${item.path}`}
                        onClick={() => handleItemClick(item)}
                        className="nav-item w-full"
                        style={{
                          background: active ? 'var(--sidebar-item-active)' : 'transparent',
                          color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                          boxShadow: active ? 'inset 0 1px 20px rgba(255,255,255,0.08)' : 'none',
                        }}>
                        <Icon size={18} className="flex-shrink-0" style={{ opacity: active ? 1 : 0.7 }} />
                        <span className="truncate text-sm">{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div className="px-3 py-4 border-t flex flex-col gap-1" style={{ borderColor: 'var(--sidebar-border)', borderTopWidth: 1, borderTopStyle: 'solid' }}>
        <button onClick={() => { const ev = new KeyboardEvent('keydown', { metaKey: true, key: 'k' }); window.dispatchEvent(ev); }}
          className="nav-item w-full" style={{ color: 'var(--text-tertiary)' }}>
          <Search size={18} />
          <span className="flex-1 text-left text-xs">Search commands...</span>
          <kbd className="text-[9px]">⌘K</kbd>
        </button>
        <button onClick={() => navigate('/settings')}
          className="nav-item w-full"
          style={{
            background: isActive('/settings') ? 'var(--sidebar-item-active)' : 'transparent',
            color: isActive('/settings') ? 'var(--text-primary)' : 'var(--text-secondary)',
          }}>
          <Settings size={18} />
          <span className="truncate text-sm">Settings</span>
        </button>
        <button onClick={() => setMini(true)}
          className="nav-item w-full"
          style={{ background: 'transparent', color: 'var(--text-tertiary)' }}>
          <PanelLeftClose size={18} />
          <span className="truncate text-sm">收起侧边栏</span>
        </button>
        {/* 模式切换按钮：视觉上区分于普通导航项 */}
        <button onClick={handleToggleMode}
          className="nav-item w-full"
          style={{
            background: uiMode === 'coding' ? 'rgba(94,158,255,0.12)' : 'transparent',
            color: uiMode === 'coding' ? 'var(--color-accent)' : 'var(--text-secondary)',
            border: '1px solid ' + (uiMode === 'coding' ? 'rgba(94,158,255,0.4)' : 'var(--sidebar-border)'),
            borderRadius: 8,
          }}>
          <Code2 size={18} />
          <span className="truncate text-sm">{uiMode === 'coding' ? '普通模式' : 'Coding 模式'}</span>
        </button>
      </div>
    </aside>
  );
}