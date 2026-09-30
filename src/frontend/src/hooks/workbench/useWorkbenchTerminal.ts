/**
 * T21 `useWorkbenchTerminal` —— Terminal 面板的真实终端数据。
 *
 * ## 唯一数据源
 * `api.result.getTerminalHistory()` / `api.result.executeTerminal()`（api/client.ts:515,516），
 * 二者都走 `requestResult`：**永不 throw**，调用点判别 `ok`（因此本文件没有 try/catch）。
 *
 * ## 后端契约（读 src/backend/src/modules/terminal/index.ts 后确认）
 * - `GET /api/terminal/history` 返回**裸数组**（不是 `{ items }` 包装）：`unshift` 写入，
 *   所以是 **newest-first**；上限 100 条（lib/command/history.ts:MAX_HISTORY）；
 *   `timestamp` 是 `new Date().toLocaleTimeString()`（**本地时间字符串，不是 ISO**）。
 * - `POST /api/terminal/execute` 的响应体**只有 `{ output }`**。后端自己用三个输出前缀
 *   算了一个 `success` 却**不回传**（terminal/index.ts:57,66）——所以前端只能按同样三个
 *   前缀**推断**，见 `inferTerminalSuccess`。本文件绝不假设响应里存在 `success` 字段。
 *
 * ## 本地回显
 * 执行成功后立即回显一行（真实 command + 真实 output），其 `duration` 为 `null`
 * 表示"本地未测得"，**绝不编造时长**；下次挂载时后端权威条目（含真实 id / duration /
 * success）会整体替换本地回显。
 */
import { useCallback, useEffect, useState } from 'react';
import type { TerminalEntry } from '../../api/types';
import { api } from '../../api/client';

/**
 * 后端判定失败时输出会带的前缀（与 backend/src/modules/terminal/index.ts:57 逐字一致）。
 * 后端用同样三个前缀算 `success` 却不回传，前端因此复用同一份取值做推断。
 */
export const TERMINAL_FAILURE_PREFIXES = ['错误:', '安全限制', '权限不足'] as const;

/**
 * 从执行输出推断成功与否。
 *
 * ⚠️ 这是**推断**，不是后端字段：`/terminal/execute` 的响应体只有 `{ output }`。
 * 判定规则与后端一致（只看输出开头是否命中三个失败前缀），因此后端改了前缀表，
 * 这里就会失配 —— 改动必须同时落在 backend/src/modules/terminal/index.ts:57。
 */
export function inferTerminalSuccess(output: string): boolean {
  return !TERMINAL_FAILURE_PREFIXES.some(prefix => output.startsWith(prefix));
}

/** 终端渲染行：后端权威条目与本地回显共用一个形状。 */
export interface TerminalLine {
  /** 稳定 key：后端条目用其 id，本地回显用 `local-<n>` */
  readonly key: string;
  readonly command: string;
  readonly output: string;
  readonly success: boolean;
  /** 本地时间字符串（`toLocaleTimeString()`，与后端同格式）；不是 ISO */
  readonly timestamp: string;
  /** 毫秒；`null` = 本地回显，服务端未计时（不编造） */
  readonly duration: number | null;
  readonly source: 'terminal' | 'agent';
}

export interface UseWorkbenchTerminalResult {
  /** 渲染行，newest-first（后端写入序 + 本地回显插在表头） */
  readonly history: readonly TerminalLine[];
  /** 执行命令；resolve 后表头已插入该命令的本地回显 */
  readonly execute: (command: string) => Promise<void>;
  readonly running: boolean;
  readonly error: string | null;
  /** 本地清屏：只清本面板视图，**不改后端共享的 100 条历史** */
  readonly clear: () => void;
}

const EMPTY_HISTORY: readonly TerminalLine[] = [];

/** 后端条目 → 渲染行（字段一一对应，无加工）。 */
function toLine(entry: TerminalEntry): TerminalLine {
  return {
    key: entry.id,
    command: entry.command,
    output: entry.output,
    success: entry.success,
    timestamp: entry.timestamp,
    duration: entry.duration,
    source: entry.source ?? 'terminal',
  };
}

/** 本地回显序号：与后端 id 空间隔离（后端 id 形如 `cmd-<ts>-<rand>`）。 */
let localEchoSeq = 0;

export function useWorkbenchTerminal(): UseWorkbenchTerminalResult {
  const [history, setHistory] = useState<readonly TerminalLine[]>(EMPTY_HISTORY);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 挂载读一次权威历史（newest-first 裸数组）；卸载后不再写 state
  useEffect(() => {
    let active = true;
    void api.result.getTerminalHistory().then(res => {
      if (!active) return;
      if (!res.ok) {
        setError(res.error.message);
        return;
      }
      setHistory(res.data.map(toLine));
    });
    return () => { active = false; };
  }, []);

  const execute = useCallback(async (command: string): Promise<void> => {
    if (command.trim() === '') return;
    setRunning(true);
    setError(null);
    try {
      const res = await api.result.executeTerminal(command);
      if (!res.ok) {
        setError(res.error.message);
        return;
      }
      // execute 只回 { output }：成功与否由前缀推断（见 inferTerminalSuccess 的注释）
      const output = res.data.output ?? '';
      localEchoSeq += 1;
      const echo: TerminalLine = {
        key: `local-${localEchoSeq}`,
        command,
        output,
        success: inferTerminalSuccess(output),
        timestamp: new Date().toLocaleTimeString(),
        duration: null,
        source: 'terminal',
      };
      setHistory(previous => [echo, ...previous]);
    } finally {
      setRunning(false);
    }
  }, []);

  const clear = useCallback((): void => { setHistory(EMPTY_HISTORY); }, []);

  return { history, execute, running, error, clear };
}
