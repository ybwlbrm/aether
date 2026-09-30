import { describe, expect, it, vi } from "vitest"

import {
  createProviderSelectionController,
  firstTextProvider,
  resolveModel,
  resolvePreferredProvider,
  supportsVision,
  toProviderOptions,
  toSelectOptions,
  toTextProviders,
  type ProviderOption,
  type ProviderSelectionController,
} from "./useProviderSelection"

function provider(id: string, extra: Partial<ProviderOption> = {}): ProviderOption {
  return { id, ...extra }
}

const TEXT = provider("deepseek", { name: "DeepSeek", capabilities: ["text"], models: ["r1", "chat"] })
const VISION = provider("gemini", { name: "Gemini", capabilities: ["text", "image"] })
const EMBED_ONLY = provider("embedder", { capabilities: ["embedding"] })

/** mock api 面：两个端点各自可替换为成功/失败 */
function mockApi(options: {
  providers?: () => Promise<unknown>
  defaults?: () => Promise<Record<string, string>>
} = {}): ProviderSelectionController {
  return createProviderSelectionController({
    getProviders: options.providers ?? (async () => [TEXT, VISION]),
    getDefaultProviders: options.defaults ?? (async () => ({ text: "gemini" })),
  })
}

describe("useProviderSelection 的边界解析", () => {
  it("只接受带字符串 id 的对象，非法项被剔除", () => {
    const parsed = toProviderOptions([
      { id: "a" },
      { name: "无 id" },
      null,
      "字符串",
      42,
      { id: 7 },
    ])

    expect(parsed).toEqual([{ id: "a" }])
  })

  it("非数组载荷退化为空列表（不抛）", () => {
    expect(toProviderOptions(undefined)).toEqual([])
    expect(toProviderOptions({ id: "a" })).toEqual([])
  })
})

describe("useProviderSelection 的 resolveModel 三级回退", () => {
  it("调用方指定的 preferred 优先级最高", () => {
    expect(resolveModel(provider("x", { models: ["m1"], defaultModel: "d1" }), "手动选的")).toBe("手动选的")
  })

  it("未指定时取 provider.models[0]", () => {
    expect(resolveModel(provider("x", { models: ["m1", "m2"], defaultModel: "d1" }), "")).toBe("m1")
  })

  it("models 为空时取 defaultModel", () => {
    expect(resolveModel(provider("x", { defaultModel: "d1" }), "")).toBe("d1")
  })

  it("models 与 defaultModel 都没有时兜底 gpt-4o", () => {
    expect(resolveModel(provider("x"), "")).toBe("gpt-4o")
  })
})

describe("useProviderSelection 的首选 provider 解析", () => {
  it("配置指定的 text provider 优先", () => {
    expect(resolvePreferredProvider([TEXT, VISION], "gemini")?.id).toBe("gemini")
  })

  it("配置 id 不在列表里时回退首个 text provider", () => {
    expect(resolvePreferredProvider([TEXT, VISION], "已删除的 provider")?.id).toBe("deepseek")
  })

  it("无配置时直接取首个 text provider", () => {
    expect(resolvePreferredProvider([EMBED_ONLY, VISION], undefined)?.id).toBe("gemini")
  })

  it("firstTextProvider 在无 text 能力时退回列表首项", () => {
    expect(firstTextProvider([EMBED_ONLY])?.id).toBe("embedder")
    expect(firstTextProvider([])).toBeUndefined()
  })

  it("空列表 + 无配置时返回 undefined（保持未初始化，等待重试）", () => {
    expect(resolvePreferredProvider([], undefined)).toBeUndefined()
  })
})

describe("useProviderSelection 的 <select> 数据推导", () => {
  it("只列 text 能力，能力探测识别多模态", () => {
    expect(toTextProviders([TEXT, VISION, EMBED_ONLY]).map((p) => p.id)).toEqual(["deepseek", "gemini"])
    expect(supportsVision(VISION)).toBe(true)
    expect(supportsVision(TEXT)).toBe(false)
    expect(supportsVision(null)).toBe(false)
  })

  it("label 用 name 兜底 id，并给多模态项加 📷 标记", () => {
    expect(toSelectOptions([provider("匿名"), VISION])).toEqual([
      { value: "匿名", label: "匿名", supportsVision: false },
      { value: "gemini", label: "Gemini 📷", supportsVision: true },
    ])
  })
})

