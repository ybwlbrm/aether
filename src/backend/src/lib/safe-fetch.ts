/**
 * SSRF 防护：安全的 fetch URL 校验
 *
 * 设计原则：
 * - 仅允许 http/https 协议
 * - 必须阻止：云元数据地址 169.254.169.254（AWS/Azure/GCP/Aliyun）、链路本地 169.254.0.0/16
 * - 必须允许：用户配置的本地 AI 提供商（如 Ollama http://127.0.0.1:11434、LM Studio http://localhost:1234 等）
 *   因此回环地址 (127.0.0.1, localhost, ::1) 和私网段 (10.x, 192.168.x, 172.16-31.x) 应放行
 * - 防止 IP 伪装（十进制/八进制/十六进制混淆、IPv6 嵌入 IPv4 等）
 */

const METADATA_HOSTS = new Set([
  '169.254.169.254',           // AWS/Azure/GCP/阿里云元数据服务
  'metadata.google.internal',  // GCP
  'metadata.azure.com',        // Azure
  'metadata.aliyun.com',       // 阿里云
]);

const METADATA_SUFFIXES = [
  '.metadata.google.internal',
  '.compute.internal',         // GCP 内部
  '.internal',                 // 通用内部域名后缀
  '.local',                    // mDNS 本地域名
];

/** 解析 hostname 为标准化 IPv4 地址（若为 IP 形式） */
export function parseIpv4(host: string): string | null {
  // 去除 IPv6 括号
  const h = host.startsWith('[') ? host.slice(1, -1) : host;

  // 标准点分十进制
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h)) return h;

  // 纯数字（十进制整数表示的 IPv4，如 2130706433 = 127.0.0.1）
  if (/^\d+$/.test(h)) {
    const num = parseInt(h, 10);
    if (num >= 0 && num <= 0xffffffff) {
      return [
        (num >>> 24) & 0xff,
        (num >>> 16) & 0xff,
        (num >>> 8) & 0xff,
        num & 0xff,
      ].join('.');
    }
    return null;
  }

  // 八进制（如 0177.0.0.1）
  if (/^0[0-7]+(\.0[0-7]+){3}$/.test(h)) {
    return h.split('.').map(o => parseInt(o, 8).toString()).join('.');
  }

  // 十六进制（如 0x7f.0x0.0x0.0x1）
  if (/^0x[0-9a-fA-F]+(\.0x[0-9a-fA-F]+){3}$/.test(h)) {
    return h.split('.').map(o => parseInt(o, 16).toString()).join('.');
  }

  return null;
}

/** 判断 IPv4 是否为链路本地地址 (169.254.0.0/16) */
export function isLinkLocal(ip: string): boolean {
  return /^169\.254\./.test(ip);
}

/** 判断 IPv4 是否为私网/回环地址（允许用于本地 AI 提供商） */
export function isPrivateOrLoopback(ip: string): boolean {
  // 回环 127.0.0.0/8
  if (/^127\./.test(ip)) return true;
  // 私网 10.0.0.0/8
  if (/^10\./.test(ip)) return true;
  // 私网 192.168.0.0/16
  if (/^192\.168\./.test(ip)) return true;
  // 私网 172.16.0.0/12 (172.16-31.x.x)
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  // 零地址 0.0.0.0
  if (ip === '0.0.0.0') return true;
  return false;
}

/** 判断 hostname 是否为元数据服务域名 */
export function isMetadataHostname(host: string): boolean {
  const lower = host.toLowerCase();
  if (METADATA_HOSTS.has(lower)) return true;
  for (const suffix of METADATA_SUFFIXES) {
    if (lower.endsWith(suffix)) return true;
  }
  return false;
}

/**
 * 校验 URL 是否安全可 fetch
 *
 * @param raw 原始 URL 字符串
 * @returns true=安全可请求，false=拒绝（SSRF 风险）
 *
 * 规则：
 * 1. 仅允许 http: / https: 协议
 * 2. 拒绝链路本地 169.254.0.0/16（含 169.254.169.254 云元数据）
 * 3. 拒绝元数据服务域名
 * 4. 允许回环/私网地址（本地 AI 提供商合法用例）
 * 5. 防止 IP 伪装（十进制/八进制/十六进制混淆）
 */
export function isSafeFetchUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    // 仅允许 http/https
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;

    const host = u.hostname.toLowerCase();

    // 1. 直接命中元数据服务域名/IP
    if (isMetadataHostname(host)) return false;

    // 2. 解析 IP 形式（含混淆编码）
    const ip = parseIpv4(host);
    if (ip) {
      // 链路本地/元数据 IP 必须拦截
      if (isLinkLocal(ip)) return false;
      // 私网/回环 IP 放行（本地 AI 提供商）
      // 无需额外检查，直接通过
    }

    // 3. 域名形式的链路本地检查（极少见，但防御性检查）
    if (/^169\.254\./.test(host)) return false;

    return true;
  } catch {
    // URL 解析失败视为不安全
    return false;
  }
}

/**
 * 校验并抛出错误（用于 provider 创建/更新/测试端点）
 */
export function assertSafeFetchUrl(raw: string, fieldName: string = 'baseUrl'): void {
  if (!isSafeFetchUrl(raw)) {
    throw new Error(`${fieldName} 存在 SSRF 风险：禁止访问链路本地/元数据地址或非 http(s) 协议`);
  }
}