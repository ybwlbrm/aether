import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Bold, Italic, Heading1, Heading2, List, Code2, Link2 } from 'lucide-react';
import { createHighlighter } from 'shiki';
import type { Highlighter } from 'shiki';

/* ============================================================
   MarkdownEditor — 分栏 Markdown 编辑器（编辑 + 实时预览）
   - 左侧 textarea 编辑，右侧渲染预览
   - 工具栏在光标处插入 Markdown 语法
   - 代码块用 shiki 高亮；预览内容先 HTML 转义再应用正则（防 XSS）
   ============================================================ */

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  minHeight?: number;
}

/* ---------- 安全工具：先转义 HTML，再在转义文本上应用受控正则 ---------- */

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const escapeAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/* 行内渲染：输入为已转义文本，输出受控 HTML 标签 */
const renderInline = (text: string): string => {
  let t = text;
  // 行内代码（优先，避免其中的 * 等符号被后续规则误解析）
  t = t.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');
  // 加粗 **text**
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  // 斜体 *text*（排除加粗的 **）
  t = t.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  // 链接 [text](https://...)
  // P1-13 加固：捕获组内再校验协议（虽正则已限定 https?://，二次防御防正则改进引入伪协议）
  t = t.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (match, label: string, url: string) => {
      const safe = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    }
  );
  return t;
};

/* ---------- Shiki 高亮（单例 + 主题跟随） ---------- */

type ShikiTheme = 'github-dark' | 'github-light';

const getActiveTheme = (): ShikiTheme =>
  document.documentElement.getAttribute('data-theme') === 'light'
    ? 'github-light'
    : 'github-dark';

let highlighterPromise: Promise<Highlighter> | null = null;

const getHighlighter = (): Promise<Highlighter> => {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ['github-dark', 'github-light'],
      langs: [
        'javascript', 'typescript', 'jsx', 'tsx', 'python', 'json', 'bash',
        'shell', 'html', 'css', 'markdown', 'sql', 'java', 'go', 'rust',
        'yaml', 'xml', 'c', 'cpp', 'csharp', 'php', 'ruby', 'text',
      ],
    });
  }
  return highlighterPromise;
};

/* 渲染单个代码块：shiki 可用则高亮，否则降级为纯文本 pre */
const renderCodeBlock = (
  lang: string,
  code: string,
  hl: Highlighter | null
): string => {
  const langLabel = escapeAttr(lang || 'text');
  const safeCode = escapeHtml(code);
  if (hl) {
    try {
      const codeHtml = hl.codeToHtml(code, {
        lang: (lang || 'text') as never,
        theme: getActiveTheme(),
      });
      return `<div class="md-code-block" data-lang="${langLabel}">${codeHtml}</div>`;
    } catch {
      /* 未知语言或高亮失败 → 降级渲染 */
    }
  }
  return `<div class="md-code-block" data-lang="${langLabel}"><pre class="md-code-fallback"><code>${safeCode}</code></pre></div>`;
};

/* ---------- Markdown → HTML ---------- */

const renderMarkdown = (src: string, hl: Highlighter | null): string => {
  const escaped = escapeHtml(src);

  // 1. 提取代码块为占位符
  const blocks: { lang: string; code: string }[] = [];
  const withPlaceholders = escaped.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    blocks.push({ lang: (lang as string) || 'text', code: code as string });
    return `\u0000BLOCK${blocks.length - 1}\u0000`;
  });

  // 2. 逐行渲染非代码部分
  const lines = withPlaceholders.split('\n');
  let html = '';
  let listType: 'ul' | 'ol' | null = null;
  let inQuote = false;

  const closeList = () => {
    if (listType) {
      html += `</${listType}>`;
      listType = null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    // 代码块占位符 → 渲染为（可能高亮的）代码块
    const blockMatch = line.match(/^\u0000BLOCK(\d+)\u0000$/);
    if (blockMatch) {
      closeList();
      inQuote = false;
      const b = blocks[Number(blockMatch[1])];
      html += renderCodeBlock(b.lang, b.code, hl);
      continue;
    }

    if (!line.trim()) {
      closeList();
      inQuote = false;
      html += '<div class="md-spacer"></div>';
      continue;
    }

    // 引用块
    if (line.startsWith('> ')) {
      closeList();
      if (!inQuote) {
        html += '<blockquote class="md-quote">';
        inQuote = true;
      }
      html += `<p>${renderInline(line.slice(2))}</p>`;
      continue;
    }
    if (inQuote) {
      html += '</blockquote>';
      inQuote = false;
    }

    // 标题 # ~ ######
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html += `<h${level} class="md-heading md-h${level}">${renderInline(heading[2] as string)}</h${level}>`;
      continue;
    }

    // 列表：- / * 无序，1. 有序
    const ul = line.match(/^[-*]\s+(.*)$/);
    const ol = line.match(/^\d+\.\s+(.*)$/);
    if (ul || ol) {
      const type: 'ul' | 'ol' = ol ? 'ol' : 'ul';
      if (listType !== type) {
        closeList();
        html += `<${type} class="md-list">`;
        listType = type;
      }
      html += `<li>${renderInline((ul ?? ol)![1] as string)}</li>`;
      continue;
    }

    closeList();
    // 普通段落
    html += `<p>${renderInline(line)}</p>`;
  }

  closeList();
  if (inQuote) html += '</blockquote>';
  return html;
};

/* ---------- 工具栏动作 ---------- */

type ToolbarAction = 'bold' | 'italic' | 'h1' | 'h2' | 'list' | 'code' | 'link';

