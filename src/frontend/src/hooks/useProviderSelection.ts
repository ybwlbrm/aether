import { useMemo, useRef, useSyncExternalStore } from 'react';
import { api } from '../api/client';

// ============================================================
// AI Provider 选项（模型/模式选择器用）—— 契约源头在本文件
// ============================================================

export interface ProviderOption {
  readonly id: string
  readonly name?: string
  readonly models?: string[]
  readonly defaultModel?: string
  readonly capabilities?: string[]
}

/** provider <select> 的一个可选项 */
export interface ProviderSelectOption {
  readonly value: string
  readonly label: string
  readonly supportsVision: boolean
}

function isProviderOption(value: unknown): value is ProviderOption {
  return typeof value === 'object' && value !== null && typeof (value as ProviderOption).id === 'string'
}

/** Provider 列表边界解析：只接受带字符串 id 的对象 */
export function toProviderOptions(raw: unknown): ProviderOption[] {
  return Array.isArray(raw) ? raw.filter(isProviderOption) : []
}

/** 首个可用 text provider；无 text 能力时退回列表首项 */
export function firstTextProvider(providers: readonly ProviderOption[]): ProviderOption | undefined {
  return providers.find(p => p.capabilities?.includes('text')) ?? providers[0]
}

/** 模型回退链：调用方指定的 preferred → provider.models[0] → defaultModel → 全局兜底 */
export function resolveModel(provider: ProviderOption, preferred: string): string {
  if (preferred) return preferred
  const [firstModel] = provider.models ?? []
  return firstModel ?? provider.defaultModel ?? 'gpt-4o'
}

/** 只列 text 能力的 provider（选择器可选项集合） */
export function toTextProviders(providers: readonly ProviderOption[]): ProviderOption[] {
  return providers.filter(p => p.capabilities?.includes('text'))
}

/** 能力探测：能否分析图片（<select> 用 📷 标记提示） */
export function supportsVision(provider: ProviderOption | null): boolean {
  return provider?.capabilities?.includes('image') ?? false
}

/** <select> 数据推导：label 附带多模态标记 */
export function toSelectOptions(providers: readonly ProviderOption[]): ProviderSelectOption[] {
  return providers.map(provider => ({
    value: provider.id,
    label: `${provider.name ?? provider.id}${supportsVision(provider) ? ' 📷' : ''}`,
    supportsVision: supportsVision(provider),
  }))
}

/**
 * 默认 provider 的解析：配置里指定的 text provider 优先，否则取首个 text provider。
 * 两者都取不到时返回 undefined（保持未初始化态，后续 load 可再补位）。
 */
export function resolvePreferredProvider(
  providers: readonly ProviderOption[],
  preferredId: string | undefined,
): ProviderOption | undefined {
  if (preferredId) {
    const preferred = providers.find(p => p.id === preferredId)
    if (preferred) return preferred
  }
  return firstTextProvider(providers)
}

// ============================================================
// 选择控制器（与 React 解耦，可直接单测）
// ============================================================

export interface ProviderSelectionState {
  readonly providers: readonly ProviderOption[]
  readonly selected: ProviderOption | null
  readonly selectedModel: string
  readonly loading: boolean
  readonly error: string | null
}

/** 控制器依赖的 api 面（测试注入替身，生产绑真实 api） */
export interface ProviderSelectionApi {
  readonly getProviders: () => Promise<unknown>
  readonly getDefaultProviders: () => Promise<Record<string, string>>
}

export interface ProviderSelectionController {
  readonly getState: () => ProviderSelectionState
  readonly subscribe: (listener: () => void) => () => void
  readonly load: () => Promise<void>
  readonly setSelected: (provider: ProviderOption) => void
  readonly selectModel: (model: string) => void
}

const INITIAL_STATE: ProviderSelectionState = {
  providers: [],
  selected: null,
  selectedModel: '',
  loading: false,
  error: null,
}

