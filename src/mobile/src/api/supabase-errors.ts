// ============================================================
// Supabase 错误分类（任务 §22：禁止 catch{} 静默吞掉错误）
// 所有 Supabase 交互错误统一按类别上报，便于 UI 层针对性提示。
// ============================================================

/** 错误类别：network 网络 / auth 认证 / permission 权限 / schema 结构 / conflict 冲突 / server 服务端 */
export type SupabaseErrorKind = 'network' | 'auth' | 'permission' | 'schema' | 'conflict' | 'server';

/** 分类后的 Supabase 错误 */
export class SupabaseApiError extends Error {
  readonly kind: SupabaseErrorKind;
  readonly status?: number;
  readonly code?: string;

  constructor(kind: SupabaseErrorKind, message: string, opts?: { status?: number; code?: string }) {
    super(message);
    this.name = 'SupabaseApiError';
    this.kind = kind;
    this.status = opts?.status;
    this.code = opts?.code;
  }
}

/** 将任意错误分类为 SupabaseApiError */
export function classifyError(e: unknown): SupabaseApiError {
  if (e instanceof SupabaseApiError) return e;

  const anyE = e as { name?: string; status?: number; statusCode?: number; code?: string; message?: string; __isAuthError?: boolean };
  const status = anyE?.status ?? anyE?.statusCode;
  const code = anyE?.code;
  const message = anyE?.message ?? String(e);
  const msgLower = message.toLowerCase();

  // 网络层错误：fetch 抛出的 TypeError / 网络不可达
  if (e instanceof TypeError || anyE?.name === 'TypeError' || /failed to fetch|networkerror|fetch failed|load failed|network request failed/i.test(msgLower)) {
    return new SupabaseApiError('network', '网络错误，请检查网络连接', { status, code });
  }

  // 认证错误：401、auth-js 错误类
  if (anyE?.__isAuthError || status === 401 || /invalid login credentials|email not confirmed|invalid email|password should be|rate limit|auth/i.test(msgLower)) {
    return new SupabaseApiError('auth', message || '认证失败', { status, code });
  }

  // 权限错误：RLS 拒绝、42501
  if (code === '42501' || status === 403 || /permission denied|row.?level security|new row violates|denied by .* policy/i.test(msgLower)) {
    return new SupabaseApiError('permission', '没有权限执行此操作（RLS 或角色权限不足）', { status, code });
  }

  // 结构错误：表/列不存在、类型错误
  if (code === '42P01' || code === '42703' || code === '42883' || code === '22P02' || /relation .* does not exist|column .* does not exist|undefined_table|undefined_column|invalid input syntax/i.test(msgLower)) {
    return new SupabaseApiError('schema', message, { status, code });
  }

  // 冲突错误：唯一约束 / 外键约束
  if (code === '23505' || code === '23503' || code === '23502' || code === '23P01' || status === 409 || /duplicate key|foreign key|violates .* constraint|already exists/i.test(msgLower)) {
    return new SupabaseApiError('conflict', message, { status, code });
  }

  // 服务端 5xx 或未知错误
  if (status !== undefined && status >= 500) {
    return new SupabaseApiError('server', message, { status, code });
  }
  return new SupabaseApiError('server', message || '未知错误', { status, code });
}
