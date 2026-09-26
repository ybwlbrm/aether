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

// P1-026：后端启动状态显式化 + 启动期不空白。
// 旧实现必须等 startServer() 成功才 createWindow()，而后端健康检查最长 20s，
// 期间连窗口都没有（进程像"卡死"），健康检查失败更是永久不 resolve —— 窗口永远不出现。
// 新实现：进程就绪立刻建窗口并显示状态页（starting → failed/restarting → healthy 后加载主应用），
// 每个状态都有明确文案 + 可操作出口（Retry / View logs）。
const BACKEND_STATE = Object.freeze({
  STARTING: 'starting',
  HEALTHY: 'healthy',
  FAILED: 'failed',
  STOPPED: 'stopped',
  RESTARTING: 'restarting',
});
/** 主应用页面（后端托管的 /command-center）地址 */
const APP_URL = 'http://127.0.0.1:3000/command-center?new=true';
/** 状态页按钮 → 主进程的通信标记（data: 页面在 sandbox 下无 preload，只能借 console 通道） */
const STATUS_ACTION = Object.freeze({
  RETRY: '__aether_status_action__:retry',
  VIEW_LOGS: '__aether_status_action__:view-logs',
});

let backendState = BACKEND_STATE.STARTING;
/** 主应用是否已成功加载 —— 决定状态变化时是渲染状态页还是保留已加载界面 */
let appLoaded = false;
/** 主应用导航是否已发起（防止"健康即加载"与"启动序列结束加载"重复导航） */
let appLoadStarted = false;
/** 启动序列进行中（防止 Retry / 自动重启并发发起多轮启动） */
let bootInFlight = false;

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

// ============================================================
// P1-026：启动状态页（后端未就绪时前端不空白）
// ============================================================

/** HTML 转义 —— 状态页会插入错误描述/日志路径等外部字符串 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 状态页文案：starting/restarting 是过程态（spinner），failed/stopped 是失败态（可操作） */
const STATUS_PAGE_COPY = {
  [BACKEND_STATE.STARTING]: {
    spinner: true,
    title: 'Starting Aether…',
    lead: '正在启动本地后端服务，首次启动需要加载数据库与运行时，通常 1–5 秒。',
  },
  [BACKEND_STATE.RESTARTING]: {
    spinner: true,
    title: 'Restarting Aether…',
    lead: '后端进程异常退出，正在自动重启。',
  },
  [BACKEND_STATE.FAILED]: {
    spinner: false,
    title: 'Backend unavailable',
    lead: '本地后端未能启动，主界面无法加载。',
  },
  [BACKEND_STATE.STOPPED]: {
    spinner: false,
    title: 'Backend stopped',
    lead: '后端已连续崩溃并停止自动重启，主界面无法加载。',
  },
};

/**
 * 渲染启动状态页。data: URL 不经过 HTTP 响应头，因此不受注入的 CSP 头约束，
 * 内联 onclick 可用；按钮通过 console 标记与主进程通信（sandbox 下无 preload 桥接）。
 */
