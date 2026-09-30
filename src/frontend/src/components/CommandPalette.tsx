/**
 * Global Command Palette（T23，spec §55-56）。
 *
 * 导航部分**完全由 T19 的 NavModel 投影**（`getPaletteSurfaces()`）：本文件不手写任何
 * 路由表 —— 20 条 route、5 个 workbench 面板、3 个 orphan action 表面各自带 id / label /
 * description / icon / keywords 进来，因此侧栏与面板看到的导航永远同源。在此之上叠加 5 组
 * 操作命令：Run（直连 runsApi，含此前无 UI 的 recover stale runs）、Workbench、
 * Appearance（7 主题 + 2 明暗 + 2 材质 + 轮播）、Conversation、System。
 *
 * 不变量：① `scoreMatch` 导出且纯（无 DOM，Node 下可单测）；② 全部 app 事件经 T1
 * `dispatchAppEvent` 派发；③ 组头走 `.aether-nav-group-label`（sentence case，非大写 eyebrow）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Activity, ArrowRight, Droplets, Images, Layers, Maximize2, MessageSquare, MessageSquarePlus,
  Moon, Palette, Pause, Pin, Play, RefreshCw, Search, Square, Stethoscope, Sun, Trash2, X,
  type LucideIcon,
} from 'lucide-react';
import type { RunStatus } from '@pacc/shared';
import { api } from '../api/client';
import { runsApi } from '../api/runs';
import { dispatchAppEvent, subscribeAppEvent } from '../lib/events';
import { RUN_STATUS_META } from '../lib/run-status';
import { useAppearanceStore, type ColorScheme, type MaterialMode, type UiTheme } from '../store/appearance';
import { useRunStore } from '../store/runStore';
import { useWorkspaceStore, type WorkbenchTab } from '../store/workspace';
import { getPaletteSurfaces, type NavSurface } from './navigation';
import { confirm } from './ui/confirm-dialog';

/* ------------------------------------------------------------------ *
 * 匹配（纯函数，无 DOM）
 * ------------------------------------------------------------------ */

const MATCH_ALL = 0, MATCH_SUBSEQUENCE = 1, MATCH_PREFIX = 2, MATCH_EXACT = 3, NO_MATCH = -1;

/** needle 的字符是否按序出现在 haystack 中（全小写入参） */
function isSubsequence(needle: string, haystack: string): boolean {
  let cursor = 0;
  for (let i = 0; i < haystack.length && cursor < needle.length; i += 1) {
    if (haystack[i] === needle[cursor]) cursor += 1;
  }
  return cursor === needle.length;
}

/** 匹配强度 exact(3) > prefix(2) > subsequence(1)；大小写不敏感、裁剪空白；空查询全通过，无匹配 -1 */
export function scoreMatch(query: string, candidate: string): number {
  const q = query.trim().toLowerCase();
  const c = candidate.trim().toLowerCase();
  if (q.length === 0) return MATCH_ALL;
  if (c.length === 0) return NO_MATCH;
  if (q === c) return MATCH_EXACT;
  if (c.startsWith(q)) return MATCH_PREFIX;
  return isSubsequence(q, c) ? MATCH_SUBSEQUENCE : NO_MATCH;
}

/** ⌘K / Ctrl+K：大小写不敏感，任一修饰键即可 */
export function isPaletteHotkey(key: string, metaKey: boolean, ctrlKey: boolean): boolean {
  return (metaKey || ctrlKey) && key.toLowerCase() === 'k';
}

/* ------------------------------------------------------------------ *
 * 命令模型
 * ------------------------------------------------------------------ */

/** 分组即展示标签：sentence case 单词，天然不是大写 eyebrow */
export type PaletteGroup = 'Navigate' | 'Run' | 'Workbench' | 'Appearance' | 'Conversation' | 'System';

const PALETTE_GROUPS: readonly PaletteGroup[] = Object.freeze(
  ['Navigate', 'Run', 'Workbench', 'Appearance', 'Conversation', 'System'],
);

