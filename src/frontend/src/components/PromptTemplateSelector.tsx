import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Bookmark, FileText, Plus, Trash2, Pencil, X, Loader2 } from 'lucide-react';
import { confirm as confirmDialog } from './ui/confirm-dialog';
import { api } from '../api/client';

// 提示词模板 — 后端 API 持久化 + localStorage 回退 CRUD
export interface PromptTemplate {
  id: string;
  name: string;
  content: string;
  createdAt: string;
}

const STORAGE_KEY = 'prompt_templates';

async function loadTemplates(): Promise<PromptTemplate[]> {
  try {
    return await api.getPromptTemplates();
  } catch {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
}

async function saveTemplate(tpl: PromptTemplate): Promise<void> {
  try {
    if (tpl.id.startsWith('tpl-')) {
      await api.createPromptTemplate({ name: tpl.name, content: tpl.content });
    } else {
      await api.updatePromptTemplate(tpl.id, { name: tpl.name, content: tpl.content });
    }
  } catch {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify([tpl])); } catch { /* ignore */ }
  }
}

async function deleteTemplate(id: string): Promise<void> {
  try {
    await api.deletePromptTemplate(id);
  } catch {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }
}

interface PromptTemplateSelectorProps {
  open: boolean;
  onClose: () => void;
  onSelect: (content: string) => void;
  currentInput?: string;
}

