/**
 * EXE 桌面版打包脚本
 * 
 * 流程:
 * 1. 构建 shared + backend + frontend
 * 2. 用 esbuild 打包后端为单文件
 * 3. 使用 @electron/packager 创建 exe 版本
 * 4. 输出到 dist_exe/ 目录
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist_exe');

function run(cmd, cwd = ROOT) {
  console.log(`  > ${cmd}`);
  execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf-8' });
}

function log(step, msg) {
  console.log(`\n[${step}] ${msg}`);
}

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Aether                               ║');
  console.log('║   EXE 桌面版打包工具                    ║');
  console.log('╚══════════════════════════════════════════╝\n');

  // Step 1: 清理
  log('1/8', '清理旧构建...');
  if (fs.existsSync(DIST_DIR)) {
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(DIST_DIR, { recursive: true });

  // Step 2: 构建共享模块
  log('2/8', '构建共享模块 @pacc/shared...');
  run('npm run build -w src/shared');

  // Step 3: 构建后端
  log('3/8', '构建后端 @pacc/backend...');
  run('npm run build -w src/backend');

  // Step 4: esbuild 打包后端为单文件
  log('4/8', 'esbuild 打包后端为单文件...');
  run('node build/bundle-backend.js');

  // Step 5: 构建前端
  log('5/8', '构建前端 @pacc/frontend...');
  run('npm run build -w src/frontend');

  // Step 6: 创建 EXE 应用的目录结构
  log('6/8', '组装 EXE 应用目录...');
  
  const appDir = path.join(DIST_DIR, 'app');
  const resourcesDir = path.join(appDir, 'resources');
  const appResourcesDir = path.join(resourcesDir, 'app');
  
  fs.mkdirSync(path.join(appResourcesDir, 'electron'), { recursive: true });
  fs.mkdirSync(path.join(appResourcesDir, 'build'), { recursive: true });
  fs.mkdirSync(path.join(appResourcesDir, 'src', 'frontend', 'dist'), { recursive: true });

  // 复制 electron/main.js
  fs.copyFileSync(
    path.join(ROOT, 'electron', 'main.js'),
    path.join(appResourcesDir, 'electron', 'main.js')
  );

  // 复制 electron/preload.js（桌面通知 IPC 桥接）
  const preloadJs = path.join(ROOT, 'electron', 'preload.js');
  if (fs.existsSync(preloadJs)) {
    fs.copyFileSync(preloadJs, path.join(appResourcesDir, 'electron', 'preload.js'));
  }

  // 复制 build/backend-bundle.js
  fs.copyFileSync(
    path.join(ROOT, 'build', 'backend-bundle.js'),
    path.join(appResourcesDir, 'build', 'backend-bundle.js')
  );

  // 复制 build/lib/worker.js（thread-stream worker）
  const workerLib = path.join(ROOT, 'build', 'lib');
  if (fs.existsSync(workerLib)) {
    const destLib = path.join(appResourcesDir, 'build', 'lib');
    if (!fs.existsSync(destLib)) fs.mkdirSync(destLib, { recursive: true });
    const files = fs.readdirSync(workerLib);
    for (const f of files) {
      fs.copyFileSync(path.join(workerLib, f), path.join(destLib, f));
    }
  }

  // 复制 build/worker.js（pino worker）
  const pinoWorker = path.join(ROOT, 'build', 'worker.js');
  if (fs.existsSync(pinoWorker)) {
    fs.copyFileSync(pinoWorker, path.join(appResourcesDir, 'build', 'worker.js'));
  }

  // 复制 build/static/（swagger-ui 静态资源）
  const swaggerStatic = path.join(ROOT, 'build', 'static');
  if (fs.existsSync(swaggerStatic)) {
    const destStatic = path.join(appResourcesDir, 'build', 'static');
    if (!fs.existsSync(destStatic)) fs.mkdirSync(destStatic, { recursive: true });
    const files = fs.readdirSync(swaggerStatic);
    for (const f of files) {
      fs.copyFileSync(path.join(swaggerStatic, f), path.join(destStatic, f));
    }
  }

  // 复制 build/sql-wasm.wasm
  fs.copyFileSync(
    path.join(ROOT, 'build', 'sql-wasm.wasm'),
    path.join(appResourcesDir, 'build', 'sql-wasm.wasm')
  );

  // 复制 build/sql-wasm.js
  fs.copyFileSync(
    path.join(ROOT, 'build', 'sql-wasm.js'),
    path.join(appResourcesDir, 'build', 'sql-wasm.js')
  );

  // 复制 build/yt-dlp.exe（工具箱「YouTube 下载」依赖，随包分发避免用户额外安装）
  const ytDlpExe = path.join(ROOT, 'build', 'yt-dlp.exe');
  if (fs.existsSync(ytDlpExe)) {
    fs.copyFileSync(ytDlpExe, path.join(appResourcesDir, 'build', 'yt-dlp.exe'));
    console.log('  ✓ 复制 yt-dlp.exe');
  } else {
    console.log('  ⚠ 未找到 yt-dlp.exe（YouTube 下载将使用系统 yt-dlp）');
  }

  // 自包含修复：复制内置 ffmpeg.exe + ffprobe.exe（音频/视频转换依赖，
  // 随包分发后用户机器无需单独安装 ffmpeg）
  const ffmpegExe = path.join(ROOT, 'build', 'ffmpeg.exe');
  if (fs.existsSync(ffmpegExe)) {
    fs.copyFileSync(ffmpegExe, path.join(appResourcesDir, 'build', 'ffmpeg.exe'));
    console.log('  ✓ 复制 ffmpeg.exe');
  } else {
    console.log('  ⚠ 未找到 ffmpeg.exe（音频转换将使用系统 ffmpeg）');
  }
  const ffprobeExe = path.join(ROOT, 'build', 'ffprobe.exe');
  if (fs.existsSync(ffprobeExe)) {
    fs.copyFileSync(ffprobeExe, path.join(appResourcesDir, 'build', 'ffprobe.exe'));
    console.log('  ✓ 复制 ffprobe.exe');
  }

  // 复制前端 dist
  const frontendDist = path.join(ROOT, 'src', 'frontend', 'dist');
  const copyDir = (src, dest) => {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    const items = fs.readdirSync(src);
    for (const item of items) {
      const s = path.join(src, item);
      const d = path.join(dest, item);
      if (fs.statSync(s).isDirectory()) {
        copyDir(s, d);
      } else {
        fs.copyFileSync(s, d);
      }
    }
  };
  copyDir(frontendDist, path.join(appResourcesDir, 'src', 'frontend', 'dist'));

  // 复制 node_modules/sql.js（后端运行时 external 依赖）
  log('6.6/8', '复制 sql.js 模块...');
  const sqlJsSrc = path.join(ROOT, 'node_modules', 'sql.js');
  const sqlJsDest = path.join(appResourcesDir, 'node_modules', 'sql.js');
  copyDir(sqlJsSrc, sqlJsDest);

  // 复制 native 模块（@napi-rs/canvas, sharp, koffi 等 esbuild external 的依赖）
  log('6.7/8', '复制 native 模块...');
  // 黑屏修复：koffi 是 DPAPI 主密钥解密的原生模块，必须复制进 EXE，
  // 否则后端启动时 keystore 解密失败 → 后端崩溃 → 窗口黑屏。
  const nativeModules = ['@napi-rs/canvas', '@napi-rs/canvas-win32-x64-msvc', 'sharp', 'koffi'];
  for (const mod of nativeModules) {
    const src = path.join(ROOT, 'node_modules', mod);
    const dest = path.join(appResourcesDir, 'node_modules', mod);
    if (fs.existsSync(src)) {
      copyDir(src, dest);
      console.log(`  ✓ 复制 ${mod}`);
    } else {
      console.log(`  ⚠ 未找到 ${mod}，跳过`);
    }
  }
  // P2 修复：sharp 0.33+ 的二进制由 @img/sharp-win32-x64 提供（可选依赖）。
  // 若不复制 @img 目录，打包后的 EXE 中 sharp 报 "Could not find the required module '@img/sharp-win32-x64'"。
  try {
    const imgDir = path.join(ROOT, 'node_modules', '@img');
    if (fs.existsSync(imgDir)) {
      copyDir(imgDir, path.join(appResourcesDir, 'node_modules', '@img'));
      console.log('  ✓ 复制 @img/sharp 二进制');
    }
  } catch (e) {
    console.log(`  ⚠ 复制 @img 失败: ${e.message}`);
  }

  // 黑屏修复：koffi 的 .node 二进制由 @koromix/koffi-win32-x64 平台包提供（optionalDependencies）。
  // koffi 通过 `../../../@koromix/koffi-<platform>` 相对路径加载，若不复制该目录，
  // EXE 中 keystore DPAPI 解密失败 → 后端崩溃 → 窗口黑屏。
  try {
    const koromixDir = path.join(ROOT, 'node_modules', '@koromix');
    if (fs.existsSync(koromixDir)) {
      copyDir(koromixDir, path.join(appResourcesDir, 'node_modules', '@koromix'));
      console.log('  ✓ 复制 @koromix/koffi 二进制');
    } else {
      console.log('  ⚠ 未找到 @koromix，跳过');
    }
  } catch (e) {
    console.log(`  ⚠ 复制 @koromix 失败: ${e.message}`);
  }

  // P1 修复：playwright 是 /api/testing 运行时 external 依赖，必须复制进 EXE 包，
  // 否则桌面版「网页自动化测试」功能会因找不到模块而崩溃。
  log('6.8/8', '复制 playwright 及其浏览器运行时...');
  const playwrightDeps = ['playwright', 'playwright-core', 'chromium-bidi', 'graceful-fs'];
  for (const mod of playwrightDeps) {
    const src = path.join(ROOT, 'node_modules', mod);
    const dest = path.join(appResourcesDir, 'node_modules', mod);
    if (fs.existsSync(src)) {
      copyDir(src, dest);
      console.log(`  ✓ 复制 ${mod}`);
    } else {
      console.log(`  ⚠ 未找到 ${mod}，跳过`);
    }
  }
  // playwright 依赖的浏览器二进制（%LOCALAPPDATA%\ms-playwright）无法随包分发，
  // 首次运行时 testing 功能会提示执行 `npx playwright install chromium`。
  // 此处仅复制 playwright-cli 入口及 browsers.json 配置，让运行时能给出清晰报错指引。
  try {
    const pwCliDir = path.join(ROOT, 'node_modules', 'playwright', 'cli.js');
    if (fs.existsSync(pwCliDir)) {
      fs.copyFileSync(pwCliDir, path.join(appResourcesDir, 'node_modules', 'playwright', 'cli.js'));
    }
  } catch (e) {
    console.log(`  ⚠ 复制 playwright cli 失败: ${e.message}`);
  }

  // 复制 icon
  const iconSrc = path.join(ROOT, 'build', 'icon.png');
  if (fs.existsSync(iconSrc)) {
    fs.copyFileSync(iconSrc, path.join(resourcesDir, 'icon.png'));
  }

  // 复制 package.json
  const pkg = {
    name: 'aether',
    version: '1.0.0',
    main: 'electron/main.js',
    private: true,
  };
  fs.writeFileSync(path.join(appResourcesDir, 'package.json'), JSON.stringify(pkg, null, 2));

  // Step 7: 复制 Electron 和创建启动脚本
  log('7/8', '复制 Electron 运行时...');
  
  const electronDir = path.join(ROOT, 'node_modules', 'electron', 'dist');
  copyDir(electronDir, appDir);

  // 重命名 electron.exe 为应用名
  const appExe = path.join(appDir, 'Aether.exe');
  if (fs.existsSync(path.join(appDir, 'electron.exe'))) {
    fs.renameSync(path.join(appDir, 'electron.exe'), appExe);
  }

  // 创建启动脚本 (方便调试)
  const runBat = path.join(DIST_DIR, '启动应用.bat');
  // P2 修复：bat 中文乱码的三种错误组合：
  //  (1) UTF-8 写入 + 无 chcp 65001 → cmd 按 ANSI 读 UTF-8 字节 → 乱码
  //  (2) GBK 写入 + chcp 65001 → 代码页切到 UTF-8 后按 UTF-8 读 GBK 字节 → 乱码
  // 正确组合 = UTF-8 编码文件 + chcp 65001（代码页与文件编码一致）
  const runBatContent = '@echo off\r\nchcp 65001 >nul\r\ncd /d "%~dp0"\r\n:: 杀掉占用 3000 端口的旧进程（防止端口冲突导致黑屏）\r\npowershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue; if ($c) { $c | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } }" >nul 2>&1\r\ntimeout /t 1 /nobreak >nul\r\nstart "" "app\\Aether.exe"\r\necho 应用已启动！\r\n';
  fs.writeFileSync(runBat, Buffer.from(runBatContent, 'utf8'));

  // Step 8: 计算大小
  log('8/8', '计算打包结果...');
  let totalSize = 0;
  const walkDir = (dir) => {
    const items = fs.readdirSync(dir);
    for (const item of items) {
      const p = path.join(dir, item);
      const stat = fs.statSync(p);
      if (stat.isDirectory()) {
        walkDir(p);
      } else {
        totalSize += stat.size;
      }
    }
  };
  walkDir(DIST_DIR);

  console.log(`\n✅ 便携版打包完成!`);
  console.log(`   输出目录: ${DIST_DIR}`);
  console.log(`   总大小: ${(totalSize / 1024 / 1024).toFixed(1)} MB`);
  console.log(`   启动文件: ${DIST_DIR}\\启动应用.bat`);
  console.log(`   主程序: ${DIST_DIR}\\app\\Aether.exe`);

  // Step 9: 生成 NSIS 安装包
  log('9/9', '生成 NSIS 安装包...');
  try {
    // 用命令行参数动态注入当前机器的绝对路径（不依赖 yml 硬编码），
    // 保证项目被 clone 到任意目录后都能正确打包。
    const outDir = path.join(ROOT, 'dist_electron').replace(/\\/g, '/');
    const buildRes = path.join(ROOT, 'build').replace(/\\/g, '/');
    run(`npx electron-builder --config electron/electron-builder.yml --win --x64 -c.directories.output="${outDir}" -c.directories.buildResources="${buildRes}"`);
    console.log(`\n✅ NSIS 安装包生成完成!`);
    console.log(`   输出目录: ${path.join(ROOT, 'dist_electron')}`);
  } catch (e) {
    console.error(`\n⚠ NSIS 安装包生成失败: ${e.message}`);
    console.log(`   便携版仍可正常使用: ${DIST_DIR}`);
  }
}

main().catch(err => {
  console.error('打包失败:', err);
  process.exit(1);
});