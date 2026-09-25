import { useState, useRef, useCallback, useEffect } from 'react';
import { api } from '../../api/client';
import { useAutosaveDraft } from '../../hooks/useAutosaveDraft';
// P0 通知幂等化：媒体生成终态通知统一经 NotificationCenter（generationId dedupeKey 幂等）
import { notificationCenter, buildTerminalDedupeKey } from '../../lib/notification-center';

export interface GenFormState {
  type: 'image' | 'video';
  prompt: string;
  negativePrompt: string;
  model: string;
  providerId: string;
  size: string;
  num: number;
  imageUrl: string;
  imageData: string;
  videoDuration: string;
}

export interface GenResult {
  url: string;
  id: string;
  type: string;
  prompt: string;
  model: string;
  size: string;
  createdAt: string;
}

export interface UseGenerationOptions {
  providers: Array<{
    id: string;
    name: string;
    provider: string;
    models: string[];
    isDefault: boolean;
  }>;
  defaultProvs: Record<string, string>;
  onSuccess?: (results: GenResult[]) => void;
  onError?: (error: string) => void;
  onFormReset?: () => void;
}

const IMAGE_SIZES = ['1024x1024', '1024x1792', '1792x1024', '768x768', '768x1344', '1344x768', '1536x1536', '512x512'];
const VIDEO_SIZES = ['1920x1080', '1280x720', '1080x1920', '1024x1024'];
const VIDEO_DURATIONS = [
  { label: '约 5 秒', value: '{"frames":121,"fps":24}' },
  { label: '约 10 秒', value: '{"frames":241,"fps":24}' },
];

