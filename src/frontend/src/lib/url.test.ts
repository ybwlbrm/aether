import { describe, it, expect } from 'vitest';
import { isUrlLike, normalizeUrl } from './url';

/** [输入, normalizeUrl 期望输出] */
const URL_LIKE: ReadonlyArray<readonly [string, string]> = [
  ['https://a.com', 'https://a.com/'],
  ['http://localhost:3000/x', 'http://localhost:3000/x'],
  // 裸 host:port（开发服务器）
  ['localhost:3000', 'http://localhost:3000/'],
  // 裸 IPv4:port
  ['192.168.1.5:8080', 'http://192.168.1.5:8080/'],
];

/** 视为搜索词 / 无法安全内嵌的输入 */
const NOT_URL_LIKE: ReadonlyArray<readonly [string, string]> = [
  ['foo.bar', '未知后缀的点号 token'],
  ['hello world', '含空格的搜索短语'],
  ['', '空串'],
  ['   ', '纯空白'],
  ['javascript:alert(1)', '可执行协议（iframe 绝不能收到）'],
];

describe('isUrlLike', () => {
  it.each(URL_LIKE)('%s 判定为网址', input => {
    expect(isUrlLike(input)).toBe(true);
  });

  it.each(NOT_URL_LIKE)('%s 判定为搜索词（%s）', input => {
    expect(isUrlLike(input)).toBe(false);
  });
});

describe('normalizeUrl', () => {
  it.each(URL_LIKE)('%s 规范化为 %s（无协议补 http://）', (input, expected) => {
    expect(normalizeUrl(input)).toBe(expected);
  });

  it.each(NOT_URL_LIKE)('%s 返回 null（%s）', input => {
    expect(normalizeUrl(input)).toBeNull();
  });

  it('忽略首尾空白', () => {
    expect(normalizeUrl('  localhost:3000  ')).toBe('http://localhost:3000/');
  });

  it('安全：非 http(s) 协议永远不产出 src', () => {
    for (const hostile of ['javascript:alert(1)', 'data:text/html,<script>', 'file:///c:/x', 'vbscript:msgbox']) {
      expect(normalizeUrl(hostile)).toBeNull();
    }
  });
});
