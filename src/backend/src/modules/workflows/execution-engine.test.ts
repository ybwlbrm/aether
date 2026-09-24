import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { topoSort, executeWorkflow } from './execution-engine.js';

describe('workflows topoSort — 拓扑排序与环检测', () => {
  const node = (id: string) => ({ id, type: 'tool' as const, label: id, config: {} });

  it('DAG 正常拓扑排序', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const edges = [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'c' },
    ];
    const order = topoSort(nodes, edges);
    assert.ok(order, '应为有效的拓扑序');
    assert.equal(order!.length, 3);
    assert.ok(order!.findIndex(n => n.id === 'a') < order!.findIndex(n => n.id === 'b'));
    assert.ok(order!.findIndex(n => n.id === 'b') < order!.findIndex(n => n.id === 'c'));
  });

  it('多根 DAG：全部根节点入队', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const edges = [
      { id: 'e1', source: 'a', target: 'c' },
      { id: 'e2', source: 'b', target: 'c' },
    ];
    const order = topoSort(nodes, edges);
    assert.ok(order, '应为有效的拓扑序');
    assert.equal(order!.length, 3);
  });

  it('环检测：循环依赖返回 null（fail-fast，LC-020）', () => {
    const nodes = [node('a'), node('b')];
    const edges = [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'a' },
    ];
    assert.equal(topoSort(nodes, edges), null, '循环依赖必须返回 null 以触发 fail-fast');
  });

  it('自环：单节点自引用同样返回 null', () => {
    const nodes = [node('a')];
    const edges = [{ id: 'e1', source: 'a', target: 'a' }];
    assert.equal(topoSort(nodes, edges), null);
  });

  it('孤立节点：无环图正常排序', () => {
    const nodes = [node('a'), node('b')];
    assert.equal(topoSort(nodes, [])?.length, 2);
  });
});

describe('workflows executeWorkflow — §41 受控并行 DAG + §42 条件边显式化', () => {
  const node = (id: string, type: 'tool' | 'condition' = 'tool') => ({ id, type, label: id, config: {} });
  const edge = (id: string, source: string, target: string, condition?: 'passed' | 'failed') => ({
    id, source, target, ...(condition ? { condition } : {}),
  });

  /** 最小 executeWorkflow 上下文：用空 db/saveDb 桩 */
  function makeOpts(nodes: ReturnType<typeof node>[], edges: ReturnType<typeof edge>[], executeNode: (n: any) => Promise<{ output: string; data?: unknown }>) {
    return {
      workflowId: 'wf-test',
      nodes,
      edges,
      input: {},
      config: { workflowMaxParallel: 2 },
      executeNode: (n: any, _cfg: any, ctx: Record<string, unknown>) => executeNode(n),
      db: {
        update: () => ({ set: () => ({ where: () => ({ run: () => {} }) }) }),
        select: () => ({ from: () => ({ where: () => ({ get: () => ({ status: 'running' }) }) }) }),
        insert: () => ({ values: () => ({ run: () => {} }) }),
      },
      saveDb: () => {},
      request: { raw: { socket: { destroyed: false } } },
      onEvent: () => {},
    } as never;
  }

  it('§41: 多根并行节点均执行（非串行首根）', async () => {
    const executed: string[] = [];
    const nodes = [node('a'), node('b'), node('c')];
    const edges = [
      edge('e1', 'a', 'c'),
      edge('e2', 'b', 'c'),
    ];
    const result = await executeWorkflow(makeOpts(nodes, edges, async (n) => {
      executed.push(n.id);
      return { output: `out-${n.id}` };
    }));
    assert.equal(result.status, 'completed');
    assert.ok(executed.includes('a') && executed.includes('b') && executed.includes('c'),
      `三个节点都应执行，实际: ${executed.join(',')}`);
  });

  it('§42: 条件边显式化 — passed 边走，failed 边不走', async () => {
    const executed: string[] = [];
    const nodes = [
      node('cond', 'condition'),
      node('yes'),
      node('no'),
    ];
    const edges = [
      edge('e1', 'cond', 'yes', 'passed'),
      edge('e2', 'cond', 'no', 'failed'),
    ];
    const result = await executeWorkflow(makeOpts(nodes, edges, async (n) => {
      executed.push(n.id);
      if (n.type === 'condition') return { output: '', data: { passed: true } };
      return { output: `out-${n.id}` };
    }));
    assert.equal(result.status, 'completed');
    assert.ok(executed.includes('yes'), 'passed 边目标应执行');
    assert.ok(!executed.includes('no'), 'failed 边目标不应执行（条件边显式化）');
  });
});
