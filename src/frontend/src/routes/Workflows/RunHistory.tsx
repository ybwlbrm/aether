import { CheckCircle2, AlertCircle, Loader2, X } from 'lucide-react';
import type { RunRecord, Workflow } from './types';
import { NODE_META } from './constants';

interface RunHistoryProps {
  runs: RunRecord[];
  editing: Workflow | null;
  runResult: RunRecord | null;
  onSelectRun: (run: RunRecord) => void;
  onCloseRunResult: () => void;
  onClose: () => void;
}

export function RunHistory({ runs, editing, runResult, onSelectRun, onCloseRunResult, onClose }: RunHistoryProps) {
  if (!editing) return null;

  return (
    <div className="glass-card" style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>运行记录</div>
        <button className="btn btn-ghost" style={{ padding: 4 }} onClick={onClose}><X size={14} /></button>
      </div>
      {runs.length === 0 ? (
        <p style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>暂无运行记录</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 400, overflowY: 'auto' }}>
          {runs.map((r) => (
            <div
              key={r.id}
              style={{
                padding: 10, borderRadius: 10, cursor: 'pointer',
                border: `1px solid ${r.status === 'completed' ? 'var(--color-success)44' : r.status === 'failed' ? 'var(--color-danger)44' : 'var(--text-tertiary)44'}`,
                background: r.status === 'completed' ? 'var(--color-success)0d' : r.status === 'failed' ? 'var(--color-danger)0d' : 'transparent',
              }}
              onClick={() => onSelectRun(r)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600 }}>
                {r.status === 'completed' ? <CheckCircle2 size={13} style={{ color: 'var(--color-success)' }} />
                  : r.status === 'failed' ? <AlertCircle size={13} style={{ color: 'var(--color-danger)' }} />
                  : <Loader2 size={13} className="spin" />}
                {r.status === 'completed' ? '已完成' : r.status === 'failed' ? '失败' : '运行中'}
                <span style={{ color: 'var(--text-tertiary)', fontWeight: 400, marginLeft: 'auto' }}>
                  {new Date(r.startedAt).toLocaleString('zh-CN')}
                </span>
              </div>
              {r.error && <div style={{ fontSize: 11, color: 'var(--color-danger)', marginTop: 4 }}>{r.error}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface RunResultPanelProps {
  runResult: RunRecord;
  editing: Workflow | null;
  onClose: () => void;
}

export function RunResultPanel({ runResult, editing, onClose }: RunResultPanelProps) {
  if (!editing) return null;

  return (
    <div className="glass-card" style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 13, fontWeight: 600 }}>
        {runResult.status === 'completed'
          ? <CheckCircle2 size={15} style={{ color: 'var(--color-success)' }} />
          : <AlertCircle size={15} style={{ color: 'var(--color-danger)' }} />}
        运行结果 · {runResult.status === 'completed' ? '成功' : '失败'}
        <button className="btn btn-ghost" style={{ padding: 4, marginLeft: 'auto' }} onClick={onClose}><X size={14} /></button>
      </div>
      {runResult.error && (
        <div style={{ fontSize: 12, color: 'var(--color-danger)', marginBottom: 10, padding: 8, borderRadius: 8, background: 'var(--color-danger)0d' }}>
          {runResult.error}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 320, overflowY: 'auto' }}>
        {Object.entries(runResult.results || {}).map(([nodeId, res]) => {
          const node = editing.nodes.find(n => n.id === nodeId);
          const color = node ? NODE_META[node.type].color : 'var(--text-tertiary)';
          return (
            <div key={nodeId} style={{ padding: 10, borderRadius: 10, border: `1px solid ${color}33`, background: `${color}0d` }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, color }}>
                {res.label || nodeId}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 120, overflowY: 'auto' }}>
                {String(res.output || '').slice(0, 800)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}