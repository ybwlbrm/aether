export type TabType = 'bookmarks' | 'notes' | 'wiki' | 'memory';

export interface WikiPage {
  id: string;
  title: string;
  content: string;
  category: string;
  createdAt: string;
  updatedAt: string;
}

export interface Bookmark {
  id: string;
  title: string;
  url: string;
  tags: string[];
  summary: string;
  createdAt: string;
}

export interface Note {
  id: string;
  title: string;
  content: string;
  tags: string[];
  createdAt: string;
}

export interface Memory {
  id: string;
  type: 'short_term' | 'long_term' | 'project';
  key: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TabConfig {
  id: TabType;
  label: string;
  icon: React.ReactNode;
  color: string;
}