export interface PaletteCommand {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly icon: LucideIcon;
  readonly group: PaletteGroup;
  readonly keywords: readonly string[];
  /** 命中的 NavModel route 表面；workbench / action / 自有命令为 null */
  readonly path: string | null;
  readonly run: () => void;
}

export interface RecentConversation { readonly id: string; readonly title: string }

export interface PaletteContext {
  readonly navigate: (path: string) => void;
  /** 当前路由 path：决定「选会话」是派事件还是导航（与抽屉同一契约） */
  readonly pathname: string;
  readonly activeRunId: string | null;
  readonly activeRunStatus: RunStatus | null;
  readonly conversations: readonly RecentConversation[];
}

/** NavModel 的 3 个 orphan action 表面在 palette 中的功能归属；未登记者默认 System */
const ACTION_GROUP_BY_ID: ReadonlyMap<string, PaletteGroup> = new Map([
  ['action:ui-mode', 'System'], ['action:approvals', 'System'], ['action:conv-panel', 'Conversation'],
]);

function groupForSurface(surface: NavSurface): PaletteGroup {
  switch (surface.surfaceKind) {
    case 'route': return 'Navigate';
    case 'workbench': return 'Workbench';
    case 'action': return ACTION_GROUP_BY_ID.get(surface.id) ?? 'System';
  }
}

/** 展示名表用 `Record` 把取值集合在编译期与 appearance store 锁死 */
const THEME_LABELS: Readonly<Record<UiTheme, string>> = Object.freeze({
  'liquid-glass': 'Liquid glass', shadcn: 'Shadcn', geist: 'Geist', magic: 'Magic',
  origin: 'Origin', 'dark-minimal': 'Dark minimal', light: 'Light',
});
const SCHEME_LABELS: Readonly<Record<ColorScheme, string>> = Object.freeze({ dark: 'Dark', light: 'Light' });
const MATERIAL_LABELS: Readonly<Record<MaterialMode, string>> = Object.freeze({ glass: 'Glass', opaque: 'Opaque' });

/** 逐会话命令的展示上限：palette 是命令入口，不是会话浏览器 */
const MAX_RECENT_CONVERSATIONS = 3;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

/** 边界解析：conversations DTO 在此收窄成 RecentConversation，命令层零断言 */
function toRecentConversations(raw: unknown): readonly RecentConversation[] {
  if (!Array.isArray(raw)) return [];
  const entries: readonly unknown[] = raw;
  return entries.flatMap((entry): RecentConversation[] => {
    if (!isRecord(entry)) return [];
    const id = entry['id'], title = entry['title'];
    return typeof id === 'string' && typeof title === 'string' ? [{ id, title }] : [];
  });
}

/** 已在 command center 就派 select-conversation，否则走抽屉已有的 ?selectConv 契约 */
function selectConversation(ctx: PaletteContext, conversationId: string): void {
  if (ctx.pathname === '/command-center' || ctx.pathname === '/') {
    dispatchAppEvent('select-conversation', { conversationId });
    return;
  }
  ctx.navigate(`/command-center?selectConv=${conversationId}`);
}

async function deleteConversation(ctx: PaletteContext, conversation: RecentConversation): Promise<void> {
  if (!(await confirm(`确定删除「${conversation.title}」？`))) return;
  const pending: Promise<unknown> = api.deleteConversation(conversation.id);
  await pending;
  dispatchAppEvent('conversations-changed');
  if (ctx.pathname === '/chat') ctx.navigate('/command-center');
}

/* ---- 各组命令（纯数据组装，无 React） ---- */

