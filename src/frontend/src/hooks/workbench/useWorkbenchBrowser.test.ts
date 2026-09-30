/**
 * T21 `useWorkbenchBrowser` —— Browser 面板的地址安全契约（TDD：先 RED）。
 *
 * 判定完全委托 T4 `lib/url.ts`：只有 http/https 能变成 iframe 的 src，
 * `javascript:` / `data:` / `file:` 一律返回 null。本文件锁死的不变量是：
 * **无论输入什么，`iframeSrc` 都不会是可执行协议**。
 */
import { describe, expect, it } from 'vitest';
import { normalizeUrl } from '../../lib/url';
import { createBrowserSession, RELOAD_PARAM, resolveBrowserInput } from './useWorkbenchBrowser';

const A = 'http://a.test/one';
const B = 'https://b.test/two';

describe('resolveBrowserInput —— URL 判定委托 T4', () => {
  it('javascript: 被 T4 判为非 URL-like，href 为 null', () => {
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(resolveBrowserInput('javascript:alert(1)')).toEqual({ href: null, blocked: true });
  });

  it('data: / file: 同样被拒', () => {
    expect(resolveBrowserInput('data:text/html,<script>x</script>').href).toBeNull();
    expect(resolveBrowserInput('file:///C:/Windows').href).toBeNull();
  });

  it('裸主机补全 scheme 后放行', () => {
    expect(resolveBrowserInput('a.test/one')).toEqual({ href: A, blocked: false });
  });

  it('空输入不算被拦截（没有可加载目标，但也不是非法协议）', () => {
    expect(resolveBrowserInput('   ')).toEqual({ href: null, blocked: false });
  });
});

describe('createBrowserSession —— iframe 永不接收可执行协议', () => {
  it('首次输入 javascript: 时 iframeSrc 保持 null', () => {
    const session = createBrowserSession('');

    session.setUrl('javascript:alert(1)');

    expect(session.getSnapshot().iframeSrc).toBeNull();
    expect(session.getSnapshot().blocked).toBe(true);
    expect(session.getSnapshot().url).toBe('javascript:alert(1)');
  });

  it('已加载页面后再输入 javascript:：保留原页面，且 blocked 置位', () => {
    const session = createBrowserSession(A);

    session.setUrl('javascript:void(0)');

    expect(session.getSnapshot().iframeSrc).toBe(A);
    expect(session.getSnapshot().blocked).toBe(true);
  });

  it('导航栈只收规范化 href，可回退/前进', () => {
    const session = createBrowserSession(A);

    session.setUrl(B);
    expect(session.getSnapshot().iframeSrc).toBe(B);
    expect(session.getSnapshot().canGoBack).toBe(true);
    expect(session.getSnapshot().canGoForward).toBe(false);

    session.back();
    expect(session.getSnapshot().iframeSrc).toBe(A);
    expect(session.getSnapshot().canGoForward).toBe(true);

    session.forward();
    expect(session.getSnapshot().iframeSrc).toBe(B);
  });

  it('在历史中间导航会截断前进分支', () => {
    const session = createBrowserSession(A);
    session.setUrl(B);
    session.back();

    session.setUrl('http://c.test/three');

    expect(session.getSnapshot().canGoForward).toBe(false);
    expect(session.getSnapshot().iframeSrc).toBe('http://c.test/three');
  });

  it('回到栈首不能再退，回到栈尾不能再进', () => {
    const session = createBrowserSession(A);
    session.back();
    expect(session.getSnapshot().canGoBack).toBe(false);

    session.setUrl(B);
    session.forward();
    expect(session.getSnapshot().canGoForward).toBe(false);
  });

  it('reload 改变 iframeSrc 以强制重新加载文档', () => {
    const session = createBrowserSession(A);
    const before = session.getSnapshot().iframeSrc;

    session.reload();

    const after = session.getSnapshot().iframeSrc;
    expect(after).not.toBe(before);
    expect(after).toContain(`${RELOAD_PARAM}=1`);
    // 基础地址不变：reload 只加缓存破坏参数，不换页
    expect(session.getSnapshot().canGoBack).toBe(false);
  });

  it('订阅者在每次变更时被通知，取消订阅后不再收到', () => {
    const session = createBrowserSession(A);
    let hits = 0;
    const unsubscribe = session.subscribe(() => { hits += 1; });

    session.setUrl(B);
    expect(hits).toBe(1);

    unsubscribe();
    session.back();
    expect(hits).toBe(1);
  });
});
