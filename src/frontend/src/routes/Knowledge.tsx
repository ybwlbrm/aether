import { useState, useRef, useEffect } from 'react';
import { motion } from 'framer-motion';
import { PageHeader } from '../components/PageHeader';
import { MarkdownEditor } from '../components/MarkdownEditor';
import { BookOpen, Link2, StickyNote, FileText, Plus, Search, Tag, X, ExternalLink, Clock, Trash2, Save, Eye, Pencil, FolderPlus, Upload, Loader2, Brain, Sparkles } from 'lucide-react';
import { confirm as confirmDialog } from '../components/ui/confirm-dialog';
import { api } from '../api/client';

type TabType = 'bookmarks' | 'notes' | 'wiki' | 'memory';

interface WikiPage {
  id: string;
  title: string;
  content: string;
  category: string;
  createdAt: string;
  updatedAt: string;
}

interface Bookmark {
  id: string;
  title: string;
  url: string;
  tags: string[];
  summary: string;
  createdAt: string;
}

interface Note {
  id: string;
  title: string;
  content: string;
  tags: string[];
  createdAt: string;
}

/** AI 提取的记忆（对应后端 memories 表） */
interface Memory {
  id: string;
  type: 'short_term' | 'long_term' | 'project';
  key: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

/** 记忆类型徽章样式 */
const memoryTypeStyles: Record<string, { label: string; color: string }> = {
  short_term: { label: '短期', color: '#3b82f6' },
  long_term: { label: '长期', color: '#a78bfa' },
  project: { label: '项目', color: '#22c55e' },
};

const memoryFilters = [
  { id: '', label: '全部' },
  { id: 'short_term', label: '短期' },
  { id: 'long_term', label: '长期' },
  { id: 'project', label: '项目' },
];

const tabs = [
  { id: 'bookmarks' as TabType, label: '收藏夹', icon: <Link2 size={20} />, color: 'var(--color-accent)' },
  { id: 'notes' as TabType, label: '闪念备忘录', icon: <StickyNote size={20} />, color: 'var(--color-warning)' },
  { id: 'wiki' as TabType, label: '知识库', icon: <BookOpen size={20} />, color: '#a78bfa' },
  { id: 'memory' as TabType, label: '记忆', icon: <Brain size={20} />, color: '#22d3ee' },
];

export function Knowledge() {
  const [activeTab, setActiveTab] = useState<TabType>('bookmarks');

  // 从 localStorage 读取数据，并提供刷新函数
  const loadFromStorage = () => {
    try {
      setBookmarks(JSON.parse(localStorage.getItem('knowledge_bookmarks') || '[]'));
    } catch { setBookmarks([]); }
    try {
      setNotes(JSON.parse(localStorage.getItem('knowledge_notes') || '[]'));
    } catch { setNotes([]); }
    try {
      setWikiPages(JSON.parse(localStorage.getItem('knowledge_wiki') || '[]'));
    } catch { setWikiPages([]); }
  };

  const [bookmarks, setBookmarks] = useState<Bookmark[]>(() => {
    try { return JSON.parse(localStorage.getItem('knowledge_bookmarks') || '[]'); } catch { return []; }
  });
  const [notes, setNotes] = useState<Note[]>(() => {
    try { return JSON.parse(localStorage.getItem('knowledge_notes') || '[]'); } catch { return []; }
  });
  const [wikiPages, setWikiPages] = useState<WikiPage[]>(() => {
    try { return JSON.parse(localStorage.getItem('knowledge_wiki') || '[]'); } catch { return []; }
  });
  const [wikiPage, setWikiPage] = useState<WikiPage | null>(null);
  const [wikiEditing, setWikiEditing] = useState(false);

  // 首次加载时尝试从后端 API 加载 Wiki 页面
  useEffect(() => {
    if (activeTab === 'wiki') {
      api.getWikiPages().then(pages => {
        if (pages && pages.length > 0) { setWikiPages(pages); }
      }).catch(() => {});
    }
  }, [activeTab]);

  // 监听云同步事件，数据变化时自动刷新
  useEffect(() => {
    const handler = () => loadFromStorage();
    window.addEventListener('sync-data-changed', handler);
    return () => window.removeEventListener('sync-data-changed', handler);
  }, []);
  const [wikiTitle, setWikiTitle] = useState('');
  const [wikiContent, setWikiContent] = useState('');
  const [wikiCategory, setWikiCategory] = useState('通用');
  const [newNote, setNewNote] = useState('');
  const [newBookmark, setNewBookmark] = useState({ title: '', url: '', tags: '' });
  const [searchQuery, setSearchQuery] = useState('');
  const fileImportRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  // ---- 记忆（AI 提取，后端持久化）----
  const [memories, setMemories] = useState<Memory[]>([]);
  const [memorySearch, setMemorySearch] = useState('');
  const [memoryFilter, setMemoryFilter] = useState('');
  const [extractText, setExtractText] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [extractResult, setExtractResult] = useState('');
  // 审计修复：记忆加载错误状态（替代静默 console.error）
  const [memoryError, setMemoryError] = useState<string | null>(null);

  const loadMemories = async () => {
    setMemoryError(null);
    try {
      let list: Memory[] = memorySearch.trim()
        ? await api.searchMemories(memorySearch.trim())
        : await api.getMemories(memoryFilter || undefined);
      // 搜索 + 类型筛选组合时本地过滤
      if (memorySearch.trim() && memoryFilter) {
        list = (list || []).filter(m => m.type === memoryFilter);
      }
      setMemories(list || []);
    } catch (e: unknown) {
      // 审计修复：加载失败不再仅 console.error，显示错误提示供用户知晓
      console.error('加载记忆失败:', e);
      setMemories([]);
      setMemoryError(e instanceof Error ? e.message : '加载记忆失败');
    }
  };

  // 切换 tab / 搜索 / 筛选变化时重新加载（搜索输入带 300ms 防抖）
  useEffect(() => {
    if (activeTab !== 'memory') return;
    const t = setTimeout(() => { void loadMemories(); }, memorySearch.trim() ? 300 : 0);
    return () => clearTimeout(t);
    // P2-2 修复：原 eslint-disable react-hooks/exhaustive-deps 引用了未安装的规则。
    // 规则未启用，直接移除引用。
  }, [activeTab, memorySearch, memoryFilter]);

  const handleExtract = async () => {
    if (!extractText.trim() || extracting) return;
    setExtracting(true);
    setExtractResult('');
    try {
      const res = await api.extractMemory({ content: extractText.trim() });
      setExtractResult(`已提取 ${res.extracted} 条记忆`);
      if (res.extracted > 0) setExtractText('');
      await loadMemories();
    } catch (e: unknown) {
      setExtractResult(`提取失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExtracting(false);
    }
  };

  const deleteMemoryItem = async (id: string) => {
    if (!(await confirmDialog('确定删除此记忆？此操作不可撤销。'))) return;
    try {
      await api.deleteMemory(id);
      await loadMemories();
    } catch (e: unknown) {
      alert(`删除失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // 导入文件：txt/md 直接读文本存入笔记；doc/docx/pdf/epub 等由后端解析
  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setImporting(true);
    const unsupportedFiles: string[] = [];
    const process = async () => {
      for (const f of files) {
        const ext = f.name.split('.').pop()?.toLowerCase() || '';
        if (['txt', 'md', 'markdown', 'log', 'json', 'csv'].includes(ext)) {
          const text = await f.text();
          const updated = [{ id: Date.now().toString() + Math.random(), title: f.name, content: text, tags: ['导入'], createdAt: new Date().toISOString() } as Note, ...notes];
          setNotes(updated);
          localStorage.setItem('knowledge_notes', JSON.stringify(updated));
        } else {
          unsupportedFiles.push(f.name);
          const updated = [{ id: Date.now().toString() + Math.random(), title: `📄 ${f.name}`, content: `⚠️ 仅保存文件引用（内容未解析）\n文件名: ${f.name}\n大小: ${(f.size / 1024).toFixed(0)}KB\n\n当前版本仅支持解析 .txt/.md/.json/.csv 等文本文件，${ext.toUpperCase()} 格式的内容解析暂不支持。`, tags: [ext.toUpperCase()], createdAt: new Date().toISOString() } as Note, ...notes];
          setNotes(updated);
          localStorage.setItem('knowledge_notes', JSON.stringify(updated));
        }
      }
      setImporting(false);
      e.target.value = '';
      // 审计修复：明确提示用户哪些文件仅保存了引用
      if (unsupportedFiles.length > 0) {
        alert(`以下文件仅保存了文件引用（内容未解析），当前版本不支持解析此格式：\n\n${unsupportedFiles.join('\n')}\n\n支持解析的格式：.txt, .md, .json, .csv, .log`);
      }
    };
    void process();
  };

  const addBookmark = () => {
    if (!newBookmark.url) return;
    const bookmark: Bookmark = {
      id: Date.now().toString(),
      title: newBookmark.title || newBookmark.url,
      url: newBookmark.url,
      tags: newBookmark.tags.split(',').map(t => t.trim()).filter(Boolean),
      summary: '',
      createdAt: new Date().toISOString(),
    };
    const updated = [bookmark, ...bookmarks];
    setBookmarks(updated);
    localStorage.setItem('knowledge_bookmarks', JSON.stringify(updated));
    setNewBookmark({ title: '', url: '', tags: '' });
  };

  const addNote = () => {
    if (!newNote.trim()) return;
    const note: Note = {
      id: Date.now().toString(),
      title: newNote.split('\n')[0].slice(0, 50),
      content: newNote,
      tags: [],
      createdAt: new Date().toISOString(),
    };
    const updated = [note, ...notes];
    setNotes(updated);
    localStorage.setItem('knowledge_notes', JSON.stringify(updated));
    setNewNote('');
  };

  const deleteBookmark = async (id: string) => {
    if (!(await confirmDialog('确定删除此收藏？此操作不可撤销。'))) return;
    const updated = bookmarks.filter(b => b.id !== id);
    setBookmarks(updated);
    localStorage.setItem('knowledge_bookmarks', JSON.stringify(updated));
  };
  const deleteNote = async (id: string) => {
    if (!(await confirmDialog('确定删除此笔记？此操作不可撤销。'))) return;
    const updated = notes.filter(n => n.id !== id);
    setNotes(updated);
    localStorage.setItem('knowledge_notes', JSON.stringify(updated));
  };

  const filteredBookmarks = bookmarks.filter(b =>
    b.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    b.tags.some(t => t.toLowerCase().includes(searchQuery.toLowerCase()))
  );
  const filteredNotes = notes.filter(n =>
    n.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    n.content.toLowerCase().includes(searchQuery.toLowerCase())
  );
  // P1-5 修复：wiki tab 搜索过滤原先缺失，导致搜索框对 Wiki 列表无效
  const filteredWikiPages = wikiPages.filter(p =>
    p.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    p.content.toLowerCase().includes(searchQuery.toLowerCase()) ||
    p.category.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)', backgroundImage: 'var(--bg-gradient)' }}>
      <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '0 24px' }}>
        <PageHeader title="知识管理" description="收藏夹 · 闪念备忘录 · 知识库 · 记忆" icon={<BookOpen size={22} />} color="#a78bfa" />

        {/* Tabs - 加大、方正、接近标准 input 高度 */}
        <div className="flex gap-3 mb-6">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className="flex items-center gap-2.5 rounded-[14px] font-medium transition-all"
              style={{
                padding: '14px 28px',
                fontSize: 15,
                background: activeTab === tab.id ? `${tab.color}18` : 'var(--bg-surface)',
                color: activeTab === tab.id ? tab.color : 'var(--text-secondary)',
                border: `1px solid ${activeTab === tab.id ? `${tab.color}30` : 'var(--border-primary)'}`,
                height: 52,
              }}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>

        {/* Search - 标准 input 样式，不加覆盖（记忆 tab 使用自己的 API 搜索，隐藏本地过滤框） */}
        {activeTab !== 'memory' && (
          <div className="glass-card" style={{ padding: '20px', marginBottom: 24 }}>
            <div className="flex items-center gap-3">
              <Search size={20} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
              <input
                className="input"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder={`搜索${tabs.find(t => t.id === activeTab)?.label}...`}
              />
            </div>
          </div>
        )}

        {/* 导入文件栏 */}
        <div className="glass-card" style={{ padding: '16px', marginBottom: 24, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="flex items-center gap-3">
            <Upload size={18} style={{ color: 'var(--color-accent)', flexShrink: 0 }} />
            <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>导入文件到知识库（txt/md 直接读取，pdf/docx/epub 等保存引用）</span>
          </div>
          <div className="flex items-center gap-2">
            <input ref={fileImportRef} type="file" multiple style={{ display: 'none' }} onChange={handleImport} accept=".txt,.md,.markdown,.log,.json,.csv,.pdf,.doc,.docx,.epub,.mobi" />
            <button className="btn btn-secondary" onClick={() => fileImportRef.current?.click()} disabled={importing}>
              {importing ? <><Loader2 size={18} className="animate-spin" /> 导入中...</> : <><Upload size={18} /> 导入文件</>}
            </button>
          </div>
        </div>

        {/* Bookmarks Tab */}
        {activeTab === 'bookmarks' && (
          <div className="glass-card" style={{ padding: '24px' }}>
            <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 16 }}>添加收藏</h3>
            <div className="flex gap-3 mb-4">
              <input className="input flex-1" value={newBookmark.url} onChange={e => setNewBookmark(p => ({ ...p, url: e.target.value }))} placeholder="输入链接 URL..." />
              <input className="input" style={{ flex: 0.5 }} value={newBookmark.tags} onChange={e => setNewBookmark(p => ({ ...p, tags: e.target.value }))} placeholder="标签（逗号分隔）" />
              <button className="btn btn-primary" onClick={addBookmark}><Plus size={18} /> 添加</button>
            </div>

            {filteredBookmarks.length === 0 ? (
              <div className="empty-state py-12">
                <Link2 size={36} className="empty-state-icon" />
                {/* 审计修复：区分搜索无结果 vs 无数据 */}
                <div className="empty-state-title">{searchQuery ? '未找到匹配的收藏' : '暂无收藏'}</div>
                <div className="empty-state-desc">{searchQuery ? `没有匹配"${searchQuery}"的收藏` : '添加链接开始收藏'}</div>
                {searchQuery && <button className="btn btn-ghost mt-3" onClick={() => setSearchQuery('')} style={{ fontSize: '13px' }}>清除搜索</button>}
              </div>
            ) : (
              <div className="space-y-3">
                {filteredBookmarks.map(b => (
                  <motion.div key={b.id} className="rounded-[14px] p-4" style={{ background: 'var(--glass-fill)', border: '1px solid var(--border-primary)' }}>
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <a href={b.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: '14px', fontWeight: 600, color: 'var(--color-accent)', textDecoration: 'none' }}>
                          {b.title} <ExternalLink size={12} style={{ display: 'inline' }} />
                        </a>
                        <p style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: 2 }}>{b.url}</p>
                        {b.tags.length > 0 && (
                          <div className="flex gap-1 mt-2">
                            {b.tags.map(tag => (
                              <span key={tag} className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(94,158,255,0.12)', color: 'var(--color-accent)' }}>{tag}</span>
                            ))}
                          </div>
                        )}
                      </div>
                      <button onClick={() => deleteBookmark(b.id)} style={{ color: 'var(--text-tertiary)', cursor: 'pointer', background: 'none', border: 'none', padding: 4 }}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </motion.div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Notes Tab */}
        {activeTab === 'notes' && (
          <div className="glass-card" style={{ padding: '24px' }}>
            <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 16 }}>快速记录</h3>
            <textarea
              className="input textarea"
              rows={3}
              value={newNote}
              onChange={e => setNewNote(e.target.value)}
              placeholder="记录你的想法..."
              style={{ marginBottom: 12 }}
            />
            <button className="btn btn-primary" onClick={addNote} disabled={!newNote.trim()}><Plus size={18} /> 添加</button>

            {filteredNotes.length === 0 ? (
              <div className="empty-state py-12">
                <StickyNote size={36} className="empty-state-icon" />
                {/* 审计修复：区分搜索无结果 vs 无数据 */}
                <div className="empty-state-title">{searchQuery ? '未找到匹配的记录' : '暂无记录'}</div>
                <div className="empty-state-desc">{searchQuery ? `没有匹配"${searchQuery}"的记录` : '记录你的想法和灵感'}</div>
                {searchQuery && <button className="btn btn-ghost mt-3" onClick={() => setSearchQuery('')} style={{ fontSize: '13px' }}>清除搜索</button>}
              </div>
            ) : (
              <div className="space-y-3 mt-6">
                {filteredNotes.map(n => (
                  <motion.div key={n.id} className="rounded-[14px] p-4" style={{ background: 'var(--glass-fill)', border: '1px solid var(--border-primary)' }}>
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <p style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>{n.title}</p>
                        <p style={{ fontSize: '13px', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{n.content}</p>
                        <p style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: 8 }}><Clock size={12} style={{ display: 'inline', marginRight: 4 }} />{new Date(n.createdAt).toLocaleString()}</p>
                      </div>
                      <button onClick={() => deleteNote(n.id)} style={{ color: 'var(--text-tertiary)', cursor: 'pointer', background: 'none', border: 'none', padding: 4, flexShrink: 0 }}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </motion.div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Wiki Tab */}
        {activeTab === 'wiki' && (
          <div className="glass-card" style={{ padding: '24px' }}>
            <div className="flex items-center justify-between mb-6">
              <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)' }}>
                Wiki · {wikiPages.length} 页
              </h3>
              <button className="btn btn-primary" onClick={() => {
                setWikiPage(null); setWikiEditing(true);
                setWikiTitle(''); setWikiContent(''); setWikiCategory('通用');
              }}>
                <FolderPlus size={16} /> 新建页面
              </button>
            </div>

            {wikiEditing && (
              <div style={{ marginBottom: 16 }}>
                <div className="flex gap-3 mb-3">
                  <input className="input flex-1" placeholder="页面标题" value={wikiTitle} onChange={e => setWikiTitle(e.target.value)} />
                  <input className="input" style={{ flex: 0.3 }} placeholder="分类" value={wikiCategory} onChange={e => setWikiCategory(e.target.value)} />
                </div>
                <MarkdownEditor
                  value={wikiContent}
                  onChange={setWikiContent}
                  placeholder={'# 标题\n\n支持 Markdown 语法：**加粗**、*斜体*、`代码`、列表、代码块等'}
                  minHeight={360}
                />
                <div className="flex gap-3" style={{ marginTop: 12 }}>
                  <button className="btn btn-primary" onClick={async () => {
                    if (!wikiTitle.trim()) { alert('请输入标题'); return; }
                    const pageData = { title: wikiTitle.trim(), content: wikiContent, category: wikiCategory };
                    try {
                      const saved = wikiPage
                        ? await api.updateWikiPage(wikiPage.id, pageData)
                        : await api.createWikiPage(pageData);
                      setWikiPages(prev => wikiPage
                        ? prev.map(p => p.id === wikiPage.id ? { ...p, ...pageData, updatedAt: new Date().toISOString() } : p)
                        : [...prev, { ...pageData, id: saved.id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]);
                      setWikiPage(wikiPage ? { ...wikiPage, ...pageData, updatedAt: new Date().toISOString() } : { ...pageData, id: saved.id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
                    } catch {
                      // 审计修复：后端保存失败不再静默降级，提示用户（仍降级到 localStorage 防数据丢失）
                      alert('⚠️ Wiki 页面保存到后端失败，已临时保存到本地。请检查网络连接后重试。');
                      const page: WikiPage = {
                        id: wikiPage?.id || Date.now().toString(),
                        title: wikiTitle.trim(),
                        content: wikiContent,
                        category: wikiCategory,
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                      };
                      const next = wikiPage
                        ? wikiPages.map(p => p.id === wikiPage.id ? page : p)
                        : [...wikiPages, page];
                      setWikiPages(next);
                      localStorage.setItem('knowledge_wiki', JSON.stringify(next));
                      setWikiPage(page);
                    }
                    setWikiEditing(false);
                  }}>
                    <Save size={16} /> 保存
                  </button>
                  <button className="btn btn-ghost" onClick={() => setWikiEditing(false)}>取消</button>
                </div>
              </div>
            )}

            {filteredWikiPages.length === 0 && !wikiEditing ? (
              <div className="empty-state py-12">
                <BookOpen size={36} className="empty-state-icon" />
                <div className="empty-state-title">{searchQuery ? '无匹配的 Wiki 页面' : '暂无知识库页面'}</div>
                <div className="empty-state-desc">{searchQuery ? '尝试修改搜索条件' : '点击「新建页面」开始记录知识'}</div>
              </div>
            ) : (
              <>
                {wikiPage && !wikiEditing && (
                  <div className="rounded-[14px] p-5 mb-4" style={{ background: 'var(--glass-fill)', border: '1px solid var(--border-primary)' }}>
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <h4 style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)' }}>{wikiPage.title}</h4>
                        <p style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: 2 }}>{wikiPage.category} · 更新于 {new Date(wikiPage.updatedAt).toLocaleString()}</p>
                      </div>
                      <button className="btn btn-ghost btn-sm" onClick={() => setWikiPage(null)} style={{ fontSize: 12 }}><X size={14} /> 关闭</button>
                    </div>
                    <div style={{ fontSize: '13px', color: 'var(--text-primary)', lineHeight: 1.7 }}>
                      {wikiPage.content.split('\n').map((line, i) => {
                        if (line.startsWith('# ')) return <h5 key={i} style={{ fontSize: 18, fontWeight: 700, margin: '12px 0 8px' }}>{line.slice(2)}</h5>;
                        if (line.startsWith('## ')) return <h6 key={i} style={{ fontSize: 15, fontWeight: 600, margin: '10px 0 6px' }}>{line.slice(3)}</h6>;
                        if (line.startsWith('- ')) return <p key={i} style={{ paddingLeft: 16, marginBottom: 4 }}>• {line.slice(2)}</p>;
                        if (line.trim() === '') return <div key={i} style={{ height: 6 }} />;
                        return <p key={i} style={{ marginBottom: 6 }}>{line}</p>;
                      })}
                    </div>
                  </div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {filteredWikiPages.map(p => (
                    <motion.div key={p.id} className="rounded-[14px] p-4 cursor-pointer"
                      style={{ background: wikiPage?.id === p.id ? 'var(--glass-fill)' : 'var(--glass-fill)', border: `1px solid ${wikiPage?.id === p.id ? 'rgba(167,139,250,0.2)' : 'var(--border-primary)'}` }}
                      onClick={() => { setWikiPage(p); setWikiEditing(false); }}
                      whileHover={{ y: -2 }}
                    >
                      <div className="flex items-center justify-between">
                        <div className="min-w-0 flex-1">
                          <p style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)' }}>{p.title}</p>
                          <p style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: 2 }}>{p.category} · {new Date(p.updatedAt).toLocaleDateString()}</p>
                        </div>
                        <div className="flex gap-1 flex-shrink-0">
                          <button onClick={e => { e.stopPropagation(); setWikiPage(p); setWikiEditing(true); setWikiTitle(p.title); setWikiContent(p.content); setWikiCategory(p.category); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)' }}>
                            <Pencil size={14} />
                          </button>
                          <button onClick={async (e) => { e.stopPropagation(); if (!(await confirmDialog('确定删除此 Wiki 页面？此操作不可撤销。'))) return; try { await api.deleteWikiPage(p.id); setWikiPages(prev => prev.filter(x => x.id !== p.id)); if (wikiPage?.id === p.id) setWikiPage(null); } catch (e) { /* 审计修复：删除失败不再静默，提示用户且不移除 UI 条目（防数据不一致） */ alert('Wiki 页面删除失败: ' + (e instanceof Error ? e.message : '网络错误')); } }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)' }}>
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        {/* Memory Tab - AI 提取的记忆 */}
        {activeTab === 'memory' && (
          <div className="glass-card" style={{ padding: '24px' }}>
            {/* 提取区 */}
            <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 16 }}>AI 提取记忆</h3>
            <textarea
              className="input textarea"
              rows={3}
              value={extractText}
              onChange={e => setExtractText(e.target.value)}
              placeholder="粘贴要提取记忆的内容（聊天记录、笔记、文章段落等），AI 将自动分类并保存..."
              style={{ marginBottom: 12 }}
            />
            <div className="flex items-center gap-3">
              <button className="btn btn-primary" onClick={handleExtract} disabled={!extractText.trim() || extracting}>
                {extracting ? <><Loader2 size={18} className="animate-spin" /> 提取中...</> : <><Sparkles size={18} /> 提取记忆</>}
              </button>
              {extractResult && (
                <span style={{ fontSize: '13px', color: extractResult.startsWith('提取失败') ? '#ef4444' : 'var(--color-success, #22c55e)' }}>{extractResult}</span>
              )}
            </div>

            {/* 搜索 + 类型筛选 */}
            <div className="flex gap-3 mt-6 mb-4">
              <div className="flex items-center gap-3 flex-1" style={{ background: 'var(--glass-fill)', border: '1px solid var(--border-primary)', borderRadius: 12, padding: '0 14px' }}>
                <Search size={16} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                <input
                  className="input"
                  style={{ border: 'none', background: 'transparent', boxShadow: 'none', paddingLeft: 0 }}
                  value={memorySearch}
                  onChange={e => setMemorySearch(e.target.value)}
                  placeholder="搜索记忆内容..."
                />
              </div>
              <div className="flex gap-2 flex-shrink-0">
                {memoryFilters.map(f => (
                  <button
                    key={f.id || 'all'}
                    onClick={() => setMemoryFilter(f.id)}
                    className="rounded-full text-xs font-medium transition-all"
                    style={{
                      padding: '8px 16px',
                      background: memoryFilter === f.id ? 'rgba(34,211,238,0.15)' : 'var(--glass-fill)',
                      color: memoryFilter === f.id ? '#22d3ee' : 'var(--text-secondary)',
                      border: `1px solid ${memoryFilter === f.id ? 'rgba(34,211,238,0.35)' : 'var(--border-primary)'}`,
                      cursor: 'pointer',
                    }}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 记忆列表 */}
            {/* 审计修复：记忆加载错误状态 — 替代静默 console.error */}
            {memoryError && (
              <div className="empty-state py-12">
                <div className="empty-state-icon" style={{ color: 'var(--color-danger)' }}>⚠️</div>
                <div className="empty-state-title">记忆加载失败</div>
                <div className="empty-state-desc">{memoryError}</div>
                <button className="btn btn-ghost mt-3" onClick={() => loadMemories()} style={{ fontSize: '13px' }}>重试</button>
              </div>
            )}
            {!memoryError && memories.length === 0 ? (
              <div className="empty-state py-12">
                <Brain size={36} className="empty-state-icon" />
                <div className="empty-state-title">{memorySearch || memoryFilter ? '无匹配的记忆' : '暂无记忆'}</div>
                <div className="empty-state-desc">{memorySearch || memoryFilter ? '尝试修改搜索条件' : '粘贴内容并点击「提取记忆」，AI 将自动抽取并分类'}</div>
              </div>
            ) : (
              <div className="space-y-3">
                {memories.map(m => {
                  const style = memoryTypeStyles[m.type] || memoryTypeStyles.short_term;
                  return (
                    <motion.div key={m.id} className="rounded-[14px] p-4" style={{ background: 'var(--glass-fill)', border: '1px solid var(--border-primary)' }}>
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: `${style.color}1a`, color: style.color, fontWeight: 600 }}>{style.label}</span>
                            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{m.key}</span>
                          </div>
                          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{m.content}</p>
                          {m.tags.length > 0 && (
                            <div className="flex gap-1 mt-2 flex-wrap">
                              {m.tags.map(tag => (
                                <span key={tag} className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(94,158,255,0.12)', color: 'var(--color-accent)' }}>#{tag}</span>
                              ))}
                            </div>
                          )}
                          <p style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: 8 }}>
                            <Clock size={12} style={{ display: 'inline', marginRight: 4 }} />{new Date(m.createdAt).toLocaleString()}
                          </p>
                        </div>
                        <button onClick={() => deleteMemoryItem(m.id)} style={{ color: 'var(--text-tertiary)', cursor: 'pointer', background: 'none', border: 'none', padding: 4, flexShrink: 0 }}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}