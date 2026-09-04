import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { topoSort } from './execution-engine.js';

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