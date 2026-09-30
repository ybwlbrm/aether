import { describe, expect, it, vi } from "vitest"

import {
  addFilesToStore,
  createAttachmentStore,
  takeWithinCapacity,
  type AttachmentStore,
} from "./useAttachments"
import type { Attachment } from "./useStreamSend"

function attachment(name: string): Attachment {
  return { name, dataUrl: `data:image/png;base64,${name}` }
}

/** node 环境无 FileReader：用一个把任意 File 直接变成 dataURL 的替身 */
function stubFileReader(): void {
  vi.stubGlobal("FileReader", class {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    result: unknown = null
    readAsDataURL(file: File): void {
      this.result = `data:${file.type};base64,${file.name}`
      this.onload?.()
    }
  })
}

function file(name: string): File {
  return { name, type: "image/png" } as File
}

describe("useAttachments 的快照同步读不变量", () => {
  it("clear() 之后同步读仍拿到 clear 前的附件（in-flight send 存活）", () => {
    // Given: 已累积两个附件（state 与同步读指向同一份快照）
    const store = createAttachmentStore()
    store.addAll([attachment("a.png"), attachment("b.png")])

    // When: 发送入口在同一 tick 内读走并清空
    const inFlight = store.takeForSend()

    // Then: 渲染视图已清空，而 in-flight send 仍持有 clear 前的那批
    expect(store.getSnapshot()).toEqual([])
    expect(inFlight.map((a) => a.name)).toEqual(["a.png", "b.png"])
  })

  it("takeForSend 是快照拷贝：后续追加不会污染已取走的那批", () => {
    // Given
    const store = createAttachmentStore([attachment("first.png")])

    // When
    const inFlight = store.takeForSend()
    store.addAll([attachment("second.png")])

    // Then
    expect(inFlight.map((a) => a.name)).toEqual(["first.png"])
    expect(store.getSnapshot().map((a) => a.name)).toEqual(["second.png"])
  })

  it("clear() 幂等：空列表不再通知订阅者", () => {
    // Given
    const store = createAttachmentStore()
    const listener = vi.fn()
    store.subscribe(listener)

    // When
    store.clear()
    store.clear()

    // Then: 空集合的清空是 no-op，不产生无谓渲染
    expect(listener).not.toHaveBeenCalled()
  })

  it("removeAt 按下标移除，越界不改变列表也不通知", () => {
    // Given
    const store = createAttachmentStore([attachment("a.png"), attachment("b.png"), attachment("c.png")])
    const listener = vi.fn()
    store.subscribe(listener)

    // When
    store.removeAt(9)

    // Then
    expect(listener).not.toHaveBeenCalled()
    expect(store.getSnapshot().map((a) => a.name)).toEqual(["a.png", "b.png", "c.png"])

    // And: 合法下标精确移除该项，其余保持顺序
    store.removeAt(1)
    expect(store.getSnapshot().map((a) => a.name)).toEqual(["a.png", "c.png"])
  })

  it("退订后不再收到变更通知", () => {
    // Given
    const store: AttachmentStore = createAttachmentStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    // When
    unsubscribe()
    store.addAll([attachment("a.png")])

    // Then
    expect(listener).not.toHaveBeenCalled()
  })
})

describe("useAttachments 的容量裁剪", () => {
  it("maxCount 为 0 时不接受任何文件", () => {
    expect(takeWithinCapacity([file("a.png"), file("b.png")], 0)).toEqual([])
  })

  it("maxCount 为 1 时只取第一个文件", () => {
    expect(takeWithinCapacity([file("a.png"), file("b.png")], 1)).toEqual([file("a.png")])
  })

  it("文件数超过 maxCount 时只读前 N 个（其余根本不进 FileReader）", async () => {
    // Given: 三个文件，上限两个
    stubFileReader()
    const store = createAttachmentStore()

    // When
    await addFilesToStore(store, [file("a.png"), file("b.png"), file("c.png")], 2)

    // Then
    expect(store.getSnapshot().map((a) => a.name)).toEqual(["a.png", "b.png"])
  })

  it("maxCount 非有限（默认）时不做裁剪", () => {
    const files = [file("a.png"), file("b.png")]
    expect(takeWithinCapacity(files, Number.POSITIVE_INFINITY)).toEqual(files)
  })

  it("负数上限等价于 0，而不是数组的尾部切片", () => {
    // Given: slice(0, -1) 会意外保留除最后一项外的全部文件 —— 上限必须是硬边界
    expect(takeWithinCapacity([file("a.png"), file("b.png")], -1)).toEqual([])
  })
})

describe("useAttachments 的文件读取", () => {
  it("把每个文件读成 { name, dataUrl } 追加进 store", async () => {
    // Given
    stubFileReader()
    const store = createAttachmentStore()

    // When
    await addFilesToStore(store, [file("shot.png")], 10)

    // Then
    expect(store.getSnapshot()).toEqual([
      { name: "shot.png", dataUrl: "data:image/png;base64,shot.png" },
    ])
  })

  it("读不出字符串结果的文件被跳过，不写入空 dataUrl", async () => {
    // Given: FileReader 抛出 IO 错误
    vi.stubGlobal("FileReader", class {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      result: unknown = null
      readAsDataURL(): void { this.onerror?.() }
    })
    const store = createAttachmentStore()

    // When
    await addFilesToStore(store, [file("broken.png")], 10)

    // Then
    expect(store.getSnapshot()).toEqual([])
  })

  it("空选择是 no-op", async () => {
    stubFileReader()
    const store = createAttachmentStore()

    await addFilesToStore(store, [], 10)

    expect(store.getSnapshot()).toEqual([])
  })
})
