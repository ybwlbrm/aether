// ==================== 工具 Schema 定义 ====================

export const searchTools = [
  // grep tool
  {
    type: 'function',
    function: {
      name: 'grep',
      description: '使用正则表达式搜索文件内容，返回匹配的文件和行',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '正则表达式模式' },
          path: { type: 'string', description: '搜索目录路径（可选，默认工作目录）' },
          include: { type: 'string', description: '文件类型过滤如 *.ts, *.{ts,tsx}（可选）' },
          maxResults: { type: 'number', description: '最大结果数（默认 50）' },
        },
        required: ['pattern'],
      },
    },
  },
  // glob tool
  {
    type: 'function',
    function: {
      name: 'glob',
      description: '按文件名模式搜索文件，如 **/*.ts 或 src/**/*.css',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'glob 模式' },
          path: { type: 'string', description: '搜索目录（可选，默认工作目录）' },
        },
        required: ['pattern'],
      },
    },
  },
  // web_search tool
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '搜索互联网信息，返回标题、链接和摘要',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          maxResults: { type: 'number', description: '最大结果数（默认 5，最大 10）' },
        },
        required: ['query'],
      },
    },
  },
  // web_fetch tool
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: '获取网页内容并转换为文本',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '网页 URL' },
          format: { type: 'string', enum: ['text', 'markdown'], description: '输出格式（默认 text）' },
        },
        required: ['url'],
      },
    },
  },
];

// ==================== 常量 ====================

export const FORBIDDEN_PATH_PATTERNS = [
  'windows', 'program files', 'program files (x86)', 'system32',
  '/etc', '/root', '/boot', '/sbin', '/bin', '/usr/bin',
  '.git',
];

export const GREP_SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);
export const GLOB_SKIP_DIRS = new Set(['node_modules', '.git']);
export const GREP_MAX_DEPTH = 5;
export const GREP_MAX_FILE_SIZE = 1024 * 1024; // 1MB，超过则跳过
export const GREP_HARD_LIMIT = 200;
export const GREP_LINE_PREVIEW = 200; // 单行匹配预览的最大字符数
export const GLOB_HARD_LIMIT = 500;
export const WEB_SEARCH_TIMEOUT = 15000;
export const WEB_FETCH_TIMEOUT = 30000;
export const WEB_FETCH_MAX_OUTPUT = 8000; // 返回给 AI 的正文最大字符数

export const TEXT_EXTENSIONS = new Set([
  // 标记 / 配置 / 数据
  'txt', 'md', 'markdown', 'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'xml', 'svg', 'csv', 'tsv', 'properties', 'editorconfig', 'gitignore', 'gitattributes', 'npmrc', 'nvmrc',
  // 脚本 / 编程语言
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx',
  'py', 'pyi', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'scala', 'dart', 'lua', 'zig',
  'c', 'h', 'cpp', 'hpp', 'cc', 'hh', 'cs', 'fs', 'fsx', 'vb',
  'php', 'pl', 'pm', 'r', 'jl', 'ex', 'exs', 'erl', 'clj', 'cljs', 'hs', 'ml',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd',
  // Web / 样式
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'astro',
  // 其他
  'sql', 'graphql', 'gql', 'proto', 'log', 'lock', 'gradle', 'dockerfile', 'makefile', 'patch', 'diff',
]);

export const TEXT_BASENAMES = new Set(['license', 'readme', 'changelog', 'contributing', 'authors', 'notice', 'procfile']);