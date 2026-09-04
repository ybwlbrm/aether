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
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-undef': 'off', // TS 已处理
      '@typescript-eslint/no-explicit-any': 'warn', // P2-8: 逐步收紧 any 使用
      '@typescript-eslint/no-var-requires': 'off',
      'no-console': 'off',
      // P2-2 修复：引用 react-hooks 规则但未安装插件 → ESLint 报 "Definition for rule was not found"。
      // 项目中未安装 eslint-plugin-react-hooks，移除该规则引用。若未来安装插件可重新启用。
      // 'react-hooks/exhaustive-deps': 'warn',
    },
  },
];
