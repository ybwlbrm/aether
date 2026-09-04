import { randomBytes } from 'node:crypto';

let localAuthToken: string | null = null;

/**
 * 生成并返回本地认证 token（启动时调用一次）。
 * token 仅存在于内存中，不落盘。
 */
export function generateLocalAuthToken(): string {
  localAuthToken = randomBytes(32).toString('hex');
  return localAuthToken;
}

/**
 * 获取当前的本地认证 token。
 * 若未生成则返回 null（正常情况下 buildApp 启动时已生成）。
 */
export function getLocalAuthToken(): string | null {
  return localAuthToken;
}

/**
 * 验证 Authorization: Bearer <token> 头。
 * 返回 true 表示 token 匹配，false 表示缺失或不匹配。
 */
export function verifyAuthToken(authHeader: string | undefined): boolean {
  if (!localAuthToken) return false;
  if (!authHeader) return false;
  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) return false;
  // 使用恒定时间比较防止时序攻击（虽本地 token 风险极低，但养成好习惯）
  if (token.length !== localAuthToken.length) return false;
  let result = 0;
  for (let i = 0; i < token.length; i++) {
    result |= token.charCodeAt(i) ^ localAuthToken.charCodeAt(i);
  }
  return result === 0;
}