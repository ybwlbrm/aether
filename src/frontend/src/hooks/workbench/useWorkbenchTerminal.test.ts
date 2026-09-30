/**
 * T21 `useWorkbenchTerminal` —— 终端面板数据契约（TDD：先 RED）。
 *
 * 唯一数据源：`api.result.getTerminalHistory()` / `api.result.executeTerminal()`，
 * 二者都走 `requestResult`（永不 throw，调用点判别 `ok`）。
 *
 * ## 为什么成功与否是"推断"而不是字段
 * 后端 `POST /api/terminal/execute` 的响应体**只有** `{ output }`
 * （src/backend/src/modules/terminal/index.ts:66 `return { output }`），
 * 它内部用三个输出前缀算了一个 `success` 却**不回传**。因此前端只能按同样三个
 * 前缀推断，且该推断必须与后端保持同一份取值 —— 见 `inferTerminalSuccess`。
 * 本文件不得声称响应里有 success 字段：那是后端没有的契约。
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { inferTerminalSuccess, useWorkbenchTerminal, TERMINAL_FAILURE_PREFIXES } from './useWorkbenchTerminal';

// ---------- 成功推断（后端三前缀的镜像） ----------

describe('inferTerminalSuccess —— execute 只回 { output }，成功由输出前缀推断', () => {
  it.each([
    ['错误:', '错误: 命令不存在'],
    ['安全限制', '安全限制：目标路径不在允许目录内'],
    ['权限不足', '权限不足：该命令需要 Level 3'],
  ])('输出以 %s 开头时判为失败', (_prefix, output) => {
    expect(inferTerminalSuccess(output)).toBe(false);
  });

  it('正常命令输出判为成功', () => {
    expect(inferTerminalSuccess('vite v6.0.0 ready in 412 ms\n')).toBe(true);
  });

  it('输出中段出现失败前缀不影响判定（后端只看 startsWith）', () => {
    expect(inferTerminalSuccess('build log\n错误: 3 个历史告警')).toBe(true);
  });

  it('空输出判为成功（后端未拒绝即成功）', () => {
    expect(inferTerminalSuccess('')).toBe(true);
  });

  it('前缀表与后端一致：恰好三个，且与后端逐字相同', () => {
    expect([...TERMINAL_FAILURE_PREFIXES]).toEqual(['错误:', '安全限制', '权限不足']);
  });
});

// ---------- hook 返回值契约 ----------

describe('useWorkbenchTerminal hook 契约', () => {
  it('未取数时返回空历史 + 可调 execute/clear（静态渲染不发请求）', () => {
    function Probe(): ReturnType<typeof createElement> {
      const { history, running, error, execute, clear } = useWorkbenchTerminal();
      return createElement(
        'span',
        null,
        JSON.stringify({
          history: history.length,
          running,
          error,
          execute: typeof execute,
          clear: typeof clear,
        }),
      );
    }

    const markup = renderToStaticMarkup(createElement(Probe));

    expect(markup).toContain(
      '{&quot;history&quot;:0,&quot;running&quot;:false,&quot;error&quot;:null,&quot;execute&quot;:&quot;function&quot;,&quot;clear&quot;:&quot;function&quot;}',
    );
  });
});