const toolbarButtons: { action: ToolbarAction; icon: ReactNode; title: string }[] = [
  { action: 'bold', icon: <Bold size={15} />, title: '加粗 **文本**' },
  { action: 'italic', icon: <Italic size={15} />, title: '斜体 *文本*' },
  { action: 'h1', icon: <Heading1 size={15} />, title: '一级标题' },
  { action: 'h2', icon: <Heading2 size={15} />, title: '二级标题' },
  { action: 'list', icon: <List size={15} />, title: '无序列表' },
  { action: 'code', icon: <Code2 size={15} />, title: '行内代码 `code`' },
  { action: 'link', icon: <Link2 size={15} />, title: '链接 [文本](https://)' },
];

/* ---------- 组件 ---------- */

export function MarkdownEditor({ value, onChange, placeholder, minHeight = 320 }: MarkdownEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [highlighter, setHighlighter] = useState<Highlighter | null>(null);
  const [rendered, setRendered] = useState('');
  const renderVersion = useRef(0);

  // 初始化 shiki 高亮器（模块级单例，仅首次加载）
  useEffect(() => {
    let cancelled = false;
    getHighlighter()
      .then(h => {
        if (!cancelled) setHighlighter(h);
      })
      .catch(() => {
        /* 高亮失败时预览仍可正常降级渲染 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 实时渲染：value 变化或高亮器就绪时重新生成 HTML
  useEffect(() => {
    const version = ++renderVersion.current;
    setRendered(renderMarkdown(value, highlighter));
    return () => {
      // 版本号自增使过期渲染结果被丢弃
      if (renderVersion.current === version) {
        /* 保留最新渲染 */
      }
    };
  }, [value, highlighter]);

  /* 在光标处插入/切换 Markdown 语法 */
  const applyAction = (action: ToolbarAction) => {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = value.slice(start, end);

    let next = value;
    let nextCursor = start;

    // 包裹型语法：** **、* *、` `、[ ]( )
    if (action === 'bold' || action === 'italic' || action === 'code' || action === 'link') {
      const specs: Record<
        string,
        { open: string; close: string; placeholder: string; cursorInUrl?: boolean }
      > = {
        bold: { open: '**', close: '**', placeholder: '加粗文字' },
        italic: { open: '*', close: '*', placeholder: '斜体文字' },
        code: { open: '`', close: '`', placeholder: '代码' },
        link: { open: '[', close: '](https://)', placeholder: '链接文字', cursorInUrl: true },
      };
      const spec = specs[action];
      const content = selected || spec.placeholder;
      const insert = `${spec.open}${content}${spec.close}`;
      next = value.slice(0, start) + insert + value.slice(end);
      if (spec.cursorInUrl) {
        // 光标停在 url 括号内，便于直接输入地址
        nextCursor = start + insert.length - (spec.close.length - 1);
      } else if (selected) {
        nextCursor = start + insert.length;
      } else {
        // 未选中时：光标停留在占位内容之后，便于继续输入
        nextCursor = start + spec.open.length + content.length;
      }
    } else {
      // 行首型语法：#、##、- （已存在则移除，实现切换）
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const lineEndIdx = value.indexOf('\n', end);
      const lineEnd = lineEndIdx === -1 ? value.length : lineEndIdx;
      const lineContent = value.slice(lineStart, lineEnd);
      const beforeLine = value.slice(0, lineStart);
      const afterLine = value.slice(lineEnd);

      let newLine = lineContent;
      if (action === 'h1' || action === 'h2') {
        const prefix = action === 'h1' ? '# ' : '## ';
        const headingMatch = lineContent.match(/^(#{1,6})\s+/);
        if (headingMatch) {
          const existing = `${headingMatch[1]} `;
          if (existing.trim() === prefix.trim()) {
            newLine = lineContent.slice(existing.length); // 同级别 → 移除
          } else {
            newLine = prefix + lineContent.slice(headingMatch[0].length); // 切换级别
          }
        } else {
          newLine = prefix + lineContent;
        }
      } else {
        // 无序列表：已有 - 前缀则移除
        const listMatch = lineContent.match(/^[-*]\s+/);
        if (listMatch) {
          newLine = lineContent.slice(listMatch[0].length);
        } else {
          newLine = `- ${lineContent}`;
        }
      }

      next = beforeLine + newLine + afterLine;
      // 光标平移到新行的内容中（保持相对位置）
      const delta = newLine.length - lineContent.length;
      nextCursor = start + delta;
    }

    onChange(next);

    // 恢复焦点与光标位置
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(nextCursor, nextCursor);
    });
  };

  return (
    <div className="md-editor" style={{ minHeight }}>
      <div className="md-toolbar">
        {toolbarButtons.map((btn, i) => (
          <span key={btn.action} style={{ display: 'inline-flex', alignItems: 'center' }}>
            {i === 5 && <span className="md-toolbar-divider" />}
            <button
              type="button"
              className="md-toolbar-btn"
              title={btn.title}
              aria-label={btn.title}
              onClick={() => applyAction(btn.action)}
              onMouseDown={e => e.preventDefault() /* 防止 textarea 失焦 */}
            >
              {btn.icon}
            </button>
          </span>
        ))}
        <span className="md-toolbar-hint">Markdown</span>
      </div>
      <div className="md-panes">
        <div className="md-pane md-editor-pane">
          <textarea
            ref={textareaRef}
            className="md-editor-textarea"
            value={value}
            onChange={e => onChange(e.target.value)}
            placeholder={placeholder}
            spellCheck={false}
          />
        </div>
        <div className="md-pane md-preview-pane" role="note" aria-label="Markdown 预览">
          {rendered ? (
            <div className="md-body" dangerouslySetInnerHTML={{ __html: rendered }} />
          ) : (
            <div className="md-preview-empty">预览将随输入实时更新…</div>
          )}
        </div>
      </div>
    </div>
  );
}
