/**
 * 安全条件求值（WF-001 / P0-28）
 *
 * workflow condition 节点操作符集合。13 种操作符全部为纯函数实现，
 * 绝不使用 eval / new Function —— 输入即字符串/原始值，输出布尔。
 */

export const CONDITION_OPERATORS = [
  'equals', 'not_equals', 'contains', 'starts_with', 'ends_with',
  'truthy', 'falsy', 'greater_than', 'less_than',
  'greater_or_equal', 'less_or_equal', 'exists', 'not_exists',
] as const;

export type ConditionOperator = typeof CONDITION_OPERATORS[number];

/** 字符串假值（truthy/falsy 语义：空串 / 'false' / '0' / null / undefined → 假） */
function asText(value: unknown, allowNull = false): string {
  if (value == null) return '';
  return typeof value === 'string' ? value : String(value);
}

/** 数值化比较（非数字 → NaN → 返回 false） */
function asNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 求值条件表达式（无 eval）。
 * @param op 操作符（未知操作符回退 Boolean(value)，保持旧实现兼容）
 * @param value 待判断值
 * @param compare 比较目标值
 */
export function evaluateCondition(op: string, value: unknown, compare?: unknown): boolean {
  const v = asText(value);
  const c = asText(compare);
  switch (op) {
    case 'equals':
      return v === c;
    case 'not_equals':
      return v !== c;
    case 'contains':
      return v.includes(c);
    case 'starts_with':
      return v.startsWith(c);
    case 'ends_with':
      return v.endsWith(c);
    case 'truthy':
      return v !== '' && v !== 'false' && v !== '0';
    case 'falsy':
      return v === '' || v === 'false' || v === '0';
    case 'greater_than': {
      const a = asNumber(v); const b = asNumber(c);
      return a !== null && b !== null && a > b;
    }
    case 'less_than': {
      const a = asNumber(v); const b = asNumber(c);
      return a !== null && b !== null && a < b;
    }
    case 'greater_or_equal': {
      const a = asNumber(v); const b = asNumber(c);
      return a !== null && b !== null && a >= b;
    }
    case 'less_or_equal': {
      const a = asNumber(v); const b = asNumber(c);
      return a !== null && b !== null && a <= b;
    }
    case 'exists':
      return value != null && v !== '';
    case 'not_exists':
      return value == null || v === '';
    default:
      // 兼容旧 behavior：未知操作符按 Boolean(value) 处理
      return value != null && v !== '' && v !== 'false' && v !== '0';
  }
}