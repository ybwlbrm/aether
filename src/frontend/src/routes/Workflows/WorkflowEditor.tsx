import { useState, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import { PageHeader } from '../../components/PageHeader';
import { api } from '../../api/client';
import { Workflow as WorkflowIcon, Play, Save, ChevronLeft, History, Loader2, HelpCircle, Link2, GripVertical, Trash, X, CheckCircle2, AlertCircle, Sparkles } from 'lucide-react';
import type { Workflow, FlowNode, FlowEdge, NodeType, RunRecord } from './types';
import { NODE_META, PALETTE, uid } from './constants';
import { NodePalette } from './NodePalette';
import { NodeConfig } from './NodeConfig';
import { RunHistory, RunResultPanel } from './RunHistory';

interface WorkflowEditorProps {
  editing: Workflow;
  dirty: boolean;
  saving: boolean;
  running: boolean;
  runResult: RunRecord | null;
  runs: RunRecord[];
  showRuns: boolean;
  error: string | null;
  selectedNodeId: string | null;
  connectingFrom: string | null;
  dragIndex: React.MutableRefObject<number | null>;
  onBack: () => void;
  onToggleRuns: () => void;
  onSave: () => Promise<void>;
  onRun: () => Promise<void>;
  onSelectNode: (id: string) => void;
  onConnectingFrom: (id: string | null) => void;
  onToggleEdge: (targetId: string) => void;
  onRemoveNode: (id: string) => void;
  onAddNode: (type: NodeType) => void;
  onDrop: (e: React.DragEvent) => void;
  onNodeDrop: (e: React.DragEvent, targetIndex: number) => void;
  onCloseRunResult: () => void;
  onCloseRuns: () => void;
  onSelectRun: (run: RunRecord) => void;
  loadRuns: (id: string) => Promise<void>;
}

export function WorkflowEditor({
  editing, dirty, saving, running, runResult, runs, showRuns, error,
  selectedNodeId, connectingFrom, dragIndex,
  onBack, onToggleRuns, onSave, onRun,
  onSelectNode, onConnectingFrom, onToggleEdge, onRemoveNode, onAddNode,
  onDrop, onNodeDrop, onCloseRunResult, onCloseRuns, onSelectRun, loadRuns
}: WorkflowEditorProps) {
  const selectedNode = editing.nodes.find(n => n.id === selectedNodeId) || null;

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('application/node-type') as NodeType;
    if (type && NODE_META[type]) onAddNode(type);
  };

  const handleNodeDrop = (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
    e.stopPropagation();
    const from = dragIndex.current;
    dragIndex.current = null;
    if (from === null || from === targetIndex) return;
    onNodeDrop(e, targetIndex);
  };

  return (
    <div>
      <PageHeader
        title={editing.name || '未命名工作流'}
        description={`${editing.nodes.length} 节点 · ${editing.edges.length} 连接 · 触发器: ${editing.trigger}`}
        icon={<WorkflowIcon size={22} />}
        color="var(--color-accent)"
        action={
          <div className="flex items-center gap-3">
            <button className="btn btn-secondary" onClick={onBack}>
              <ChevronLeft size={16} /> 返回
            </button>
            <button className="btn btn-secondary" onClick={onToggleRuns}>
              <History size={16} /> 运行记录
            </button>
            <button className="btn btn-primary" onClick={onSave} disabled={saving || !dirty}>
              {saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />} 保存
            </button>
            <button className="btn btn-primary" onClick={onRun} disabled={running || editing.nodes.length === 0}>
              {running ? <Loader2 size={16} className="spin" /> : <Play size={16} />} 运行
            </button>
          </div>
        }
      />

      {/* 使用说明面板（可折叠） */}
      <details className="glass-card" style={{ marginBottom: 16, padding: '12px 16px' }}>
        <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <HelpCircle size={16} /> 使用说明（点击展开/收起）
        </summary>
        <div style={{ marginTop: 12, fontSize: 13, color: 'var(--text-tertiary)', lineHeight: 1.8 }}>
          <p><b style={{ color: 'var(--text-secondary)' }}>什么是工作流？</b><br />
          工作流就是把多个步骤串起来自动执行。比如「读取文件 → AI 分析 → 生成报告」一条线跑完。</p>
          <p><b style={{ color: 'var(--text-secondary)' }}>怎么用？</b></p>
          <ol style={{ paddingLeft: 20 }}>
            <li>从左侧<b>节点库</b>拖拽节点到中间画布（或直接点击添加）</li>
            <li>点击节点上的 <Link2 size={12} style={{ display: 'inline' }} /> 图标，再点击下一个节点，把它们<b>连起来</b></li>
            <li>连线表示执行顺序：<span style={{ color: 'var(--text-tertiary)' }}>↓ 执行顺序</span> = 按顺序执行；条件节点会有 <span style={{ color: 'var(--color-success)' }}>✓ 通过</span> 和 <span style={{ color: 'var(--color-danger)' }}>✗ 不通过</span> 两条路</li>
            <li>点击节点，在右侧<b>配置面板</b>填写参数</li>
            <li>点右上角<b>保存</b> → <b>运行</b>，查看结果</li>
          </ol>
          <p><b style={{ color: 'var(--text-secondary)' }}>节点类型说明：</b></p>
          <ul style={{ paddingLeft: 20 }}>
            <li><b>🧰 工具</b> — 读写本地文件（read_file/write_file/list_files 等）</li>
            <li><b>🤖 AI Agent</b> — 调用 AI 模型对话（需要配置 prompt）</li>
            <li><b>💻 系统命令</b> — 执行系统操作（如 <code>powercfg</code> 调音量、<code>start notepad</code> 开程序）</li>
            <li><b>🖼️ 媒体</b> — AI 生成图片/视频</li>
            <li><b>📄 文档</b> — AI 生成 PPT/Word 文档</li>
            <li><b>🔀 条件</b> — 根据条件走不同分支（通过/不通过）</li>
          </ul>
          <p><b style={{ color: 'var(--text-secondary)' }}>不会配？用 AI 创建！</b><br />
          回到工作流列表，点「AI 创建」按钮，用自然语言描述你想做什么，AI 会自动生成节点和连线。</p>
        </div>
      </details>

      {error && (
        <div className="glass-card" style={{ marginBottom: 16, padding: 12, color: 'var(--color-danger)', fontSize: 13 }}>
          {error}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr 300px', gap: 16, alignItems: 'start' }}>
        {/* 左侧：节点调色板 */}
        <NodePalette onAddNode={onAddNode} dragIndex={dragIndex} />

        {/* 中间：画布 */}
        <div
          className="glass-card"
          style={{ padding: 24, minHeight: 480 }}
          onDragOver={e => e.preventDefault()}
          onDrop={handleDrop}
        >
          {editing.nodes.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 400, color: 'var(--text-tertiary)', gap: 8 }}>
              <WorkflowIcon size={36} />
              <p style={{ fontSize: 13 }}>从左侧拖入节点开始编排</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              {editing.nodes.map((node, index) => {
                const meta = NODE_META[node.type];
                const isSelected = selectedNodeId === node.id;
                const isConnecting = connectingFrom === node.id;
                const incoming = editing.edges.filter(e => e.target === node.id);
                const outgoing = editing.edges.filter(e => e.source === node.id);
                return (
                  <div key={node.id}>
                    {/* 入边连接线 — 带标签说明 */}
                    {index > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '2px 0' }}>
                        {/* 连线标签：如果是条件节点的出边，显示"通过/不通过" */}
                        {(() => {
                          const prevNode = editing.nodes[index - 1];
                          if (prevNode?.type === 'condition') {
                            const condEdges = editing.edges.filter(e => e.source === prevNode.id);
                            const edgeIdx = condEdges.findIndex(e => e.target === node.id);
                            if (edgeIdx === 0) return <span style={{ fontSize: 10, color: 'var(--color-success)', marginBottom: 2 }}>✓ 通过</span>;
                            if (edgeIdx === 1) return <span style={{ fontSize: 10, color: 'var(--color-danger)', marginBottom: 2 }}>✗ 不通过</span>;
                          }
                          return <span style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 2 }}>↓ 执行顺序</span>;
                        })()}
                        <div style={{ width: 2, height: 16, background: 'var(--text-tertiary)', opacity: 0.4 }} />
                      </div>
                    )}
                    <div
                      onDragStart={(e: React.DragEvent) => {
                        dragIndex.current = index;
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                      onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
                      onDrop={e => handleNodeDrop(e, index)}
                      onClick={() => onSelectNode(node.id)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 14,
                        border: `1.5px solid ${isSelected ? meta.color : `${meta.color}55`}`,
                        background: isSelected ? `${meta.color}1e` : 'rgba(var(--glass-fill-rgb), 0.5)',
                        cursor: 'grab', position: 'relative',
                        boxShadow: isSelected ? `0 0 0 3px ${meta.color}22` : 'none',
                      }}
                    >
                      <GripVertical size={16} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                      <div style={{ width: 34, height: 34, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', background: meta.color, color: '#fff', flexShrink: 0 }}>
                        {meta.icon}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{node.label}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {incoming.length > 0 && `← ${incoming.length} 入 · `}{outgoing.length > 0 && `${outgoing.length} 出`}
                          {incoming.length === 0 && outgoing.length === 0 && '未连接'}
                        </div>
                      </div>
                      <button
                        className="btn btn-ghost"
                        style={{ padding: 6 }}
                        title={connectingFrom ? (connectingFrom === node.id ? '取消连接' : '连接到该节点') : '连接到此节点'}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (connectingFrom === node.id) { onConnectingFrom(null); return; }
                          if (connectingFrom) { onToggleEdge(node.id); return; }
                          onConnectingFrom(node.id);
                        }}
                      >
                        <Link2 size={14} style={{ color: isConnecting ? meta.color : 'var(--text-tertiary)' }} />
                      </button>
                      <button
                        className="btn btn-ghost"
                        style={{ padding: 6 }}
                        title="删除节点"
                        onClick={(e) => { e.stopPropagation(); onRemoveNode(node.id); }}
                      >
                        <Trash size={14} style={{ color: 'var(--color-danger)' }} />
                      </button>
                    </div>
                    {isConnecting && (
                      <div style={{ textAlign: 'center', fontSize: 11, color: meta.color, marginTop: 6 }}>
                        点击下方目标节点建立连接（再次点击取消）
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 右侧：配置面板 + 运行结果 + 运行记录 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {showRuns ? (
            <RunHistory
              runs={runs}
              editing={editing}
              runResult={runResult}
              onSelectRun={onSelectRun}
              onCloseRunResult={onCloseRunResult}
              onClose={onCloseRuns}
            />
          ) : selectedNode ? (
            <NodeConfig node={selectedNode} onChange={() => { onSelectNode(selectedNode.id); }} />
          ) : (
            <div className="glass-card" style={{ padding: 16, color: 'var(--text-tertiary)', fontSize: 13 }}>
              点击画布中的节点进行配置
            </div>
          )}

          {runResult && (
            <RunResultPanel
              runResult={runResult}
              editing={editing}
              onClose={onCloseRunResult}
            />
          )}
        </div>
      </div>
    </div>
  );
}