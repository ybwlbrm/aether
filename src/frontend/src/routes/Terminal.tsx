import { useState, useRef, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Terminal as TerminalIcon, Play, Trash2, Clock, ChevronRight } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';

interface CommandEntry {
  id: string;
  command: string;
  output: string;
  timestamp: string;
  duration: number;
  success: boolean;
  source?: 'terminal' | 'agent';
}

export function Terminal() {
  const [input, setInput] = useState('');
  const [entries, setEntries] = useState<CommandEntry[]>([]);
  const [executing, setExecuting] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [entries]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 轮询共享命令历史（Agent 执行的命令也会显示在这里）
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch('/api/terminal/history', {
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data)) {
            setEntries(data);
          }
        }
      } catch { /* 忽略 */ }
    };
    poll();
    const interval = setInterval(poll, 2000);
    return () => clearInterval(interval);
  }, []);

  const execute = useCallback(async (cmd: string) => {
    if (!cmd.trim() || executing) return;
    setExecuting(true);
    setInput('');
    setHistoryIndex(-1);

    const startTime = Date.now();
    const entryId = `term-${Date.now()}`;

    setEntries(prev => [...prev, {
      id: entryId, command: cmd, output: '⏳ 执行中...',
      timestamp: new Date().toLocaleTimeString(), duration: 0, success: true, source: 'terminal',
    }]);

    try {
      const res = await fetch('/api/terminal/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ command: cmd }),
      });
      const data = await res.json();
      const duration = Date.now() - startTime;
      const success = res.ok && !data.output?.startsWith('错误:') && !data.output?.startsWith('安全限制');

      setEntries(prev => prev.map(e =>
        e.id === entryId ? { ...e, output: data.output || '(无输出)', duration, success } : e
      ));
      setCommandHistory(prev => [cmd, ...prev].slice(0, 50));
    } catch (e: unknown) {
      setEntries(prev => prev.map(e =>
        e.id === entryId ? { ...e, output: `错误: ${e instanceof Error ? e.message : '请求失败'}`, duration: Date.now() - startTime, success: false } : e
      ));
    } finally {
      setExecuting(false);
      inputRef.current?.focus();
    }
  }, [executing]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { execute(input); return; }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (commandHistory.length > 0) {
        const newIndex = Math.min(historyIndex + 1, commandHistory.length - 1);
        setHistoryIndex(newIndex);
        setInput(commandHistory[newIndex]);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex > 0) {
        setHistoryIndex(historyIndex - 1);
        setInput(commandHistory[historyIndex - 1]);
      } else {
        setHistoryIndex(-1);
        setInput('');
      }
    }
  };

  return (
    <div className="flex flex-col h-full" style={{ padding: 'var(--space-6)' }}>
      <PageHeader
        title="终端"
        description="执行命令，查看实时输出"
        icon={<TerminalIcon size={24} />}
        action={
          <button onClick={() => setEntries([])} className="btn-icon"
            style={{ padding: '8px 16px', borderRadius: 'var(--radius-sm)', background: 'var(--bg-surface)', border: '1px solid var(--border-primary)', color: 'var(--text-secondary)', fontSize: 'var(--font-sm)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Trash2 size={14} /> 清屏
          </button>
        }
      />

      {/* 终端输出区域 — 使用 glass-card 类获得 Apple Glass 效果 */}
      <div ref={outputRef} className="glass-card" style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-4)', marginBottom: 'var(--space-4)', fontFamily: 'var(--font-mono)', fontSize: 'var(--font-sm)', lineHeight: 1.6 }}>
        {entries.length === 0 ? (
          <div style={{ color: 'var(--text-tertiary)', textAlign: 'center', paddingTop: '30%' }}>
            <TerminalIcon size={32} style={{ opacity: 0.3, margin: '0 auto 12px', display: 'block' }} />
            <div style={{ fontSize: 'var(--font-base)', marginBottom: 4 }}>输入命令开始</div>
            <div style={{ fontSize: 'var(--font-xs)' }}>Agent 执行的命令也会显示在这里</div>
          </div>
        ) : (
          entries.map(entry => (
            <motion.div key={entry.id} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
              style={{ marginBottom: 16, opacity: entry.output === '⏳ 执行中...' ? 0.6 : 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <ChevronRight size={12} style={{ color: entry.source === 'agent' ? 'var(--color-success)' : 'var(--color-accent)', flexShrink: 0 }} />
                <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{entry.command}</span>
                {entry.source === 'agent' && (
                  <span style={{ fontSize: 'var(--font-xs)', color: 'var(--color-success)', background: 'rgba(52,211,153,0.1)', padding: '1px 6px', borderRadius: 4 }}>Agent</span>
                )}
                <span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--font-xs)', marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 3 }}>
                  <Clock size={10} />
                  {entry.duration > 0 ? `${(entry.duration / 1000).toFixed(1)}s` : ''}
                </span>
              </div>
              <div style={{
                color: entry.success ? 'var(--text-secondary)' : 'var(--color-danger)',
                whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
                paddingLeft: 12, borderLeft: '2px solid ' + (entry.success ? 'var(--color-accent)' : 'var(--color-danger)'),
                marginLeft: 4, fontSize: 'var(--font-xs)',
              }}>
                {entry.output}
              </div>
            </motion.div>
          ))
        )}
      </div>

      {/* 输入区域 — 也使用 glass-card 类 */}
      <div className="glass-card" style={{ display: 'flex', gap: 8, padding: 'var(--space-3)', alignItems: 'center' }}>
        <span style={{ color: 'var(--color-accent)', fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 16, paddingLeft: 4 }}>$</span>
        <input ref={inputRef} type="text" value={input}
          onChange={e => setInput(e.target.value)} onKeyDown={handleKeyDown}
          placeholder="输入命令..."
          disabled={executing}
          style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: 'var(--font-base)', padding: '4px 0' }}
        />
        <button onClick={() => execute(input)} disabled={!input.trim() || executing}
          style={{ padding: '6px 14px', borderRadius: 'var(--radius-sm)', background: 'var(--color-accent)', border: 'none', color: '#fff', cursor: !input.trim() || executing ? 'not-allowed' : 'pointer', opacity: !input.trim() || executing ? 0.5 : 1, display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--font-sm)', fontWeight: 500 }}>
          <Play size={14} fill="currentColor" /> 执行
        </button>
      </div>
    </div>
  );
}