import { useState, useMemo, memo } from 'react';

interface CodeTableViewProps {
  code: string;
  language: string;
  showLineNumbers?: boolean;
}

/**
 * 纯文字代码展示 — 无背景、透明
 * 参考 DeepSeek Harness MarkdownText 纯文字风格
 */
export const CodeTableView = memo(({ code, language, showLineNumbers = true }: CodeTableViewProps) => {
  const lines = useMemo(() => code.split('\n'), [code]);
  const lineCount = lines.length;
  const isLong = lineCount > 100 || code.length > 3000;
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };

  const displayLines = collapsed ? lines.slice(0, 50) : lines;
  const lineNumWidth = String(lineCount).length;

  return (
    <div style={{ margin: '2px 0', background: 'transparent' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-tertiary)' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{language}</span>
        <span>{lineCount} 行</span>
        <button onClick={handleCopy} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 12, padding: 0 }}>{copied ? '已复制' : '复制'}</button>
        {isLong && <button onClick={() => setCollapsed(!collapsed)} style={{ background: 'none', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', fontSize: 12, padding: 0 }}>{collapsed ? `展开全部 ${lineCount} 行` : '折叠'}</button>}
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-primary)', background: 'transparent' }}>
        {displayLines.map((line, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, background: 'transparent' }}>
            {showLineNumbers && <span style={{ color: 'var(--text-tertiary)', textAlign: 'right', minWidth: `${lineNumWidth}ch`, userSelect: 'none', flexShrink: 0 }}>{i + 1}</span>}
            <span style={{ background: 'transparent' }}>{line || ' '}</span>
          </div>
        ))}
      </div>
      {collapsed && <div style={{ color: 'var(--color-accent)', fontSize: 12 }}>... 已折叠 {lineCount - 50} 行</div>}
    </div>
  );
});