import { useEffect, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { GradientShimmer } from '../components/ui/gradient-shimmer';
import { useAppStore } from '../store/app';
import { CodingHome } from './CodingHome';
import {
  Sparkles, Bot, MessageSquare, FileText, Palette,
  Cable, Search, Wrench, BookOpen, Key, FolderKanban,
  Image, Database, Workflow, LayoutDashboard, Globe,
  Zap, Shield, Download, Brain
} from 'lucide-react';

const categories = [
  {
    label: '工作区',
    icon: <LayoutDashboard size={18} />,
    items: [
      { label: 'AI 对话', desc: '多模型聊天与 Agent 编排', icon: <MessageSquare size={22} />, path: '/chat', color: 'var(--color-accent)' },
      { label: 'Agent 工作室', desc: '工作流编排与能力管理', icon: <Brain size={22} />, path: '/agent-settings', color: '#a78bfa' },
      { label: '可视化工作流', desc: '拖拽编排 AI 工作流并一键运行', icon: <Workflow size={22} />, path: '/workflows', color: '#60a5fa' },
    ],
  },
  {
    label: '工具',
    icon: <Wrench size={18} />,
    items: [
      { label: '工具箱', desc: '格式转换、PDF、音频处理', icon: <Wrench size={22} />, path: '/toolbox', color: 'var(--color-warning)' },
      { label: '搜索引擎', desc: '无广告聚合多源搜索', icon: <Search size={22} />, path: '/search', color: 'var(--color-success)' },
      { label: '知识库', desc: '收藏夹、笔记、Wiki', icon: <BookOpen size={22} />, path: '/knowledge', color: 'var(--color-danger)' },
    ],
  },
  {
    label: 'AI',
    icon: <Sparkles size={18} />,
    items: [
      { label: 'AI Studio', desc: '图片与视频 AI 生成', icon: <Image size={22} />, path: '/media', color: '#a78bfa' },
      { label: '文档生成', desc: 'PPT 与 Word 文档', icon: <FileText size={22} />, path: '/documents', color: 'var(--color-success)' },
      { label: '项目管理', desc: '项目、脚本与命令', icon: <FolderKanban size={22} />, path: '/projects', color: 'var(--color-danger)' },
    ],
  },
  {
    label: '系统',
    icon: <Zap size={18} />,
    items: [
      { label: 'AI Providers', desc: '管理 AI 模型', icon: <Cable size={22} />, path: '/providers', color: 'var(--color-accent)' },
      { label: '媒体库', desc: '已生成的文件', icon: <Database size={22} />, path: '/library', color: '#60a5fa' },
      { label: '设置', desc: '主题与系统配置', icon: <Zap size={22} />, path: '/settings', color: '#94a3b8' },
    ],
  },
];

export function CommandCenter() {
  const navigate = useNavigate();
  const { uiMode, setUiMode } = useAppStore();
  const [health, setHealth] = useState<{ status: string } | null>(null);
  const [providers, setProviders] = useState<any[]>([]);
  // 审计修复：健康检查失败状态，避免永久显示"检测中"
  const [healthFailed, setHealthFailed] = useState(false);

  useEffect(() => {
    // 审计修复：health 失败时设置 healthFailed，UI 显示"连接失败"而非永久"检测中"
    api.health().then(setHealth).catch(() => setHealthFailed(true));
    api.getProviders().then(setProviders).catch(() => {});

    // Q1 彻底修复：检测 URL ?new=true 参数（EXE 启动时 main.js 传入），
    // 强制切换到 coding 模式并进入 CodingHome 新对话页。
    // 这样用户每次启动应用都看到全新的 "What can I build for you?" 页面。
    const params = new URLSearchParams(window.location.search);
    if (params.get('new') === 'true') {
      window.history.replaceState({}, '', '/command-center');
      setUiMode('coding');
    }
  }, [setUiMode]);

  const handleSend = useCallback((message: string) => navigate(`/chat?q=${encodeURIComponent(message)}&new=true`), [navigate]);

  // Coding 模式：渲染 CodingHome（ChatGPT 风格对话界面）
  if (uiMode === 'coding') return <CodingHome />;

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)', backgroundImage: 'var(--bg-gradient)' }}>
      <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '0 24px' }}>
        {/* Header */}
        <motion.div 
          initial={{ opacity: 0, y: 20 }} 
          animate={{ opacity: 1, y: 0 }} 
          transition={{ duration: 0.6 }}
          style={{ paddingTop: '48px', paddingBottom: '32px' }}
        >
          <div className="flex items-center gap-4 mb-2">
            <div style={{
              width: 48, height: 48, borderRadius: 16,
              background: 'linear-gradient(135deg, var(--color-accent), #a78bfa)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 8px 32px rgba(94,158,255,0.25)',
            }}>
              <Sparkles size={24} style={{ color: 'var(--on-accent)' }} />
            </div>
            <div>
              <h1 style={{ fontSize: '28px', fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.03em' }}>
                <GradientShimmer gradient="mint" duration={2} pauseBetween={2000}>
                  AI 全能工作台
                </GradientShimmer>
              </h1>
              <p style={{ fontSize: '14px', color: 'var(--text-tertiary)', marginTop: 4 }}>
                {providers.length > 0 
                  ? `已连接 ${providers.length} 个 AI Provider · 系统就绪`
                  : '请先在 AI Providers 中配置 API Key'}
              </p>
            </div>
          </div>
        </motion.div>

        {/* Categories */}
        {categories.map((category, ci) => (
          <motion.div
            key={category.label}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 + ci * 0.1, duration: 0.5 }}
            style={{ marginBottom: '28px' }}
          >
            <div className="flex items-center gap-2 mb-4">
              <span style={{ color: 'var(--text-tertiary)', opacity: 0.6 }}>{category.icon}</span>
              <h2 style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {category.label}
              </h2>
              <div style={{ flex: 1, height: 1, background: 'var(--border-primary)', marginLeft: 12 }} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {category.items.map((item, i) => (
                <motion.button
                  key={item.label}
                  onClick={() => navigate(item.path)}
                  className="glass-card"
                  style={{
                    padding: '20px',
                    textAlign: 'left',
                    cursor: 'pointer',
                    border: '1px solid var(--card-border)',
                    minHeight: '100px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 12,
                  }}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 + ci * 0.1 + i * 0.05, duration: 0.4 }}
                  whileHover={{ y: -3, transition: { duration: 0.2 } }}
                  whileTap={{ scale: 0.98 }}
                >
                  <div className="flex items-center gap-3">
                    <div className="flex items-center justify-center flex-shrink-0" 
                      style={{ width: 40, height: 40, borderRadius: 12, background: `${item.color}18` }}>
                      <span style={{ color: item.color }}>{item.icon}</span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate" style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)' }}>
                        {item.label}
                      </div>
                      <div className="truncate" style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: 2 }}>
                        {item.desc}
                      </div>
                    </div>
                  </div>
                </motion.button>
              ))}
            </div>
          </motion.div>
        ))}

        {/* Status Bar */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.8, duration: 0.5 }}
          style={{
            padding: '16px 20px',
            borderRadius: 12,
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-primary)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '48px',
          }}
        >
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: healthFailed ? 'var(--color-danger)' : health?.status === 'ok' ? 'var(--color-success)' : 'var(--color-warning)', display: 'block' }} />
              <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>服务状态: {healthFailed ? '连接失败' : health?.status === 'ok' ? '运行中' : '检测中'}</span>
            </div>
            <div className="flex items-center gap-2">
              <Cable size={14} style={{ color: 'var(--text-tertiary)' }} />
              <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Provider: {providers.length}</span>
            </div>
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
            AI 全能工作台 v1.0
          </div>
        </motion.div>
      </div>
    </div>
  );
}