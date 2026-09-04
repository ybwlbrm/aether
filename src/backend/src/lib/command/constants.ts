/** 允许执行的命令白名单（首词精确匹配） */
export const ALLOWED_EXEC = new Set([
  'node', 'npm', 'npx', 'python', 'python3', 'pip', 'tsx', 'curl',
  'echo', 'cat', 'ls', 'dir', 'pwd', 'cd', 'mkdir', 'cp', 'mv', 'rm',
  'grep', 'find', 'type', 'where', 'date', 'whoami', 'hostname',
  'netstat', 'ping', 'more', 'sort', 'uniq', 'wc', 'head', 'tail',
  'code', 'explorer', 'start',
  'powershell', 'pwsh', 'cmd',
]);

/**
 * 禁止出现的危险命令 token — 只保留真正危险的。
 * 用户要求允许 powershell/cmd，移除它们以支持日常文件操作。
 */
export const FORBIDDEN_TOKENS = new Set([
  'wscript', 'wscript.exe', 'cscript', 'cscript.exe',
  'shutdown', 'shutdown.exe', 'format', 'format.com',
  'taskkill', 'diskpart', 'reg', 'reg.exe', 'schtasks',
]);

/** 禁止的危险参数组合（子串匹配） */
export const FORBIDDEN_COMBINATIONS = ['rm -rf', 'del /f', 'del /q', 'rmdir /s'];

/** 敏感路径段（与 files.ts 的 FORBIDDEN_PATH_PATTERNS 保持一致语义） */
export const FORBIDDEN_PATH_PATTERNS = [
  'windows', 'program files', 'program files (x86)', 'system32',
  '/etc', '/root', '/boot', '/sbin', '/bin', '/usr/bin',
  '.git',
];

export const DEFAULT_TIMEOUT_MS = 30000;
export const MAX_TIMEOUT_MS = 60000;
export const MAX_OUTPUT_CHARS = 50000;

/** 内建命令集合 */
export const BUILTIN_COMMANDS = new Set([
  'echo', 'dir', 'ls', 'type', 'cat', 'pwd', 'cd', 'mkdir', 'rm', 'cp', 'mv', 'where', 'date', 'whoami', 'hostname',
]);

/** 危险解释器 basename 列表 */
export const DANGEROUS_BASENAMES = [
  'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'cmd', 'cmd.exe',
  'mshta', 'mshta.exe', 'bash', 'wsl', 'wsl.exe',
  'rundll32', 'rundll32.exe', 'regsvr32', 'regsvr32.exe',
  'wmic', 'wmic.exe', 'certutil', 'certutil.exe', 'bitsadmin', 'bitsadmin.exe',
];