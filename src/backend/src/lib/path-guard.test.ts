import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
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

describe('path-guard ・ Level 3 敏感路径防护 (SEC-004)', () => {
  it('Level 3 仍拒绝 system32 敏感路径段', () => {
    assert.equal(isPathSafe('C:/Windows/System32/cmd.exe', ['C:/'], 3), false);
  });

  it('Level 3 仍拒绝 .git 目录', () => {
    assert.equal(isPathSafe('C:/repo/.git/config', ['C:/repo'], 3), false);
  });

  it('Level 3 仍拒绝用户 .config 配置目录', () => {
    const home = homedir().replace(/\\/g, '/');
    assert.equal(isPathSafe(`${home}/.config/app/settings.json`, ['/'], 3), false);
  });

  it('Level 3 非敏感路径保持全局可写（主语义不变）', () => {
    assert.equal(isPathSafe('C:/Users/x/Documents/anything/x.txt', ['C:/a'], 3), true);
  });
});

describe('path-guard ・ symlink/junction 逃逸防护 (PATH-001)', () => {
  it('allowedDirs 内的 junction 指向目录外 → 必须拒绝（realpath 解析后越界）', () => {
    if (process.platform !== 'win32') return; // junction 主要在 Windows
    let base: string | null = null;
    try {
      base = mkdtempSync(join(tmpdir(), 'pg-link-'));
      const allowed = join(base, 'safe');
      const secretDir = join(base, 'secret');
      mkdirSync(allowed, { recursive: true });
      mkdirSync(secretDir, { recursive: true });
      writeFileSync(join(secretDir, 'plan.txt'), 'top-secret');
      const link = join(allowed, 'link');
      try {
        symlinkSync(secretDir, link, 'junction');
      } catch {
        return; // 无 junction 权限的环境跳过
      }
      // 攻击：allowed 目录内 junction 指向 external secret —— realpath 后必须判定越界
      const r = checkPathSafe(join(link, 'plan.txt'), [allowed]);
      assert.equal(r.ok, false, 'junction 逃逸必须被拒绝');
      // L3 也不能借 junction 逃逸到敏感路径
      const r3 = checkPathSafe(join(link, 'plan.txt'), [allowed], 3);
      assert.equal(r3.ok, false, 'L3 经 junction 访问也需被 realpath 拦截');
    } finally {
      if (base) { try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ } }
    }
  });

  it('不含 junction 的正常路径不受影响', () => {
    assert.equal(isPathSafe('C:/workspace/app/file.ts', ['C:/workspace']), true);
  });
});

describe('path-guard ・ Unix 敏感段修复 (Wave0-PG)', () => {
  it('REGRESSION-FIX: /usr/bin 段必须被拒绝（原实现 split 后段名无斜杠，/usr/bin 永远不匹配）', () => {
    const r = checkPathSafe('/usr/bin/env', ['/']);
    assert.equal(r.ok, false, '/usr/bin 属于系统目录，必须拒绝（win32 下按段名/usr+bin 相邻对同理拦截）');
  });

  it('REGRESSION-FIX: /etc 段必须被拒绝（不再依赖带斜杠字符串匹配）', () => {
    const r = checkPathSafe('/etc/passwd', ['/']);
    assert.equal(r.ok, false);
  });

  it('非 bin 顶层段（如 bin-tools）不受影响，避免误伤', () => {
    if (process.platform === 'win32') {
      assert.equal(isPathSafe('C:/bin-tools/legit/x', ['C:/']), true);
    } else {
      assert.equal(isPathSafe('/bin-tools/legit/x', ['/']), true);
    }
  });

  it('项目内 bin 目录（C:/project/bin）不误伤（仅 usr/bin 或 Unix 顶层 /bin 敏感）', () => {
    assert.equal(isPathSafe('C:/workspace/bin/tools', ['C:/workspace']), true);
  });

  it('isPathInAllowedDirs 走 physical path（junction 指向外部仍拒绝）', () => {
    if (process.platform !== 'win32') return;
    let base: string | null = null;
    try {
      base = mkdtempSync(join(tmpdir(), 'pg-ina-'));
      const allowed = join(base, 'safe');
      const secret = join(base, 'secret');
      mkdirSync(allowed, { recursive: true });
      mkdirSync(secret, { recursive: true });
      const link = join(allowed, 'link');
      try { symlinkSync(secret, link, 'junction'); } catch { return; }
      assert.equal(isPathInAllowedDirs(join(link, 'x.txt'), [allowed]), false, 'isPathInAllowedDirs 必须使用 physical path');
    } finally {
      if (base) { try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ } }
    }
  });
});