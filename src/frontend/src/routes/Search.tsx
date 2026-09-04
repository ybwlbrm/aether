import { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { PageHeader } from '../components/PageHeader';
import { api } from '../api/client';
import { Search as SearchIcon, Globe, FileText, ExternalLink, Download, Filter, Clock, Bookmark, X, BookOpen, Database, MessageSquare } from 'lucide-react';

// P0 修复：仅允许 http/https 链接，防止 javascript:/vbscript:/data: 伪协议 XSS
function safeUrl(url: string): string {
  if (!url) return '';
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return url;
    return '';
  } catch {
    return '';
  }
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
  date: string;
  role?: string;
}

interface SearchHistoryItem {
  id: string;
  query: string;
  sources: string;
  resultCount: number;
  createdAt: string;
}

const searchSources = [
  { id: 'duckduckgo', label: 'DuckDuckGo', icon: <Globe size={16} />, color: 'var(--color-danger)' },
  { id: 'knowledge', label: '知识库', icon: <BookOpen size={16} />, color: '#a78bfa' },
  { id: 'library', label: '媒体库', icon: <Database size={16} />, color: 'var(--color-success)' },
  { id: 'web', label: '网页抓取', icon: <Globe size={16} />, color: 'var(--color-accent)' },
  { id: 'conversations', label: '对话', icon: <MessageSquare size={16} />, color: '#f59e0b' },
];

const roleColors: Record<string, string> = {
  user: 'var(--color-accent)',
  assistant: 'var(--color-success)',
  system: 'var(--color-danger)',
  tool: '#a78bfa',
};