function runCommands(ctx: PaletteContext): readonly PaletteCommand[] {
  const commands: PaletteCommand[] = [
    { id: 'run:new', label: 'New run', description: '在 command center 发起一次新的运行', icon: Play, group: 'Run', path: null, keywords: ['start', 'begin', '执行', '开始'], run: () => ctx.navigate('/command-center') },
    { id: 'run:recover-stale', label: 'Recover stale runs', description: '把崩溃遗留的 run 标记为 interrupted', icon: RefreshCw, group: 'Run', path: null, keywords: ['recover', 'stale', 'crash', '恢复', '崩溃'], run: () => { void runsApi.recoverStaleRuns(); } },
  ];
  const { activeRunId, activeRunStatus } = ctx;
  if (activeRunId === null || activeRunStatus === null) return commands;
  // allow-list 镜像后端路由层（lib/run-status）：不发必然 409 的请求
  const state = RUN_STATUS_META[activeRunStatus].label;
  if (RUN_STATUS_META[activeRunStatus].pausable) commands.push(
    { id: 'run:pause', label: 'Pause run', description: `暂停当前 run（${state}）`, icon: Pause, group: 'Run', path: null, keywords: ['pause', 'hold', '暂停'], run: () => { void runsApi.pauseRun(activeRunId); } },
  );
  if (RUN_STATUS_META[activeRunStatus].resumable) commands.push(
    { id: 'run:resume', label: 'Resume run', description: `继续当前 run（${state}）`, icon: Play, group: 'Run', path: null, keywords: ['resume', 'continue', '继续'], run: () => { void runsApi.resumeRun(activeRunId); } },
  );
  if (RUN_STATUS_META[activeRunStatus].cancellable) commands.push(
    { id: 'run:cancel', label: 'Cancel run', description: `取消当前 run（${state}）`, icon: Square, group: 'Run', path: null, keywords: ['cancel', 'stop', 'abort', '取消', '中止'], run: () => { void runsApi.cancelRun(activeRunId); } },
  );
  return commands;
}

function workbenchCommands(): readonly PaletteCommand[] {
  const ws = () => useWorkspaceStore.getState();
  const tabs: readonly WorkbenchTab[] = ['browser', 'code', 'files', 'terminal', 'preview'];
  return [
    ...tabs.map((tab): PaletteCommand => ({ id: `workbench:${tab}`, label: `Workbench · ${tab}`, description: `在右侧工作台打开 ${tab} 面板`, icon: Layers, group: 'Workbench', path: null, keywords: ['workbench', 'pane', '面板', tab], run: () => dispatchAppEvent('workbench-open', { tab }) })),
    { id: 'workbench:pin', label: 'Workbench · Pin', description: '固定右侧工作台', icon: Pin, group: 'Workbench', path: null, keywords: ['pin', '固定'], run: () => ws().toggleWorkbenchPin() },
    { id: 'workbench:maximize', label: 'Workbench · Maximize', description: '最大化右侧工作台', icon: Maximize2, group: 'Workbench', path: null, keywords: ['maximize', 'expand', '最大化'], run: () => ws().toggleWorkbenchMaximize() },
    { id: 'workbench:close', label: 'Workbench · Close', description: '收起右侧工作台', icon: X, group: 'Workbench', path: null, keywords: ['close', 'hide', '关闭', '收起'], run: () => ws().closeWorkbench() },
  ];
}

function appearanceCommands(): readonly PaletteCommand[] {
  const appearance = () => useAppearanceStore.getState();
  const themes = (Object.keys(THEME_LABELS) as UiTheme[]).map((theme): PaletteCommand => ({
    id: `appearance:theme:${theme}`, label: `Theme · ${THEME_LABELS[theme]}`, description: `切换到 ${THEME_LABELS[theme]} 主题`,
    icon: Palette, group: 'Appearance', path: null, keywords: ['theme', 'ui', '主题', theme],
    run: () => appearance().setUiTheme(theme),
  }));
  const schemes = (Object.keys(SCHEME_LABELS) as ColorScheme[]).map((scheme): PaletteCommand => ({
    id: `appearance:scheme:${scheme}`, label: `Color scheme · ${SCHEME_LABELS[scheme]}`, description: `切到${scheme === 'dark' ? '暗色' : '亮色'}模式`,
    icon: scheme === 'dark' ? Moon : Sun, group: 'Appearance', path: null, keywords: ['dark', 'light', '明暗', scheme],
    run: () => appearance().setColorScheme(scheme),
  }));
  const materials = (Object.keys(MATERIAL_LABELS) as MaterialMode[]).map((mode): PaletteCommand => ({
    id: `appearance:material:${mode}`, label: `Material · ${MATERIAL_LABELS[mode]}`, description: `材质切到 ${MATERIAL_LABELS[mode]}`,
    icon: mode === 'glass' ? Droplets : Square, group: 'Appearance', path: null, keywords: ['material', 'glass', 'opaque', '材质'],
    run: () => appearance().setMaterialMode(mode),
  }));
  return [
    ...themes, ...schemes, ...materials,
    { id: 'appearance:slideshow', label: 'Toggle wallpaper slideshow', description: '开关壁纸轮播', icon: Images, group: 'Appearance', path: null, keywords: ['slideshow', 'wallpaper', '轮播', '壁纸'], run: () => appearance().toggleSlideshow() },
  ];
}

