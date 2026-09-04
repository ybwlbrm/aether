import { BookOpen, Link2, StickyNote, FileText, Brain, Sparkles } from 'lucide-react';
import type { TabConfig } from './types';

export const tabs: TabConfig[] = [
  { id: 'bookmarks', label: '收藏夹', icon: <Link2 size={20} />, color: 'var(--color-accent)' },
  { id: 'notes', label: '闪念备忘录', icon: <StickyNote size={20} />, color: 'var(--color-warning)' },
  { id: 'wiki', label: '知识库', icon: <BookOpen size={20} />, color: '#a78bfa' },
  { id: 'memory', label: '记忆', icon: <Brain size={20} />, color: '#22d3ee' },
];

export const memoryTypeStyles: Record<string, { label: string; color: string }> = {
  short_term: { label: '短期', color: '#3b82f6' },
  long_term: { label: '长期', color: '#a78bfa' },
  project: { label: '项目', color: '#22c55e' },
};

export const memoryFilters = [
  { id: '', label: '全部' },
  { id: 'short_term', label: '短期' },
  { id: 'long_term', label: '长期' },
  { id: 'project', label: '项目' },
];