// 使用 esbuild 将后端打包成单个文件
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

async function main() {
  console.log('=== 打包后端 ===');

  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'backend', 'dist', 'index.js')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    outfile: path.join(__dirname, 'backend-bundle.js'),
    format: 'cjs',
    minify: false,
    sourcemap: false,
    external: ['sql.js', '@napi-rs/canvas', '@napi-rs/canvas-win32-x64-msvc', 'sharp', 'playwright', 'playwright-core', 'chromium-bidi'],
    alias: {
      '@pacc/shared': path.join(__dirname, '..', 'src', 'shared', 'dist', 'index.js'),
    },
    banner: {
      js: `const importMetaUrl = require('url').pathToFileURL(__filename).href;\n`,
    },
    define: {
      'import.meta.url': 'importMetaUrl',
    },
  });

  // 复制 sql.js WASM 文件到输出目录
  const wasmFiles = [
    ['sql-wasm.wasm', 'sql-wasm.wasm'],
  ];

  for (const [src, dest] of wasmFiles) {
    const srcPath = path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', src);
    const destPath = path.join(__dirname, dest);
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, destPath);
      console.log(`  ✓ 复制 ${src} (${fs.statSync(srcPath).size} bytes)`);
    }
  }

  // 复制 sql.js 的 JS 入口
  const sqlJsSrc = path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.js');
  const sqlJsDest = path.join(__dirname, 'sql-wasm.js');
  fs.copyFileSync(sqlJsSrc, sqlJsDest);
  console.log(`  ✓ 复制 sql-wasm.js (${fs.statSync(sqlJsSrc).size} bytes)`);

  // 创建 sql.js 的 package.json 别名
  fs.writeFileSync(
    path.join(__dirname, 'sql.js-package.json'),
    JSON.stringify({ name: 'sql.js', main: 'sql-wasm.js' }, null, 2)
  );

  // 复制 thread-stream worker（pino 日志依赖，esbuild 打包后 __dirname 指向 build/）
  const threadStreamLib = path.join(__dirname, '..', 'node_modules', 'thread-stream', 'lib');
  const threadStreamDest = path.join(__dirname, 'lib');
  if (fs.existsSync(threadStreamLib)) {
    if (!fs.existsSync(threadStreamDest)) fs.mkdirSync(threadStreamDest, { recursive: true });
    const files = fs.readdirSync(threadStreamLib);
    for (const f of files) {
      const src = path.join(threadStreamLib, f);
      if (fs.statSync(src).isFile()) {
        fs.copyFileSync(src, path.join(threadStreamDest, f));
      }
    }
    console.log(`  ✓ 复制 thread-stream worker (${files.length} files)`);
  }

  // 复制 pino worker（pino-pretty 依赖）
  const pinoWorker = path.join(__dirname, '..', 'node_modules', 'pino', 'lib', 'worker.js');
  if (fs.existsSync(pinoWorker)) {
    fs.copyFileSync(pinoWorker, path.join(__dirname, 'worker.js'));
    console.log('  ✓ 复制 pino worker');
  }

  // 复制 @fastify/swagger-ui 静态资源（swagger 文档页面依赖）
  const swaggerStatic = path.join(__dirname, '..', 'node_modules', '@fastify', 'swagger-ui', 'static');
  const swaggerDest = path.join(__dirname, 'static');
  if (fs.existsSync(swaggerStatic)) {
    if (!fs.existsSync(swaggerDest)) fs.mkdirSync(swaggerDest, { recursive: true });
    const files = fs.readdirSync(swaggerStatic);
    for (const f of files) {
      const src = path.join(swaggerStatic, f);
      if (fs.statSync(src).isFile()) {
        fs.copyFileSync(src, path.join(swaggerDest, f));
      }
    }
    console.log(`  ✓ 复制 swagger-ui static (${files.length} files)`);
  }

  const bundleSize = fs.statSync(path.join(__dirname, 'backend-bundle.js')).size;
  console.log(`\n=== 打包完成 ===`);
  console.log(`  bundle: build/backend-bundle.js (${(bundleSize / 1024).toFixed(1)} KB)`);
  console.log(`  wasm:   build/sql-wasm.wasm`);
  console.log(`  sql.js: build/sql-wasm.js`);
}

main().catch(err => {
  console.error('打包失败:', err);
  process.exit(1);
});