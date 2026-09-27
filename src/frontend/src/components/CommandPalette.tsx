import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import {
  Search, ArrowRight, Home, Bot, FolderKanban, BookOpen, Settings,
  Wrench, Globe, Terminal as TerminalIcon, Workflow, Cable, Activity,
  Sparkles, Sun, Moon, Wallpaper, PlayCircle, Square, ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { useAppearanceStore } from '../store/appearance';
import { useWorkspaceStore } from '../store/workspace';

/**
 * Global Command Palette（spec §55-56）
 *
 * 快捷键 ⌘K / Ctrl+K。五类命令：
 *   Navigate（导航） / Object（对象） / Action（动作） / Agent（Agent） / Appearance（外观）
 * 按 Enter 执行；↑↓ 选择；Esc 关闭。外观命令直接驱动 Appearance Engine。
 */

interface Command {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  category: 'Navigate' | 'Object' | 'Action' | 'Agent' | 'Appearance';
  path?: string;
  action?: () => void;
  keywords?: string;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const colorScheme = useAppearanceStore((s) => s.colorScheme);
  const setColorScheme = useAppearanceStore((s) => s.setColorScheme);
  const material = useAppearanceStore((s) => s.material);
  const setMaterialMode = useAppearanceStore((s) => s.setMaterialMode);
  const toggleSlideshow = useAppearanceStore((s) => s.toggleSlideshow);
  const openWorkbench = useWorkspaceStore((s) => s.openWorkbench);
  const setWorkbenchTab = useWorkspaceStore((s) => s.setWorkbenchTab);

  // 受控开关：⌘K + toggle-command-palette 事件
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    const toggleHandler = () => setOpen((prev) => !prev);
    window.addEventListener('keydown', handler);
    window.addEventListener('toggle-command-palette', toggleHandler);
    return () => {
      window.removeEventListener('keydown', handler);
      window.removeEventListener('toggle-command-palette', toggleHandler);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
      setQuery('');
      setSelectedIndex(0);
    }
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const go = (path: string) => navigate(path);
    return [
      // ---- Navigate ----
      { id: 'n-home', label: 'Open Home', description: 'Command center', icon: Home, category: 'Navigate', path: '/command-center' },
      { id: 'n-chat', label: 'Open Chat', description: 'AI conversation', icon: Bot, category: 'Navigate', path: '/chat' },
      { id: 'n-projects', label: 'Open Projects', description: 'Project workspaces', icon: FolderKanban, category: 'Navigate', path: '/projects' },
      { id: 'n-knowledge', label: 'Open Knowledge', description: 'Sources, notes, wiki', icon: BookOpen, category: 'Navigate', path: '/knowledge' },
      { id: 'n-settings', label: 'Open Settings', description: 'System configuration', icon: Settings, category: 'Navigate', path: '/settings' },
      // ---- Object ----
      { id: 'o-terminal', label: 'Open Terminal', description: 'Terminal workspace', icon: TerminalIcon, category: 'Object', path: '/terminal' },
      { id: 'o-browser', label: 'Open Browser', description: 'Browse the web', icon: Globe, category: 'Object', path: '/browser' },
      { id: 'o-toolbox', label: 'Open Toolbox', description: 'Format conversion tools', icon: Wrench, category: 'Object', path: '/toolbox' },
      { id: 'o-workflows', label: 'Open Workflows', description: 'Visual workflow canvas', icon: Workflow, category: 'Object', path: '/workflows' },
      { id: 'o-mcp', label: 'Open MCP', description: 'MCP developer workspace', icon: Cable, category: 'Object', path: '/mcp' },
      { id: 'o-models', label: 'Open Models', description: 'Providers and models', icon: Sparkles, category: 'Object', path: '/providers' },
      { id: 'o-monitoring', label: 'Open Monitoring', description: 'Runs overview', icon: Activity, category: 'Object', path: '/monitoring' },
      // ---- Action ----
      { id: 'a-wb-browser', label: 'Workbench · Browser', description: 'Open browser in right workbench', icon: Globe, category: 'Action', action: () => { setWorkbenchTab('browser'); openWorkbench('browser'); } },
      { id: 'a-wb-code', label: 'Workbench · Code', description: 'Open code in right workbench', icon: Search, category: 'Action', action: () => { setWorkbenchTab('code'); openWorkbench('code'); } },
      { id: 'a-wb-files', label: 'Workbench · Files', description: 'Open files in right workbench', icon: FolderKanban, category: 'Action', action: () => { setWorkbenchTab('files'); openWorkbench('files'); } },
      { id: 'a-wb-terminal', label: 'Workbench · Terminal', description: 'Open terminal in right workbench', icon: TerminalIcon, category: 'Action', action: () => { setWorkbenchTab('terminal'); openWorkbench('terminal'); } },
      { id: 'a-wb-preview', label: 'Workbench · Preview', description: 'Open preview in right workbench', icon: PlayCircle, category: 'Action', action: () => { setWorkbenchTab('preview'); openWorkbench('preview'); } },
      // ---- Agent ----
      { id: 'g-model', label: 'Change Model', description: 'Open model settings', icon: Sparkles, category: 'Agent', path: '/providers' },
      { id: 'g-stop', label: 'Stop Run', description: 'Stop the current agent run', icon: Square, category: 'Agent', action: () => { window.dispatchEvent(new CustomEvent('aether-stop-run')); } },
      { id: 'g-approval', label: 'Approval Center', description: 'Review pending permissions', icon: ShieldCheck, category: 'Agent', action: () => { window.dispatchEvent(new CustomEvent('aether-open-approvals')); } },
      // ---- Appearance ----
      {
        id: 'app-glass', label: material.mode === 'glass' ? 'Liquid Glass · Off' : 'Liquid Glass · On',
        description: material.mode === 'glass' ? 'Switch material to opaque' : 'Switch material to glass',
        icon: material.mode === 'glass' ? Moon : Sun, category: 'Appearance',
        action: () => setMaterialMode(material.mode === 'glass' ? 'opaque' : 'glass'),
      },
      {
        id: 'app-theme', label: colorScheme === 'dark' ? 'Theme · Light' : 'Theme · Dark',
        description: colorScheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode',
        icon: colorScheme === 'dark' ? Sun : Moon, category: 'Appearance',
        action: () => setColorScheme(colorScheme === 'dark' ? 'light' : 'dark'),
      },
      { id: 'app-wallpaper', label: 'Change Wallpaper', description: 'Open appearance settings', icon: Wallpaper, category: 'Appearance', action: () => go('/settings') },
      { id: 'app-slideshow', label: 'Toggle Slideshow', description: 'Toggle wallpaper slideshow', icon: PlayCircle, category: 'Appearance', action: toggleSlideshow },
    ];
  }, [navigate, colorScheme, setColorScheme, material.mode, setMaterialMode, toggleSlideshow, openWorkbench, setWorkbenchTab]);

  const filtered = useMemo(() => {
    if (!query.trim()) return commands;
    const q = query.toLowerCase();
    return commands.filter((c) =>
      c.label.toLowerCase().includes(q) ||
      c.description.toLowerCase().includes(q) ||
      (c.keywords ?? '').toLowerCase().includes(q) ||
      c.category.toLowerCase().includes(q),
    );
  }, [commands, query]);

  const handleSelect = useCallback((command: Command) => {
    setOpen(false);
    if (command.path) {
      navigate(command.path);
    } else if (command.action) {
      command.action();
    }
  }, [navigate]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    }
    if (e.key === 'Enter' && !(e.nativeEvent as KeyboardEvent).isComposing && filtered[selectedIndex]) {
      handleSelect(filtered[selectedIndex]);
    }
  };

  // 按类别分组展示
  const grouped = useMemo(() => {
    const order: Command['category'][] = ['Navigate', 'Object', 'Action', 'Agent', 'Appearance'];
    return order
      .map((cat) => ({ cat, items: filtered.filter((c) => c.category === cat) }))
      .filter((g) => g.items.length > 0);
  }, [filtered]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 'var(--z-command-palette, 1400)',
              background: 'var(--bg-overlay)',
            }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            style={{
              position: 'fixed',
              top: '12%',
              left: '50%',
              zIndex: 'calc(var(--z-command-palette, 1400) + 1)',
              width: '100%',
              maxWidth: 560,
              transform: 'translateX(-50%)',
            }}
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.15, ease: [0.25, 0.1, 0.25, 1] }}
          >
            <div
              style={{
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-primary)',
                borderRadius: 'var(--radius-dialog)',
                boxShadow: 'var(--shadow-lg)',
                overflow: 'hidden',
                backdropFilter: 'blur(var(--glass-blur-radius)) saturate(var(--glass-saturate))',
                WebkitBackdropFilter: 'blur(var(--glass-blur-radius)) saturate(var(--glass-saturate))',
              }}
            >
              {/* Search input */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '12px 16px',
                  borderBottom: '1px solid var(--border-primary)',
                }}
              >
                <Search size={16} style={{ color: 'var(--text-tertiary)' }} />
                <input
                  ref={inputRef}
                  type="text"
                  value={query}
                  onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0); }}
                  onKeyDown={handleKeyDown}
                  placeholder="Search or run an action…"
                  aria-label="Search commands"
                  style={{
                    flex: 1,
                    outline: 'none',
                    border: 'none',
                    background: 'transparent',
                    fontSize: 14,
                    color: 'var(--text-primary)',
                    fontFamily: 'inherit',
                  }}
                />
                <kbd style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>ESC</kbd>
              </div>

              {/* Results */}
              <div
                style={{ maxHeight: 380, overflowY: 'auto', padding: 8 }}
                role="listbox"
                aria-label="Commands"
              >
                {grouped.length === 0 && (
                  <div style={{ textAlign: 'center', padding: 24, fontSize: 13, color: 'var(--text-tertiary)' }}>
                    No matching commands
                  </div>
                )}
                {grouped.map(({ cat, items }) => (
                  <div key={cat}>
                    <div
                      style={{
                        padding: '6px 10px 2px',
                        fontSize: 10,
                        fontWeight: 600,
                        letterSpacing: '0.08em',
                        textTransform: 'uppercase',
                        color: 'var(--text-tertiary)',
                      }}
                    >
                      {cat}
                    </div>
                    {items.map((cmd) => {
                      const idx = filtered.indexOf(cmd);
                      const active = idx === selectedIndex;
                      const Icon = cmd.icon;
                      return (
                        <button
                          key={cmd.id}
                          role="option"
                          aria-selected={active}
                          aria-label={`${cmd.label}：${cmd.description}`}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10,
                            width: '100%',
                            padding: '8px 10px',
                            borderRadius: 'var(--radius-surface)',
                            border: 'none',
                            background: active ? 'var(--sidebar-item-active)' : 'transparent',
                            color: 'var(--text-primary)',
                            fontSize: 13,
                            cursor: 'pointer',
                            textAlign: 'left',
                          }}
                          onClick={() => handleSelect(cmd)}
                          onMouseEnter={() => setSelectedIndex(idx)}
                        >
                          <span
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              width: 28,
                              height: 28,
                              borderRadius: 6,
                              background: 'var(--bg-surface)',
                              color: 'var(--text-secondary)',
                              flexShrink: 0,
                            }}
                          >
                            <Icon size={15} />
                          </span>
                          <span style={{ flex: 1, minWidth: 0 }}>
                            <span style={{ display: 'block', fontWeight: 500 }}>{cmd.label}</span>
                            <span style={{ display: 'block', fontSize: 11, color: 'var(--text-tertiary)' }}>
                              {cmd.description}
                            </span>
                          </span>
                          <ArrowRight size={14} style={{ color: 'var(--text-tertiary)', opacity: active ? 1 : 0 }} />
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
