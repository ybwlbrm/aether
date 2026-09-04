import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { checkPathSafe, isPathSafe, isPathInAllowedDirs, isPathAllowed } from './path-guard.js';

describe('path-guard — allowedDirs 包含性', () => {
  const allowed = ['C:/workspace'];

  it('允许 allowedDirs 自身', () => {
    assert.equal(isPathAllowed('C:/workspace', allowed), true);
  });

  it('允许 allowedDirs 子目录', () => {
    assert.equal(isPathAllowed('C:/workspace/projects/a/file.ts', allowed), true);
  });

  it('拒绝 allowedDirs 之外的路径', () => {
    assert.equal(isPathAllowed('C:/Windows/System32/drivers/etc/hosts', allowed), false);
  });

  it('拒绝前置同名目录（C:/workspace-other 不应被 C:/workspace 前缀匹配）', () => {
    assert.equal(isPathAllowed('C:/workspace-other/x.txt', allowed), false);
  });
});

describe('path-guard — 敏感路径段', () => {
  const allowedAny = ['C:/'];

  it('拒绝 system32 段（allowedDirs 为整盘时仍拦截）', () => {
    const r = checkPathSafe('C:/Windows/System32/cmd.exe', allowedAny);
    assert.equal(r.ok, false);
    assert.match(r.error || '', /敏感路径/);
  });

  it('拒绝 /etc（Unix 语义；win32 跳过——resolve 会转为盘符路径）', { skip: process.platform === 'win32' }, () => {
    assert.equal(isPathSafe('/etc/passwd', ['/']), false);
  });

  it('拒绝 .git 段', () => {
    assert.equal(isPathSafe('C:/repo/.git/config', ['C:/repo']), false);
  });

  it('允许包含 windows 字样的合法子目录（段匹配避免误伤）', () => {
    assert.equal(isPathSafe('C:/workspace/my-windows-app/src/main.ts', ['C:/workspace']), true);
  });
});

describe('path-guard — 配置目录防护与权限', () => {
  it('拒绝用户 .config 目录（防护方向）', () => {
    const home = homedir().replace(/\\/g, '/');
    const cfgPath = `${home}/.config/app/settings.json`;
    const r = checkPathSafe(cfgPath, ['/']);
    // 拦截或安全拒绝均可接受；唯一不允许的是"合法放行"
    assert.notEqual(r.ok, true, '用户配置目录不应被放行');
  });

  it('Level 3 超级权限绕过路径限制', () => {
    assert.equal(isPathSafe('C:/anything/out/of/dirs/x', ['C:/a'], 3), true);
  });

  it('checkPathSafe 在无 allowedDirs 时报错', () => {
    const r = checkPathSafe('C:/x', []);
    assert.equal(r.ok, false);
    assert.match(r.error || '', /未配置/);
  });
});

describe('path-guard — isPathInAllowedDirs（data 模块语义）', () => {
  it('仅校验 allowedDirs', () => {
    assert.equal(isPathInAllowedDirs('C:/workspace/a.txt', ['C:/workspace']), true);
  });

  it('拒绝越界路径', () => {
    assert.equal(isPathInAllowedDirs('C:/elsewhere/a.txt', ['C:/workspace']), false);
  });

  it('空路径返回 false', () => {
    assert.equal(isPathInAllowedDirs('', ['C:/workspace']), false);
  });
});