import React, { useMemo } from 'react';
import type { AgentEventEnvelope } from '@pacc/shared';
import { projectToRecords } from '../../store/activityStore';
import type { TaskCard as TaskCardModel } from '../../store/activityStore';
import { TaskCardView } from './TaskCard';

const TOOL_LABELS: Record<string, string> = {
  read_file: 'Read', write_file: 'Write', list_files: 'List', edit_file: 'Edit',
  delete_file: 'Delete', create_directory: 'Mkdir',
  grep: 'Grep', glob: 'Glob', web_search: 'Search', web_fetch: 'Fetch',
  execute_command: 'Shell', run_tests: 'Test', code_review: 'Review', lsp_diagnostics: 'LSP',
};

const ToolLine = React.memo(function ToolLine({ title, summary, state }: { title: string; summary: string; state: string }) {
  const isRunning = state === 'running';
  const isError = state === 'error';
  return (
    <div
      data-state={state}
      style={{
        position: 'relative',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        gap: 0,
        fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace)',
        fontSize: 14,
        lineHeight: '24px',
        color: isError ? 'var(--color-danger, #f87171)' : 'var(--text-primary)',
      }}
    >
      <span style={{ fontWeight: 400, flexShrink: 0 }}>{title}</span>
      <span style={{ flexShrink: 0, display: 'inline-block', width: 2, height: 2, borderRadius: 1, margin: '0 8px', verticalAlign: 'middle', background: 'var(--text-tertiary)' }} />
      <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14, lineHeight: '24px', color: isError ? 'inherit' : 'var(--text-tertiary)' }}>
        {summary}
      </span>
      {isRunning && <div className="tool-row-sweep" />}
    </div>
  );
});

const ThinkLine = React.memo(function ThinkLine({ text, running }: { text: string; running?: boolean }) {
  const [expanded, setExpanded] = React.useState(false);
  const lines = text.split('\n');
  const summary = running ? lines.filter(Boolean).pop() || text : lines[0] || text;
  const truncated = summary.length > 80 ? summary.slice(0, 80) + '…' : summary;
  const scrollRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (scrollRef.current && expanded) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [text, expanded]);
  return (
    <div data-variant="think" data-state={running ? 'running' : 'ok'} style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 14, lineHeight: '24px' }}>
      <div role="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}
        style={{ cursor: 'pointer', userSelect: 'none', display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden' }}>
        <span style={{ flexShrink: 0, color: 'var(--text-tertiary)', fontSize: 12 }}>{expanded ? '▾' : '▸'}</span>
        <span style={{ fontWeight: 400 }}>Think</span>
        <span style={{ width: 2, height: 2, borderRadius: 1, background: 'var(--text-tertiary)', flexShrink: 0 }} />
        <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-tertiary)' }}>{truncated}</span>
      </div>
      {expanded && (
        <div ref={scrollRef} style={{ padding: '4px 0 4px 20px', color: 'var(--text-tertiary)', whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.5, maxHeight: 200, overflowY: 'auto' }}>
          {text}
        </div>
      )}
    </div>
  );
});

/**
 * ActivityStream——按 seq 顺序渲染所有事件（工具行、思考行、任务卡）。
 * 对齐 DeepSeek Harness 的 conversation timeline：每个事件类型是独立行，按 seq 排列。
 * 不再只显示最新任务——所有任务的过程事件都保留并显示。
 */
export function ActivityStream({ events, taskCard }: { events: AgentEventEnvelope[]; taskCard?: TaskCardModel | null }) {
  // 从所有事件中提取 reasoning 的完整内容（按 seq 累积）
  const reasoningText = useMemo(() => {
    return events
      .filter(e => e.eventType === 'agent.reasoning.delta' && e.content)
      .map(e => e.content)
      .join('');
  }, [events]);

  // projectToRecords 产生折叠后的工具行、agent 状态行
  const records = useMemo(() => projectToRecords(events), [events]);

  const result: React.ReactNode[] = [];

  for (const rec of records) {
    if (rec.kind === 'tool') {
      const label = rec.label ? (TOOL_LABELS[rec.label] ?? 'Tool') : 'Tool';
      const target = rec.target ?? '';
      const state = rec.status === 'error' ? 'error' : rec.status === 'completed' ? 'ok' : 'running';
      result.push(<ToolLine key={`t-${rec.seq}`} title={label} summary={target} state={state} />);
    } else if (rec.kind === 'agent' && rec.status === 'running' && rec.message) {
      result.push(<ThinkLine key={`a-${rec.seq}`} text={rec.message} running={rec.status === 'running'} />);
    }
  }

  // 如果有 reasoning 内容，作为 ThinkLine 显示在工具行之后（按顺序）
  if (reasoningText) {
    const isRunning = events.some(e => e.eventType === 'agent.reasoning.delta' && !events.some(ee => ee.eventType === 'task.completed' && ee.seq > e.seq));
    result.push(<ThinkLine key={`reasoning`} text={reasoningText} running={isRunning} />);
  }

  const showTaskCard = taskCard && (taskCard.steps.length > 0 || taskCard.plan || taskCard.agentOutputs.size > 0);
  if (result.length === 0 && !showTaskCard) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0, margin: '4px 0' }}>
      {showTaskCard && <TaskCardView card={taskCard!} />}
      {result}
    </div>
  );
}

export function ThinkingIndicator({ content }: { content: string }) {
  const [expanded, setExpanded] = React.useState(false);
  if (!content) return null;
  return (
    <div style={{ margin: '2px 12px', fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 12 }}>
      <div role="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}
        style={{ cursor: 'pointer', userSelect: 'none', color: 'var(--color-accent)' }}>
        {expanded ? '▾' : '▸'} keep diving...
      </div>
      {expanded && (
        <div style={{ marginTop: 2, color: 'var(--text-tertiary)', whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.5, maxHeight: 120, overflowY: 'auto' }}>
          {content}
        </div>
      )}
    </div>
  );
}

export function injectActivityStyles() {
  if (typeof document === 'undefined' || document.getElementById('dsh-tool-styles')) return;
  const style = document.createElement('style');
  style.id = 'dsh-tool-styles';
  style.textContent = `
    @keyframes dsh-tool-row-sweep {
      0% { left: -300px; }
      90%, 100% { left: 100%; }
    }
    .tool-row-sweep {
      position: absolute; top: 0; bottom: 0; left: 0;
      width: 300px;
      background: linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--bg-base, #1a1a2e) 60%, transparent) 55%, transparent 100%);
      animation: dsh-tool-row-sweep 2.6s ease-out infinite;
      pointer-events: none;
    }
  `;
  document.head.appendChild(style);
}