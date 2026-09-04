import { Wrench, Bot, Image as ImageIcon, FileText, GitBranch, Terminal } from 'lucide-react';
import type { NodeType, NodeMeta } from './types';

export const NODE_META: Record<NodeType, NodeMeta> = {
  tool: { label: '工具', color: '#60a5fa', icon: <Wrench size={16} />, desc: '执行文件/系统工具' },
  agent: { label: 'AI Agent', color: '#a78bfa', icon: <Bot size={16} />, desc: '调用 AI 模型' },
  media: { label: '媒体', color: '#f472b6', icon: <ImageIcon size={16} />, desc: '生成图片/视频' },
  document: { label: '文档', color: '#34d399', icon: <FileText size={16} />, desc: '生成 PPT/文档' },
  condition: { label: '条件', color: '#fbbf24', icon: <GitBranch size={16} />, desc: '条件分支判断' },
  system: { label: '系统命令', color: '#f97316', icon: <Terminal size={16} />, desc: '执行系统命令（如音量、打开程序）' },
};

export const PALETTE: NodeType[] = ['tool', 'agent', 'system', 'media', 'document', 'condition'];

export const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;