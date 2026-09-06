const { app, BrowserWindow, Tray, Menu, dialog, nativeImage, ipcMain, Notification, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');

// P1-8 修复：单实例锁 — 防止多开 Aether.exe 导致 3000 端口冲突与数据竞态。
// 第二个实例启动时聚焦已有窗口并退出。
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let mainWindow = null;
let serverProcess = null;
let tray = null;
let restartCount = 0;
const MAX_SERVER_RESTARTS = 5;
app.isQuitting = false;

const isDev = !app.isPackaged;
const DATA_DIR = isDev
  ? path.join(__dirname, '..', 'data')
  : path.join(app.getPath('documents'), 'AICommandCenter');

// P1-17/P1-18：健康检查 — 判断后端是否真正 Ready（而不是看 stdout 文本）
// - P1-17：stdout.includes('已启动'/'3000') 不可靠 → 改为 HTTP 健康轮询
// - P1-18：EADDRINUSE 不能直接当成功 → 必须 GET /api/health 验证确实是 Aether
const BACKEND_PORT = 3000;
const HEALTH_URL = `http://127.0.0.1:${BACKEND_PORT}/api/health`;
const HEALTH_INTERVAL_MS = 500;
const HEALTH_TIMEOUT_MS = 20000;

/** 轮询 /api/health 直到返回 200 且是 Aether 实例（含 aether identity 校验） */
function waitForBackendHealth(timeoutMs = HEALTH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tryHealth = async () => {
      try {
        const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          // E1-001：必须是真正的 Aether 后端 —— 校验 health 响应的显式身份标识
          // （app/name 含 aether），而不是凭任意 JSON 的 status 字段就判定成功。
          // 防止"3000 被其他服务占用 → 误认为后端已启动"。
          const body = await res.json().catch(() => ({}));
          const appId = typeof body.app === 'string' ? body.app : '';
          const nameId = typeof body.name === 'string' ? body.name : '';
          const isAether = appId.toLowerCase() === 'aether' || /aether/i.test(nameId);
          if (isAether && typeof body.version === 'string' && body.version) {
            return resolve(body);
          }
        }
      } catch { /* 尚未就绪，继续轮询 */ }
      if (Date.now() >= deadline) {
        return reject(new Error(`后端健康检查超时（${timeoutMs}ms）：${HEALTH_URL}`));
      }
      setTimeout(tryHealth, HEALTH_INTERVAL_MS);
    };
    tryHealth();
  });
}

/**
 * P1-19：运行恢复扫描（Recovery Scan）
 * 后端 crash 后重新启动时，把遗留的 running/waiting Run 标记为 interrupted。
 * 优先调用后端 recovery 端点；不存在则 fallback（仅记录，等待后端自愈）。
 */
async function runRecoveryScan() {
  const endpoints = [
    '/api/runs/recover',
    '/api/runs/recovery',
    '/api/recovery',
    '/api/runs/repair',
  ];
  for (const ep of endpoints) {
    try {
      const res = await fetch(`http://127.0.0.1:${BACKEND_PORT}${ep}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        log(`[恢复] ${ep} → ${JSON.stringify(body).slice(0, 200)}`);
        return body;
      }
      if (res.status !== 404) {
        log(`[恢复] ${ep} 返回 ${res.status}`);
        return null;
      }
      // 404 = 端点不存在，继续尝试下一个
    } catch (e) {
      log(`[恢复] ${ep} 请求失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  log('[恢复] 未找到后端 recovery 端点 —— 由后端启动自检处理 interrupted runs（如有）');
  return null;
}

// 第二个实例触发时（单实例锁生效），聚焦已有窗口
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    mainWindow.show();
  }
});

// 日志文件
const LOG_FILE = path.join(DATA_DIR, 'electron.log');
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_e) { /* ignore */ }
}

function getServerPath() {
  if (isDev) return path.join(__dirname, '..', 'src', 'backend', 'dist', 'index.js');
  // 生产模式：app 目录（展开的 asar），兼容 app.asar 目录名
  const asarDir = path.join(process.resourcesPath, 'app.asar', 'build', 'backend-bundle.js');
  const appDir = path.join(process.resourcesPath, 'app', 'build', 'backend-bundle.js');
  if (require('fs').existsSync(asarDir)) return asarDir;
  return appDir;
}