function conversationCommands(ctx: PaletteContext): readonly PaletteCommand[] {
  const commands: PaletteCommand[] = [
    { id: 'conversation:new', label: 'New conversation', description: '在 chat 里开始一个新会话', icon: MessageSquarePlus, group: 'Conversation', path: null, keywords: ['new', 'create', '新建', '会话'], run: () => ctx.navigate('/chat') },
  ];
  for (const conversation of ctx.conversations.slice(0, MAX_RECENT_CONVERSATIONS)) {
    commands.push(
      { id: `conversation:open:${conversation.id}`, label: `Open ${conversation.title}`, description: '载入该会话', icon: MessageSquare, group: 'Conversation', path: null, keywords: ['open', 'recent', '打开', '最近'], run: () => selectConversation(ctx, conversation.id) },
      { id: `conversation:delete:${conversation.id}`, label: `Delete ${conversation.title}`, description: '删除该会话（需确认）', icon: Trash2, group: 'Conversation', path: null, keywords: ['delete', 'remove', '删除'], run: () => { void deleteConversation(ctx, conversation); } },
    );
  }
  return commands;
}

function systemCommands(ctx: PaletteContext): readonly PaletteCommand[] {
  return [
    { id: 'system:selfcheck', label: 'System · Self check', description: '环境与依赖自检诊断', icon: Stethoscope, group: 'System', path: null, keywords: ['selfcheck', 'diagnose', '自检', '诊断'], run: () => ctx.navigate('/selfcheck') },
    { id: 'system:monitoring', label: 'System · Monitoring', description: '运行健康度、延迟与失败', icon: Activity, group: 'System', path: null, keywords: ['monitoring', 'health', '监控', '指标'], run: () => ctx.navigate('/monitoring') },
  ];
}

/** NavModel 表面 → palette 命令：workbench / action 表面在此获得它们的 dispatcher */
function surfaceCommand(surface: NavSurface, ctx: PaletteContext): PaletteCommand {
  return {
    id: surface.id, label: surface.label, description: surface.description, icon: surface.icon,
    group: groupForSurface(surface), keywords: surface.keywords,
    path: surface.surfaceKind === 'route' ? surface.path : null,
    run: () => {
      switch (surface.surfaceKind) {
        case 'route': ctx.navigate(surface.path); return;
        case 'workbench': dispatchAppEvent('workbench-open', { tab: surface.workbenchTab }); return;
        case 'action': surface.run(); return;
      }
    },
  };
}

/** palette 的完整命令模型：28 个 NavModel 表面 + 5 组操作命令 */
export function buildPaletteCommands(ctx: PaletteContext): readonly PaletteCommand[] {
  return [
    ...getPaletteSurfaces().map((surface) => surfaceCommand(surface, ctx)),
    ...runCommands(ctx), ...workbenchCommands(), ...appearanceCommands(),
    ...conversationCommands(ctx), ...systemCommands(ctx),
  ];
}

