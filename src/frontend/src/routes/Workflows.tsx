import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api/client';
import { confirm as confirmDialog } from '../components/ui/confirm-dialog';
import type { Workflow, FlowNode, FlowEdge, RunRecord, NodeType } from './Workflows/types';
import { WorkflowList } from './Workflows/WorkflowList';
import { WorkflowEditor } from './Workflows/WorkflowEditor';
import { NODE_META, PALETTE, uid } from './Workflows/constants';

export function Workflows() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Workflow | null>(null);
  const [dirty, setDirty] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [connectingFrom, setConnectingFrom] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<RunRecord | null>(null);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [showRuns, setShowRuns] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [aiCreating, setAiCreating] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [showAiPanel, setShowAiPanel] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragIndex = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const list = await api.getWorkflows();
      setWorkflows(list);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const loadRuns = useCallback(async (id: string) => {
    try {
      setRuns(await api.getWorkflowRuns(id));
    } catch { /* 忽略历史加载失败 */ }
  }, []);

  const openEditor = async (wf: Workflow) => {
    try {
      const fresh = await api.getWorkflow(wf.id);
      setEditing(fresh);
      setSelectedNodeId(null);
      setConnectingFrom(null);
      setRunResult(null);
      setDirty(false);
      setShowRuns(false);
      loadRuns(fresh.id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '打开失败');
    }
  };

  const handleCreate = async () => {
    if (!newName.trim()) {
      setError('请输入工作流名称');
      return;
    }
    try {
      setCreating(true);
      const wf = await api.createWorkflow({ name: newName.trim(), description: '', nodes: [], edges: [], trigger: 'manual' });
      setNewName('');
      await load();
      await openEditor(wf);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '创建失败');
    } finally {
      setCreating(false);
    }
  };

  // AI 辅助创建：用户描述需求 → AI 生成完整工作流
  const handleAiCreate = async () => {
    if (!aiPrompt.trim()) {
      setError('请描述你想做的工作流');
      return;
    }
    try {
      setAiCreating(true);
      setError(null);
      const wf = await api.aiCreateWorkflow({ description: aiPrompt.trim() });
      setAiPrompt('');
      setShowAiPanel(false);
      await load();
      await openEditor(wf);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'AI 创建失败');
    } finally {
      setAiCreating(false);
    }
  };

  // 导入工作流 JSON 文件
  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string);
        if (!data.name || !Array.isArray(data.nodes)) {
          setError('文件格式不正确：需要 name 和 nodes 字段');
          return;
        }
        const wf = await api.createWorkflow({
          name: data.name,
          description: data.description || '',
          nodes: data.nodes,
          edges: data.edges || [],
          trigger: data.trigger || 'manual',
        });
        await load();
        await openEditor(wf);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : '导入失败');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleDelete = async (id: string) => {
    if (!(await confirmDialog('确定删除该工作流？此操作不可恢复。'))) return;
    try {
      await api.deleteWorkflow(id);
      if (editing?.id === id) setEditing(null);
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '删除失败');
    }
  };

  // ---- 编辑器操作 ----

  const patch = (fn: (wf: Workflow) => Workflow) => {
    setEditing(prev => {
      if (!prev) return prev;
      const next = fn(prev);
      setDirty(true);
      return next;
    });
  };

  const addNode = (type: NodeType) => {
    patch(wf => ({
      ...wf,
      nodes: [...wf.nodes, { id: uid(), type, label: NODE_META[type].label, config: {} }],
    }));
  };

  const updateNode = (id: string, fn: (n: FlowNode) => FlowNode) => {
    patch(wf => ({ ...wf, nodes: wf.nodes.map(n => n.id === id ? fn(n) : n) }));
  };

  const removeNode = (id: string) => {
    patch(wf => ({
      ...wf,
      nodes: wf.nodes.filter(n => n.id !== id),
      edges: wf.edges.filter(e => e.source !== id && e.target !== id),
    }));
    setSelectedNodeId(prev => prev === id ? null : prev);
  };

  const toggleEdge = (targetId: string) => {
    if (!connectingFrom || connectingFrom === targetId) return;
    patch(wf => {
      const existing = wf.edges.find(e => e.source === connectingFrom && e.target === targetId);
      return {
        ...wf,
        edges: existing
          ? wf.edges.filter(e => e.id !== existing.id)
          : [...wf.edges, { id: uid(), source: connectingFrom, target: targetId }],
      };
    });
    setConnectingFrom(null);
  };

  const handleSave = async () => {
    if (!editing) return;
    try {
      setSaving(true);
      const saved = await api.updateWorkflow(editing.id, {
        name: editing.name,
        description: editing.description,
        nodes: editing.nodes,
        edges: editing.edges,
        trigger: editing.trigger,
      });
      setEditing(saved);
      setDirty(false);
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleRun = async () => {
    if (!editing) return;
    try {
      setRunning(true);
      setRunResult(null);
      // 如果有未保存的修改，先保存再运行
      if (dirty) {
        await handleSave();
      }
      // 重新从后端获取最新工作流数据，确保运行的是已保存版本
      const fresh = await api.getWorkflow(editing.id);
      setEditing(fresh);
      const result = await api.runWorkflow(editing.id, {});
      setRunResult(result);
      loadRuns(editing.id);
      // 运行完成通知
      if (result.status === 'completed') {
        try { const { sendNotification } = await import('../lib/notifications'); sendNotification('✅ 工作流运行完成', { body: `${editing.name} - ${Object.keys(result.results || {}).length} 个节点执行成功` }); } catch { /* ignore */ }
      } else if (result.status === 'failed') {
        try { const { sendNotification } = await import('../lib/notifications'); sendNotification('❌ 工作流运行失败', { body: result.error || '未知错误', always: true }); } catch { /* ignore */ }
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '执行失败');
    } finally {
      setRunning(false);
    }
  };

  if (!editing) {
    return (
      <WorkflowList
        workflows={workflows}
        loading={loading}
        error={error}
        newName={newName}
        setNewName={setNewName}
        creating={creating}
        showAiPanel={showAiPanel}
        setShowAiPanel={setShowAiPanel}
        aiPrompt={aiPrompt}
        setAiPrompt={setAiPrompt}
        aiCreating={aiCreating}
        fileInputRef={fileInputRef}
        onCreate={handleCreate}
        onAiCreate={handleAiCreate}
        onImportFile={handleImportFile}
        onOpenEditor={openEditor}
        onDelete={handleDelete}
        onRunDirect={async (wf) => {
          try {
            const result = await api.runWorkflow(wf.id, {});
            if (result.status === 'completed') {
              try { const { sendNotification } = await import('../lib/notifications'); sendNotification('✅ 工作流运行完成', { body: `${wf.name} 执行成功` }); } catch { /* ignore */ }
            } else {
              alert(`${wf.name} 运行${result.status === 'failed' ? '失败' : '完成'}: ${result.error || ''}`);
            }
          } catch (err: unknown) {
            alert('运行失败: ' + (err instanceof Error ? err.message : String(err)));
          }
        }}
        onExport={(wf) => {
          const blob = new Blob([JSON.stringify(wf, null, 2)], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `${wf.name}.json`;
          a.click();
        }}
      />
    );
  }

  return (
    <WorkflowEditor
      editing={editing}
      dirty={dirty}
      saving={saving}
      running={running}
      runResult={runResult}
      runs={runs}
      showRuns={showRuns}
      error={error}
      selectedNodeId={selectedNodeId}
      connectingFrom={connectingFrom}
      dragIndex={dragIndex}
      onBack={() => setEditing(null)}
      onToggleRuns={() => setShowRuns(v => !v)}
      onSave={handleSave}
      onRun={handleRun}
      onSelectNode={setSelectedNodeId}
      onConnectingFrom={setConnectingFrom}
      onToggleEdge={toggleEdge}
      onRemoveNode={removeNode}
      onAddNode={addNode}
      onDrop={(e) => {
        e.preventDefault();
        const type = e.dataTransfer.getData('application/node-type') as NodeType;
        if (type && NODE_META[type]) addNode(type);
      }}
      onNodeDrop={(e, targetIndex) => {
        e.preventDefault();
        e.stopPropagation();
        const from = dragIndex.current;
        dragIndex.current = null;
        if (from === null || from === targetIndex) return;
        patch(wf => {
          const nodes = [...wf.nodes];
          const [moved] = nodes.splice(from, 1);
          nodes.splice(targetIndex, 0, moved);
          return { ...wf, nodes };
        });
      }}
      onCloseRunResult={() => setRunResult(null)}
      onCloseRuns={() => setShowRuns(false)}
      onSelectRun={setRunResult}
      loadRuns={loadRuns}
    />
  );
}