export function PromptTemplateSelector({ open, onClose, onSelect, currentInput = '' }: PromptTemplateSelectorProps) {
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false); // P1-15：保存防连点
  const [name, setName] = useState('');
  const [content, setContent] = useState('');

  // 打开时从后端 API 加载模板，重置表单状态
  useEffect(() => {
    if (open) {
      loadTemplates().then(setTemplates);
      setShowSaveForm(false);
      setEditingId(null);
      setName('');
      setContent('');
    }
  }, [open]);

  const persist = async (next: PromptTemplate[]) => {
    setTemplates(next);
    // 审计修复：去掉 slice(0,5) 截断，同步全部本地新建模板到后端
    for (const tpl of next) {
      if (tpl.id.startsWith('tpl-')) {
        try { await api.createPromptTemplate({ name: tpl.name, content: tpl.content }); } catch (e) { console.warn('模板保存失败:', e instanceof Error ? e.message : e); }
      }
    }
  };

  const handleSaveNew = async () => {
    const trimmedName = name.trim();
    const trimmedContent = content.trim();
    if (!trimmedName || !trimmedContent) return;
    if (saving) return; // P1-15：防连点
    setSaving(true);
    try {
      const saved = await api.createPromptTemplate({ name: trimmedName, content: trimmedContent });
      setTemplates(prev => [...prev, saved]);
    } catch {
      const tpl: PromptTemplate = {
        id: `tpl-${Date.now()}`,
        name: trimmedName,
        content: trimmedContent,
        createdAt: new Date().toISOString(),
      };
      setTemplates(prev => [...prev, tpl]);
    }
    setName('');
    setContent('');
    setShowSaveForm(false);
    setSaving(false);
  };

  const handleUpdate = async (id: string) => {
    const trimmedName = name.trim();
    const trimmedContent = content.trim();
    if (!trimmedName || !trimmedContent) return;
    if (saving) return; // P1-15：防连点
    setSaving(true);
    try {
      await api.updatePromptTemplate(id, { name: trimmedName, content: trimmedContent });
    } catch { /* ignore */ }
    setTemplates(prev => prev.map(t => (t.id === id ? { ...t, name: trimmedName, content: trimmedContent } : t)));
    setEditingId(null);
    setSaving(false);
  };

  const handleDelete = async (id: string) => {
    if (await confirmDialog({ title: '删除模板', message: '确定删除此模板？', confirmText: '删除', variant: 'danger' })) {
      try { await api.deletePromptTemplate(id); } catch { /* ignore */ }
      setTemplates(prev => prev.filter(t => t.id !== id));
    }
  };

  const startEdit = (tpl: PromptTemplate) => {
    setEditingId(tpl.id);
    setName(tpl.name);
    setContent(tpl.content);
  };

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: 'var(--z-modal-backdrop, 1600)', background: 'rgba(0,0,0,0.5)' }}
      onClick={onClose}
    >
      <div
        className="glass-card rounded-2xl w-full max-w-lg mx-4 flex flex-col"
        style={{ background: 'var(--bg-base, #1a1a2e)', maxHeight: '70vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between p-5 pb-3">
          <h3 className="text-lg font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <Bookmark size={18} style={{ color: 'var(--color-accent)' }} /> 提示词模板
          </h3>
          <button
            onClick={onClose}
            className="flex items-center justify-center w-8 h-8 rounded-lg hover:bg-white/[0.08]"
            style={{ color: 'var(--text-tertiary)' }}
            title="关闭"
          >
            <X size={16} />
          </button>
        </div>

        {/* 新建模板表单 */}
        {showSaveForm && (
          <div className="mx-5 mb-3 p-3 rounded-xl" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-primary)' }}>
            <input
              className="input mb-2"
              placeholder="模板名称"
              value={name}
              onChange={e => setName(e.target.value)}
              autoFocus
            />
            <textarea
              className="input w-full mb-2"
              placeholder="模板内容"
              value={content}
              onChange={e => setContent(e.target.value)}
              rows={3}
              style={{ resize: 'vertical' }}
            />
            <div className="flex gap-2 justify-end">
              <button className="btn btn-ghost" onClick={() => setShowSaveForm(false)}>取消</button>
              <button className="btn btn-primary" onClick={handleSaveNew} disabled={!name.trim() || !content.trim() || saving}>保存</button>
            </div>
          </div>
        )}

        {/* 模板列表 */}
        <div className="flex-1 overflow-y-auto min-h-0 px-5 pb-3" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {templates.length === 0 && !showSaveForm && (
            <div className="empty-state py-8">
              <FileText size={28} className="empty-state-icon" />
              <div className="empty-state-title">暂无模板</div>
              <div className="empty-state-desc">保存常用提示词，一键复用</div>
            </div>
          )}
          {templates.map(tpl =>
            editingId === tpl.id ? (
              <div key={tpl.id} className="p-3 rounded-xl" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-primary)' }}>
                <input
                  className="input mb-2"
                  placeholder="模板名称"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  autoFocus
                />
                <textarea
                  className="input w-full mb-2"
                  placeholder="模板内容"
                  value={content}
                  onChange={e => setContent(e.target.value)}
                  rows={3}
                  style={{ resize: 'vertical' }}
                />
                <div className="flex gap-2 justify-end">
                  <button className="btn btn-ghost" onClick={() => setEditingId(null)}>取消</button>
                  <button className="btn btn-primary" onClick={() => handleUpdate(tpl.id)} disabled={!name.trim() || !content.trim() || saving}>保存</button>
                </div>
              </div>
            ) : (
              <div
                key={tpl.id}
                className="group rounded-xl p-3 cursor-pointer transition-colors hover:bg-white/[0.06]"
                style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-primary)' }}
                onClick={() => { onSelect(tpl.content); onClose(); }}
                title="点击使用此模板"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate" style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{tpl.name}</div>
                    <div className="mt-0.5 truncate" style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>{tpl.content}</div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      className="flex items-center justify-center w-7 h-7 rounded-lg hover:bg-white/[0.08]"
                      style={{ color: 'var(--text-secondary)' }}
                      title="编辑"
                      onClick={(e) => { e.stopPropagation(); startEdit(tpl); }}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      className="flex items-center justify-center w-7 h-7 rounded-lg hover:bg-white/[0.08]"
                      style={{ color: 'var(--color-danger)' }}
                      title="删除"
                      onClick={(e) => { e.stopPropagation(); handleDelete(tpl.id); }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              </div>
            )
          )}
        </div>

        {/* 底部 — 保存当前输入为模板 */}
        <div className="p-5 pt-3 border-t" style={{ borderColor: 'var(--border-primary)' }}>
          <button
            className="btn btn-primary w-full"
            onClick={() => { setShowSaveForm(true); setEditingId(null); setName(''); setContent(currentInput); }}
          >
            <Plus size={16} /> 保存当前输入为模板
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}