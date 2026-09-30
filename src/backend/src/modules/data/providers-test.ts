import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { isSafeFetchUrl } from '../../lib/safe-fetch.js';

/** Provider 测试连接路由 */
export function registerProviderTestRoutes(app: FastifyInstance, config: BackendConfig): void {
  // ====== Provider Test Connection ======
  app.post('/api/providers/test', { schema: { description: '测试 Provider 连接', tags: ['数据'] } }, async (request) => {
    const body = request.body as any;
    const { baseUrl, apiKey } = body;
    if (!baseUrl || !apiKey) return { success: false, message: '缺少 Base URL 或 API Key' };
    // SSRF 防护：校验 baseUrl
    if (!isSafeFetchUrl(baseUrl)) {
      return { success: false, message: 'Base URL 存在 SSRF 风险：禁止访问链路本地/元数据地址或非 http(s) 协议' };
    }
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      return { success: response.ok, message: response.ok ? '连接成功' : `API 返回错误: ${response.status}` };
    } catch (e: unknown) {
      return { success: false, message: `连接失败: ${(e instanceof Error ? e.message : String(e))}` };
    }
  });
}