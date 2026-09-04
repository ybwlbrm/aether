// ---- Type Definitions ----
export interface ApiProviderConfig {
  id: string;
  name: string;
  provider: 'openai' | 'anthropic' | 'gemini' | 'deepseek' | 'custom';
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
}

export interface SettingsData {
  port: number;
  theme: 'dark' | 'light';
  allowedDirs: string[];
  defaultDir?: string; // 默认工作目录（从 allowedDirs 中选择）
  providers: ApiProviderConfig[];
  bgImage?: string;
  /** 背景轮播图片列表 */
  bgImages?: string[];
  /** 背景来源模式：upload=上传 / dir=目录 */
  bgMode?: 'upload' | 'dir';
  /** 背景轮播目录路径（dir 模式） */
  bgDir?: string;
  /** 背景轮播切换间隔（秒） */
  bgInterval?: number;
  /** 各能力类型的默认 Provider ID */
  defaultProviders?: {
    image?: string;
    video?: string;
    text?: string;
    audio?: string;
  };
  /** P2-9: 权限级别 — 1=只读，2=读写（与 /api/settings/security 端点一致） */
  permissionLevel?: number;
  updatedAt: string;
}

export interface ProjectItem {
  id: string;
  name: string;
  type: 'url' | 'bat' | 'command';
  target: string;
  category?: string;
  description?: string;
  createdAt: string;
  lastAccessed?: string;
}

export interface MemoryItem {
  id: string;
  content: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  category: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
}

export interface ChatHistory {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

// ---- Defaults ----
export const DEFAULT_SETTINGS: SettingsData = {
  port: 3000,
  theme: 'dark',
  allowedDirs: ['./data', './workspace'],
  providers: [],
  updatedAt: new Date().toISOString(),
};