export function useGeneration({
  providers,
  defaultProvs,
  onSuccess,
  onError,
  onFormReset,
}: UseGenerationOptions) {
  const [generating, setGenerating] = useState(false);
  const [genProgressLabel, setGenProgressLabel] = useState('');
  const [genResults, setGenResults] = useState<GenResult[]>([]);
  const [toasts, setToasts] = useState<Array<{ id: string; message: string; type: string }>>([]);

  const [form, setForm, clearDraft] = useAutosaveDraft<GenFormState>('media_gen_form', {
    type: 'image',
    prompt: '',
    negativePrompt: '',
    model: '',
    providerId: '',
    size: '1024x1024',
    num: 1,
    imageUrl: '',
    imageData: '',
    videoDuration: '{"frames":121,"fps":24}',
  });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const toastIdRef = useRef(0);
  const progressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const genStartTimeRef = useRef<number>(0);

  const pushTimeout = useCallback((fn: () => void, ms: number) => {
    const id = setTimeout(() => {
      pendingTimeoutsRef.current = pendingTimeoutsRef.current.filter(t => t !== id);
      fn();
    }, ms);
    pendingTimeoutsRef.current.push(id);
    return id;
  }, []);

  useEffect(() => () => {
    if (progressIntervalRef.current) clearInterval(progressIntervalRef.current);
    for (const t of pendingTimeoutsRef.current) clearTimeout(t);
    pendingTimeoutsRef.current = [];
  }, []);

  const addToast = useCallback((message: string, type = 'INFO') => {
    const id = String(++toastIdRef.current);
    setToasts(prev => [...prev, { id, message, type }]);
    pushTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 3500);
  }, [pushTimeout]);

  const getAvailableModels = useCallback(() => {
    const selectedProvider = providers.find(p => p.id === form.providerId);
    if (!selectedProvider) return [];
    const models = selectedProvider.models || [];
    return Array.isArray(models) ? models : [];
  }, [providers, form.providerId]);

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result as string;
      setForm(f => ({ ...f, imageData: dataUrl, imageUrl: '' }));
    };
    reader.readAsDataURL(file);
  };

  const clearImage = () => {
    setForm(f => ({ ...f, imageData: '', imageUrl: '' }));
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleGenerate = async () => {
    if (!form.prompt.trim()) return;
    if (!form.providerId) {
      addToast('请先在 Settings 中配置 API Provider', 'WARNING');
      return;
    }

    setGenerating(true);
    setGenProgressLabel('准备中...');
    setGenResults([]);
    genStartTimeRef.current = Date.now();

    // FE-09 修复：显示真实等待时间，移除假进度条
    progressIntervalRef.current = setInterval(() => {
      const elapsed = Math.round((Date.now() - genStartTimeRef.current) / 1000);
      setGenProgressLabel(`已等待 ${elapsed} 秒`);
    }, 1000);

    try {
      const genParams: {
        type: 'image' | 'video';
        prompt: string;
        negativePrompt?: string;
        model?: string;
        providerId?: string;
        size?: string;
        num?: number;
        image?: string;
        numFrames?: number;
        frameRate?: number;
      } = {
        type: form.type,
        prompt: form.prompt,
        providerId: form.providerId,
        size: form.size,
      };

      if (form.negativePrompt) genParams.negativePrompt = form.negativePrompt;
      if (form.model) genParams.model = form.model;
      if (form.type === 'image') genParams.num = form.num;
      if (form.imageData) genParams.image = form.imageData;
      // P1-1 修复（审计）：图生视频粘贴的图片 URL 必须真正传给后端
      // （此前只发 imageData 不发 imageUrl，导致 URL 参考图功能"UI 有，实际没接上"）
      if (form.imageUrl) genParams.image = form.imageUrl;

      if (form.type === 'video') {
        try {
          const dur = JSON.parse(form.videoDuration);
          genParams.numFrames = dur.frames;
          genParams.frameRate = dur.fps;
        } catch { /* use defaults */ }
      }

      setGenProgressLabel('正在生成...');
      const result = await api.generateMedia(genParams);

      clearInterval(progressIntervalRef.current!);
      setGenProgressLabel('完成！');

      if (result?.results && result.results.length > 0) {
        setGenResults(result.results);
        addToast(`生成成功：${result.results.length} 个文件`, 'SUCCESS');
        // P0 通知幂等化：媒体生成终态 → NotificationCenter（generationId dedupeKey 幂等，
        // 双击/重试/组件重挂载不会重复通知）
        const generationId = `${genStartTimeRef.current}`;
        notificationCenter.notifyOnce({
          id: `media-${generationId}`,
          type: 'completed',
          title: form.type === 'image' ? '图片生成完成' : '视频生成完成',
          body: form.prompt.slice(0, 100),
          createdAt: new Date().toISOString(),
          dedupeKey: buildTerminalDedupeKey('media', generationId, 'completed'),
        });
        onSuccess?.(result.results);
      } else if (result?.error || (result?.status && result.status !== 'success')) {
        // P0-3/Oracle 复审修复：生成失败（无有效结果）时显式报错 ——
        // 前端不再在"results 为空"时静默视为成功（后端视频失败已不生成伪 MP4）。
        const errMsg = result?.error || '生成失败（未返回有效结果）';
        addToast(`生成失败：${errMsg}`, 'ERROR');
        onError?.(errMsg);
      }

      if (result?.error && result?.results && result.results.length > 0) {
        addToast(`部分失败：${result.error}`, 'WARNING');
      }

      pushTimeout(() => {
        setGenResults([]);
        setForm(f => ({
          ...f, prompt: '', negativePrompt: '', imageData: '', imageUrl: '',
          num: 1,
        }));
        onFormReset?.();
      }, 1500);
    } catch (e: unknown) {
      clearInterval(progressIntervalRef.current!);
      const errorMsg = `生成失败：${(e instanceof Error ? e.message : String(e))}`;
      addToast(errorMsg, 'ERROR');
      onError?.(errorMsg);
    }
    setGenerating(false);
  };

  const handleTypeChange = useCallback((newType: 'image' | 'video') => {
    const defaultId = defaultProvs[newType];
    const newProviderId = defaultId && providers.some(p => p.id === defaultId)
      ? defaultId
      : (providers[0]?.id || form.providerId);
    const newSize = newType === 'image' ? '1024x1024' : '1920x1080';
    setForm(f => ({ ...f, type: newType, size: newSize, providerId: newProviderId }));
  }, [defaultProvs, providers, form.providerId]);

  const handleProviderChange = useCallback((providerId: string) => {
    setForm(f => ({ ...f, providerId }));
  }, []);

  const handleModelChange = useCallback((model: string) => {
    setForm(f => ({ ...f, model }));
  }, []);

  const handleSizeChange = useCallback((size: string) => {
    setForm(f => ({ ...f, size }));
  }, []);

  const handleNumChange = useCallback((num: number) => {
    setForm(f => ({ ...f, num: Math.min(10, Math.max(1, num)) }));
  }, []);

  const handleVideoDurationChange = useCallback((videoDuration: string) => {
    setForm(f => ({ ...f, videoDuration }));
  }, []);

  const handlePromptChange = useCallback((prompt: string) => {
    setForm(f => ({ ...f, prompt }));
  }, []);

  const handleNegativePromptChange = useCallback((negativePrompt: string) => {
    setForm(f => ({ ...f, negativePrompt }));
  }, []);

  const handleImageUrlChange = useCallback((imageUrl: string) => {
    setForm(f => ({ ...f, imageUrl, imageData: '' }));
  }, []);

  const handleFileUpload = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const availableSizes = form.type === 'image' ? IMAGE_SIZES : VIDEO_SIZES;
  const availableModels = getAvailableModels();

  return {
    form,
    setForm,
    generating,
    genProgressLabel,
    genResults,
    toasts,
    fileInputRef,
    availableSizes,
    availableModels,
    VIDEO_DURATIONS,
    handleGenerate,
    handleTypeChange,
    handleProviderChange,
    handleModelChange,
    handleSizeChange,
    handleNumChange,
    handleVideoDurationChange,
    handlePromptChange,
    handleNegativePromptChange,
    handleImageUrlChange,
    handleImageUpload,
    handleFileUpload,
    clearImage,
    addToast,
  };
}