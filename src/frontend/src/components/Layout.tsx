import { useEffect, useState, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { CommandPalette } from './CommandPalette';
import { LiquidGlassFilter } from './LiquidGlassFilter';
import { api } from '../api/client';
import { requestNotificationPermission } from '../lib/notifications';
import { useAppStore } from '../store/app';
import { Maximize2, Minimize2, Trash2, MessageSquare } from 'lucide-react';
import { confirm as confirmDialog } from './ui/confirm-dialog';

/** 采样 img 亮度，动态设置 --glass-vibrancy-opacity */
function sampleLuminance(img: HTMLImageElement): number {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx) return 0.5;
  ctx.drawImage(img, 0, 0, 64, 64);
  const data = ctx.getImageData(0, 0, 64, 64).data;
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    total += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
  }
  return total / (data.length / 4);
}

function vibrancyOpacity(lum: number): number {
  // 苹果 iOS26 标准：亮背景 6%~15%，暗背景 20%~35%
  // 但用户反馈需要更通透，再降 50%
  return lum > 0.5
    ? Math.max(0.04, Math.min(0.08, 0.04 + (1 - lum) * 0.08))
    : Math.max(0.06, Math.min(0.12, 0.06 + (0.5 - lum) * 0.12));
}

export function Layout() {
  const location = useLocation();
  const isCommandCenter = location.pathname === '/command-center' || location.pathname === '/';
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [customBg, setCustomBg] = useState<string | null>(null);
  // 背景轮播
  const [slideImages, setSlideImages] = useState<string[]>([]);
  const [slideIndex, setSlideIndex] = useState(0);
  const [slideInterval, setSlideInterval] = useState(10);
  const [slideEnabled, setSlideEnabled] = useState(false);
  const slideTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const bgImgRef = useRef<HTMLImageElement>(null);
  const vibrancyFrame = useRef<number>(0);

  // 首次访问应用时请求通知权限（用户拒绝后不再询问）
  useEffect(() => { requestNotificationPermission(); }, []);

  // 监听背景轮播事件
  useEffect(() => {
    // 页面加载时从后端恢复轮播设置
    (async () => {
      try {
        const { api } = await import('../api/client.js');
        const res = await api.getBackgrounds();
        if (res?.images?.length > 0) {
          setSlideImages(res.images);
          setSlideInterval(res.interval || 10);
          // 从上次轮播位置恢复（取模防止图片列表变化导致越界；JS 负数取模需二次修正）
          const saved = parseInt(localStorage.getItem('bgSlideshowIndex') || '0', 10);
          const len = res.images.length;
          setSlideIndex(Number.isFinite(saved) ? ((saved % len) + len) % len : 0);
          setSlideEnabled(true);
          setCustomBg(null);
        }
      } catch (_e: unknown) { console.warn("[SilentCatch]", _e); }
    })();

    const startHandler = (e: Event) => {
      const ce = e as CustomEvent;
      const { images, interval } = ce.detail || {};
      if (images?.length > 0) {
        setSlideImages(images);
        setSlideInterval(interval || 10);
        setSlideIndex(0);
        setSlideEnabled(true);
        setCustomBg(null);
      } else {
        // 空列表：停止轮播（避免旧图片继续显示，状态与模式不同步）
        setSlideEnabled(false);
        setSlideImages([]);
        if (slideTimerRef.current) { clearInterval(slideTimerRef.current); slideTimerRef.current = null; }
      }
    };
    const stopHandler = () => {
      setSlideEnabled(false);
      setSlideImages([]);
      if (slideTimerRef.current) { clearInterval(slideTimerRef.current); slideTimerRef.current = null; }
    };
    const clearHandler = () => {
      // 清除所有背景图片（同时停轮播）
      setSlideEnabled(false);
      setSlideImages([]);
      if (slideTimerRef.current) { clearInterval(slideTimerRef.current); slideTimerRef.current = null; }
    };
    // 仅更新切换间隔：不重建轮播、不重置索引
    const intervalHandler = (e: Event) => {
      const ce = e as CustomEvent;
      const v = parseInt(ce.detail?.interval, 10);
      if (Number.isFinite(v) && v > 0) {
        setSlideInterval(v);
      }
    };
    window.addEventListener('bg-slideshow-start', startHandler);
    window.addEventListener('bg-slideshow-stop', stopHandler);
    window.addEventListener('bg-slideshow-clear', clearHandler);
    window.addEventListener('bg-slideshow-interval', intervalHandler);
    return () => {
      window.removeEventListener('bg-slideshow-start', startHandler);
      window.removeEventListener('bg-slideshow-stop', stopHandler);
      window.removeEventListener('bg-slideshow-clear', clearHandler);
      window.removeEventListener('bg-slideshow-interval', intervalHandler);
      if (slideTimerRef.current) clearInterval(slideTimerRef.current);
    };
  }, []);

  // 轮播定时器
  useEffect(() => {
    if (!slideEnabled || slideImages.length <= 1) return;
    if (slideTimerRef.current) clearInterval(slideTimerRef.current);
    slideTimerRef.current = setInterval(() => {
      setSlideIndex(prev => (prev + 1) % slideImages.length);
    }, slideInterval * 1000);
    return () => {
      // Functional cleanup: read current ref at cleanup time to avoid stale capture
      const timer = slideTimerRef.current;
      if (timer) clearInterval(timer);
    };
  }, [slideEnabled, slideImages.join('|'), slideInterval]);

  // 持久化当前轮播位置：刷新后从上次位置继续
  useEffect(() => {
    if (slideEnabled) {
      localStorage.setItem('bgSlideshowIndex', String(slideIndex));
    }
  }, [slideIndex, slideEnabled]);

  // ============================================================
  // 远程命令实时监听：手机端发指令时自动跳转到聊天页
  // 通过轮询后端 /api/sync/latest-command 实现，无需前端直连 Supabase
  // ============================================================
  const navigate = useNavigate();
  const setUiMode = useAppStore((s) => s.setUiMode);

  // ============================================================
  // 对话记录面板：全局状态，在 Layout 级别管理
  // ============================================================
  const [sidebarConvOpen, setSidebarConvOpen] = useState(false);
  const [conversations, setConversations] = useState<any[]>([]);

  // 加载对话列表
  const loadConversations = useCallback(async () => {
    try {
      const convs = await api.getConversations();
      setConversations(convs || []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadConversations(); }, [loadConversations]);

  // 监听对话变更事件：CodingHome 创建/删除对话后通知刷新
  useEffect(() => {
    const handler = () => loadConversations();
    window.addEventListener('conversations-changed', handler);
    return () => window.removeEventListener('conversations-changed', handler);
  }, [loadConversations]);

  // 选择对话：跳转到 AI 对话页并加载该对话
  const handleSelectConv = useCallback(async (id: string) => {
    setSidebarConvOpen(false);
    const path = window.location.pathname;
    if (path === '/command-center' || path === '/') {
      // 已在 AI 对话页，直接派发事件
      window.dispatchEvent(new CustomEvent('select-conversation', { detail: { conversationId: id } }));
    } else {
      // 不在 AI 对话页，导航过去
      navigate(`/command-center?selectConv=${id}`);
    }
  }, [navigate]);

  // 删除对话
  const handleDeleteConv = useCallback(async (id: string) => {
    if (!(await confirmDialog('确定删除此对话？'))) return;
    try {
      await api.deleteConversation(id);
      // 同步删除 Supabase 记录
      await fetch('/api/sync/delete-conversation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ conversationId: id }),
      }).catch(() => {});
      loadConversations();
    } catch (e: unknown) { alert('删除失败: ' + (e instanceof Error ? e.message : String(e))); }
  }, [loadConversations]);

  // ============================================================
  // 监听 toggle-conv-panel 事件：从任意页面打开对话记录面板（无需跳转）
  // ============================================================
  useEffect(() => {
    const handler = () => {
      setSidebarConvOpen(prev => !prev);
    };
    window.addEventListener('toggle-conv-panel', handler);
    return () => window.removeEventListener('toggle-conv-panel', handler);
  }, []);
  useEffect(() => {
    const abortController = new AbortController();
    let cancelled = false;
    let lastId: string | null = null;

    const poll = async () => {
      if (cancelled) return;
      try {
        const res = await fetch('/api/sync/latest-command', {
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
          signal: abortController.signal,
        });
        if (cancelled) return; // Check after await
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return; // Check after await
        if (data.hasNew && data.command) {
          const cmd = data.command;
          // Q1/Q4 修复：仅在命令仍处于「待处理/处理中」时跳转。
          // /api/sync/latest-command 已过滤仅返回 pending/processing，
          // 双保险：此处再校验状态，已完成/失败命令绝不触发 UI 跳转
          if ((cmd.status === 'pending' || cmd.status === 'processing') && cmd.id !== lastId) {
            lastId = cmd.id;
            console.log('[Layout] 检测到远程命令:', cmd.content?.slice(0, 50));
            window.dispatchEvent(new CustomEvent('remote-command', {
              detail: { content: cmd.content, id: cmd.id, conversationId: cmd.conversationId },
            }));
            // 存待处理的远程命令（conversationId 可能还没生成，CodingHome 会轮询补齐）
            try {
              sessionStorage.setItem('aether_pending_remote', JSON.stringify({
                content: cmd.content,
                commandId: cmd.id,
                conversationId: cmd.conversationId || null,
                receivedAt: Date.now(),
              }));
            } catch { /* ignore */ }
            // 切换到 coding 模式并跳转到 coding 对话界面（CodingHome）
            // 用变化的 query 参数触发 CodingHome 重新检查 aether_pending_remote
            // （避免 window.location.href 全刷新丢失状态，也避免同路由 navigate 不重挂载）
            setUiMode('coding');
            navigate(`/command-center?remote=${Date.now()}`);
          }
        }
      } catch {
        // 后端未启动或未配置同步，静默忽略（含 AbortError）
      }
    };

    // 立即执行一次，然后每 1.5 秒轮询（Q4 优化：原 3s 轮询使手机发指令后 UI 滞后最多 3s）
    poll();
    const interval = setInterval(poll, 1500);

    return () => {
      cancelled = true;
      abortController.abort();
      clearInterval(interval);
    };
  }, [navigate, setUiMode]);

  // 轮播时让页面透明，显示轮播图（覆盖 --bg-base 变量，所有页面自动生效）
  useEffect(() => {
    const root = document.documentElement;
    if (slideEnabled) {
      root.style.setProperty('--bg-base', 'transparent');
      root.style.setProperty('--bg-gradient', 'none');
    } else {
      root.style.removeProperty('--bg-base');
      root.style.removeProperty('--bg-gradient');
    }
  }, [slideEnabled]);

  // 加载保存的 UI 主题
  useEffect(() => {
    const savedTheme = localStorage.getItem('uiTheme') || 'liquid-glass';
    // 白框修复：shadcn/ui 组件（含 Streamdown）依赖 .dark class 选择器匹配深色变量。
    // 项目一直只设置了 data-theme 属性，从未设置 .dark class，
    // 导致 shadcn 的 --background 变量取的是 :root（白色）而非 .dark（深色），
    // 所有 Streamdown 渲染的卡片/代码块/内联代码背景均为白色。
    document.documentElement.classList.add('dark');
    if (savedTheme !== 'liquid-glass') {
      document.documentElement.setAttribute('data-theme', savedTheme);
    }
    // 强制重绘玻璃卡片（刷新 backdrop-filter GPU 缓存）
    const repaintEls = () => document.querySelectorAll<HTMLElement>('.glass-card, .sidebar-glass, .input, .select, .btn');
    const doRepaint = () => {
      const els = repaintEls();
      els.forEach(el => {
        el.style.transform = 'translateZ(0.001px)';
        el.style.backdropFilter = 'none';
      });
      setTimeout(() => {
        els.forEach(el => {
          el.style.transform = '';
          el.style.backdropFilter = '';
        });
      }, 50);
    };
    doRepaint();
  }, []);

  useEffect(() => {
    // 每次挂载/导航都从 localStorage 读取背景，确保背景显示
    const savedBg = localStorage.getItem('customBg');
    // 即使 localStorage 为空也要清空 state，否则删掉后图片残留
    setCustomBg(savedBg || null);

// 监听 Settings 页面保存背景后实时更新
          const handler = (e: Event) => {
            const ce = e as CustomEvent;
            if (ce.detail) {
              setCustomBg(ce.detail);
            } else {
              setCustomBg(null);
            }
          };
          window.addEventListener('custombg-change', handler);

          // 加载已保存的玻璃效果参数（三个滑块值）
          try {
            const saved = localStorage.getItem('glassEffect');
            if (saved) {
              const g = JSON.parse(saved);
              if (g.blurRadius != null) document.documentElement.style.setProperty('--glass-blur-radius', `${g.blurRadius}px`);
              if (g.saturate != null) document.documentElement.style.setProperty('--glass-saturate', `${g.saturate}%`);
              if (g.vibrancyOpacity != null) document.documentElement.style.setProperty('--glass-vibrancy-opacity', String(g.vibrancyOpacity));
            }
          } catch (_e: unknown) { /* ignore - intentional */ }

          // 强制重绘玻璃卡片（刷新 backdrop-filter GPU 缓存）
          const repaintEls2 = document.querySelectorAll<HTMLElement>('.glass-card, .sidebar-glass, .input, .select, .btn');
          repaintEls2.forEach(el => {
            el.style.transform = 'translateZ(0.001px)';
            el.style.backdropFilter = 'none';
          });
          setTimeout(() => {
            repaintEls2.forEach(el => {
              el.style.transform = '';
              el.style.backdropFilter = '';
            });
          }, 50);

          return () => window.removeEventListener('custombg-change', handler);
  }, [location.pathname]); // 每次导航重新读取 localStorage

  // 全局动态透明度：采样背景亮度，实时调整 --glass-vibrancy-opacity
  // 苹果 iOS26 标准：亮背景 6%~15%，暗背景 20%~35%
  // 但当前 UI 需要更通透，故整体下调 40%
  // 若用户已在设置中手动调过透明度滑块，则尊重手动值，不再自动覆盖
  useEffect(() => {
    const update = () => {
      // 检查用户是否手动设置过透明度滑块
      let manualOpacity: number | null = null;
      try {
        const saved = localStorage.getItem('glassEffect');
        if (saved) {
          const g = JSON.parse(saved);
          if (typeof g.vibrancyOpacity === 'number') manualOpacity = g.vibrancyOpacity;
        }
      } catch (_e: unknown) { /* ignore - intentional */ }

      if (manualOpacity != null) {
        // 用户手动调过透明度，尊重该值
        document.documentElement.style.setProperty('--glass-vibrancy-opacity', String(manualOpacity));
        return;
      }

      if (customBg && bgImgRef.current && bgImgRef.current.complete && bgImgRef.current.naturalWidth > 0) {
        const lum = sampleLuminance(bgImgRef.current);
        const opacity = vibrancyOpacity(lum);
        document.documentElement.style.setProperty('--glass-vibrancy-opacity', String(opacity));
      } else {
        // 无自定义背景：深色 0.06，浅色 0.05（极致通透）
        const theme = document.documentElement.getAttribute('data-theme');
        const opacity = theme === 'light' ? 0.05 : 0.06;
        document.documentElement.style.setProperty('--glass-vibrancy-opacity', String(opacity));
      }
    };

    const schedule = () => {
      if (vibrancyFrame.current !== 0) window.cancelAnimationFrame(vibrancyFrame.current);
      vibrancyFrame.current = window.requestAnimationFrame(() => {
        vibrancyFrame.current = 0;
        update();
      });
    };

    update(); // 初始
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);

    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (vibrancyFrame.current !== 0) window.cancelAnimationFrame(vibrancyFrame.current);
    };
  }, [customBg, location.pathname]);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
    }
  }, []);

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  return (
    <div
      className="min-h-screen"
      data-custom-bg={customBg ? 'true' : undefined}
      style={{
        background: !slideEnabled ? 'var(--bg-base)' : undefined,
        backgroundImage: !slideEnabled ? 'var(--bg-gradient)' : undefined,
      }}
    >
      {/* 隐藏的 img 用于 JS 采样背景亮度 */}
      {customBg && (
        <img
          ref={bgImgRef}
          src={customBg}
          alt=""
          aria-hidden="true"
          style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
        />
      )}
      {/* 背景轮播 — 渐入切换 */}
      {slideEnabled && slideImages.length > 0 && (
        <div key={`bg-${slideIndex}`} style={{
          position: 'fixed', inset: 0, zIndex: -1,
          backgroundImage: `url(${slideImages[slideIndex]})`,
          backgroundSize: 'cover', backgroundPosition: 'center', backgroundRepeat: 'no-repeat',
          opacity: 0.6, pointerEvents: 'none',
          transition: 'opacity 1s ease-in-out',
        }} />
      )}
      {/* 背景图层 — 在所有内容之下 */}
      {!slideEnabled && customBg && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: -1,
            backgroundImage: `url(${customBg})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
            opacity: 0.6,
            pointerEvents: 'none',
          }}
        />
      )}
      <LiquidGlassFilter />
      <CommandPalette />
      <Sidebar />

      {/* 对话记录面板 — 全局可用，无需跳转 */}
      <AnimatePresence>
        {sidebarConvOpen && (
          <motion.div
            initial={{ x: -300, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: -300, opacity: 0 }}
            transition={{ duration: 0.2 }}
            style={{ position: 'fixed', left: 'var(--sidebar-width)', top: 0, bottom: 0, width: 260, zIndex: 40, overflow: 'hidden', padding: 0, WebkitClipPath: 'none', clipPath: 'none', borderRadius: 0 }}
            className="glass-card"
          >
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-primary)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Chat History</span>
              <button onClick={() => setSidebarConvOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', padding: 8, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 36, minHeight: 36, fontSize: 18, lineHeight: 1 }} title="关闭">✕</button>
            </div>
            <div style={{ overflowY: 'auto', maxHeight: 'calc(100vh - 50px)', display: 'flex', flexDirection: 'column', gap: 4, padding: 8 }}>
              {conversations.map((conv: any) => (
                <div key={conv.id}
                  onClick={() => handleSelectConv(conv.id)}
                  style={{ padding: '10px 12px', borderRadius: 8, cursor: 'pointer', background: 'transparent', display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{conv.title}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{new Date(conv.updatedAt).toLocaleString()}</div>
                  </div>
                  <button onClick={(e) => { e.stopPropagation(); handleDeleteConv(conv.id); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', flexShrink: 0 }}>
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
              {conversations.length === 0 && (
                <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-tertiary)', fontSize: 13 }}>No conversations yet</div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

<main
        style={{
          marginLeft: 'var(--sidebar-width)',
          minHeight: '100vh',
          position: 'relative',
          zIndex: 1,
        }}
      >
        <motion.div
          key={location.pathname}
          style={{
            padding: '0',
            maxWidth: isCommandCenter ? 'none' : 'var(--max-content-width)',
            margin: isCommandCenter ? '0' : '0 auto',
          }}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
        >
          <Outlet />
        </motion.div>
      </main>
    </div>
  );
}