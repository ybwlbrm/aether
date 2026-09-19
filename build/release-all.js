/**
 * Aether 一键发布脚本 — 打包 + 同步 + 上传 GitHub
 *
 * 功能：
 *   1. 一键打包：shared/backend/frontend/mobile 构建 + EXE 便携版 + NSIS Setup + Android APK
 *   2. 同步上传：自用版提交 → 文件级差异同步到开源版 → 开源版提交 → push GitHub → 创建/更新 Release
 *
 * 用法：
 *   node build/release-all.js                # 全流程（build + sync + release）
 *   node build/release-all.js --skip-build   # 跳过打包（仅同步+发布）
 *   node build/release-all.js --skip-sync    # 跳过同步（仅打包+发布本地产物）
 *   node build/release-all.js --skip-release # 打包+同步但不创建 GitHub Release
 *
 * 环境要求：
 *   - Node 20+ / JDK 21（APK）/ Android SDK（APK）
 *   - gh CLI 已认证（gh auth status）
 *   - 自用版与开源版为两个本地目录（见下方路径常量）
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============ 配置 ============
const PRIVATE_DIR = path.resolve(__dirname, '..');              // 自用版根
const OPENSOURCE_DIR = 'D:\\Aether-OpenSource';                  // 开源版根
const GITHUB_REPO = 'ybwlbrm/aether';                            // GitHub 仓库
const JAVA_HOME = 'C:\\Program Files\\Microsoft\\jdk-21.0.12.101-hotspot'; // JDK 21
const VERSION = require(path.join(PRIVATE_DIR, 'package.json')).version;  // 从 package.json 读取
const TAG = 'v' + VERSION;

// 同步时排除的 PRIVATE_ONLY 路径（与 docs/SYNC_MANIFEST.md 一致）
// 注意：只排除「构建产物 / 个人数据 / 密钥」，保留 build/*.js 打包脚本（开源版需要它们）。
// 逐项说明：
//   data/ qa/                     → 个人数据 / QA 截图
//   dist dist_electron dist_exe dist_release  → 构建产物目录
//   build/sqljs_dist build/backend-bundle.js → bundle 中间产物
//   android/app/build             → gradle 构建产物
//   android/*.jks android/keystore.properties → 签名与密钥
//   *.log *.db                    → 日志 / 数据库
//   docs/architecture/            → 私有架构文档
//   src/mobile/dist               → mobile 构建产物
//   Aether-Mobile.apk cap_sync.log smoke_*.txt server_*.txt eb_run*.log pack_*.log tsc_output.txt → 根目录杂项
const EXCLUDE = /^(data\/|qa\/|dist|dist_electron|dist_exe|dist_release|build\/sqljs_dist|build\/backend-bundle\.js|android\/app\/build\/|docs\/architecture\/|Aether-Mobile\.apk|cap_sync\.log|smoke_.*\.txt|server_.*\.txt|eb_run.*\.log|pack_.*\.log|tsc_output\.txt|src\/mobile\/dist\/|.*\.jks$|.*keystore\.properties$|.*\.log$|.*\.db$)/;

// ============ 工具 ============
function run(cmd, cwd) {
  console.log('  > ' + cmd);
  try {
    return execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf-8', windowsHide: true });
  } catch (e) {
    const out = (e.stdout || '') + (e.stderr || '');
    if (out) console.log(out.split('\n').slice(-5).join('\n'));
    throw new Error('命令失败: ' + cmd + '\n' + out.slice(-500));
  }
}

function log(step, msg) {
  console.log('\n[' + step + '] ' + msg);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

// ============ 1. 打包 ============
async function buildAll() {
  log('BUILD', '开始打包 Aether ' + VERSION);
  run('npm run build -w src/shared', PRIVATE_DIR);
  run('npm run build -w src/backend', PRIVATE_DIR);
  run('npm run build -w src/frontend', PRIVATE_DIR);

  log('BUILD', '生成 EXE 便携版 + NSIS Setup...');
  run('node build/build-exe.js', PRIVATE_DIR);

  log('BUILD', '构建 mobile 前端并打包 APK...');
  run('npm run build:mobile', PRIVATE_DIR);
  run('npx cap sync android', PRIVATE_DIR);
  // 修复：原 `set JAVA_HOME=... && cd android && gradlew.bat` 在 execSync(cmd) 下
  // 报 "JAVA_HOME is set to an invalid directory"。改用 cmd /c + env 注入，
  // 确保 gradle 读取正确的 JAVA_HOME（.bat 必须经 cmd 启动）。
  function runGradle() {
    const { spawnSync } = require('child_process');
    const gradlePath = path.join(PRIVATE_DIR, 'android', 'gradlew.bat');
    const res = spawnSync('cmd', ['/c', gradlePath, 'assembleRelease'], {
      cwd: path.join(PRIVATE_DIR, 'android'),
      env: { ...process.env, JAVA_HOME },
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
    });
    if (res.status !== 0) throw new Error('gradlew assembleRelease 失败 (exit ' + res.status + ')');
  }
  runGradle();

  // 复制 APK 到根目录
  const apk = path.join(PRIVATE_DIR, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
  if (fs.existsSync(apk)) fs.copyFileSync(apk, path.join(PRIVATE_DIR, 'Aether-Mobile.apk'));
  log('BUILD', '打包完成');
}

// ============ 2. 同步 ============
function syncToOpenSource() {
  log('SYNC', '提交自用版...');
  run('git add -A', PRIVATE_DIR);
  try {
    run('git commit -m "release: Aether ' + VERSION + '"', PRIVATE_DIR);
  } catch { /* 无改动时 commit 失败可忽略 */ }

  log('SYNC', '文件级差异同步到开源版 (' + OPENSOURCE_DIR + ')...');
  // 用自用版 git 受控文件列表，排除 PRIVATE_ONLY 后复制到开源版
  const files = run('git ls-files', PRIVATE_DIR).split('\n')
    .filter(Boolean)
    .filter((f) => !EXCLUDE.test(f));

  let copied = 0;
  let deleted = 0;
  for (const f of files) {
    const src = path.join(PRIVATE_DIR, f);
    const dst = path.join(OPENSOURCE_DIR, f);
    if (!fs.existsSync(src)) continue;
    // 仅当内容不同才复制（跳过未变化文件）
    if (fs.existsSync(dst)) {
      const a = fs.readFileSync(src);
      const b = fs.readFileSync(dst);
      if (a.equals(b)) continue;
    }
    ensureDir(path.dirname(dst));
    fs.copyFileSync(src, dst);
    copied++;
  }
  // 清理开源版中已在自用版删除的文件（同样受 EXCLUDE 保护）
  const openFiles = run('git ls-files', OPENSOURCE_DIR).split('\n').filter(Boolean);
  for (const f of openFiles) {
    if (EXCLUDE.test(f)) continue;
    if (!fs.existsSync(path.join(PRIVATE_DIR, f))) {
      const dst = path.join(OPENSOURCE_DIR, f);
      if (fs.existsSync(dst)) { fs.unlinkSync(dst); deleted++; }
    }
  }
  console.log('  > 同步 ' + copied + ' 个变更文件' + (deleted > 0 ? ('，删除 ' + deleted + ' 个废弃文件') : ''));

  log('SYNC', '提交开源版...');
  run('git add -A', OPENSOURCE_DIR);
  try {
    run('git commit -m "release: Aether ' + VERSION + '"', OPENSOURCE_DIR);
  } catch { /* 无改动时 commit 失败可忽略 */ }
}

