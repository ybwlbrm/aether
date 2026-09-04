import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { exportDir, imagesToPdf } from './utils.js';

/** 图片转换相关路由：图片→PDF、图片→图片（sharp） */
export function registerImageRoutes(app: FastifyInstance, config: BackendConfig): void {
  // 图片 → PDF / 图片 → 图片 转换在 /api/toolbox/convert 中处理
  // 这里导出供 convert 端点使用的核心函数
}

/** 图片数组转 PDF - 供 convert 端点调用 */
export { imagesToPdf };

/** 导出目录工具 - 供 convert 端点调用 */
export { exportDir };