function renderStatusPage({ state, detail = '', errorCode, errorDescription = '' }) {
  const copy = STATUS_PAGE_COPY[state] || STATUS_PAGE_COPY[BACKEND_STATE.FAILED];
  const hint = errorCode
    ? `<p>加载错误码 <code>${escapeHtml(errorCode)}</code>：${escapeHtml(errorDescription)}</p>`
    : '';
  const reason = detail ? `<p>${escapeHtml(detail)}</p>` : '';
  const actions = copy.spinner
    ? ''
    : `<div class="actions">
         <button class="primary" onclick="console.info('${STATUS_ACTION.RETRY}')">重试</button>
         <button class="ghost" onclick="console.info('${STATUS_ACTION.VIEW_LOGS}')">查看日志</button>
       </div>
       <p class="hint">日志文件：<code>${escapeHtml(LOG_FILE)}</code></p>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>
    /* 主窗口 frame:false（无边框），状态页必须自带拖拽区，否则启动期窗口无法移动 */
    body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0b0f;color:#e8e8ea;
         font-family:system-ui,'Microsoft YaHei',sans-serif;-webkit-user-select:none;-webkit-app-region:drag}
    .card{text-align:center;padding:40px;max-width:560px}
    h1{font-size:22px;margin:0 0 12px;font-weight:600}
    p{font-size:13px;line-height:1.6;color:#9a9aa2;margin:6px 0}
    code{background:#1c1c22;padding:2px 8px;border-radius:6px;font-size:12px;color:#ff8f6b;word-break:break-all}
    .spinner{width:34px;height:34px;margin:0 auto 20px;border-radius:50%;
      border:3px solid #1c1c22;border-top-color:#4f6df5;animation:aether-spin .9s linear infinite}
    @keyframes aether-spin{to{transform:rotate(360deg)}}
    @media (prefers-reduced-motion: reduce){.spinner{animation-duration:3s}}
    .actions{margin-top:22px;display:flex;gap:10px;justify-content:center}
    button{padding:9px 26px;border:0;border-radius:8px;font-size:14px;cursor:pointer;font-family:inherit;
           -webkit-app-region:no-drag}
    button.primary{background:#4f6df5;color:#fff} button.primary:hover{background:#5d79f7}
    button.ghost{background:#1c1c22;color:#e8e8ea} button.ghost:hover{background:#24242c}
    .hint{margin-top:16px;font-size:12px}
  </style></head><body>
    <div class="card">
      ${copy.spinner ? '<div class="spinner"></div>' : ''}
      <h1>${escapeHtml(copy.title)}</h1>
      <p>${escapeHtml(copy.lead)}</p>
      ${reason}${hint}${actions}
    </div></body></html>`;
}

/** 在主窗口渲染状态页并确保窗口可见（窗口已销毁/正在退出时静默跳过） */
function showStatusPage(options) {
  if (!mainWindow || mainWindow.isDestroyed() || app.isQuitting) return;
  const html = renderStatusPage(options);
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => {});
  mainWindow.show();
}

/** 后端就绪后加载主应用（幂等：同一次启动只导航一次） */
function loadAppPage() {
  if (!mainWindow || mainWindow.isDestroyed() || app.isQuitting) return;
  if (appLoadStarted || appLoaded) return;
  appLoadStarted = true;
  log('加载主应用页面…');
  mainWindow.loadURL(APP_URL).catch((e) => {
    log(`主应用页面加载失败: ${e.message}`);
  });
}

/**
 * 状态迁移唯一入口。
 * - healthy 且主应用未加载 → 直接进入主应用
 * - 其余状态且主应用未加载 → 渲染对应状态页（启动/失败都不空白）
 * - 主应用已加载（非启动期故障）→ 只记日志，不覆盖正在使用的界面
 * @param {'starting'|'healthy'|'failed'|'stopped'|'restarting'} next 目标状态
 * @param {{ detail?: string, errorCode?: number|string, errorDescription?: string }} [options] 状态页附加信息
 * @returns {boolean} 本次调用是否已渲染状态页（状态未变化时不渲染，由调用方决定是否补渲染）
 */
function setBackendState(next, options = {}) {
  if (backendState === next) return false;
  const prev = backendState;
  backendState = next;
  const { detail = '' } = options;
  log(`[后端状态] ${prev} → ${next}${detail ? '（' + detail + '）' : ''}`);
  if (next === BACKEND_STATE.HEALTHY) {
    loadAppPage();
    return false;
  }
  if (appLoaded) return false; // 主应用已在使用中 —— 只记日志，不覆盖界面
  showStatusPage({ state: next, ...options });
  return true;
}

