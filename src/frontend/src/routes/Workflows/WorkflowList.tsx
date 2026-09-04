import { useState, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { PageHeader } from '../../components/PageHeader';
import { confirm as confirmDialog } from '../../components/ui/confirm-dialog';
import { api } from '../../api/client';
import { Workflow as WorkflowIcon, Play, Save, Plus, Trash, Bot, FileText, Loader2, ChevronLeft, X } from 'lucide-react';
import type { Workflow } from './types';
import { NodePalette } from './NodePalette';
import { uid } from './constants';

interface WorkflowListProps {
  workflows: Workflow[];
  loading: boolean;
  error: string | null;
  newName: string;
  setNewName: (name: string) => void;
  creating: boolean;
  showAiPanel: boolean;
  setShowAiPanel: (show: boolean) => void;
  aiPrompt: string;
  setAiPrompt: (prompt: string) => void;
  aiCreating: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onCreate: () => Promise<void>;
  onAiCreate: () => Promise<void>;
  onImportFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onOpenEditor: (wf: Workflow) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onRunDirect: (wf: Workflow) => Promise<void>;
  onExport: (wf: Workflow) => void;
}

export function WorkflowList({
  workflows, loading, error, newName, setNewName, creating,
  showAiPanel, setShowAiPanel, aiPrompt, setAiPrompt, aiCreating,
  fileInputRef, onCreate, onAiCreate, onImportFile,
  onOpenEditor, onDelete, onRunDirect, onExport
}: WorkflowListProps) {
  const dragIndex = useRef<number | null>(null);

  return (
    <div>
      <PageHeader
        title="工作流"
        description="可视化编排 AI 工作流：拖拽节点、连接、配置、一键运行"
        icon={<WorkflowIcon size={22} />}
        color="var(--color-accent)"
        action={
          <div className="flex items-center gap-2 flex-wrap">
            <input
              className="input"
              style={{ width: 180 }}
              placeholder="新工作流名称…"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') onCreate(); }}
            />
            <button className="btn btn-primary" onClick={onCreate} disabled={creating}>
              {creating ? <Loader2 size={16} className="spin" /> : <Plus size={16} />} 新建
            </button>
            <button className="btn btn-secondary" onClick={() => setShowAiPanel(!showAiPanel)} title="AI 辅助创建工作流">
              <Bot size={16} /> AI 创建
            </button>
            <input ref={fileInputRef} type="file" accept=".json" style={{ display: 'none' }} onChange={onImportFile} />
            <button className="btn btn-secondary" onClick={() => fileInputRef.current?.click()} title="导入 JSON 工作流文件">
              <FileText size={16} /> 导入
            </button>
          </div>
        }
      />
      {showAiPanel && (
        <div className="glass-card" style={{ marginBottom: 16, padding: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <Bot size={20} style={{ color: '#a78bfa' }} />
            <h3 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>AI 辅助创建工作流</h3>
            <button onClick={() => setShowAiPanel(false)} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)' }}>
              <X size={16} />
            </button>
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 12 }}>
            用自然语言描述你想实现的功能，AI 会自动生成工作流节点和连接。例如：「读取一个文件，用 AI 分析内容，然后生成一份 PPT」
          </p>
          <div style={{ display: 'flex', gap: 12 }}>
            <textarea
              className="input"
              style={{ flex: 1, minHeight: 80, resize: 'vertical' }}
              placeholder="描述你想做的工作流…"
              value={aiPrompt}
              onChange={e => setAiPrompt(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onAiCreate(); }}
            />
            <button className="btn btn-primary" onClick={onAiCreate} disabled={aiCreating || !aiPrompt.trim()} style={{ flexShrink: 0 }}>
              {aiCreating ? <><Loader2 size={16} className="spin" /> 生成中…</> : <><Bot size={16} /> 生成</>}
            </button>
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 8 }}>
            提示：Ctrl+Enter 快速生成
          </p>
        </div>
      )}
      {error && (
        <div className="glass-card" style={{ marginBottom: 16, padding: 12, color: 'var(--color-danger)', fontSize: 13 }}>
          {error}
        </div>
      )}
      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><div className="spinner" /></div>
      ) : workflows.length === 0 ? (
        <div className="glass-card" style={{ textAlign: 'center', padding: 64 }}>
          <WorkflowIcon size={40} style={{ color: 'var(--text-tertiary)', marginBottom: 12 }} />
          <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>还没有工作流，点击右上角创建一个吧</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
          <AnimatePresence>
            {workflows.map((wf) => (
              <motion.div
                key={wf.id}
                layout
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="glass-card"
                style={{ cursor: 'pointer', padding: 20 }}
                onClick={() => onOpenEditor(wf)}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{
                      width: 34, height: 34, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: 'linear-gradient(135deg, var(--color-accent), var(--color-accent)cc)', color: '#fff',
                    }}>
                      <WorkflowIcon size={17} />
                    </div>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>{wf.name}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                        {wf.nodes.length} 节点 · {wf.edges.length} 连接 · {wf.trigger}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button
                      className="btn btn-ghost"
                      style={{ padding: 6 }}
                      onClick={async (e) => {
                        e.stopPropagation();
                        try {
                          const result = await api.runWorkflow(wf.id, {});
                          if (result.status === 'completed') {
                            try { const { sendNotification } = await import('../../lib/notifications'); sendNotification('✅ 工作流运行完成', { body: `${wf.name} 执行成功` }); } catch { /* ignore */ }
                          } else {
                            alert(`${wf.name} 运行${result.status === 'failed' ? '失败' : '完成'}: ${result.error || ''}`);
                          }
                        } catch (err: unknown) {
                          alert('运行失败: ' + (err instanceof Error ? err.message : String(err)));
                        }
                      }}
                      title="直接运行"
                    >
                      <Play size={14} style={{ color: 'var(--color-success)' }} />
                    </button>
                    <button
                      className="btn btn-ghost"
                      style={{ padding: 6 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        const blob = new Blob([JSON.stringify(wf, null, 2)], { type: 'application/json' });
                        const a = document.createElement('a');
                        a.href = URL.createObjectURL(blob);
                        a.download = `${wf.name}.json`;
                        a.click();
                      }}
                      title="导出 JSON"
                    >
                      <FileText size={14} style={{ color: 'var(--text-tertiary)' }} />
                    </button>
                    <button
                      className="btn btn-ghost"
                      style={{ padding: 6 }}
                      onClick={(e) => { e.stopPropagation(); onDelete(wf.id); }}
                      title="删除"
                    >
                      <Trash size={14} style={{ color: 'var(--color-danger)' }} />
                    </button>
                  </div>
                </div>
                {wf.description && (
                  <p style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {wf.description}
                  </p>
                )}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}