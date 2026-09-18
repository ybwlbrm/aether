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
const TAG = `v${VERSION}`;

// 同步时排除的 PRIVATE_ONLY 路径（与 docs/SYNC_MANIFEST.md 一致）
const EXCLUDE = /^(data\/|qa\/|dist|build\/|android\/app\/build|\.jks$|keystore|\.log$|\.db$|docs\/architecture\/)/;

// ============ 工具 ============
function run(cmd, cwd, silent = false) {
  console.log(`  > ${cmd}`);
  try {
    return execSync(cmd, { cwd, stdio: silent ? 'pipe' : 'pipe', encoding: 'utf-8', windowsHide: true });
  } catch (e) {
    const out = (e.stdout || '') + (e.stderr || '');
    if (out) console.log(out.split('\n').slice(-5).join('\n'));
    throw new Error(`命令失败: ${cmd}\n${out.slice(-500)}`);
  }
}

function log(step, msg) {
  console.log(`\n[${step}] ${msg}`);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

// ============ 1. 打包 ============
async function buildAll() {
  log('BUILD', `开始打包 Aether ${VERSION}`);
  run('npm run build -w src/shared', PRIVATE_DIR);
  run('npm run build -w src/backend', PRIVATE_DIR);
  run('npm run build -w src/frontend', PRIVATE_DIR);

  log('BUILD', '生成 EXE 便携版 + NSIS Setup...');
  run('node build/build-exe.js', PRIVATE_DIR);

  log('BUILD', '构建 mobile 前端并打包 APK...');
  run('npm run build:mobile', PRIVATE_DIR);
  run('npx cap sync android', PRIVATE_DIR);
  const gradle = `set JAVA_HOME=${JAVA_HOME} && cd android && gradlew.bat assembleRelease`;
  run(gradle, PRIVATE_DIR);

  // 复制 APK 到根目录
  const apk = path.join(PRIVATE_DIR, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
  if (fs.existsSync(apk)) fs.copyFileSync(apk, path.join(PRIVATE_DIR, 'Aether-Mobile.apk'));
  log('BUILD', '打包完成');
}

// ============ 2. 同步 ============
function syncToOpenSource() {
  log('SYNC', '提交自用版...');
  run('git add -A', PRIVATE_DIR);
  run(`git commit -m "release: Aether ${VERSION}" || exit 0`, PRIVATE_DIR, true);

  log('SYNC', `文件级差异同步到开源版 (${OPENSOURCE_DIR})...`);
  // 获取自用版相对上次发布点的新增/修改文件（这里用 git 全部受控文件对比开源版）
  const files = run('git ls-files', PRIVATE_DIR).split('\n')
    .filter(Boolean)
    .filter(f => !EXCLUDE.test(f));

  let copied = 0;
  for (const f of files) {
    const src = path.join(PRIVATE_DIR, f);
    const dst = path.join(OPENSOURCE_DIR, f);
    if (!fs.existsSync(src)) continue;
    // 仅当内容不同才复制（跳过未变化文件）
    if (fs.existsSync(dst)) {
      const a = fs.readFileSync(src); const b = fs.readFileSync(dst);
      if (a.equals(b)) continue;
    }
    ensureDir(path.dirname(dst));
    fs.copyFileSync(src, dst);
    copied++;
  }
  console.log(`  > 同步 ${copied} 个变更文件`);

  log('SYNC', '提交开源版...');
  run('git add -A', OPENSOURCE_DIR);
  run(`git commit -m "release: Aether ${VERSION}" || exit 0`, OPENSOURCE_DIR, true);
}

// ============ 3. 发布 ============
async function release() {
  log('RELEASE', `上传 GitHub (${GITHUB_REPO})...`);
  // 绕过可能失效的本地代理直连 GitHub
  run('git -c http.proxy= -c https.proxy= push origin master', OPENSOURCE_DIR);

  const assets = [
    path.join(PRIVATE_DIR, 'dist_electron', `Aether Setup ${VERSION}.exe`),
    path.join(PRIVATE_DIR, 'Aether-Mobile.apk'),
  ].filter(a => fs.existsSync(a));

  if (assets.length === 0) {
    throw new Error('未找到构建产物（Setup exe / APK），请先执行打包');
  }

  // 生成 SHA256
  const hashes = assets.map(a => `- ${path.basename(a)}: \`${sha256(a)}\``).join('\n');

  // 删除旧 release（若存在）后重建，保证资产与源码同一提交
  run(`gh release delete ${TAG} --repo ${GITHUB_REPO} --yes || exit 0`, PRIVATE_DIR, true);
  const note = `Aether ${VERSION} — 架构收口版本

## SHA256
${hashes}
`;
  run(`gh release create ${TAG} ${assets.map(a => `"${a}"`).join(' ')} --repo ${GITHUB_REPO} --title "Aether ${VERSION}" --notes "${note.replace(/"/g, '\\"')}"`, PRIVATE_DIR);
  log('RELEASE', `已发布 https://github.com/${GITHUB_REPO}/releases/tag/${TAG}`);
}

// ============ 入口 ============
async function main() {
  const args = process.argv.slice(2);
  const skipBuild = args.includes('--skip-build');
  const skipSync = args.includes('--skip-sync');
  const skipRelease = args.includes('--skip-release');

  console.log('============================================');
  console.log(` Aether 一键发布 v${VERSION}`);
  console.log('============================================');

  const start = Date.now();
  if (!skipBuild) await buildAll();
  if (!skipSync) syncToOpenSource();
  if (!skipRelease) await release();

  console.log(`\n✅ 全部完成，耗时 ${((Date.now() - start) / 1000).toFixed(1)}s`);
  if (skipRelease) console.log('（--skip-release 已指定，跳过 GitHub Release 创建）');
}

main().catch(e => {
  console.error('\n❌ 发布失败:', e.message);
  process.exit(1);
});
