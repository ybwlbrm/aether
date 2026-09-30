/**
 * T21 `useWorkbenchCode` —— Code 面板两条数据路径（TDD：先 RED）。
 *
 * 同一条 run，工具事件载荷的完整性有两种可能，渲染必须分开：
 *   ① **完整载荷**（SSE 实时帧 / 未打包的回放帧）：`tool.outputDetail` 是全文，
 *      `tool.toolOutput` 只是 `buildToolPayload` 截断到 200 字的摘要。
 *   ② **packed-replay 载荷**：后端 `readEvents` 对打包行只回放 `payload: { content }`
 *      （复刻见 store/projections.test.ts:254），`toolName / toolInput / inputDetail /
 *      outputDetail` 全部丢失 —— T9 `hasFullToolPayload` 据此返回 false。
 *
 * 路径 ② 下**必须**显示显式截断提示，且**绝不**用 200 字摘要冒充完整文件。
 * 路径/操作/op 一律取自 T9 `projectFileActivity`（inputDetail.path，回退 toolInput），
 * 本文件不另写一套路径提取规则。
 */
import type { AgentEventEnvelope } from '@pacc/shared';
import { describe, expect, it } from 'vitest';

import { buildCodeFiles, MISSING_CONTENT_NOTICE, REPLAY_TRUNCATION_NOTICE } from './useWorkbenchCode';

const RUN_ID = 'run-1';
const TS = '2026-01-01T00:00:00.000Z';
const FULL_TEXT = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
/** buildToolPayload 对超过 200 字的输出：摘要截断加省略号，全文留在 outputDetail。 */
const SUMMARY = `${FULL_TEXT.slice(0, 200)}…`;

/** 完整载荷事件（真实链路 buildToolPayload 产出：toolName + toolInput + inputDetail + outputDetail）。 */
function fullPayloadEvent(path: string): AgentEventEnvelope {
  return {
    eventId: 'e-1',
    sessionId: 'conv-1',
    runId: RUN_ID,
    taskId: 'task-1',
    agentId: 'sisyphus',
    agentType: 'conversation',
    eventType: 'tool.completed',
    timestamp: TS,
    seq: 1,
    tool: {
      toolName: 'read_file',
      toolInput: path,
      toolOutput: SUMMARY,
      inputDetail: { path },
      outputDetail: FULL_TEXT,
    },
  };
}

/** packed-replay 事件：复刻 stream.ts readEvents 的 packed 剥离 —— 完全没有 tool 载荷。 */
function packedReplayEvent(seq: number): AgentEventEnvelope {
  return {
    eventId: `p-${seq}`,
    sessionId: 'conv-1',
    runId: RUN_ID,
    taskId: 'task-1',
    agentId: 'sisyphus',
    agentType: 'conversation',
    eventType: 'tool.completed',
    timestamp: TS,
    seq,
    content: 'read_file src/app.ts → ok',
  };
}

describe('buildCodeFiles —— 完整 payload 路径', () => {
  it('从 outputDetail 渲染全文，不受 200 字摘要影响', () => {
    const files = buildCodeFiles([fullPayloadEvent('src/app.ts')], RUN_ID);

    expect(files).toHaveLength(1);
    const file = files[0];
    expect(file?.path).toBe('src/app.ts');
    expect(file?.op).toBe('read');
    expect(file?.content).toBe(FULL_TEXT);
    expect(file?.truncated).toBe(false);
  });

  it('同一路径多次操作以最后一次为准', () => {
    const first = fullPayloadEvent('src/app.ts');
    const second: AgentEventEnvelope = {
      ...first,
      eventId: 'e-3',
      seq: 3,
      timestamp: '2026-01-01T00:00:05.000Z',
      tool: { toolName: 'edit_file', toolInput: 'src/app.ts', outputDetail: 'export const v = 2;' },
    };

    const files = buildCodeFiles([first, second], RUN_ID);

    expect(files).toHaveLength(1);
    expect(files[0]?.content).toBe('export const v = 2;');
    expect(files[0]?.at).toBe('2026-01-01T00:00:05.000Z');
  });

  it('outputDetail 缺失时给诚实提示，绝不伪造文件内容', () => {
    const withoutDetail: AgentEventEnvelope = {
      ...fullPayloadEvent('src/app.ts'),
      tool: { toolName: 'write_file', toolInput: 'src/app.ts' },
    };

    const files = buildCodeFiles([withoutDetail], RUN_ID);

    expect(files[0]?.content).toBe(MISSING_CONTENT_NOTICE);
    expect(files[0]?.truncated).toBe(true);
  });

  it('runId 省略时按全部事件投影', () => {
    const files = buildCodeFiles([fullPayloadEvent('src/app.ts')]);

    expect(files).toHaveLength(1);
    expect(files[0]?.truncated).toBe(false);
  });
});

describe('buildCodeFiles —— packed-replay 降级路径', () => {
  it('渲染 200 字摘要并附显式 truncated after replay 提示', () => {
    const files = buildCodeFiles([fullPayloadEvent('src/app.ts'), packedReplayEvent(2)], RUN_ID);

    expect(files).toHaveLength(1);
    const file = files[0];
    expect(file?.path).toBe('src/app.ts');
    expect(file?.content).toContain(SUMMARY);
    expect(file?.content).toContain('truncated after replay');
    expect(file?.content).toContain(REPLAY_TRUNCATION_NOTICE);
    expect(file?.truncated).toBe(true);
  });

  it('降级内容长度受摘要长度限制 —— 不会冒充完整文件', () => {
    const files = buildCodeFiles([fullPayloadEvent('src/app.ts'), packedReplayEvent(2)], RUN_ID);

    // 全文 40 行远长于 200 字摘要：降级路径拿不到全文
    expect(files[0]?.content).not.toContain('line 39');
  });

  it('摘要也缺失时退回诚实提示（不编造任何内容）', () => {
    const started: AgentEventEnvelope = {
      ...fullPayloadEvent('src/app.ts'),
      eventId: 'e-0',
      seq: 0,
      eventType: 'tool.started',
      tool: { toolName: 'read_file', toolInput: 'src/app.ts' },
    };

    const files = buildCodeFiles([started, packedReplayEvent(2)], RUN_ID);

    expect(files[0]?.content).toBe(MISSING_CONTENT_NOTICE);
    expect(files[0]?.truncated).toBe(true);
  });
});
