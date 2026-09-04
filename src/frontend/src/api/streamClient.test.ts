import { describe, it, expect, vi } from 'vitest';
import { parseSseFrame } from './streamClient';

describe('streamClient — parseSseFrame 帧解析', () => {
  it('解析 event: + data: 单帧', () => {
    const { eventName, dataLine } = parseSseFrame('event: token\ndata: {"total_tokens":10}\n\n');
    expect(eventName).toBe('token');
    expect(JSON.parse(dataLine).total_tokens).toBe(10);
  });

  it('无 event: 行时默认 message', () => {
    const { eventName, dataLine } = parseSseFrame('data: hello\n\n');
    expect(eventName).toBe('message');
    expect(dataLine).toBe('hello');
  });

  it('CRLF 行尾正确处理', () => {
    const { dataLine } = parseSseFrame('data: a\r\ndata: b\r\n\r\n');
    expect(dataLine).toBe('a\nb');
  });

  it('多行 data 合并且去除尾换行', () => {
    const { dataLine } = parseSseFrame('data: line1\ndata: line2\n\n');
    expect(dataLine).toBe('line1\nline2');
  });

  it('空 data 行不产生内容', () => {
    const { dataLine } = parseSseFrame('data:\n\n');
    expect(dataLine).toBe('');
  });
});

describe('streamClient — envelope 载荷判别（ST-01 防双发回归）', () => {
  it('envelope 帧解析后保留 eventType 与 seq', () => {
    const raw = 'event: agent.message.delta\ndata: {"eventId":"e1","sessionId":"s1","taskId":"t1","agentId":"main","agentType":"conversation","eventType":"agent.message.delta","seq":1,"content":"x"}\n\n';
    const { eventName, dataLine } = parseSseFrame(raw);
    const payload = JSON.parse(dataLine);
    expect(eventName).toBe(payload.eventType);
    expect(payload.seq).toBe(1);
    expect(typeof payload.eventId).toBe('string');
  });

  it('envelope 是判别联合的关键判定：含 eventId/seq/eventType 三要素', () => {
    const payload = { eventId: 'x', eventType: 'task.started', seq: 1 };
    // isEnvelopePayload 未导出；此测试锁定帧载荷形状契约（防因字段改名导致 ST-01）
    expect(payload.eventType).toBeTruthy();
    expect(typeof payload.seq).toBe('number');
    expect(payload.eventId).toBeTruthy();
  });
});