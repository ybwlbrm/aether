import { useState, useRef } from 'react';
import { Globe, ExternalLink, ArrowRight, RotateCcw, Search } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/** 判断输入是「网址」还是「搜索关键词」：
 *  含点且无空格的形如 xxx.com → 网址；
 *  否则当作关键词走 DuckDuckGo 搜索（聚合搜索引擎已合并到浏览器）。
 */
function isUrlLike(raw: string): boolean {
  const t = raw.trim();
  if (/^https?:\/\//i.test(t) || /^www\./i.test(t)) return true;
  if (t.includes(' ')) return false;
  if (t.includes('.')) return /^[\w-]+(\.[\w-]+)+/.test(t);
  return false;
}

export function Browser() {
  const [input, setInput] = useState('');
  const [src, setSrc] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const go = (raw?: string) => {
    const q = (raw ?? input).trim();
    if (!q) return;
    // 网址：直接内嵌浏览
    if (isUrlLike(q)) {
      const target = normalizeUrl(q);
      setSrc(target);
      setBlocked(false);
      setInput(target);
      return;
    }
    // 关键词：走 DuckDuckGo 搜索（内嵌展示）
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
    setSrc(searchUrl);
    setBlocked(false);
    setInput(q);
  };

  const handleLoad = () => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    try {
      // 同源 iframe 可安全访问；跨域访问会抛出 SecurityError
      win.document;
      setBlocked(false);
    } catch {
      // 跨域页面无法确认是否被 X-Frame-Options 拦截，提示用户备用方案
      setBlocked(true);
    }
  };

  const openInNewTab = () => {
    if (src) window.open(src, '_blank', 'noopener,noreferrer');
  };

  const reload = () => {
    if (!src) return;
    const current = src;
    setSrc(null);
    requestAnimationFrame(() => {
      setSrc(current);
      setBlocked(false);
    });
  };

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)', backgroundImage: 'var(--bg-gradient)' }}>
      <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '0 24px' }}>
        <PageHeader
          title="Browser"
          description="内置浏览器与网页搜索"
          icon={<Globe size={22} />}
          color="var(--color-success)"
        />

        <div className="flex items-center gap-2" style={{ marginBottom: 16 }}>
          <div className="flex-1 glass-card" style={{ padding: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Globe size={16} style={{ color: 'var(--text-tertiary)', marginLeft: 8, flexShrink: 0 }} />
            <input
              className="input"
              type="text"
              placeholder="输入网址，例如 example.com 或 https://example.com"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !(e.nativeEvent as any).isComposing) go(); }}
              style={{ flex: 1, border: 'none', background: 'transparent', boxShadow: 'none', height: 36 }}
            />
          </div>
          <button className="btn btn-primary flex-shrink-0" onClick={() => go()} title="前往">
            <ArrowRight size={16} /> 前往
          </button>
          <button
            className="btn btn-ghost flex-shrink-0"
            onClick={openInNewTab}
            disabled={!src}
            title="在新标签页打开"
          >
            <ExternalLink size={16} /> 新标签页
          </button>
          <button
            className="btn btn-ghost flex-shrink-0"
            onClick={reload}
            disabled={!src}
            title="刷新"
          >
            <RotateCcw size={16} />
          </button>
        </div>

        {blocked && (
          <div
            className="flex items-center gap-2 px-4 py-3 rounded-[14px]"
            style={{ background: 'rgba(251, 191, 36, 0.1)', border: '1px solid rgba(251, 191, 36, 0.25)', marginBottom: 16 }}
          >
            <span style={{ color: 'var(--color-warning)' }} className="text-sm">
              该网站可能禁止内嵌显示（X-Frame-Options / CSP 限制）。如果页面无法加载，请使用「新标签页」按钮打开。
            </span>
            <button className="btn btn-ghost flex-shrink-0" style={{ marginLeft: 'auto' }} onClick={openInNewTab}>
              <ExternalLink size={14} /> 在新标签页打开
            </button>
          </div>
        )}

        <div
          className="glass-card overflow-hidden"
          style={{ padding: 0, backdropFilter: 'blur(var(--glass-blur-radius)) saturate(var(--glass-saturate))', WebkitBackdropFilter: 'blur(var(--glass-blur-radius)) saturate(var(--glass-saturate))', border: '1px solid var(--card-border)', boxShadow: 'var(--card-shadow)' }}
        >
          {src ? (
            <iframe
              ref={iframeRef}
              src={src}
              title="Browser"
              style={{ width: '100%', height: 'calc(100vh - 200px)', border: 'none', display: 'block' }}
              onLoad={handleLoad}
            />
          ) : (
            <div
              className="flex flex-col items-center justify-center"
              style={{ width: '100%', height: 'calc(100vh - 200px)', color: 'var(--text-tertiary)' }}
            >
              <Globe size={48} style={{ opacity: 0.3, marginBottom: 16 }} />
              <p style={{ fontSize: '15px' }}>在上方输入网址，开始浏览网页</p>
              <p style={{ fontSize: '13px', marginTop: 6, opacity: 0.7 }}>
                注意：部分网站（如 Google）会通过 X-Frame-Options 禁止内嵌，此时请使用「新标签页」打开
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
