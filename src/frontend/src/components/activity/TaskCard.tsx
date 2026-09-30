import React from 'react';
import type { TaskCard as TaskCardModel, TaskCardStep } from '../../store/activityStore';

/**
 * TaskCard — 对齐 DeepSeek Harness 的任务生命周期卡。
 * 展示：任务状态（running/ok/error + 结束原因）、步骤链（Agent/工具）、流式 thinking、Agent 输出。
 * 数据来自 activityStore.projectTaskCard（事件流投影），过程与最终输出天然分离。
 */

const STATUS_TEXT: Record<TaskCardModel['status'], string> = {
  running: '进行中',
  completed: '完成',
  cancelled: '已取消',
  failed: '失败',
};

const END_REASON_TEXT: Record<string, string> = {
  stop: '正常结束',
  tool_calls: '工具调用完成',
  'max-tokens': '达到 token 上限',
  max_turns: '达到回合上限',
  error: '出错',
  aborted: '已中止',
  completed: '正常完成',
};

function StepRow({ step }: { step: TaskCardStep }) {
  const isRunning = step.state === 'running';
  const isError = step.state === 'error';
  return (
    <div
      data-state={step.state}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontFamily: 'var(--font-mono, ui-monospace, Menlo, Consolas, monospace)',
        fontSize: 13,
        lineHeight: '22px',
        color: isError ? 'var(--color-danger, #f87171)' : 'var(--text-primary)',
        paddingLeft: 0,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <span style={{ flexShrink: 0, color: isError ? 'inherit' : 'var(--text-tertiary)', fontSize: 12 }}>
        {isRunning ? '●' : isError ? '✕' : '✓'}
      </span>
      <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {step.label}
      </span>
      {isRunning && <span className="tool-row-sweep" />}
    </div>
  );
}

export function TaskCardView({ card }: { card: TaskCardModel }) {
  const isRunning = card.status === 'running';
  const isError = card.status === 'failed';
  if (card.steps.length === 0 && !card.plan && card.agentOutputs.size === 0) return null;

  return (
    <div
      data-state={card.status}
      style={{
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--border-primary)',
        background: 'var(--bg-surface)',
        padding: '10px 12px',
        margin: '8px 0',
        fontFamily: 'var(--font-mono, ui-monospace, Menlo, Consolas, monospace)',
      }}
    >
      {/* 状态行：任务状态 + 结束原因 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 500 }}>
        <span style={{ color: isError ? 'var(--color-danger)' : isRunning ? 'var(--color-accent)' : 'var(--color-success)' }}>
          {isRunning && <span className="animate-spin inline-block">⏳</span>}
          {!isRunning && (isError ? '✕' : '✓')}
        </span>
        <span style={{ color: 'var(--text-primary)' }}>任务 {STATUS_TEXT[card.status]}</span>
        {card.endReason && (
          <span style={{ color: 'var(--text-tertiary)', fontSize: 12, marginLeft: 'auto' }}>
            {END_REASON_TEXT[card.endReason] ?? card.endReason}
          </span>
        )}
      </div>

      {/* 执行计划（task.plan — 计划先行，对齐 harness plan 模式） */}
      {card.plan && (
        <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-tertiary)', fontWeight: 500 }}>
            <span>📋</span><span>计划</span>
          </div>
          <div style={{ padding: '4px 0 2px 18px', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>
            {card.plan}
          </div>
        </div>
      )}

      {/* 步骤链（仅 Agent 步骤，工具步骤由 ActivityStream 统一渲染，避免重复） */}
      {card.steps.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 8 }}>
          {card.steps.map((s) => <StepRow key={s.key} step={s} />)}
        </div>
      )}

      {/* 思考流（thinking）已移到 ActivityStream 内作为浮动行穿插在过程中，实时滚动最新内容 */}

      {/* 子 Agent 输出面板（agent.message.delta 按 agentId 累积，过程保留，不混入最终输出） */}
      {card.agentOutputs.size > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
          {Array.from(card.agentOutputs.entries()).map(([agentId, text]) => (
            <AgentOutputRow key={`ao-${agentId}`} agentId={agentId} text={text} />
          ))}
        </div>
      )}
    </div>
  );
}

/** 子 Agent 输出行 — 可折叠（harness 风格：每个 Agent 独立面板） */
function AgentOutputRow({ agentId, text }: { agentId: string; text: string }) {
  const [expanded, setExpanded] = React.useState(false);
  const summary = text.split('\n')[0] || text;
  const truncated = summary.length > 90 ? summary.slice(0, 90) + '…' : summary;
  return (
    <div data-variant="agent-output" style={{ borderTop: '1px solid var(--border-primary)', paddingTop: 6, marginTop: 2 }}>
      <div
        role="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((e) => !e)}
        style={{ cursor: 'pointer', userSelect: 'none', display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)' }}
      >
        <span style={{ flexShrink: 0, fontSize: 12 }}>{expanded ? '▾' : '▸'}</span>
        <span style={{ fontWeight: 500 }}>{agentId}</span>
        <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-tertiary)', fontSize: 12 }}>{truncated}</span>
      </div>
      {expanded && (
        <div style={{ padding: '4px 0 4px 20px', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.5, maxHeight: 240, overflowY: 'auto' }}>
          {text}
        </div>
      )}
    </div>
  );
}