function startServer() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const serverPath = getServerPath();
    if (!fs.existsSync(serverPath)) return reject(new Error(`后端文件未找到: ${serverPath}`));
    const env = {
      ...process.env, PORT: '3000', HOST: '127.0.0.1', DATA_DIR, NODE_ENV: 'production',
      ELECTRON_RUN_AS_NODE: '1',
    };
    serverProcess = fork(serverPath, [], { env, stdio: 'pipe' });
    let resolved = false;
    const tryResolve = () => {
      if (!resolved) { resolved = true; restartCount = 0; resolve(); }
    };
    // P1-17：stdout 仅用于日志记录，不再作为 Ready 判据
    serverProcess.stdout.on('data', (d) => { log(`[后端] ${d.toString().trim()}`); });
    serverProcess.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      log(`[后端:err] ${msg}`);
      // P1-18：EADDRINUSE 不再直接当成功 —— 先健康检查验证是不是 Aether
      if (msg.includes('EADDRINUSE') || msg.includes('address already in use')) {
        log('[后端] 端口被占用，健康检查验证是否为 Aether 实例...');
        waitForBackendHealth().then(tryResolve).catch((e) => log(`[后端] 端口占用但非 Aether 实例: ${e.message}`));
      }
    });
    serverProcess.on('error', (err) => { log(`[后端] fork 错误: ${err.message}`); reject(err); });
    // P0-2: 后端进程意外退出后自动重启（最多 5 次，间隔 3s），避免应用白屏
    // 正常退出（app quit 时主动 kill）不重启
    serverProcess.on('exit', (code) => {
      log(`[后端] 进程退出 (code: ${code})`);
      if (app.isQuitting) return;
      restartCount++;
      if (restartCount > MAX_SERVER_RESTARTS) {
        log(`[后端] 已连续崩溃 ${MAX_SERVER_RESTARTS} 次，停止自动重启`);
        return;
      }
      log(`[后端] ${restartCount}/${MAX_SERVER_RESTARTS} 次自动重启（3 秒后）...`);
      setTimeout(() => {
        try {
          startServer().then(tryResolve).catch((e) => log(`[后端] 重启失败: ${e.message}`));
        } catch (e) {
          log(`[后端] 重启异常: ${e instanceof Error ? e.message : String(e)}`);
        }
      }, 3000);
    });
    // P1-17：以健康检查为唯一 Ready 判据（不再无条件 15s resolve）
    waitForBackendHealth().then(tryResolve).catch((e) => {
      log(`[后端] 健康检查失败: ${e.message}`);
      // 后端进程可能已自行退出（如端口被非 Aether 占用），交给 exit 处理器决定是否重启
      if (!resolved && !app.isQuitting) {
        // 不立即 reject —— 若进程还活着则继续等待其后续输出/退出
      }
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900,
    minWidth: 1000, minHeight: 600,
    title: 'Aether',
    backgroundColor: '#0b0b0f',
    show: false,
    // 无边框窗口 — 去掉白色窗口边框，直接用内容填充
    // Windows 上保留原生窗口控制按钮（关闭/最小化/最大化），
    // 用完全透明 titleBarOverlay 替代纯黑背景（不挡住内容）
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: '#ffffff',
      height: 36,
    },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // P0-2: CSP 注入 — 通过 onHeadersReceived 为所有本地加载的页面附加严格 CSP，
  // 即使渲染进程被 XSS 注入也无法加载远程脚本（前端自身已内置 XSS 过滤，双保险）
  // 允许项：自身脚本/样式，内联样式（React 动态样式），data/blob 图片，同源+HTTPS connect（AI API 调用）
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const csp = [
      "default-src 'self'",
      // 前端 index.html 含内联 data-theme 初始化脚本（首屏防闪烁），
      // 必须放行 'unsafe-inline'，否则被此处 HTTP 头 CSP 覆盖后主题/渲染异常
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' https: http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*",
      "media-src 'self' blob: data:",
      "frame-src 'self' https: http://localhost:* http://127.0.0.1:*",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ');
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });

  // 直接加载新对话页面 — 使用 ?new=true 让前端无论什么模式都进入新对话空白页
  // 之前加载 /chat?new=true 只能在 Chat 组件创建新对话，但用户期望的是 CodingHome
  // 的 "What can I build for you?" 新对话页面。/command-center?new=true 可让
  // CommandCenter 强制进入 coding 模式并清空会话，每次启动都是全新的对话体验。
  mainWindow.loadURL('http://127.0.0.1:3000/command-center?new=true');

  // P1-2: 黑屏兜底 — ready-to-show 超时强制显示；加载失败展示可读错误页；
  // 渲染进程崩溃自动 reload，避免用户面对无响应的深色窗口。
  const showTimeout = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      log('ready-to-show 超时（20s），强制显示窗口 — 后端可能仍在启动中');
      mainWindow.show();
    }
  }, 20000);

  mainWindow.once('ready-to-show', () => {
    clearTimeout(showTimeout);
    mainWindow.show();
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    if (errorCode === -3) return; // ERR_ABORTED（主动导航/刷新），忽略
    log(`页面加载失败 (${errorCode}): ${errorDescription} — ${validatedURL}`);
    const desc = String(errorDescription || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>
      body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0b0f;color:#e8e8ea;font-family:system-ui,'Microsoft YaHei',sans-serif}
      .card{text-align:center;padding:40px} h1{font-size:22px;margin:0 0 12px}
      p{font-size:13px;color:#9a9aa2;margin:6px 0} code{background:#1c1c22;padding:2px 8px;border-radius:6px;font-size:12px;color:#ff8f6b}
      button{margin-top:20px;padding:9px 26px;border:0;border-radius:8px;background:#4f6df5;color:#fff;font-size:14px;cursor:pointer}
      button:hover{background:#5d79f7}</style></head><body>
      <div class="card"><h1>⚠️ 服务加载失败</h1>
      <p>本地后端未能正常响应（错误码 ${errorCode}：${desc}）。</p>
      <p>常见原因：后端启动组件损坏或数据目录异常。</p>
      <p>日志：<code>%USERPROFILE%\\Documents\\AICommandCenter\\electron.log</code></p>
      <button onclick="location.reload()">重试</button></div></body></html>`;
    mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => {});
    mainWindow.show();
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (app.isQuitting) return;
    log(`渲染进程异常退出: ${details.reason}`);
    setTimeout(() => {
      try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload(); } catch (_e) { /* ignore - intentional */ }
    }, 1000);
  });

  // P1-20: 工具箱「前往下载」等 target=_blank 外部链接 —
  // 默认会新建一个空白的 Electron 子窗口（白屏弹窗），改由系统默认浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (/^https?:\/\//i.test(url)) {
        shell.openExternal(url);
      }
    } catch (e) { log(`openExternal 失败: ${e.message}`); }
    return { action: 'deny' };
  });
}

// 创建托盘菜单
function createTray() {
  try {
    tray = new Tray(nativeImage.createEmpty());
    const ctx = Menu.buildFromTemplate([
      { label: '显示窗口', click: () => { if (mainWindow) mainWindow.show(); } },
      { type: 'separator' },
      { label: '退出', click: () => { app.quit(); } },
    ]);
    tray.setToolTip('Aether');
    tray.setContextMenu(ctx);
  } catch {}
}

app.whenReady().then(async () => {
  log(`模式: ${isDev ? '开发' : '生产'}`);
  log(`数据目录: ${DATA_DIR}`);
  log(`日志文件: ${LOG_FILE}`);

  // 系统通知 — 渲染进程通过 preload 桥接调用
  // P1-19 修复：校验 sender 来自主 frame，防止子 frame 伪造通知
  ipcMain.on('show-notification', (event, { title, body }) => {
    if (!event.senderFrame || !event.senderFrame.top) return; // 只允许主 frame
    if (!Notification.isSupported()) return;
    try {
      new Notification({ title: title || 'Aether', body: body || '' }).show();
    } catch (err) {
      log(`通知发送失败: ${err.message}`);
    }
  });

  try {
    log('正在启动后端服务...');
    await startServer();
    // P1-19：后端启动/重启成功后执行 recovery scan —— 发现并修复崩溃遗留的 running 状态 Run
    log('执行运行恢复扫描（recovery scan）...');
    await runRecoveryScan();
    log('后端已启动，正在创建窗口...');
    createWindow();
    createTray();
    log('应用启动完成');
  } catch (err) {
    log(`启动失败: ${err.message}`);
    dialog.showErrorBox('启动失败', err.message);
    app.quit();
  }
});

app.on('will-quit', () => {
  // P0-2: 标记退出中，防止 kill 子进程时触发自动重启循环
  app.isQuitting = true;
  if (serverProcess && !serverProcess.killed) {
    // 优雅关闭：先发 IPC 让后端 flush 落盘再退出（sql.js 是内存库，直接强杀会丢失/损坏数据）
    try {
      serverProcess.send({ type: 'shutdown' });
    } catch (_e) { /* ignore - intentional */ }
    // 兜底：2.5s 内后端未自行退出则强制终止（防止应用卡死）
    setTimeout(() => {
      try {
        if (serverProcess && !serverProcess.killed) serverProcess.kill();
      } catch (_e) { /* ignore - intentional */ }
    }, 2500);
  }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (mainWindow === null) { createWindow(); } });