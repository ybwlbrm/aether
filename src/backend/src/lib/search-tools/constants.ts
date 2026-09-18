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

// 整改计划第 8 章（P1/P2）：本地搜索默认排除的敏感文件（basename 精确匹配）
// —— 数据库 / 同步配置 / 加密密钥 / token/key/cookie/证书 / 构建产物
export const SENSITIVE_FILE_BASENAMES = new Set([
  // 数据库与同步配置
  'pacc.db', 'pacc-test.db', 'sync-config.json',
  // 加密密钥与凭据
  '.encryption_key', '.encryption_key.backup', 'keystore.properties',
  // 凭据/token/证书
  'credentials.json', 'credentials', 'id_rsa', 'id_ed25519', 'id_dsa',
  '.npmrc', '.pypirc', '.netrc', '.env', '.env.local', '.env.production',
  'service-account.json', 'service_account.json',
  // 证书
  'cert.pem', 'key.pem', 'certificate.pem', 'chain.pem', 'fullchain.pem', 'privkey.pem',
]);

/** 敏感文件后缀（正则匹配文件路径）—— token/key/cookie/证书/私钥模式 */
export const SENSITIVE_FILE_PATTERNS = [
  /\.(pem|key|p12|pfx|jks|keystore|cer|crt|der)$/i,        // 证书/密钥
  /\.(env|secret|secrets)$/i,                                // 环境变量/机密
  /(^|[\\/])\.(env|git-credentials|docker\/(config\.json|config\.json\.lock))$/i,
  /token|apikey|api_key|secret|password|credential/i,        // 名称含凭据关键字的文件
  /(^|[\\/])(pacc\.db|sync-config\.json|\.encryption_key.*)$/i,
];

/** 敏感内容脱敏 —— 匹配 key/token/password 等模式的行替换为占位符 */
export const SENSITIVE_CONTENT_PATTERNS = [
  /(sk-[a-zA-Z0-9]{20,})/g,                          // OpenAI 风格 key
  /(['"])?(api[_-]?key|apikey|token|password|secret|authorization)(['"]?)\s*[:=]\s*['"]?[A-Za-z0-9_\-\.]{16,}['"]?/gi,
  /Bearer\s+[A-Za-z0-9\-._~+\/]+=*/g,                // Bearer token
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, // 私钥块
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