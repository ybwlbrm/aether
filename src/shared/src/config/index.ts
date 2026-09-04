import { AppConfigSchema, type AppConfig } from '../schemas/index.js';

/** 默认配置 */
const defaultConfig: AppConfig = {
  port: 3000,
  host: '127.0.0.1',
  dataDir: './data',
  allowedDirs: ['./data', './workspace'],
  allowedOrigins: [
    'http://127.0.0.1:3000',
    'http://localhost:3000',
    'http://127.0.0.1:5173',
    'http://localhost:5173',
  ],
  enableSwagger: false,
};

/** 加载配置 */
export function loadConfig(): AppConfig {
  const config: AppConfig = {
    ...defaultConfig,
    port: parseInt(process.env.PORT || '3000', 10),
    host: process.env.HOST || '127.0.0.1',
    dataDir: process.env.DATA_DIR || './data',
    allowedOrigins: process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
      : defaultConfig.allowedOrigins,
    enableSwagger: process.env.ENABLE_SWAGGER === 'true',
  };

  const result = AppConfigSchema.safeParse(config);
  if (!result.success) {
    console.error('配置验证失败:', result.error.format());
    process.exit(1);
  }
  return result.data;
}