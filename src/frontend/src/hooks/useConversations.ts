import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api/client';
import { confirm as confirmDialog } from '../components/ui/confirm-dialog';

export interface Conversation {
  id: string;
  title: string;
  updatedAt: string;
  tokenTotal?: number;
  providerId?: string;
  model?: string;
}

export interface UseConversationsOptions {
  /** Called when a conversation is selected/loaded */
  onSelect?: (id: string) => void;
  /** Called when a new conversation is created */
  onCreate?: (conv: Conversation) => void;
  /** Called when conversations list changes (for external sync) */
  onChange?: () => void;
}

export interface UseConversationsReturn {
  conversations: Conversation[];
  convLoading: boolean;
  load: () => Promise<void>;
  handleNew: (providers?: any[]) => Promise<void>;
  handleSelect: (id: string) => Promise<void>;
  handleDelete: (id: string) => Promise<void>;
  handleRename: (id: string, newTitle: string) => Promise<void>;
  setConversations: React.Dispatch<React.SetStateAction<Conversation[]>>;
}

/**
 * Shared hook for conversation list management:
 * - Loading conversations from API
 * - Creating new conversations (with provider selection)
 * - Selecting/loading a conversation
 * - Deleting conversations
 * - Renaming conversations
 * - Listening to 'conversations-changed' window event for cross-tab/component sync
 */
export function useConversations(options: UseConversationsOptions = {}): UseConversationsReturn {
  const { onSelect, onCreate, onChange } = options;
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [convLoading, setConvLoading] = useState(false);
  const loadRef = useRef<() => Promise<void> | null>(null);

  const load = useCallback(async () => {
    setConvLoading(true);
    try {
      const convs = await api.getConversations();
      setConversations(Array.isArray(convs) ? convs : []);
      onChange?.();
    } catch (e: unknown) {
      console.error('[useConversations] load failed:', e);
    } finally {
      setConvLoading(false);
    }
  }, [onChange]);

  loadRef.current = load;

  // Listen for cross-component conversation changes
  useEffect(() => {
    const handler = () => {
      loadRef.current?.();
    };
    window.addEventListener('conversations-changed', handler);
    return () => window.removeEventListener('conversations-changed', handler);
  }, []);

  const handleNew = useCallback(async (providers?: any[]) => {
    let defaultProvider = providers?.[0];
    if (!defaultProvider) {
      try {
        const dp = await api.getDefaultProviders();
        const textId = dp?.text;
        if (textId && providers) {
          const found = providers.find((p: any) => p.id === textId);
          if (found) defaultProvider = found;
        }
      } catch { /* ignore */ }
    }
    if (!defaultProvider) {
      alert('请先在左侧"设置" → "AI Provider"中配置您的 API Key，然后新建对话。');
      return;
    }
    const model = Array.isArray(defaultProvider.models) && defaultProvider.models[0]
      ? defaultProvider.models[0]
      : (defaultProvider.defaultModel || 'gpt-4o');
    try {
      const conv = await api.createConversation({ title: '新对话', providerId: defaultProvider.id, model });
      setConversations(prev => [conv, ...prev]);
      onSelect?.(conv.id);
      onCreate?.(conv);
      onChange?.();
    } catch (e: unknown) {
      alert('创建失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  }, [onSelect, onCreate, onChange]);

  const handleSelect = useCallback(async (id: string) => {
    onSelect?.(id);
  }, [onSelect]);

  const handleDelete = useCallback(async (id: string) => {
    if (!(await confirmDialog('确定删除此对话？'))) return;
    try {
      await api.deleteConversation(id);
      setConversations(prev => prev.filter(c => c.id !== id));
      onChange?.();
    } catch (e: unknown) {
      alert('删除失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  }, [onChange]);

  const handleRename = useCallback(async (id: string, newTitle: string) => {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    try {
      await api.updateConversation(id, { title: trimmed });
      setConversations(prev => prev.map(c => c.id === id ? { ...c, title: trimmed } : c));
      onChange?.();
    } catch (e: unknown) {
      alert('重命名失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  }, [onChange]);

  return {
    conversations,
    convLoading,
    load,
    handleNew,
    handleSelect,
    handleDelete,
    handleRename,
    setConversations,
  };
}