/** 状态页「查看日志」：在资源管理器中定位 electron.log（不存在则打开数据目录） */
function revealLogFile() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(LOG_FILE)) {
      shell.showItemInFolder(LOG_FILE);
    } else {
      shell.openPath(DATA_DIR);
    }
  } catch (e) {
    log(`打开日志失败: ${e instanceof Error ? e.message : String(e)}`);
    dialog.showErrorBox('无法打开日志', LOG_FILE);
  }
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
    let settled = false;
    let healthTimer = null;
    /** 健康检查通过 → healthy */
    const settleReady = () => {
      if (settled) return;
      settled = true;
      if (healthTimer) clearTimeout(healthTimer);
      restartCount = 0;
      setBackendState(BACKEND_STATE.HEALTHY);
      resolve();
    };
    /**
     * 本轮启动失败 → failed（并 reject，让调用方决定兜底）。
     * P1-026：旧实现在健康检查失败时只打日志、永不 resolve，
     * 导致启动序列永久挂起、窗口永不出现；现在有界超时后显式失败并给出可重试入口。
     */
    const settleFailed = (msg) => {
      if (settled) return;
      settled = true;
      if (healthTimer) clearTimeout(healthTimer);
      setBackendState(BACKEND_STATE.FAILED, { detail: msg });
      reject(new Error(msg));
    };
    // 硬超时兜底：与 waitForBackendHealth 内部 deadline 竞速，谁先到谁定状态
    healthTimer = setTimeout(
      () => settleFailed(`后端健康检查超时（${HEALTH_TIMEOUT_MS}ms）：${HEALTH_URL}`),
      HEALTH_TIMEOUT_MS,
    );
    // P1-17：stdout 仅用于日志记录，不再作为 Ready 判据
    serverProcess.stdout.on('data', (d) => { log(`[后端] ${d.toString().trim()}`); });
    serverProcess.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      log(`[后端:err] ${msg}`);
      // P1-18：EADDRINUSE 不再直接当成功 —— 先健康检查验证是不是 Aether
      if (msg.includes('EADDRINUSE') || msg.includes('address already in use')) {
        log('[后端] 端口被占用，健康检查验证是否为 Aether 实例...');
        waitForBackendHealth().then(settleReady).catch((e) => log(`[后端] 端口占用但非 Aether 实例: ${e.message}`));
      }
    });
    serverProcess.on('error', (err) => { log(`[后端] fork 错误: ${err.message}`); settleFailed(err.message); });
    // P0-2: 后端进程意外退出后自动重启（最多 5 次，间隔 3s），避免应用白屏
    // 正常退出（app quit 时主动 kill）不重启
    serverProcess.on('exit', (code) => {
      log(`[后端] 进程退出 (code: ${code})`);
      if (app.isQuitting) return;
      restartCount++;
      if (restartCount > MAX_SERVER_RESTARTS) {
        log(`[后端] 已连续崩溃 ${MAX_SERVER_RESTARTS} 次，停止自动重启`);
        setBackendState(BACKEND_STATE.STOPPED, { detail: `后端已连续崩溃 ${MAX_SERVER_RESTARTS} 次，已停止自动重启` });
        return;
      }
      log(`[后端] ${restartCount}/${MAX_SERVER_RESTARTS} 次自动重启（3 秒后）...`);
      setBackendState(BACKEND_STATE.RESTARTING, { detail: `后端崩溃，第 ${restartCount}/${MAX_SERVER_RESTARTS} 次自动重启（3 秒后）` });
      setTimeout(() => {
        try {
          // 重启链沿用本轮启动的 settle 函数：重启成功即视为本轮启动成功（restarting → healthy），
          // 重启失败则本轮启动失败（→ failed，可重试）
          startServer().then(settleReady).catch(settleFailed);
        } catch (e) {
          log(`[后端] 重启异常: ${e instanceof Error ? e.message : String(e)}`);
        }
      }, 3000);
    });
    // P1-17：以健康检查为唯一 Ready 判据（不再无条件 15s resolve）
    waitForBackendHealth().then(settleReady).catch((e) => {
      log(`[后端] 健康检查失败: ${e.message}`);
      // 显式失败由 settleFailed 统一处理（超时后进入 failed 状态页，可重试）
      settleFailed(e.message);
    });
  });
}

/**
 * 启动序列：后端健康 → recovery scan → 加载主应用。
 * 失败时保持窗口与状态页存活（failed + Retry/View logs），不静默退出 ——
 * 旧实现在此处 dialog.showErrorBox + app.quit()，健康检查超时场景下用户既看不到
 * 原因也无法自救（且窗口压根没创建）。
 */
