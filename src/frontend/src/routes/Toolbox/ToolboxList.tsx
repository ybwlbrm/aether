import { Wrench } from 'lucide-react';
import { PageHeader } from '../../components/PageHeader';
import type { ConvertOption, ToolCategory } from './types';
import { ToolCard } from './ToolCard';
import { categories, catOf, convertOptions } from './constants';

interface ToolboxListProps {
  activeCategory: string;
  setActiveCategory: (cat: string) => void;
  onSelect: (o: ConvertOption) => void;
}

export function ToolboxList({ activeCategory, setActiveCategory, onSelect }: ToolboxListProps) {
  const filteredOptions = activeCategory === 'all'
    ? convertOptions
    : convertOptions.filter(o => catOf(o) === activeCategory);

  return (
    <>
      {/* 分类 Tabs */}
      <div className="flex gap-2 mb-6 flex-wrap">
        {categories.map(cat => (
          <button key={cat.id} onClick={() => setActiveCategory(cat.id)}
            className="px-6 py-3 rounded-[14px] text-sm font-medium transition-all"
            style={{
              background: activeCategory === cat.id ? `${cat.color}20` : 'var(--bg-surface)',
              color: activeCategory === cat.id ? cat.color : 'var(--text-secondary)',
              border: `1px solid ${activeCategory === cat.id ? `${cat.color}40` : 'var(--border-primary)'}`,
            }}>
            {cat.label}
          </button>
        ))}
      </div>

      {/* 响应式 grid，窄屏 1 列、中屏 2 列、宽屏 4 列 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {filteredOptions.map((o, i) => (
          <ToolCard key={o.label} option={o} index={i} onSelect={onSelect} activeCategory={activeCategory} />
        ))}
      </div>
    </>
  );
}