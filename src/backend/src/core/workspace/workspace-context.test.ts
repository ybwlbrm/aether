/**
 * WorkspaceContext 测试（整改计划第 2 章，P0/P1）。
 *
 * 覆盖：
 * - canonicalResolve：realpath + Windows 大小写归一 → 同一物理目录不同写法返回同一 canonical
 * - isWithinAllowed / normalizeDir：allowedDirs 边界（含 junction 逃逸拒绝）
 * - defaultDir 回退：不在 allowedDirs 内时回退 allowedDirs[0]
 * - get cwd：唯一默认目录（不回退 process.cwd()）
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createWorkspaceContextSync, normalizeCase, physicalPath } from './workspace-context.js';

let dir: string;
let subA: string;
let subB: string;
let junction: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'pacc-ws-'));
  subA = join(dir, 'work-a');
  subB = join(dir, 'work-b');
  mkdirSync(subA, { recursive: true });
  mkdirSync(subB, { recursive: true });
  writeFileSync(join(subA, 'file.txt'), 'hello');
  // junction/symlink：work-link → work-a
  junction = join(dir, 'work-link');
  try {
    symlinkSync(subA, junction, 'junction');
  } catch {
    /* 无权限创建 junction 时跳过相关用例 */
  }
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('WorkspaceContext（整改计划第 2 章）', () => {
  test('canonicalResolve 对同一目录的不同写法返回同一 canonical（大小写归一 + realpath）', () => {
    const ctx = createWorkspaceContextSync({ allowedDirs: [subA] });
    const a = ctx.canonicalResolve(subA);
    const aCase = ctx.canonicalResolve(subA.toUpperCase());
    assert.equal(a, aCase, 'Windows 大小写归一：两种写法应返回同一 canonical');
    assert.equal(a, normalizeCase(physicalPath(subA)));
    assert.ok(a.includes('work-a'), `canonical 应解析到真实物理路径: ${a}`);
  });

  test('isWithinAllowed：allowedDirs 内的子路径通过，外部拒绝', () => {
    const ctx = createWorkspaceContextSync({ allowedDirs: [subA] });
    assert.equal(ctx.isWithinAllowed(join(subA, 'file.txt')), true);
    assert.equal(ctx.isWithinAllowed(subA), true);
    assert.equal(ctx.isWithinAllowed(subB), false, '不在 allowedDirs 内必须拒绝');
    assert.equal(ctx.isWithinAllowed(join(dir, 'outside.txt')), false);
  });

  test('前缀误匹配防护：/work 不匹配 /work-other', () => {
    const ctx = createWorkspaceContextSync({ allowedDirs: [subA] });
    const sibling = resolve(subA) + '-other';
    assert.equal(ctx.isWithinAllowed(sibling), false, '前缀相似目录不应误判为 allowedDirs 内');
  });

  test('normalizeDir：allowedDirs 内返回 canonical；外部返回 null', () => {
    const ctx = createWorkspaceContextSync({ allowedDirs: [subA] });
    assert.equal(ctx.normalizeDir(subA), normalizeCase(physicalPath(subA)));
    assert.equal(ctx.normalizeDir(join(subA, 'nested')), normalizeCase(physicalPath(join(subA, 'nested'))));
    assert.equal(ctx.normalizeDir(subB), null);
    assert.equal(ctx.normalizeDir(''), null);
    assert.equal(ctx.normalizeDir('   '), null);
  });

  test('defaultDir 不在 allowedDirs 内时回退到 allowedDirs[0]', () => {
    const ctx = createWorkspaceContextSync({ allowedDirs: [subA, subB], defaultDir: join(dir, 'no-such-dir') });
    assert.equal(ctx.defaultDir, normalizeCase(physicalPath(subA)), '非法 defaultDir 应回退 allowedDirs[0]');
  });

  test('cwd 返回 defaultDir（不回退 process.cwd()）', () => {
    const ctx = createWorkspaceContextSync({ allowedDirs: [subB], defaultDir: subB });
    assert.equal(ctx.cwd, normalizeCase(physicalPath(subB)));
    assert.notEqual(ctx.cwd, normalizeCase(physicalPath(process.cwd())));
  });

  test('junction/symlink 逃逸：link 指向 allowedDirs 外部时，physical 解析暴露真实路径', () => {
    if (!junction) return; // 无 junction 权限则跳过
    const ctx = createWorkspaceContextSync({ allowedDirs: [subA] });
    const canon = ctx.canonicalResolve(junction);
    // junction 的 canonical 应解析到真实目标（work-a），而非链接自身路径
    assert.equal(canon, normalizeCase(physicalPath(subA)), 'junction 必须解析为真实物理路径');
  });

  test('isWithinDefault：默认目录内子路径通过，外部拒绝', () => {
    const ctx = createWorkspaceContextSync({ allowedDirs: [subA, subB], defaultDir: subA });
    assert.equal(ctx.isWithinDefault(join(subA, 'file.txt')), true);
    assert.equal(ctx.isWithinDefault(subB), false);
  });
});