export function Search() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  // 审计修复：搜索错误状态 + 已搜索标记（区分"从未搜索"vs"搜索无结果"vs"搜索失败"）
  const [searchError, setSearchError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [activeSources, setActiveSources] = useState<string[]>(['duckduckgo', 'knowledge', 'library', 'web', 'conversations']);
  const [history, setHistory] = useState<SearchHistoryItem[]>([]);
  // P0 修复：搜索竞态守卫 — 递增序列号，仅最新一次搜索的结果允许写入 UI
  const searchSeqRef = useRef(0);

  // 从后端加载搜索历史（失败时回退到 localStorage）
  const loadHistory = async () => {
    try {
      const res = await api.getSearchHistory();
      if (res?.history) setHistory(res.history);
    } catch (_e: unknown) {
      try {
        const local = JSON.parse(localStorage.getItem('search_history') || '[]');
        setHistory(local.map((q: string, i: number) => ({ id: String(i), query: q, sources: '[]', resultCount: 0, createdAt: '' })));
      } catch (_e2: unknown) { /* ignore - intentional */ }
    }
  };

  useEffect(() => { loadHistory(); }, []);

  // 清空搜索历史
  const clearHistory = async () => {
    try {
      await api.clearSearchHistory();
      setHistory([]);
      try { localStorage.removeItem('search_history'); } catch (_e: unknown) { /* ignore - intentional */ }
    } catch (_e: unknown) { /* ignore - intentional */ }
  };

  const handleSearch = async (queryOverride?: string) => {
    const q = (queryOverride ?? query).trim();
    if (!q) return;
    if (queryOverride) setQuery(queryOverride);
    setSearching(true);
    // P0 修复：新一轮搜索递增序列号，作废旧请求
    const seq = ++searchSeqRef.current;
    // 审计修复：清除上次搜索的错误状态，标记已搜索
    setSearchError(null);
    setHasSearched(true);

    try {
      let combined: any[] = [];

      // DuckDuckGo + 网页抓取 → 后端
      const webSources = activeSources.filter(s => s === 'duckduckgo' || s === 'web');
      if (webSources.length > 0) {
        try {
          // 审计修复：用局部变量 q（已正确处理 queryOverride）而非旧 state query
          const res = await api.search({ query: q, sources: webSources });
          combined = res?.results || [];
        } catch (e: unknown) {
          // 审计修复：搜索失败不再静默，显示错误提示
          setSearchError(e instanceof Error ? e.message : '搜索失败');
        }
      }

      // 知识库搜索（bookmarks/notes/wiki）
      if (activeSources.includes('knowledge')) {
        // 审计修复：用 q 而非旧 state query，避免变量遮蔽
        const qLc = q.toLowerCase();
        const date = new Date().toISOString();
        try {
          const bookmarks = JSON.parse(localStorage.getItem('knowledge_bookmarks') || '[]');
          for (const b of bookmarks) {
            if ((b.title || '').toLowerCase().includes(qLc) || (b.url || '').toLowerCase().includes(qLc) || (b.tags || []).some((t: string) => t.toLowerCase().includes(qLc))) {
              combined.push({ title: `🔖 收藏: ${b.title}`, url: b.url, snippet: (b.summary || '书签收藏'), source: 'knowledge', date });
            }
          }
          const notes = JSON.parse(localStorage.getItem('knowledge_notes') || '[]');
          for (const n of notes) {
            if ((n.title || '').toLowerCase().includes(qLc) || (n.content || '').toLowerCase().includes(qLc)) {
              combined.push({ title: `📝 笔记: ${n.title}`, url: '', snippet: String(n.content || '').slice(0, 150), source: 'knowledge', date });
            }
          }
          const wiki = JSON.parse(localStorage.getItem('knowledge_wiki') || '[]');
          for (const w of wiki) {
            if ((w.title || '').toLowerCase().includes(qLc) || (w.content || '').toLowerCase().includes(qLc)) {
              combined.push({ title: `📚 知识库: ${w.title}`, url: '', snippet: String(w.content || '').slice(0, 150), source: 'knowledge', date });
            }
          }
        } catch (_e: unknown) { /* ignore - intentional */ }
      }

      // 媒体库搜索（media + documents 从后端）
      if (activeSources.includes('library')) {
        const qLc = q.toLowerCase();
        const date = new Date().toISOString();
        try {
          const media = await api.getMedia();
          for (const m of media || []) {
            if ((m.name || '').toLowerCase().includes(qLc)) {
              combined.push({
                title: `🖼️ ${m.name}`,
                url: m.url || '',
                snippet: `类型: ${m.type || 'media'} · 创建于 ${new Date(m.createdAt || '').toLocaleString()}`,
                source: 'library',
                date: m.createdAt || date,
              });
            }
          }
          const docs = await api.getDocuments();
          for (const d of docs || []) {
            if ((d.name || '').toLowerCase().includes(qLc)) {
              combined.push({
                title: `📄 ${d.name}`,
                url: d.path || '',
                snippet: `类型: ${d.type || 'document'} · 创建于 ${new Date(d.createdAt || '').toLocaleString()}`,
                source: 'library',
                date: d.createdAt || date,
              });
            }
          }
        } catch (_e: unknown) { /* ignore - intentional */ }
      }

      // 对话消息搜索（后端 LIKE 匹配，按对话分组）
      if (activeSources.includes('conversations')) {
        const date = new Date().toISOString();
        try {
          const res = await api.searchConversations(query);
          for (const conv of res?.results || []) {
            for (const msg of conv.messages || []) {
              combined.push({
                title: `💬 ${conv.conversationTitle || '对话'}`,
                url: '',
                snippet: msg.snippet || msg.content || '',
                source: 'conversations',
                date,
                role: msg.role,
              });
            }
          }
        } catch (_e: unknown) { /* ignore - intentional */ }
      }

      // 去重
      const seen = new Set<string>();
      combined = combined.filter((r: any) => { const k = r.url || r.title; if (seen.has(k)) return false; seen.add(k); return true; });
      // P0 修复：防竞态 — 旧请求返回时丢弃结果（仅最新序列写入）
      if (searchSeqRef.current !== seq) return;
      setResults(combined);
      // 审计修复：记录搜索历史（之前 recordSearchHistory 从未被调用，导致历史结果数永远0）
      try { await api.recordSearchHistory({ query: q, sources: activeSources, resultCount: combined.length }); } catch { /* 非关键路径，静默 */ }
    } catch (e: unknown) {
      // 审计修复：搜索失败不再静默 console.error，显示错误状态供用户重试
      if (searchSeqRef.current !== seq) return;
      setSearchError(e instanceof Error ? e.message : '搜索失败');
      setResults([]);
    }
    if (searchSeqRef.current === seq) setSearching(false);
    loadHistory();
  };

  const toggleSource = (sourceId: string) => {
    setActiveSources(prev =>
      prev.includes(sourceId) ? prev.filter(s => s !== sourceId) : [...prev, sourceId]
    );
  };

  const exportResults = async (format: 'csv' | 'json' | 'markdown') => {
    try {
      await api.exportData({ format, data: results, filename: `search-results-${Date.now()}` });
      const blob = new Blob([format === 'json' ? JSON.stringify(results, null, 2) : results.map(r => r.title).join('\n')], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `search-results-${Date.now()}.${format}`;
      document.body.appendChild(a);
      try {
        a.click();
      } finally {
        // P0 修复：确保释放 blob URL，避免内存泄漏
        setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 0);
      }
    } catch (_e: unknown) { console.warn("[SilentCatch]", _e); }
  };

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)', backgroundImage: 'var(--bg-gradient)' }}>
      <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '0 24px' }}>
        <PageHeader title="搜索引擎" description="聚合多源搜索 · 知识库 · 媒体库 · 无广告" icon={<SearchIcon size={22} />} color="var(--color-success)" />

        {/* Search Bar */}
        <div className="glass-card" style={{ padding: '24px', marginBottom: 24 }}>
          <div className="flex gap-3">
            <div style={{ flex: 1, position: 'relative' }}>
              <SearchIcon size={18} style={{ position: 'absolute', left: 16, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)' }} />
              <input
                className="input"
                style={{ paddingLeft: 44, height: 52 }}
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && !(e.nativeEvent as any).isComposing && handleSearch()}
                placeholder="搜索知识库、媒体库、网页..."
              />
            </div>
            <button className="btn btn-primary" onClick={() => handleSearch()} disabled={searching || !query.trim()} style={{ height: 52 }}>
              {searching ? '搜索中...' : '搜索'}
            </button>
          </div>

          {/* Search Sources */}
          <div className="flex items-center flex-wrap gap-2 mt-3">
            <span style={{ fontSize: '13px', color: 'var(--text-tertiary)', marginRight: 4 }}>搜索源:</span>
            {searchSources.map(source => (
              <button
                key={source.id}
                onClick={() => toggleSource(source.id)}
                className="flex items-center gap-2 px-6 py-3 rounded-[14px] text-sm font-medium transition-all"
                style={{
                  background: activeSources.includes(source.id) ? `${source.color}18` : 'var(--bg-surface)',
                  color: activeSources.includes(source.id) ? source.color : 'var(--text-tertiary)',
                  border: `1px solid ${activeSources.includes(source.id) ? `${source.color}30` : 'var(--border-primary)'}`,
                }}
              >
                {source.icon}
                {source.label}
                {activeSources.includes(source.id) && <span style={{ fontSize: 10, opacity: 0.6 }}>✓</span>}
              </button>
            ))}
          </div>

          {/* Search History */}
          {history.length > 0 && !results.length && (
            <div className="mt-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Clock size={14} style={{ color: 'var(--text-tertiary)' }} />
                  <span style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>搜索历史</span>
                </div>
                <button
                  onClick={clearHistory}
                  className="flex items-center gap-1"
                  style={{ fontSize: '12px', color: 'var(--text-tertiary)', background: 'transparent', border: 'none', cursor: 'pointer' }}
                >
                  <X size={12} /> 清空
                </button>
              </div>
              <div className="flex flex-col gap-1">
                {history.map(item => (
                  <button
                    key={item.id}
                    onClick={() => handleSearch(item.query)}
                    className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-left"
                    style={{ fontSize: '13px', color: 'var(--text-secondary)', background: 'var(--bg-surface)', border: '1px solid var(--border-primary)', cursor: 'pointer' }}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.query}</span>
                    <span style={{ fontSize: '11px', color: 'var(--text-tertiary)', flexShrink: 0 }}>
                      {item.resultCount ?? 0} 条结果
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Results */}
        {results.length > 0 && (
          <div className="glass-card" style={{ padding: '24px' }}>
            <div className="flex items-center justify-between mb-4">
              <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)' }}>
                搜索结果 ({results.length})
              </h3>
              <div className="flex items-center gap-2">
                <button className="btn btn-ghost btn-sm" onClick={() => exportResults('csv')} style={{ fontSize: 12 }}><Download size={14} /> CSV</button>
                <button className="btn btn-ghost btn-sm" onClick={() => exportResults('json')} style={{ fontSize: 12 }}><Download size={14} /> JSON</button>
                <button className="btn btn-ghost btn-sm" onClick={() => exportResults('markdown')} style={{ fontSize: 12 }}><Download size={14} /> MD</button>
              </div>
            </div>

            {results.map((r, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05 }}
                className="rounded-[14px] p-4 mb-3" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-md)' }}
              >
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: `${searchSources.find(s => s.id === r.source)?.color}18`, color: searchSources.find(s => s.id === r.source)?.color }}>
                        {searchSources.find(s => s.id === r.source)?.label}
                      </span>
                      {r.role && (
                        <span className="text-xs px-2 py-0.5 rounded-full" style={{
                          background: `${(roleColors[r.role] || 'var(--text-tertiary)')}18`,
                          color: roleColors[r.role] || 'var(--text-tertiary)',
                          border: `1px solid ${(roleColors[r.role] || 'var(--text-tertiary)')}30`,
                        }}>
                          {r.role}
                        </span>
                      )}
                    </div>
                    {/* P1-15 修复：url 为空时不渲染 <a>，避免空链接刷新页面 */}
                    {/* P0 修复：safeUrl 过滤 javascript:/data: 等协议，防止 XSS */}
                    {r.url && safeUrl(r.url) ? (
                      <a href={safeUrl(r.url)} target="_blank" rel="noopener noreferrer" style={{ fontSize: '15px', fontWeight: 600, color: 'var(--color-accent)', textDecoration: 'none' }}>
                        {r.title}
                      </a>
                    ) : (
                      <span style={{ fontSize: '15px', fontWeight: 600, color: 'var(--color-accent)' }}>
                        {r.title}
                      </span>
                    )}
                    <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.5 }}>{r.snippet}</p>
                    {r.url && <p style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: 4 }}>{r.url}</p>}
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        )}

        {/* 搜索错误状态 — 审计修复：不再静默，显示错误+重试 */}
        {searchError && !searching && (
          <div className="glass-card">
            <div className="empty-state">
              <div className="empty-state-icon" style={{ color: 'var(--color-danger)' }}>⚠️</div>
              <div className="empty-state-title">搜索失败</div>
              <div className="empty-state-desc">{searchError}</div>
              <button className="btn btn-ghost mt-3" onClick={() => handleSearch(query)} style={{ fontSize: '13px' }}>
                重试搜索
              </button>
            </div>
          </div>
        )}

        {/* 搜索无结果 — 审计修复：区分"搜索无结果"与"从未搜索"，加清除按钮 */}
        {hasSearched && !results.length && !searching && !searchError && (
          <div className="glass-card">
            <div className="empty-state">
              <SearchIcon size={40} className="empty-state-icon" />
              <div className="empty-state-title">未找到"{query}"的相关结果</div>
              <div className="empty-state-desc">尝试更换关键词或调整搜索源</div>
              <button className="btn btn-ghost mt-3" onClick={() => { setQuery(''); setHasSearched(false); }} style={{ fontSize: '13px' }}>
                清除搜索词
              </button>
            </div>
          </div>
        )}

        {/* 从未搜索 — 初始空状态 */}
        {!hasSearched && !results.length && !searching && (
          <div className="glass-card">
            <div className="empty-state">
              <SearchIcon size={40} className="empty-state-icon" />
              <div className="empty-state-title">输入关键词开始搜索</div>
              <div className="empty-state-desc">聚合 DuckDuckGo、知识库、媒体库、网页抓取等多源结果</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}