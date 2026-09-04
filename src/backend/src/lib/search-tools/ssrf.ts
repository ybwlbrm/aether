// ==================== 内部辅助：SSRF 防护 ====================
// 与 modules/search/index.ts 的 isSafeFetchUrl 保持一致

/** SSRF 防护：检查 URL 是否安全可访问 */
export function isSafeFetchUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    // 本地回环 / 本机
    if (host === '127.0.0.1' || host === 'localhost' || host === '0.0.0.0' || host === '::1') return false;
    // 云元数据地址（AWS/Azure/GCP/Aliyun）
    if (host === '169.254.169.254' || host.endsWith('.metadata.google.internal') || host === 'metadata.google.internal') return false;
    // 私网段 / 链路本地 / 多播
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.)/.test(host)) return false;
    // 内网域名后缀（常见本地服务域名）
    if (host.endsWith('.local') || host.endsWith('.internal')) return false;
    // 防止十进制/八进制混淆 IP（如 http://2130706433 指向 127.0.0.1）
    try {
      const ip = u.hostname.startsWith('[') ? u.hostname.slice(1, -1) : u.hostname;
      if (/^\d+$/.test(ip.replace(/\./g, '')) && ip.includes('.')) {
        if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(ip)) return false;
      }
    } catch { /* 忽略解析失败 */ }
    return true;
  } catch {
    return false;
  }
}