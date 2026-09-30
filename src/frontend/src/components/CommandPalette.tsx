import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { Search, ArrowRight, FileText, Palette, Bot, LayoutDashboard, FolderKanban, Settings, Wrench, BookOpen, Globe, KeyRound, Database, Brain, Cable, Github, Server } from 'lucide-react';

interface Command {
  id: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  path: string;
  category: string;
}

const commands: Command[] = [
  // 导航
  { id: '1', label: '控制台', description: '返回首页', icon: <LayoutDashboard size={16} />, path: '/command-center', category: '导航' },
  { id: '2', label: 'AI 对话', description: '与 AI 助手对话', icon: <Bot size={16} />, path: '/chat', category: '导航' },
  { id: '3', label: 'Agent 工作室', description: '工作流编排与能力管理', icon: <Brain size={16} />, path: '/agent-settings', category: '导航' },
  { id: '16', label: '可视化工作流', description: '拖拽式工作流编排与执行', icon: <Server size={16} />, path: '/workflows', category: '导航' },
  // 工具
  { id: '4', label: '工具箱', description: '格式转换、PDF、音频处理', icon: <Wrench size={16} />, path: '/toolbox', category: '工具' },
  { id: '5', label: '搜索引擎', description: '无广告聚合多源搜索', icon: <Search size={16} />, path: '/search', category: '工具' },
  { id: '6', label: '知识库', description: '收藏夹、笔记、Wiki', icon: <BookOpen size={16} />, path: '/knowledge', category: '工具' },
  { id: '7', label: '密码库', description: '本地加密存储密码', icon: <KeyRound size={16} />, path: '/vault', category: '工具' },
  { id: '8', label: '浏览器', description: '内置浏览器与网页搜索', icon: <Globe size={16} />, path: '/browser', category: '工具' },
  // 创建
  { id: '9', label: 'AI Studio', description: '图片与视频 AI 生成', icon: <Palette size={16} />, path: '/media', category: '创建' },
  { id: '10', label: '文档生成', description: 'PPT 与 Word 文档', icon: <FileText size={16} />, path: '/documents', category: '创建' },
  { id: '11', label: '项目管理', description: '查看和管理项目', icon: <FolderKanban size={16} />, path: '/projects', category: '管理' },
  // 资源
  { id: '12', label: '媒体库', description: '已生成的文件', icon: <Database size={16} />, path: '/library', category: '资源' },
  { id: '13', label: 'AI Providers', description: '管理 AI 模型', icon: <Cable size={16} />, path: '/providers', category: '资源' },
  // 系统
  { id: '14', label: '设置', description: '系统配置', icon: <Settings size={16} />, path: '/settings', category: '系统' },
  { id: '15', label: 'GitHub', description: '打开 GitHub', icon: <Github size={16} />, path: 'https://github.com/personal-ai-command-center', category: '系统' },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen(prev => !prev);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
      setQuery('');
      setSelectedIndex(0);
    }
  }, [open]);

  const filtered = query
    ? commands.filter(c =>
        c.label.toLowerCase().includes(query.toLowerCase()) ||
        c.description.toLowerCase().includes(query.toLowerCase())
      )
    : commands;

  const handleSelect = useCallback((command: Command) => {
    setOpen(false);
    if (command.path.startsWith('http')) {
      window.open(command.path, '_blank');
    } else {
      navigate(command.path);
    }
  }, [navigate]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, filtered.length - 1));
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
    }
    if (e.key === 'Enter' && !(e.nativeEvent as any).isComposing && filtered[selectedIndex]) {
      handleSelect(filtered[selectedIndex]);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <>
<motion.div
            style={{ position: 'fixed', inset: 0, zIndex: 'var(--z-command-palette, 1400)', background: 'var(--bg-overlay)', backdropFilter: 'blur(var(--glass-blur-radius))', WebkitBackdropFilter: 'blur(var(--glass-blur-radius))' }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="命令面板"
            style={{ position: 'fixed', top: '15%', left: '50%', zIndex: 'calc(var(--z-command-palette, 1400) + 1)', width: '100%', maxWidth: '580px', transform: 'translateX(-50%)' }}
            initial={{ opacity: 0, scale: 0.96, y: -10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -10 }}
            transition={{ duration: 0.15, ease: [0.25, 0.1, 0.25, 1] }}
          >
            <div className="glass-card overflow-hidden p-0" style={{ borderRadius: 'var(--radius-lg)', boxShadow: 'var(--card-shadow)' }}>
              {/* Search Input */}
              <div className="flex items-center gap-3 px-5 py-3.5 border-b" style={{ borderColor: 'var(--border-primary)' }}>
                <Search size={18} style={{ color: 'var(--text-tertiary)' }} />
                <input
                  ref={inputRef}
                  type="text"
                  value={query}
                  onChange={e => { setQuery(e.target.value); setSelectedIndex(0); }}
                  onKeyDown={handleKeyDown}
                  placeholder="搜索命令..."
                  className="flex-1 outline-none placeholder:text-[var(--text-tertiary)]"
                  style={{
                    fontSize: 'var(--font-base)',
                    color: 'var(--text-primary)',
                    fontFamily: 'inherit',
                    background: 'var(--input-bg)',
                    backdropFilter: 'blur(var(--glass-blur-radius)) saturate(var(--glass-saturate))',
                    WebkitBackdropFilter: 'blur(var(--glass-blur-radius)) saturate(var(--glass-saturate))',
                    border: '1px solid var(--input-border)',
                    borderRadius: 'var(--input-radius)',
                    padding: '11px 16px',
                    transition: 'all 0.2s var(--anim-ease)',
                  }}
                />
                <kbd style={{ fontSize: '11px', height: '24px', minWidth: '28px', padding: '0 6px', borderRadius: '6px', fontFamily: 'var(--font-sans)', fontWeight: 500, color: 'var(--text-tertiary)', background: 'var(--bg-surface)' }}>ESC</kbd>
              </div>

              {/* Results */}
              <div className="max-h-[360px] overflow-y-auto p-3" role="listbox" aria-label="命令列表">
                {filtered.length === 0 && (
                  <div className="text-center py-8" style={{ fontSize: 'var(--font-sm)', color: 'var(--text-tertiary)' }}>
                    未找到匹配的命令，试试：控制台、AI 对话、设置
                  </div>
                )}
                {filtered.map((cmd, i) => (
                  <button
                    key={cmd.id}
                    role="option"
                    aria-selected={i === selectedIndex}
                    aria-label={`${cmd.label}：${cmd.description}`}
                    className="w-full flex items-center gap-5 px-5 py-4 rounded-xl transition-all duration-150 mb-2"
                    style={{
                      background: i === selectedIndex ? 'var(--color-accent-subtle)' : 'transparent',
                      color: 'var(--text-primary)',
                      fontSize: 'var(--font-base)',
                      outline: i === selectedIndex ? '2px solid var(--color-accent)' : 'none',
                    }}
                    onClick={() => handleSelect(cmd)}
                    onMouseEnter={() => setSelectedIndex(i)}
                  >
                    <div className="p-2.5 rounded-lg" style={{ background: 'var(--bg-surface)', color: 'var(--text-secondary)' }}>
                      {cmd.icon}
                    </div>
                    <div className="flex-1 text-left">
                      <div className="font-medium" style={{ fontSize: '15px' }}>{cmd.label}</div>
                      <div style={{ fontSize: '13px', color: 'var(--text-tertiary)', marginTop: 3 }}>{cmd.description}</div>
                    </div>
                    <span className="px-3 py-1.5 rounded-md" style={{ fontSize: '12px', color: 'var(--text-tertiary)', background: 'var(--bg-surface)' }}>{cmd.category}</span>
                    <ArrowRight size={18} style={{ color: 'var(--text-tertiary)', opacity: i === selectedIndex ? 1 : 0 }} />
                  </button>
                ))}
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}