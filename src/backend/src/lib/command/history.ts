// ========== 共享命令执行历史（供终端页面轮询显示） ==========
export interface CommandHistoryEntry {
  id: string;
  command: string;
  output: string;
  timestamp: string;
  duration: number;
  success: boolean;
  source: 'terminal' | 'agent';
}

const commandHistory: CommandHistoryEntry[] = [];
const MAX_HISTORY = 100;

export function addCommandHistory(entry: Omit<CommandHistoryEntry, 'id' | 'timestamp'>): void {
  commandHistory.unshift({
    ...entry,
    id: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toLocaleTimeString(),
  });
  if (commandHistory.length > MAX_HISTORY) commandHistory.length = MAX_HISTORY;
}

export function getCommandHistory(): CommandHistoryEntry[] {
  return commandHistory;
}

/** 命令工具 Schema 定义 */
export const commandTools = [
  {
    type: 'function',
    function: {
      name: 'execute_command',
      description: '执行 shell 命令并返回输出结果',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令' },
          workdir: { type: 'string', description: '工作目录（可选，默认使用 allowedDirs[0]）' },
          timeout: { type: 'number', description: '超时时间毫秒（默认 30000，最大 60000）' },
        },
        required: ['command'],
      },
    },
  },
];