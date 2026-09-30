/**
 * 审批请求卡片（D1）。
 *
 * 审批此前是 `useStreamSend` 里 mode 分支内的命令式 `confirmDialog` promise ——
 * 没有状态面，因此任何不渲染那个对话框的路径（含 super 分支遗漏、headless 场景）
 * 都会让后端一直等 decideApproval，审批工具挂死。
 * 控制器把它变成状态（pendingApproval）+ 决策入口（decideApproval），本组件只是那份状态的视图。
 */
import type { ApprovalRequest } from '../../hooks/threadApproval';

export interface ApprovalCardProps {
  readonly approval: ApprovalRequest | null;
  readonly error: string | null;
  readonly onDecide: (ok: boolean) => void;
}

export function ApprovalCard({ approval, error, onDecide }: ApprovalCardProps) {
  if (!approval) return null;
  return (
    <div
      role="group"
      aria-label="需要你的确认"
      style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 14px', borderRadius: 10, background: 'var(--bg-surface)', border: '1px solid var(--color-warning)' }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>🔐 需要你的确认</div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
        AI 请求执行操作：<code>{approval.toolName}</code>
      </div>
      {approval.argsSummary && (
        <pre style={{ margin: 0, fontSize: 11, color: 'var(--text-tertiary)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{approval.argsSummary}</pre>
      )}
      {error && <div style={{ fontSize: 12, color: 'var(--color-danger)' }}>提交失败：{error}（可重试）</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn btn-primary" onClick={() => onDecide(true)}>允许</button>
        <button type="button" className="btn btn-ghost" onClick={() => onDecide(false)}>拒绝</button>
      </div>
    </div>
  );
}