/** 过滤 + 按匹配强度降序（同分保持声明序）。匹配面 = label + group + keywords */
export function rankCommands(commands: readonly PaletteCommand[], query: string): readonly PaletteCommand[] {
  if (query.trim().length === 0) return commands;
  return commands
    .map((entry) => ({ entry, score: Math.max(...[entry.label, entry.group, ...entry.keywords].map((c) => scoreMatch(query, c))) }))
    .filter((scored) => scored.score > NO_MATCH)
    .sort((a, b) => b.score - a.score)
    .map((scored) => scored.entry);
}

/* ------------------------------------------------------------------ *
 * 样式（全部由 token 驱动；几何常量收敛在此）
 * ------------------------------------------------------------------ */

const DIALOG_MAX_WIDTH = 560, RESULTS_MAX_HEIGHT = 380, ICON_SIZE = 15, ROW_ICON_BOX = 28;

const overlayStyle: React.CSSProperties = { position: 'fixed', inset: 0, zIndex: 'var(--z-command-palette)', background: 'var(--surface-overlay)', border: 'none' };
const dialogStyle: React.CSSProperties = { position: 'fixed', top: '12%', left: '50%', zIndex: 'calc(var(--z-command-palette) + 1)', width: '100%', maxWidth: DIALOG_MAX_WIDTH, transform: 'translateX(-50%)' };
const panelStyle: React.CSSProperties = {
  background: 'var(--surface-elevated)', border: 'var(--border-width-hairline) solid var(--border-default-token)',
  borderRadius: 'var(--radius-dialog)', boxShadow: 'var(--shadow-lg)', overflow: 'hidden',
  backdropFilter: 'blur(var(--glass-blur-radius)) saturate(var(--glass-saturate))',
  WebkitBackdropFilter: 'blur(var(--glass-blur-radius)) saturate(var(--glass-saturate))',
};
const searchRowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 'var(--space-3)', padding: 'var(--space-3) var(--space-4)', borderBottom: 'var(--border-width-hairline) solid var(--border-default-token)' };
const inputStyle: React.CSSProperties = { flex: 1, outline: 'none', border: 'none', background: 'transparent', fontSize: 'var(--font-size-caption)', color: 'var(--text-primary)', fontFamily: 'inherit' };
const resultsStyle: React.CSSProperties = { maxHeight: RESULTS_MAX_HEIGHT, overflowY: 'auto', padding: 'var(--space-2)' };
const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 'var(--space-3)', width: '100%', padding: 'var(--space-2) var(--space-3)', border: 'none', borderRadius: 'var(--radius-surface)', color: 'var(--text-primary)', fontSize: 'var(--font-size-caption)', cursor: 'pointer', textAlign: 'left' };
const rowIconStyle: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: ROW_ICON_BOX, height: ROW_ICON_BOX, borderRadius: 'var(--radius-control)', background: 'var(--surface-default)', color: 'var(--text-secondary)', flexShrink: 0 };

/* ------------------------------------------------------------------ *
 * 结果列表（纯展示件：可无 Router / 无 motion 静态渲染）
 * ------------------------------------------------------------------ */

export interface PaletteResultsProps {
  readonly commands: readonly PaletteCommand[];
  readonly selectedIndex: number;
  readonly onSelect: (command: PaletteCommand) => void;
  readonly onHover: (index: number) => void;
}

