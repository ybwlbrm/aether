import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { PageHeader } from '../components/PageHeader';
import { api } from '../api/client';
import { FolderKanban, Plus, Trash2, Play, ExternalLink, Terminal, Globe, X, Eye, Edit3, FileCode, FileText, FileType } from 'lucide-react';
import { confirm as confirmDialog } from '../components/ui/confirm-dialog';

interface ProjectItem {
  id: string; name: string; type: 'url' | 'bat' | 'command' | 'html' | 'py'; target: string;
  category?: string; description?: string; createdAt: string; lastAccessed?: string;
}

const TYPE_LABELS: Record<string, string> = {
  url: 'URL',
  bat: '脚本',
  command: '命令',
  html: 'HTML',
  py: 'Python',
};

export function Projects() {
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [creating, setCreating] = useState(false); // P1-15：创建防连点
  const [form, setForm] = useState({ name: '', type: 'url' as 'url' | 'bat' | 'command' | 'html' | 'py', target: '', category: '', description: '' });
  const [execOutput, setExecOutput] = useState<string | null>(null);
  const [executingId, setExecutingId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectItem | null>(null);
  // P1-14: 三态
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true); setError(null);
    api.getProjects().then(setProjects).catch((e) => setError((e instanceof Error ? e.message : String(e)) || '加载失败')).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    // P1-15 修复：表单必填校验 + 防连点
    if (!form.name.trim() || !form.target.trim()) { alert('项目名称和目标不能为空'); return; }
    if (creating) return;
    setCreating(true);
    try { await api.createProject(form); setShowForm(false); setForm({ name: '', type: 'url', target: '', category: '', description: '' }); load(); } catch (e: unknown) { alert('创建失败: ' + (e instanceof Error ? e.message : String(e))); }
    setCreating(false);
  };

  const handleDelete = async (id: string) => {
    if (await confirmDialog('确定删除？')) {
      try { await api.deleteProject(id); load(); } catch (e: unknown) { alert('删除失败: ' + (e instanceof Error ? e.message : String(e))); }
    }
  };

  const handleRename = async (id: string, currentName: string) => {
    const newName = prompt('重命名:', currentName);
    if (!newName || newName === currentName) return;
    try { await api.updateProject(id, { name: newName }); load(); } catch (e: unknown) { alert('重命名失败: ' + (e instanceof Error ? e.message : String(e))); }
  };

  const handleExec = async (p: ProjectItem) => {
    if (p.type === 'url') {
      window.open(p.target, '_blank');
      return;
    }
    if (p.type === 'bat' || p.type === 'html') {
      // bat/html 类型：直接启动，不显示输出弹窗
      try {
        await api.execProject({ type: p.type, target: p.target });
      } catch (e: unknown) {
        alert('启动失败: ' + (e instanceof Error ? e.message : String(e)));
      }
      return;
    }
    // command 类型：显示执行输出
    setExecutingId(p.id);
    setExecOutput(null);
    try {
      const result = await api.execProject({ type: p.type, target: p.target });
      if (result.error) {
        setExecOutput(`❌ ${result.error}`);
      } else {
        setExecOutput(result.stdout || result.stderr || '(no output)');
      }
    } catch (e: unknown) {
      setExecOutput(`❌ ${(e instanceof Error ? e.message : String(e))}`);
    }
    setExecutingId(null);
  };

  const typeColor = (t: string) => t === 'url' ? 'var(--color-accent)' : t === 'command' ? 'var(--color-success)' : t === 'html' ? 'var(--color-danger)' : t === 'py' ? '#a78bfa' : 'var(--color-warning)';
  const typeBg = (t: string) => t === 'url' ? 'rgba(94,158,255,0.12)' : t === 'command' ? 'rgba(52,211,153,0.12)' : t === 'html' ? 'rgba(248,113,113,0.12)' : t === 'py' ? 'rgba(167,139,250,0.12)' : 'rgba(251,191,36,0.12)';
  const typeIcon = (t: string) => t === 'url' ? <Globe size={18} /> : t === 'command' ? <Terminal size={18} /> : t === 'html' ? <FileType size={18} /> : t === 'py' ? <FileText size={18} /> : <FileCode size={18} />;

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)', backgroundImage: 'var(--bg-gradient)' }}>
    <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '0 24px' }}>
      <PageHeader title="Projects" description="项目管理 · URL / 脚本 / 命令执行" icon={<FolderKanban size={22} />} color="var(--color-danger)"
        action={<button className="btn btn-primary" onClick={() => setShowForm(!showForm)}><Plus size={18} /> New Project</button>}
      />

      {showForm && (
        <motion.div className="glass-card" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <h2 style={{ fontSize: 'var(--font-module-title)', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 'var(--space-6)' }}>
            New Project
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <div>
              <label className="block mb-2" style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)' }}>Name</label>
              <input className="input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Project name" />
            </div>
            <div>
              <label className="block mb-2" style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)' }}>Type</label>
              <select className="input select" value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value as any }))}>
                <option value="url">URL (Website)</option>
                <option value="command">Command (命令)</option>
                <option value="bat">BAT Script (脚本)</option>
                <option value="html">HTML File (网页文件)</option>
                <option value="py">Python File (.py)</option>
              </select>
            </div>
            <div className="md:col-span-2">
              <label className="block mb-2" style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)' }}>Target / Command</label>
              <input className="input" value={form.target} onChange={e => setForm(f => ({ ...f, target: e.target.value }))}
                placeholder={form.type === 'url' ? 'https://...' : form.type === 'command' ? 'e.g. echo Hello' : 'C:\\scripts\\run.bat'} />
            </div>
            <div>
              <label className="block mb-2" style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)' }}>Category (optional)</label>
              <input className="input" value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} placeholder="tools, scripts, etc." />
            </div>
            <div className="md:col-span-2">
              <label className="block mb-2" style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)' }}>Description (简介)</label>
              <textarea className="input textarea" rows={2} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="项目简介..." />
            </div>
          </div>
          <div className="flex gap-3 mt-8">
            <button className="btn btn-primary" onClick={handleCreate} disabled={creating}>{creating ? '保存中...' : 'Save'}</button>
            <button className="btn btn-ghost" onClick={() => setShowForm(false)}>Cancel</button>
          </div>
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

      <div className="glass-card">
        {projects.map((p, i) => (
          <motion.div key={p.id} className="list-row gap-4"
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
            <div className="flex items-center justify-center flex-shrink-0"
              style={{ width: 40, height: 40, borderRadius: 'var(--radius-md)', background: typeBg(p.type), color: typeColor(p.type) }}>
              {typeIcon(p.type)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate" style={{ fontSize: 'var(--font-base)', fontWeight: 500, color: 'var(--text-primary)' }}>{p.name}</span>
                <span style={{ fontSize: 'var(--font-sm)', color: 'var(--text-tertiary)', textTransform: 'uppercase' }}>{TYPE_LABELS[p.type] || p.type}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="truncate" style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)' }}>{p.target}</span>
                {p.category && <span className="tag flex-shrink-0">{p.category}</span>}
              </div>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              <button className="flex items-center justify-center w-8 h-8 rounded-lg transition-colors hover:bg-white/[0.06]"
                style={{ color: 'var(--text-tertiary)' }}
                onClick={() => handleExec(p)} title={p.type === 'url' ? 'Open' : 'Execute'}>
                {p.type !== 'url' && executingId === p.id ? <span className="spinner spinner-sm" /> : p.type === 'url' ? <ExternalLink size={18} /> : <Play size={18} />}
              </button>
              <button className="flex items-center justify-center w-8 h-8 rounded-lg transition-colors hover:bg-white/[0.06]" style={{ color: 'var(--text-tertiary)' }} onClick={() => setDetail(p)} title="查看详情"><Eye size={14} /></button>
              <button className="flex items-center justify-center w-8 h-8 rounded-lg transition-colors hover:bg-white/[0.06]" style={{ color: 'var(--text-tertiary)' }} onClick={() => handleRename(p.id, p.name)} title="重命名"><Edit3 size={14} /></button>
              <button className="flex items-center justify-center w-8 h-8 rounded-lg transition-colors hover:bg-white/[0.06]" style={{ color: 'var(--text-tertiary)' }} onClick={() => handleDelete(p.id)} title="Delete"><Trash2 size={14} /></button>
            </div>
          </motion.div>
        ))}
        {projects.length === 0 && (
          <div className="empty-state !py-16">
            <FolderKanban size={36} className="empty-state-icon" />
            <div className="empty-state-title">暂无项目</div>
            <div className="empty-state-desc">点击右上角添加</div>
          </div>
        )}
      </div>

      {/* Detail Modal */}
      {detail && (
        <>
          <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-md" onClick={() => setDetail(null)} />
          <div className="fixed inset-0 z-50 pointer-events-none flex items-center justify-center">
            <motion.div className="glass-card pointer-events-auto"
              style={{
                maxWidth: '28rem', width: '100%', margin: '0 1rem',
                clipPath: 'none',
              }}
              initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}>
              <div className="flex items-center justify-between mb-4">
                <h3 style={{ fontSize: 'var(--font-card-title)', fontWeight: 600, color: 'var(--text-primary)' }}>项目详情</h3>
                <button className="flex items-center justify-center w-8 h-8 rounded-lg transition-colors hover:bg-white/[0.06]"
                  style={{ color: 'var(--text-tertiary)' }} onClick={() => setDetail(null)}><X size={18} /></button>
              </div>
              <div className="space-y-3" style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)' }}>
                <div><span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>名称：</span>{detail.name}</div>
                <div><span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>类型：</span>{TYPE_LABELS[detail.type] || detail.type}</div>
                <div><span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>目标：</span><span style={{ wordBreak: 'break-all' }}>{detail.target}</span></div>
                {detail.category && <div><span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>分类：</span>{detail.category}</div>}
                {detail.description && <div><span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>简介：</span>{detail.description}</div>}
                <div><span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>创建时间：</span>{new Date(detail.createdAt).toLocaleString()}</div>
              </div>
              <div className="flex gap-3 mt-6">
                <button className="btn btn-primary flex-1" onClick={() => { const d = detail; setDetail(null); handleExec(d); }}>
                  {detail.type === 'url' ? '打开' : '执行'}
                </button>
                <button className="btn btn-ghost" onClick={() => setDetail(null)}>关闭</button>
              </div>
            </motion.div>
          </div>
        </>
      )}

      {/* Exec Output Modal */}
      {execOutput !== null && (
        <>
          <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-md" onClick={() => setExecOutput(null)} />
          <div className="fixed inset-0 z-50 pointer-events-none flex items-center justify-center">
            <motion.div className="glass-card pointer-events-auto"
              style={{
                maxWidth: '28rem', width: '100%', margin: '0 1rem',
                clipPath: 'none',
              }}
              initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}>
              <div className="flex items-center justify-between mb-4">
                <h3 style={{ fontSize: 'var(--font-card-title)', fontWeight: 600, color: 'var(--text-primary)' }}>Execution Output</h3>
                <button className="flex items-center justify-center w-8 h-8 rounded-lg transition-colors hover:bg-white/[0.06]"
                  style={{ color: 'var(--text-tertiary)' }} onClick={() => setExecOutput(null)}><X size={18} /></button>
              </div>
              <pre className="rounded-[14px] p-4 text-sm font-mono max-h-96 overflow-y-auto whitespace-pre-wrap"
                style={{ background: 'var(--input-bg)', color: 'var(--text-primary)' }}>{execOutput}</pre>
            </motion.div>
          </div>
        </>
      )}
    </div>
    </div>
  );
}