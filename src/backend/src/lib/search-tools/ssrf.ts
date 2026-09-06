/**
 * Wave0-SS (P0-13/P2-47): 搜索/Web-fetch SSRF 校验统一复用 lib/safe-fetch 基础设施。
 * 之前这里是一份独立且不完整的实现（不拦 IPv6 子类、行为与 safe-fetch 不一致）。
 * 现在与 provider/media/yt-dlp 共用同一套：IPv4 混淆 / IPv6 字面量全拒 / 元数据 /
 * 链路本地 / DNS rebinding（resolveAndValidateUrl）。
 */
export { isSafeFetchUrl, resolveAndValidateUrl, assertSafeFetchUrl, isPublicFetchUrl, assertPublicFetchUrl } from '../safe-fetch.js';
