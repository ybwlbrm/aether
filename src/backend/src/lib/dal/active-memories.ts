import { getMemories } from './memory.js';

/**
 * Get active memories as formatted string for prompt injection
 * 合并两个来源：新 DB memories 表 + 旧 JSON memory.json（兼容过渡）
 * 可选 context 参数：传入用户消息内容，按关键词召回相关记忆
 */
export async function getActiveMemoriesFormatted(context?: string): Promise<string> {
  const parts: string[] = [];

  // 1. 从 DB memories 表读取（新系统）
  try {
    const { getDb } = await import('../../db/client.js');
    const { memories } = await import('../../db/schema/index.js');
    const { desc, like, or } = await import('drizzle-orm');
    const db = getDb();
    // 如果有 context，按关键词召回相关记忆（先匹配相关记忆，再补充最新记忆）
    if (context && context.trim()) {
      const keywords = context.trim().split(/\s+/).filter(w => w.length > 1).slice(0, 5);
      if (keywords.length > 0) {
        const conditions = keywords.flatMap(w => {
          const p = `%${w}%`;
          return [like(memories.content, p), like(memories.key, p)];
        });
        const recalled = db.select().from(memories)
          .where(or(...conditions))
          .orderBy(desc(memories.createdAt))
          .limit(10).all();
        for (const m of recalled) {
          let tags = '';
          try { const t = JSON.parse(m.tags || '[]'); tags = Array.isArray(t) ? t.slice(0, 3).join(', ') : ''; } catch { /* ignore */ }
          parts.push(`- [${m.type}] ${m.key}: ${m.content}${tags ? ' (#' + tags + ')' : ''}`);
        }
      }
    }
    // 补充最新记忆（上限 20 条，去重）
    const existing = new Set(parts.map(p => p.split(':')[0]));
    const recent = db.select().from(memories).orderBy(desc(memories.createdAt)).limit(20).all();
    for (const m of recent) {
      const key = `- [${m.type}] ${m.key}`;
      if (existing.has(key)) continue;
      existing.add(key);
      let tags = '';
      try { const t = JSON.parse(m.tags || '[]'); tags = Array.isArray(t) ? t.slice(0, 3).join(', ') : ''; } catch { /* ignore */ }
      parts.push(`${key}: ${m.content}${tags ? ' (#' + tags + ')' : ''}`);
    }
  } catch { /* DB 未初始化或表不存在，静默降级 */ }

  // 2. 从旧 JSON 文件读取（兼容旧数据）
  try {
    const mems = await getMemories();
    const active = mems.filter(m => m.active);
    for (const m of active) {
      parts.push(`- ${m.content}`);
    }
  } catch { /* ignore */ }

  return parts.join('\n');
}