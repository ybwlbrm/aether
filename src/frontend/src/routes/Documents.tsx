import { useEffect, useState, useRef } from 'react';
import { motion } from 'framer-motion';
import { PageHeader } from '../components/PageHeader';
import { api } from '../api/client';
import { FileText, Presentation, Plus, Trash2, Download, Edit3, Eye, X } from 'lucide-react';
import { confirm as confirmDialog } from '../components/ui/confirm-dialog';
import { useAutosaveDraft } from '../hooks/useAutosaveDraft';

interface DocumentItem {
  id: string;
  name: string;
  type: string;
  status: string;
}

interface PreviewData {
  id: string;
  type: string;
  name: string;
  slides?: Array<{ title: string; content: string }>;
  sections?: Array<{ heading: string; body: string }>;
}

export function Documents() {
  const [docs, setDocs] = useState<DocumentItem[]>([]);
  const [showForm, setShowForm] = useState(false);
  // P1-1 修复：接入 useAutosaveDraft，意外刷新/误触返回时恢复输入
  const [form, setForm, clearDraft] = useAutosaveDraft('doc_gen_form', { type: 'ppt' as 'ppt' | 'doc', title: '', content: '' });
  const [generating, setGenerating] = useState(false);
  const [aiStatus, setAiStatus] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewSeqRef = useRef(0); // P1-15：预览竞态守卫
  // P1-14: 三态
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true); setError(null);
    api.getDocuments().then(setDocs).catch((e) => setError((e instanceof Error ? e.message : String(e)) || '加载失败')).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const handleGenerate = async () => {
    if (!form.title.trim()) { alert('请填写标题'); return; }
    setGenerating(true); setAiStatus(null);
    try {
      const useAi = !form.content.trim();
      if (form.type === 'ppt') await api.generatePPT({ title: form.title, slides: useAi ? [] : [{ title: form.title, content: form.content }] });
      else await api.generateDOC({ title: form.title, content: useAi ? '' : form.content });
      if (useAi) setAiStatus(`已通过 AI 根据标题「${form.title}」自动生成内容`);
      setShowForm(false); setForm({ type: 'ppt', title: '', content: '' }); clearDraft(); load();
    } catch (e: unknown) { alert('生成失败: ' + (e instanceof Error ? e.message : String(e))); }
    finally { setGenerating(false); }
  };

  const handleDelete = async (id: string) => {
    if (!(await confirmDialog('确定删除此文档？此操作不可撤销。'))) return;
    try { await api.deleteDocument(id); load(); } catch (e: unknown) { alert('删除失败: ' + (e instanceof Error ? e.message : String(e))); } };

  const handlePreview = async (id: string) => {
    const seq = ++previewSeqRef.current; // P1-15：仅最新预览写入
    setPreviewLoading(true);
    try {
      const data = await api.previewDocument(id);
      if (previewSeqRef.current !== seq) return; // 旧请求结果丢弃
      setPreview(data);
    } catch (e: unknown) {
      if (previewSeqRef.current !== seq) return;
      alert('预览加载失败: ' + (e instanceof Error ? e.message : String(e)));
    }
    if (previewSeqRef.current === seq) setPreviewLoading(false);
  };

  const handleRename = async (id: string, currentName: string) => {
    const newName = prompt('重命名:', currentName);
    if (!newName || newName === currentName) return;
    try { await api.updateDocument(id, { name: newName }); load(); } catch (e: unknown) { alert('重命名失败: ' + (e instanceof Error ? e.message : String(e))); }
  };

  return (
    <>
    <div className="min-h-screen" style={{ background: 'var(--bg-base)', backgroundImage: 'var(--bg-gradient)' }}>
    <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '0 24px' }}>
      <PageHeader title="Document Lab" description="AI 生成 PPT 和文档" icon={<FileText size={22} />} color="var(--color-success)"
        action={<button className="btn btn-primary" onClick={() => setShowForm(!showForm)}><Plus size={18} /> 新建文档</button>}
      />

      {showForm && (
        <motion.div
          className="glass-card mb-6"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
        >
          <h2 className="font-semibold mb-4" style={{ fontSize: 'var(--font-module-title)', color: 'var(--text-primary)' }}>
            生成新文档
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block mb-2" style={{ fontSize: 'var(--font-sm)', fontWeight: 500, color: 'var(--text-secondary)' }}>
                类型
              </label>
              <select className="input select" value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value as 'ppt' | 'doc' }))}>
                <option value="ppt">PPT 演示文稿</option>
                <option value="doc">Word 文档</option>
              </select>
            </div>
            <div>
              <label className="block mb-2" style={{ fontSize: 'var(--font-sm)', fontWeight: 500, color: 'var(--text-secondary)' }}>
                标题
              </label>
              <input
                className="input"
                value={form.title}
                onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                placeholder="文档标题"
              />
            </div>
          </div>

          <div className="mt-4">
            <label className="block mb-2" style={{ fontSize: 'var(--font-sm)', fontWeight: 500, color: 'var(--text-secondary)' }}>
              内容描述
            </label>
            <textarea
              className="input textarea"
              rows={4}
              value={form.content}
              onChange={e => setForm(f => ({ ...f, content: e.target.value }))}
              placeholder="描述文档内容或大纲...（留空将由 AI 根据标题自动生成）"
            />
          </div>

          <div className="flex gap-3 mt-5">
            <button className="btn btn-primary" onClick={handleGenerate} disabled={generating}>
              {generating ? '生成中...' : '生成文档'}
            </button>
            <button className="btn btn-ghost" onClick={() => setShowForm(false)}>取消</button>
          </div>

          {aiStatus && (
            <p className="mt-4" style={{ fontSize: 'var(--font-sm)', color: 'var(--color-success)' }}>
              {aiStatus}
            </p>
          )}
        </motion.div>
      )}

      {/* P1-19 修复：渲染 loading/error 三态，之前声明了但从未在 JSX 中使用 */}
      {loading && (
        <div className="glass-card flex items-center justify-center py-12">
          <div className="spinner" />
        </div>
      )}
      {error && !loading && (
        <div className="glass-card" style={{ padding: 24, textAlign: 'center' }}>
          <p style={{ color: 'var(--color-danger)', marginBottom: 12 }}>{error}</p>
          <button className="btn btn-primary" onClick={load}>重试</button>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {docs.map((doc, i) => (
          <motion.div
            key={doc.id}
            className="glass-card"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05 }}
          >
            <div className="flex items-center justify-between mb-3">
              <div
                className="p-2 rounded-[14px]"
                style={{
                  background: doc.type === 'ppt' ? 'rgba(251, 191, 36, 0.15)' : 'rgba(52, 211, 153, 0.15)',
                  color: doc.type === 'ppt' ? 'var(--color-warning)' : 'var(--color-success)',
                }}
              >
                {doc.type === 'ppt' ? <Presentation size={18} /> : <FileText size={18} />}
              </div>
              <div className="flex items-center gap-1">
                <button onClick={() => handlePreview(doc.id)} className="flex items-center justify-center w-8 h-8 rounded-lg transition-all hover:bg-white/[0.06]" style={{ color: 'var(--text-tertiary)' }} title="网页预览"><Eye size={14} /></button>
                <button onClick={() => window.open(api.documentDownloadUrl(doc.id), '_blank')} className="flex items-center justify-center w-8 h-8 rounded-lg transition-all hover:bg-white/[0.06]" style={{ color: 'var(--text-tertiary)' }} title="下载文件"><Download size={14} /></button>
                <button onClick={() => handleRename(doc.id, doc.name)} className="flex items-center justify-center w-8 h-8 rounded-lg transition-all hover:bg-white/[0.06]" style={{ color: 'var(--text-tertiary)' }} title="重命名"><Edit3 size={14} /></button>
                <button onClick={() => handleDelete(doc.id)} className="flex items-center justify-center w-8 h-8 rounded-lg transition-all hover:bg-white/[0.06]" style={{ color: 'var(--text-tertiary)' }} onMouseEnter={e => e.currentTarget.style.color = 'var(--color-danger)'} onMouseLeave={e => e.currentTarget.style.color = 'var(--text-tertiary)'} title="删除"><Trash2 size={14} /></button>
              </div>
            </div>
            <h3 className="font-semibold mb-1" style={{ fontSize: 'var(--font-card-title)', color: 'var(--text-primary)' }}>
              {doc.name}
            </h3>
            <p style={{ fontSize: 'var(--font-sm)', color: 'var(--text-tertiary)' }}>
              {doc.type.toUpperCase()} · {doc.status}
            </p>
          </motion.div>
        ))}

        {docs.length === 0 && (
          <div className="glass-card col-span-3 empty-state">
            <FileText size={40} className="empty-state-icon" />
            <div className="empty-state-title">还没有文档</div>
            <div className="empty-state-desc">点击「新建文档」开始创建</div>
          </div>
        )}
      </div>
    </div>
    </div>

    {/* 预览弹窗 */}
    {preview && (
      <>
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-md" onClick={() => setPreview(null)} />
        <div className="fixed inset-0 z-50 pointer-events-none flex items-center justify-center">
          <motion.div className="glass-card pointer-events-auto" style={{
            maxWidth: '48rem', width: '100%', margin: '0 1rem',
            maxHeight: '85vh', display: 'flex', flexDirection: 'column',
            clipPath: 'none',
          }} initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}>
            <div className="flex items-center justify-between mb-4 flex-shrink-0">
              <div>
                <h3 style={{ fontSize: 'var(--font-card-title)', fontWeight: 600, color: 'var(--text-primary)' }}>{preview.name}</h3>
                <span className="badge mt-1">{preview.type === 'ppt' ? 'PPT 演示文稿' : 'Word 文档'}</span>
              </div>
              <button className="btn btn-ghost" style={{ width: 36, height: 36, padding: 0 }} onClick={() => setPreview(null)}><X size={18} /></button>
            </div>
            <div className="flex-1 overflow-y-auto" style={{ minHeight: 200 }}>
              {previewLoading ? (
                <div className="text-center py-12" style={{ color: 'var(--text-tertiary)' }}>加载中...</div>
              ) : preview.slides && preview.slides.length > 0 ? (
                <div className="space-y-4">
                  {preview.slides.map((slide, i) => (
                    <div key={i} className="rounded-lg p-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-primary)' }}>
                      <h4 style={{ fontSize: 'var(--font-base)', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>幻灯片 {i + 1}: {slide.title}</h4>
                      <p style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{slide.content}</p>
                    </div>
                  ))}
                </div>
              ) : preview.sections && preview.sections.length > 0 ? (
                <div className="space-y-4">
                  {preview.sections.map((sec, i) => (
                    <div key={i} className="rounded-lg p-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-primary)' }}>
                      <h4 style={{ fontSize: 'var(--font-base)', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>{sec.heading}</h4>
                      <p style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{sec.body}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-12" style={{ color: 'var(--text-tertiary)' }}>
                  <p style={{ fontSize: 'var(--font-base)', marginBottom: 8 }}>该文档暂无预览数据</p>
                  <p style={{ fontSize: 'var(--font-sm)' }}>请重新生成文档以启用预览功能</p>
                </div>
              )}
            </div>
            <div className="flex gap-3 mt-4 pt-4 flex-shrink-0" style={{ borderTop: '1px solid var(--border-primary)' }}>
              <button className="btn btn-primary" onClick={() => window.open(api.documentDownloadUrl(preview.id), '_blank')}>
                <Download size={16} /> 下载文件
              </button>
              <button className="btn btn-ghost" onClick={() => setPreview(null)}>关闭</button>
            </div>
          </motion.div>
        </div>
      </>
    )}
    </>
  );
}
