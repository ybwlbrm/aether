/**
 * Media 模块共享类型与工具函数（拆分后避免子组件从页面反向导入造成循环依赖）
 */

export interface MediaItem {
  id: string;
  type: 'image' | 'video';
  name: string;
  url: string;
  mimeType: string;
  size: number;
  metadata: {
    prompt: string;
    negativePrompt?: string;
    model?: string;
    provider?: string;
    status?: string;
    error?: string;
    size?: string;
    numFrames?: number;
    frameRate?: number;
    hasImage?: boolean;
  };
  createdAt: string;
}

export function formatDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
