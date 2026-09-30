import { getDb } from '../../db/client.js';
import { memories } from '../../db/schema/index.js';
import { desc, like, or, gt, isNull, and, sql, type SQL } from 'drizzle-orm';

/**
 * P1-19 修复：中文关键词提取。
 * 旧实现 split(/\s+/) 对无空格中文（"帮我继续完成上次那个济南项目"）会生成
 * 一个巨大单关键词，召回几乎失效。新实现：
 * - 英文/数字词按空白切分
 * - 中文字段按 2-4 字符滑动窗口（bigram/trigram/4-gram）提取关键词
 * - 过滤停用词与过短片段
 * - 上限 8 个关键词（保持查询开销可控）
 */
export function extractKeywords(context: string): string[] {
  const text = context.trim();
  if (!text) return [];

  const keywords = new Set<string>();
  // 1. 英文/数字词（含空白/标点分隔）
  for (const w of text.split(/[\s\p{P}\p{S}]+/u)) {
    const cleaned = w.trim().toLowerCase();
    if (cleaned.length >= 2) keywords.add(cleaned);
  }
  // 2. 中文字段滑动窗口
  const cjkRuns = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) ?? [];
  const STOPWORDS = new Set([
    '帮我', '请你', '继续', '完成', '上次', '那个', '这个', '一下', '之后',
    '现在', '需要', '进行', '处理', '支持', '可以', '能够', '什么', '怎么',
    '为什么', '多少', '哪些', '以及', '或者', '并且', '因为', '所以', '然后',
    '这边', '那边', '咱们', '我们', '你们', '他们', '大家', '对于', '关于',
    '如果', '但是', '不过', '还是', '已经', '正在', '将会', '是否', '非常',
    '比较', '稍微', '有点', '有点', '的地方', '东西',
  ]);

  for (const run of cjkRuns) {
    if (run.length < 2) continue;
    // bigram（2-gram）
    for (let i = 0; i <= run.length - 2; i++) {
      const gram = run.slice(i, i + 2);
      if (!STOPWORDS.has(gram)) keywords.add(gram);
    }
    // trigram（3-gram）—— 4 字及以上才提取，减少噪声
    if (run.length >= 3) {
      for (let i = 0; i <= run.length - 3; i++) {
        const gram = run.slice(i, i + 3);
        keywords.add(gram);
      }
    }
    // 4-gram —— 长实体（项目名等）更有区分度
    if (run.length >= 4) {
      for (let i = 0; i <= run.length - 4; i++) {
        keywords.add(run.slice(i, i + 4));
      }
    }
  }

  // 去停用词 + 上限 8
  const result = Array.from(keywords)
    .filter(w => w.length >= 2)
    .slice(0, 8);
  return result.length > 0 ? result : [];
}

/**
 * Get active memories as formatted string for prompt injection
 * 仅从 DB memories 表读取（JSON 文件已废弃，Wave0-MEM）
 * 可选 context 参数：传入用户消息内容，按关键词召回相关记忆
 * P1-17: 召回统一过滤已过期记忆（expiresAt > now OR IS NULL）
 */
export async function getActiveMemoriesFormatted(context?: string): Promise<string> {
  const parts: string[] = [];
  const nowIso = new Date().toISOString();

  try {
    const db = getDb();
    // P1-17: 非过期条件（所有查询共享）
    const notExpired: SQL = or(gt(memories.expiresAt, nowIso), isNull(memories.expiresAt)) as SQL;
    // 如果有 context，按关键词召回相关记忆（先匹配相关记忆，再补充最新记忆）
    if (context && context.trim()) {
      const keywords = extractKeywords(context);
      if (keywords.length > 0) {
        const conditions: SQL[] = keywords.flatMap(w => {
          const p = `%${w}%`;
          return [like(memories.content, p), like(memories.key, p)] as SQL[];
        });
        conditions.push(notExpired);
        const recalled = db.select().from(memories)
          .where(and(...conditions) as SQL)
          .orderBy(desc(memories.createdAt))
          .limit(10).all();
        for (const m of recalled) {
          let tags = '';
          try { const t = JSON.parse(m.tags || '[]'); tags = Array.isArray(t) ? t.slice(0, 3).join(', ') : ''; } catch { /* ignore */ }
          parts.push(`- [${m.type}] ${m.key}: ${m.content}${tags ? ' (#' + tags + ')' : ''}`);
        }
      }
    }
    // 补充最新记忆（上限 20 条，去重，排除过期）
    const existing = new Set(parts.map(p => p.split(':')[0]));
    const recent = db.select().from(memories)
      .where(notExpired)
      .orderBy(desc(memories.createdAt))
      .limit(20).all();
    for (const m of recent) {
      const key = `- [${m.type}] ${m.key}`;
      if (existing.has(key)) continue;
      existing.add(key);
      let tags = '';
      try { const t = JSON.parse(m.tags || '[]'); tags = Array.isArray(t) ? t.slice(0, 3).join(', ') : ''; } catch { /* ignore */ }
      parts.push(`${key}: ${m.content}${tags ? ' (#' + tags + ')' : ''}`);
    }
  } catch { /* DB 未初始化或表不存在，静默降级 */ }

  return parts.join('\n');
}