export function PaletteResults(props: PaletteResultsProps): React.ReactElement {
  const { commands, selectedIndex, onSelect, onHover } = props;
  return (
    <div style={resultsStyle} role="listbox" aria-label="Commands">
      {commands.length === 0 && (
        <div style={{ textAlign: 'center', padding: 'var(--space-6)', fontSize: 'var(--font-size-caption)', color: 'var(--text-secondary)' }}>No matching commands</div>
      )}
      {PALETTE_GROUPS.map((group) => {
        const items = commands.filter((entry) => entry.group === group);
        if (items.length === 0) return null;
        return (
          <section key={group}>
            {/* 组头：sentence case，复用侧栏同一 class（T6a 决策） */}
            <div className="aether-nav-group-label" data-palette-group={group}>{group}</div>
            {items.map((entry) => {
              const index = commands.indexOf(entry);
              const active = index === selectedIndex;
              const Icon = entry.icon;
              return (
                <button
                  key={entry.id} type="button" role="option" aria-selected={active} data-active={active}
                  aria-label={`${entry.label}：${entry.description}`}
                  style={{ ...rowStyle, background: active ? 'var(--sidebar-item-active)' : 'transparent' }}
                  onClick={() => onSelect(entry)} onMouseEnter={() => onHover(index)}
                >
                  <span style={rowIconStyle}><Icon size={ICON_SIZE} aria-hidden="true" /></span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontWeight: 'var(--font-weight-medium)' }}>{entry.label}</span>
                    <span style={{ display: 'block', fontSize: 'var(--font-size-label)', color: 'var(--text-secondary)' }}>{entry.description}</span>
                  </span>
                  <ArrowRight size={ICON_SIZE} aria-hidden="true" style={{ color: 'var(--text-secondary)', opacity: active ? 1 : 0 }} />
                </button>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 面板
 * ------------------------------------------------------------------ */

export function CommandPalette(): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [conversations, setConversations] = useState<readonly RecentConversation[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const navigate = useNavigate();
  const { pathname } = useLocation();
  const activeRunId = useRunStore((s) => s.activeRunId);
  const activeRunStatus = useRunStore((s) => (s.activeRunId === null ? null : (s.runsById[s.activeRunId]?.status ?? null)));

  // 双向开关：⌘K / Ctrl+K 键位 + Sidebar 派发的 toggle-command-palette
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isPaletteHotkey(event.key, event.metaKey, event.ctrlKey)) {
        event.preventDefault();
        setOpen((prev) => !prev);
        return;
      }
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return subscribeAppEvent('toggle-command-palette', () => setOpen((prev) => !prev));
  }, []);

  const loadConversations = useCallback(async (): Promise<void> => {
    const raw: unknown = await api.getConversations();
    setConversations(toRecentConversations(raw));
  }, []);

  useEffect(() => {
    void loadConversations();
    return subscribeAppEvent('conversations-changed', () => { void loadConversations(); });
  }, [loadConversations]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelectedIndex(0);
    inputRef.current?.focus();
  }, [open]);

  const commands = useMemo(
    () => buildPaletteCommands({ navigate, pathname, activeRunId, activeRunStatus, conversations }),
    [navigate, pathname, activeRunId, activeRunStatus, conversations],
  );
  const ranked = useMemo(() => rankCommands(commands, query), [commands, query]);
  const handleSelect = useCallback((entry: PaletteCommand): void => { setOpen(false); entry.run(); }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setSelectedIndex((i) => Math.min(i + 1, ranked.length - 1)); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); setSelectedIndex((i) => Math.max(i - 1, 0)); return; }
    // IME 组字期间的 Enter 属于候选词确认，绝不能顺手执行命令
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      const target = ranked[selectedIndex];
      if (target !== undefined) handleSelect(target);
    }
  };

  if (!open) return null;

  return (
    <AnimatePresence>
      <motion.div style={overlayStyle} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setOpen(false)} aria-hidden="true" />
      <motion.div
        role="dialog" aria-modal="true" aria-label="Command palette" style={dialogStyle}
        initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.15, ease: [0.25, 0.1, 0.25, 1] }}
      >
        <div style={panelStyle}>
          <div style={searchRowStyle}>
            <Search size={ICON_SIZE} aria-hidden="true" style={{ color: 'var(--text-secondary)' }} />
            <input
              ref={inputRef} type="text" value={query} style={inputStyle}
              onChange={(event) => { setQuery(event.target.value); setSelectedIndex(0); }}
              onKeyDown={handleKeyDown} placeholder="Search or run an action…" aria-label="Search commands"
            />
            <kbd style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-secondary)' }}>ESC</kbd>
          </div>
          <PaletteResults commands={ranked} selectedIndex={selectedIndex} onSelect={handleSelect} onHover={setSelectedIndex} />
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
