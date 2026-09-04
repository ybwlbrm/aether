/** 解码常见 HTML 实体（命名实体 + 十进制/十六进制数字实体） */
export function decodeHtmlEntities(text: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', mdash: '—', ndash: '–', hellip: '…',
  };
  return text
    .replace(/&([a-z]+);/gi, (raw, name: string) => {
      const decoded = named[name.toLowerCase()];
      return decoded !== undefined ? decoded : raw;
    })
    .replace(/&#(\d+);/g, (raw, code: string) => {
      const n = parseInt(code, 10);
      return Number.isFinite(n) && n >= 32 && n <= 0x10ffff ? String.fromCodePoint(n) : raw;
    })
    .replace(/&#x([0-9a-f]+);/gi, (raw, code: string) => {
      const n = parseInt(code, 16);
      return Number.isFinite(n) && n >= 32 && n <= 0x10ffff ? String.fromCodePoint(n) : raw;
    });
}

/** 剥离所有 HTML 标签，保留纯文本 */
export function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}