import { buildApp } from './app.js';
import { loadBackendConfig } from './config/index.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';

const __dirname = dirname(fileURLToPath(import.meta.url));

let app: Awaited<ReturnType<typeof buildApp>> | null = null;

/** 优雅关闭：Electron 主进程退出前发送 IPC，让后端落盘后再退出，防止 sql.js 内存库损坏 */
function registerShutdownHandler(): void {
  // 后端通过 fork + IPC 启动（ELECTRON_RUN_AS_NODE），接收主进程发来的 shutdown 消息
  const onMessage = (msg: unknown) => {
    if (msg && typeof msg === 'object' && (msg as { type?: string }).type === 'shutdown') {
      console.log('🛑 收到 shutdown 消息，优雅落盘并退出...');
      const doExit = () => {
        try { process.exit(0); } catch (_e: unknown) { /* ignore - intentional */ }
      };
      if (app) {
        app.close()
          .then(() => { console.log('✅ 已优雅关闭'); doExit(); })
          .catch(() => doExit());
        // 兜底：3s 内没关完强制退出
        setTimeout(doExit, 3000);
      } else {
        doExit();
      }
    }
  };
  if (typeof process.on === 'function' && (process as unknown as { connected?: boolean }).connected !== false) {
    process.on('message', onMessage);
  }
}

async function main() {
  registerShutdownHandler();
  const config = await loadBackendConfig();
  app = await buildApp(config);

  // 尝试提供前端静态文件
  // 可能的路径（按优先级）：
  // 1. Electron 打包路径 (process.resourcesPath)
  // 2. 开发路径 (src/backend/dist/../../frontend/dist)
  // 3. 构建路径 (build/../src/frontend/dist)
  let frontendDist: string | null = null;

  // 尝试路径数组
  const possiblePaths = [
    // Electron 打包
    ...((process as any).resourcesPath ? [resolve((process as any).resourcesPath, 'frontend')] : []),
    // 开发模式
    resolve(__dirname, '../../frontend/dist'),
    // 构建模式 (bundle 在 build/ 目录下)
    resolve(__dirname, '../src/frontend/dist'),
    // 相对根目录
    resolve(__dirname, '../../../src/frontend/dist'),
  ];

  for (const p of possiblePaths) {
    if (existsSync(p)) {
      frontendDist = p;
      break;
    }
  }

  if (frontendDist) {
    await app.register(fastifyStatic, {
      root: frontendDist,
      prefix: '/',
      wildcard: false,
    });

    // SPA 支持：API 路径返回 404 JSON，其余未匹配路由返回 index.html (P2-12)
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.status(404).send({ error: { message: `Not Found: ${request.method} ${request.url}` } });
      }
      const indexPath = resolve(frontendDist!, 'index.html');
      if (existsSync(indexPath)) {
        reply.type('text/html').send(readFileSync(indexPath, 'utf-8'));
      } else {
        reply.status(404).send({ error: { message: 'Not Found' } });
      }
    });

    console.log(`🌐 前端静态文件已加载: ${frontendDist}`);
  } else {
    console.log('⚠️ 前端未构建，请运行 npm run build -w src/frontend');
  }

  try {
    await app.listen({ port: config.port, host: config.host });
    console.log(`\n🚀 Aether 已启动!`);
    console.log(`📱 打开: http://${config.host}:${config.port}`);
    console.log(`📚 API 文档: http://${config.host}:${config.port}/docs`);
    console.log(`💾 数据目录: ${resolve(config.dataDir)}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();