describe("useProviderSelection 的 load 与选择保持", () => {
  it("首轮 load 落定 provider 并推导好 textProviders / loading 复位", async () => {
    // Given
    const controller = mockApi()

    // When
    await controller.load()

    // Then
    const state = controller.getState()
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
    expect(state.providers).toHaveLength(2)
    expect(toTextProviders(state.providers).map((p) => p.id)).toEqual(["deepseek", "gemini"])
    expect(state.selected).not.toBeNull()
    expect(state.selectedModel).toBeTruthy()
  })

  it("手动 setSelected 在后续 load() 后存活（load 永不覆盖用户选择）", async () => {
    // Given: 首轮 load 已落定 provider
    const controller = mockApi()
    await controller.load()
    const initial = controller.getState().selected?.id
    expect(initial).toBeTruthy()

    // When: 用户手动切到另一个 provider，随后再触发一次 load（发送完成/重试都会走）
    controller.setSelected(EMBED_ONLY)
    expect(controller.getState().selected?.id).toBe("embedder")
    await controller.load()

    // Then: 手动选择仍在，load 没有覆盖它
    expect(controller.getState().selected?.id).toBe("embedder")
  })

  it("getDefaultProviders 失败时回退首个 text provider 且不抛", async () => {
    // Given
    const controller = mockApi({
      defaults: async () => { throw new Error("设置接口 500") },
    })

    // When
    await expect(controller.load()).resolves.toBeUndefined()

    // Then: 降级到首个 text provider，error 不被设置接口的失败污染
    const state = controller.getState()
    expect(state.selected?.id).toBe("deepseek")
    expect(state.selectedModel).toBe("r1")
    expect(state.error).toBeNull()
  })

  it("provider 列表为空时保持未初始化，列表就绪后的下一次 load 才落定", async () => {
    // Given: 后端尚未配置任何 provider
    let configured = false
    const controller = mockApi({
      providers: async () => (configured ? [TEXT, VISION] : []),
    })

    // When
    await controller.load()

    // Then: 无候选 → 未初始化（不猜一个空 model 的 provider）
    expect(controller.getState().selected).toBeNull()
    expect(controller.getState().selectedModel).toBe("")

    // And: 列表就绪后重试即可落定（initialized 此前未被置位）
    configured = true
    await controller.load()
    expect(controller.getState().selected?.id).toBe("deepseek")
  })

  it("getProviders 失败时记录 error，已落定的 provider 与 model 不被清空", async () => {
    // Given: 首轮成功
    let online = true
    const controller = mockApi({
      providers: async () => {
        if (!online) throw new Error("providers 不可用")
        return [TEXT, VISION]
      },
    })
    await controller.load()
    const chosen = controller.getState().selected
    expect(chosen).not.toBeNull()

    // When
    online = false
    await controller.load()

    // Then: 错误被记录，且既有选择保持不变
    const state = controller.getState()
    expect(state.error).toBe("providers 不可用")
    expect(state.selected).toBe(chosen)
    expect(state.selectedModel).toBe("r1")
  })

  it("selectModel 只改 model，不动已选 provider", async () => {
    // Given
    const controller = mockApi()
    await controller.load()
    const chosen = controller.getState().selected

    // When
    controller.selectModel("gpt-4o-mini")

    // Then
    expect(controller.getState().selected).toBe(chosen)
    expect(controller.getState().selectedModel).toBe("gpt-4o-mini")
  })

  it("订阅者在选择变化时被通知，退订后不再通知", async () => {
    // Given
    const controller = mockApi()
    const listener = vi.fn()
    const unsubscribe = controller.subscribe(listener)
    await controller.load()
    const callsAfterLoad = listener.mock.calls.length
    expect(callsAfterLoad).toBeGreaterThan(0)

    // When
    unsubscribe()
    controller.selectModel("换了个模型")

    // Then
    expect(listener.mock.calls).toHaveLength(callsAfterLoad)
  })
})
