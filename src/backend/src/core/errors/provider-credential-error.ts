/**
 * ProviderCredentialError — Provider 凭据无法解密/损坏的专用错误
 *
 * 触发场景：providers 表中的加密 API Key 在用 DPAPI 派生密钥/encryptionKey
 * 解密时失败（密钥轮换、数据损坏、跨机器恢复等）。
 *
 * 语义：绝不允许"解密失败 → 保留密文 → 调用 API（必 401）"。
 * 解密失败即停止执行，向用户展示"Provider 凭据无法解密"。
 *
 * Transport-agnostic（继承 RuntimeError 体系），纯 TypeScript。
 */

import { RuntimeError } from './runtime-error.js';

export class ProviderCredentialError extends RuntimeError {
  constructor(providerName: string, cause?: unknown) {
    super(`Provider "${providerName}" 凭据无法解密（密钥可能损坏或与加密密钥不匹配）`, {
      code: 'PROVIDER_CREDENTIAL_ERROR',
      cause,
      retryable: false,
      context: { providerName },
    });
    this.name = 'ProviderCredentialError';
    // 维持 instanceof 链
    Object.setPrototypeOf(this, ProviderCredentialError.prototype);
  }

  /** 判断错误是否为凭据问题（供业务层快速识别） */
  static isProviderCredentialError(value: unknown): value is ProviderCredentialError {
    return value instanceof ProviderCredentialError;
  }
}