async function bootBackend() {
  if (bootInFlight) {
    log('启动序列进行中，忽略重复触发');
    return;
  }
  bootInFlight = true;
  setBackendState(BACKEND_STATE.STARTING);
  try {
    await startServer();
    // P1-19：后端启动/重启成功后执行 recovery scan —— 发现并修复崩溃遗留的 running 状态 Run
    log('执行运行恢复扫描（recovery scan）...');
    await runRecoveryScan();
    loadAppPage();
    log('应用启动完成');
  } catch (err) {
    log(`启动失败: ${err.message}`);
    // settleFailed 通常已切到 failed 并渲染状态页；状态未变化时补渲染，确保用户看到最终错误
    if (backendState === BACKEND_STATE.FAILED) {
      showStatusPage({ state: BACKEND_STATE.FAILED, detail: err.message });
    } else {
      setBackendState(BACKEND_STATE.FAILED, { detail: err.message });
    }
  } finally {
    bootInFlight = false;
  }
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

  // P1-026：不再直接加载主应用 —— 先渲染"Starting Aether…"状态页，
  // 待后端 healthy 后由 setBackendState(HEALTHY) → loadAppPage() 加载
  // /command-center?new=true（?new=true 让前端强制进入 coding 模式的新对话空白页）。
  // 窗口在状态页就绪后立刻显示，启动期用户看到的是明确进度而不是黑屏/无窗口。
  // 后端已健康时（macOS activate 重建窗口）直接进主应用。
  if (backendState === BACKEND_STATE.HEALTHY) loadAppPage();
  else showStatusPage({ state: backendState });

  // P1-2：窗口显示兜底 —— ready-to-show 未触发时 3s 强显（状态页是本地 data: URL，理应立即就绪）
  const showTimeout = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      log('ready-to-show 超时（3s），强制显示窗口 — 当前展示启动状态页');
      mainWindow.show();
    }
  }, 3000);

  mainWindow.once('ready-to-show', () => {
    clearTimeout(showTimeout);
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    // 窗口重建（macOS activate）时重新允许加载主应用
    appLoaded = false;
    appLoadStarted = false;
  });

  // 状态页按钮 → 主进程动作（sandbox + contextIsolation 下状态页无 preload 桥接，
  // 借 console 通道通信，避免为一个启动页改 preload 暴露面）
  mainWindow.webContents.on('console-message', (...args) => {
    const text = args
      .map((a) => (typeof a === 'string' ? a : (a && typeof a.message === 'string' ? a.message : '')))
      .join(' ');
    if (!text.includes(STATUS_ACTION.RETRY) && !text.includes(STATUS_ACTION.VIEW_LOGS)) return;
    if (text.includes(STATUS_ACTION.VIEW_LOGS)) {
      revealLogFile();
      return;
    }
    log('[状态页] 用户点击重试，重新执行启动序列');
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
    void bootBackend();
  });

  // 主应用页面（http://127.0.0.1:3000）加载失败 → failed 状态页（Backend unavailable + Retry + View logs）
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    if (errorCode === -3) return; // ERR_ABORTED（主动导航/刷新），忽略
    if (String(validatedURL).startsWith('data:')) return; // 状态页自身，不递归
    log(`页面加载失败 (${errorCode}): ${errorDescription} — ${validatedURL}`);
    // 主应用已不可见：解除"已加载"标记，之后 Retry 或后端恢复健康都能重新导航
    appLoaded = false;
    appLoadStarted = false;
    const options = {
      detail: `加载错误码 ${errorCode}：${errorDescription}。常见原因：端口 3000 被非 Aether 服务占用、后端启动组件损坏或数据目录异常。`,
      errorCode,
      errorDescription,
    };
    // 状态未变化时 setBackendState 不渲染 —— 补渲染，保证失败一定有可见状态页
    if (!setBackendState(BACKEND_STATE.FAILED, options)) {
      showStatusPage({ state: BACKEND_STATE.FAILED, ...options });
    }
  });

  // 主应用加载成功 → 标记 appLoaded（此后后端状态变化不再覆盖正在使用的界面）
  mainWindow.webContents.on('did-finish-load', () => {
    if (appLoaded || !mainWindow || mainWindow.isDestroyed()) return;
    const url = mainWindow.webContents.getURL();
    if (url && !url.startsWith('data:')) {
      appLoaded = true;
      log('主应用页面加载完成');
    }
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

  // P1-026：先建窗口（显示"Starting Aether…"状态页）再启动后端 ——
  // 启动期不空白，且后端失败时用户仍留在可重试的状态页上，而不是无窗口或直接被 dialog 打断退出。
  createWindow();
  createTray();
  log('正在启动后端服务...');
  // P1-19：后端健康后执行 recovery scan —— 发现并修复崩溃遗留的 running 状态 Run（在 bootBackend 内）
  await bootBackend();
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