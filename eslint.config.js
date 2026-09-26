// ESLint v9 flat config — TypeScript 支持
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      '**/dist/**',
      '**/build/**',
      'dist_exe/**',
      'dist_electron/**',
      'android/**',
      'electron/**',
    ],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        __dirname: 'readonly',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        AbortSignal: 'readonly',
        AbortController: 'readonly',
        URL: 'readonly',
        crypto: 'readonly',
        localStorage: 'readonly',
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        HTMLElement: 'readonly',
        HTMLImageElement: 'readonly',
        HTMLIFrameElement: 'readonly',
        FileReader: 'readonly',
        Blob: 'readonly',
        customElements: 'readonly',
        CustomEvent: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      // 宽松规则：项目已成型，只报真正错误，不改风格
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // AEX-P2-003: 空块（含空 catch）一律 error —— 空 catch 必须显式分类
      // （intentional fallback / recoverable / ignored / bug）并写明原因，禁止静默吞错。
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-undef': 'off', // TS 已处理
      '@typescript-eslint/no-explicit-any': 'warn', // P2-8: 逐步收紧 any 使用
      '@typescript-eslint/no-var-requires': 'off',
      // AEX-P2-005: console 受限 —— 默认放行 console.warn/error（异常出口），
      // console.log/info/debug 一律告警，强制走结构化 logger。
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      // P2-2 修复：引用 react-hooks 规则但未安装插件 → ESLint 报 "Definition for rule was not found"。
      // 项目中未安装 eslint-plugin-react-hooks，移除该规则引用。若未来安装插件可重新启用。
      // 'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // AEX-P2-003: Run/Task 状态机与崩溃恢复是核心执行路径，any 零容忍。
  // 该目录由 runtime agent 独占，any 直接阻断 CI。
  {
    files: ['src/backend/src/core/runtime/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },

  // AEX-P2-005: 后端生产代码（modules/lib/plugins）禁用全部 console.*，
  // 统一走 src/backend/src/lib/logger.ts（pino 结构化日志：logger.info({ event }, 'msg')）。
  // 确需保留的调用必须写 `// eslint-disable-next-line no-console -- <原因>` 显式豁免。
  {
    files: [
      'src/backend/src/modules/**/*.ts',
      'src/backend/src/lib/**/*.ts',
      'src/backend/src/plugins/**/*.ts',
    ],
    rules: {
      // 必须写成 ['warn', {}]（空 options）而不能只写 'warn'：
      // flat config 的 rulesSchema.merge 在「后一个配置只给 severity」时
      // 会保留前一个配置的 options，于是裸 'warn' 仍会继承基础配置的
      // allow 白名单而形同虚设。空 options ⇒ allow 为空 ⇒ 所有 console 方法告警。
      'no-console': ['warn', {}],
    },
  },
];
