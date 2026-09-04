import { Component, type ErrorInfo, type ReactNode, Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ConfirmDialog } from './components/ui/confirm-dialog';

// Error Boundary — 防止未捕获错误导致白屏
class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error?: Error }, { reset: number }> {
  state = { hasError: false, error: undefined as Error | undefined };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[ErrorBoundary]', error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: undefined });
    window.location.href = '/';
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: 'var(--bg-base)', color: 'var(--text-primary)', gap: 16 }}>
          <div style={{ fontSize: 48 }}>⚠️</div>
          <h2 style={{ fontSize: 20, fontWeight: 600 }}>页面加载失败</h2>
          <p style={{ fontSize: 13, color: 'var(--text-tertiary)', maxWidth: 400, textAlign: 'center' }}>
            {this.state.error?.message || '发生未知错误'}
          </p>
          <p style={{ fontSize: 12, color: 'var(--text-tertiary)', maxWidth: 400, textAlign: 'center' }}>
            请尝试刷新页面，或返回首页重试。如问题持续，请检查后端服务是否正常运行。
          </p>
          <button className="btn btn-primary" onClick={this.handleReset}>返回首页</button>
        </div>
      );
    }
    return this.props.children;
  }
}

// 路由懒加载 — 减小首屏 bundle
const CommandCenter = lazy(() => import('./routes/CommandCenter').then(m => ({ default: m.CommandCenter })));
const Providers = lazy(() => import('./routes/Providers').then(m => ({ default: m.Providers })));
const Chat = lazy(() => import('./routes/Chat').then(m => ({ default: m.Chat })));
const Media = lazy(() => import('./routes/Media').then(m => ({ default: m.Media })));
const Documents = lazy(() => import('./routes/Documents').then(m => ({ default: m.Documents })));
const Projects = lazy(() => import('./routes/Projects').then(m => ({ default: m.Projects })));
const Library = lazy(() => import('./routes/Library').then(m => ({ default: m.Library })));
const Settings = lazy(() => import('./routes/Settings').then(m => ({ default: m.Settings })));
const Browser = lazy(() => import('./routes/Browser').then(m => ({ default: m.Browser })));
const AgentSettings = lazy(() => import('./routes/AgentSettings').then(m => ({ default: m.AgentSettings })));
const Toolbox = lazy(() => import('./routes/Toolbox').then(m => ({ default: m.Toolbox })));
const Search = lazy(() => import('./routes/Search').then(m => ({ default: m.Search })));
const Knowledge = lazy(() => import('./routes/Knowledge').then(m => ({ default: m.Knowledge })));
const Vault = lazy(() => import('./routes/Vault').then(m => ({ default: m.Vault })));
const McpSettings = lazy(() => import('./routes/McpSettings').then(m => ({ default: m.McpSettings })));
const Monitoring = lazy(() => import('./routes/Monitoring').then(m => ({ default: m.Monitoring })));
const SelfCheck = lazy(() => import('./routes/SelfCheck').then(m => ({ default: m.SelfCheck })));
const Workflows = lazy(() => import('./routes/Workflows').then(m => ({ default: m.Workflows })));
const Terminal = lazy(() => import('./routes/Terminal').then(m => ({ default: m.Terminal })));

const PageFallback = () => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
    <div className="spinner" />
  </div>
);

export function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        {/* 无边框窗口拖拽区域 — 透明覆盖顶部，可拖动窗口 */}
        <div className="app-drag-region" />
        <Routes>          <Route path="/" element={<Layout />}>
            <Route index element={<Navigate to="/command-center" replace />} />
            <Route path="command-center" element={<Suspense fallback={<PageFallback />}><CommandCenter /></Suspense>} />
            <Route path="dashboard" element={<Suspense fallback={<PageFallback />}><CommandCenter /></Suspense>} />
            <Route path="providers" element={<Suspense fallback={<PageFallback />}><Providers /></Suspense>} />
            <Route path="chat" element={<Suspense fallback={<PageFallback />}><Chat /></Suspense>} />
            <Route path="media" element={<Suspense fallback={<PageFallback />}><Media /></Suspense>} />
            <Route path="documents" element={<Suspense fallback={<PageFallback />}><Documents /></Suspense>} />
            <Route path="projects" element={<Suspense fallback={<PageFallback />}><Projects /></Suspense>} />
            <Route path="library" element={<Suspense fallback={<PageFallback />}><Library /></Suspense>} />
            <Route path="browser" element={<Suspense fallback={<PageFallback />}><Browser /></Suspense>} />
            <Route path="settings" element={<Suspense fallback={<PageFallback />}><Settings /></Suspense>} />
            <Route path="agent-settings" element={<Suspense fallback={<PageFallback />}><AgentSettings /></Suspense>} />
            <Route path="toolbox" element={<Suspense fallback={<PageFallback />}><Toolbox /></Suspense>} />
            <Route path="search" element={<Suspense fallback={<PageFallback />}><Search /></Suspense>} />
            <Route path="knowledge" element={<Suspense fallback={<PageFallback />}><Knowledge /></Suspense>} />
            <Route path="vault" element={<Suspense fallback={<PageFallback />}><Vault /></Suspense>} />
            <Route path="mcp" element={<Suspense fallback={<PageFallback />}><McpSettings /></Suspense>} />
            <Route path="monitoring" element={<Suspense fallback={<PageFallback />}><Monitoring /></Suspense>} />
            <Route path="selfcheck" element={<Suspense fallback={<PageFallback />}><SelfCheck /></Suspense>} />
            <Route path="workflows" element={<Suspense fallback={<PageFallback />}><Workflows /></Suspense>} />
<Route path="terminal" element={<Suspense fallback={<PageFallback />}><Terminal /></Suspense>} />
          </Route>
        </Routes>
      </BrowserRouter>
      <ConfirmDialog />
    </ErrorBoundary>
  );
}