// ============ 3. 发布 ============
async function release() {
  log('RELEASE', '上传 GitHub (' + GITHUB_REPO + ')...');
  // 修复：移除 -c http.proxy=/-c https.proxy= 强制清空代理。
  // 本机走 127.0.0.1:7897 代理才能访问 GitHub，清空代理导致 Connection reset。
  // 保留 git 全局/环境代理配置（或让用户通过 HTTPS_PROXY 配置）。
  run('git push origin master', OPENSOURCE_DIR);

  const assets = [
    path.join(PRIVATE_DIR, 'dist_electron', 'Aether Setup ' + VERSION + '.exe'),
    path.join(PRIVATE_DIR, 'Aether-Mobile.apk'),
  ].filter((a) => fs.existsSync(a));

  if (assets.length === 0) {
    throw new Error('未找到构建产物（Setup exe / APK），请先执行打包');
  }

  // 生成 SHA256 到临时文件（避免 cmd 转义问题）
  const hashes = assets.map((a) => '- ' + path.basename(a) + ': `' + sha256(a) + '`').join('\n');
  const noteFile = path.join(require('os').tmpdir(), 'aether-release-notes-' + VERSION + '.md');
  fs.writeFileSync(noteFile, 'Aether ' + VERSION + ' — 架构收口版本\n\n## SHA256\n' + hashes + '\n', 'utf-8');

  // 删除旧 release（若存在）后重建，保证资产与源码同一提交
  try {
    run('gh release delete ' + TAG + ' --repo ' + GITHUB_REPO + ' --yes', PRIVATE_DIR);
  } catch { /* 无旧 release 时忽略 */ }

  // ===== 版本绑定修复（严重：Release Tag 与最新 master 不一致）=====
  // 原实现：gh release create 复用已存在的 v2.2.0 tag → tag 停留在第一次创建时的
  // 旧 commit，而 push 已推进 master → Release 资产（EXE/APK）是新代码，但 tag 指向旧代码，
  // GitHub Release 页签的源码/下载是旧版本。
  // 修复：创建 release 前先删除远程 tag 与本地 tag，使 `gh release create v2.2.0`
  // 基于当前 master HEAD 重新打 tag（targetCommitish=最新提交）。
  try {
    run('git push origin :refs/tags/' + TAG, OPENSOURCE_DIR);  // 删除远程 tag
  } catch { /* tag 不存在时忽略 */ }
  try {
    run('git tag -d ' + TAG, OPENSOURCE_DIR);  // 删除本地 tag（如有）
  } catch { /* 本地无 tag 时忽略 */ }
  // 在最新 master HEAD 上创建新 tag（指向当前提交）
  run('git tag ' + TAG, OPENSOURCE_DIR);
  run('git push origin ' + TAG, OPENSOURCE_DIR);

  const assetArgs = assets.map((a) => '"' + a + '"').join(' ');
  run('gh release create ' + TAG + ' ' + assetArgs + ' --repo ' + GITHUB_REPO + ' --title "Aether ' + VERSION + '" --notes-file "' + noteFile + '"', PRIVATE_DIR);
  log('RELEASE', '已发布 https://github.com/' + GITHUB_REPO + '/releases/tag/' + TAG);
}

// ============ 入口 ============
async function main() {
  const args = process.argv.slice(2);
  const skipBuild = args.includes('--skip-build');
  const skipSync = args.includes('--skip-sync');
  const skipRelease = args.includes('--skip-release');

  console.log('============================================');
  console.log(' Aether 一键发布 v' + VERSION);
  console.log('============================================');

  const start = Date.now();
  if (!skipBuild) await buildAll();
  if (!skipSync) syncToOpenSource();
  if (!skipRelease) await release();

  console.log('\n✅ 全部完成，耗时 ' + ((Date.now() - start) / 1000).toFixed(1) + 's');
  if (skipRelease) console.log('（--skip-release 已指定，跳过 GitHub Release 创建）');
}

main().catch((e) => {
  console.error('\n❌ 发布失败:', e.message);
  process.exit(1);
});