/**
 * Provider/模型选择状态机。
 *
 * 关键不变量：initialized 一旦置位（含用户手动选择），后续 load() **永不覆盖**
 * 用户的选择 —— 这正是原实现用 ref 而非 state 承载该标记的原因。
 */
export function createProviderSelectionController(
  deps: ProviderSelectionApi,
): ProviderSelectionController {
  let state = INITIAL_STATE
  let initialized = false
  const listeners = new Set<() => void>()

  const patch = (next: Partial<ProviderSelectionState>): void => {
    state = { ...state, ...next }
    for (const listener of listeners) listener()
  }

  /** 首次落定 provider：已初始化则拒绝（用户手动选择优先级最高） */
  const commitFirstChoice = (provider: ProviderOption | undefined): void => {
    if (!provider || initialized) return
    initialized = true
    patch({ selected: provider, selectedModel: resolveModel(provider, '') })
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    setSelected: (provider) => {
      // 手动选择即终局：置位标记，之后的 load() 不得覆盖
      initialized = true
      patch({ selected: provider, selectedModel: resolveModel(provider, '') })
    },
    selectModel: (model) => patch({ selectedModel: model }),
    load: async () => {
      patch({ loading: true, error: null })
      let loaded: readonly ProviderOption[] = []
      try {
        loaded = toProviderOptions(await deps.getProviders())
        patch({ providers: loaded })
      } catch (e: unknown) {
        patch({ error: e instanceof Error ? e.message : '加载 Provider 失败' })
      } finally {
        patch({ loading: false })
      }
      // 回退 1：列表已就绪时取首个 text provider
      commitFirstChoice(firstTextProvider(loaded))
      // 回退 2：配置里的默认 text provider 补位（失败静默降级到回退 1）
      try {
        const res = await deps.getDefaultProviders()
        commitFirstChoice(resolvePreferredProvider(loaded, res?.text))
      } catch {
        // 设置接口不可用：回退 1 已经给出结果
      }
    },
  }
}

// ============================================================
// React 绑定
// ============================================================

export interface UseProviderSelectionOptions {
  /**
   * 当前会话 id。选择器与具体会话**刻意解耦**（initialized 为页面生命周期内的一次性标记），
   * 因此该字段不参与选择决策 —— 保留在契约里是为了让调用点无需了解这一解耦。
   */
  readonly conversationId: string | null
  /** 控制器替身（测试注入；生产走真实 api） */
  readonly controller?: ProviderSelectionController
}

export interface UseProviderSelectionReturn {
  readonly providers: readonly ProviderOption[]
  readonly textProviders: readonly ProviderOption[]
  readonly selected: ProviderOption | null
  readonly selectedModel: string
  readonly setSelected: (provider: ProviderOption) => void
  readonly selectModel: (model: string) => void
  readonly load: () => Promise<void>
  readonly loading: boolean
  readonly error: string | null
  readonly supportsVision: boolean
}

const REAL_API: ProviderSelectionApi = {
  getProviders: () => api.getProviders(),
  getDefaultProviders: () => api.getDefaultProviders(),
}

export function useProviderSelection(
  options: UseProviderSelectionOptions,
): UseProviderSelectionReturn {
  const injected = options.controller
  const controllerRef = useRef<ProviderSelectionController | null>(null)
  controllerRef.current ??= injected ?? createProviderSelectionController(REAL_API)
  const controller = controllerRef.current

  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
  const textProviders = useMemo(() => toTextProviders(state.providers), [state.providers])

  return {
    providers: state.providers,
    textProviders,
    selected: state.selected,
    selectedModel: state.selectedModel,
    // 控制器的动作都是闭包（不依赖 this），直接转交即可保持引用稳定
    setSelected: controller.setSelected,
    selectModel: controller.selectModel,
    load: controller.load,
    loading: state.loading,
    error: state.error,
    supportsVision: supportsVision(state.selected),
  }
}
