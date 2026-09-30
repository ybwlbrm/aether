import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
// Attachment 类型契约源头在 useStreamSend（共享发送实现），此处只复用不重定义
import type { Attachment } from './useStreamSend';

// ============================================================
// 附件存储：state 视图 + 同步读双写
//
// 不变量（原实现已确立，不得回退）：发送入口在**同一 tick** 内读走附件并清空，
// 因此「清空」不能只动 React state —— 那会让 in-flight send 读到空列表。
// 单一可变快照同时承担两个角色：
//   - getSnapshot()  → useSyncExternalStore 的渲染源
//   - takeForSend()  → 不经渲染调度、与 clear 同步的读
// 清空后 in-flight send 仍持有 clear 前的那批附件。
// ============================================================

export interface AttachmentStore {
  /** 渲染用快照（引用稳定：仅在变更时新建数组，元素只读） */
  readonly getSnapshot: () => Attachment[]
  /** 追加（空数组为 no-op，不触发通知） */
  readonly addAll: (incoming: readonly Attachment[]) => void
  /** 按下标移除；越界为 no-op */
  readonly removeAt: (index: number) => void
  readonly clear: () => void
  /** 原子消费：取走当前附件并清空 —— 供发送入口在同一 tick 内安全读取 */
  readonly takeForSend: () => Attachment[]
  readonly subscribe: (listener: () => void) => () => void
}

export function createAttachmentStore(initial: readonly Attachment[] = []): AttachmentStore {
  let snapshot: Attachment[] = [...initial]
  const listeners = new Set<() => void>()

  const replace = (next: Attachment[]): void => {
    snapshot = next
    for (const listener of listeners) listener()
  }
  const clear = (): void => {
    if (snapshot.length > 0) replace([])
  }

  return {
    getSnapshot: () => snapshot,
    addAll: (incoming) => {
      if (incoming.length === 0) return
      replace([...snapshot, ...incoming])
    },
    removeAt: (index) => {
      if (index < 0 || index >= snapshot.length) return
      replace(snapshot.filter((_, i) => i !== index))
    },
    clear,
    takeForSend: () => {
      const taken = [...snapshot]
      clear()
      return taken
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/** 容量裁剪：只取前 maxCount 个文件（maxCount 非有限视为不限） */
export function takeWithinCapacity(files: readonly File[], maxCount: number): readonly File[] {
  if (!Number.isFinite(maxCount)) return files
  const limit = Math.max(0, Math.trunc(maxCount))
  return files.slice(0, limit)
}

/** 读单个文件为 dataURL；读失败（非字符串结果 / IO 错误）返回 null 表示跳过 */
function readFileAsDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

/**
 * 把选中的文件读成附件并入 store。
 * 先按容量裁剪再读盘 —— 超出容量的文件根本不会被读取。
 */
export async function addFilesToStore(
  store: AttachmentStore,
  files: readonly File[],
  maxCount: number,
): Promise<void> {
  const accepted = takeWithinCapacity(files, maxCount)
  for (const file of accepted) {
    const dataUrl = await readFileAsDataUrl(file)
    if (dataUrl === null) continue
    store.addAll([{ name: file.name, dataUrl }])
  }
}

export interface UseAttachmentsOptions {
  /** 同时挂载的附件上限；默认不限（保持原行为） */
  readonly maxCount?: number
  /** 透传给隐藏 file input 的 accept 过滤 */
  readonly accept?: string
  /** 选择文件后收起 plus 菜单 */
  readonly onPicked?: () => void
}

/** 隐藏 file input 的行为属性（样式由页面决定） */
export interface AttachmentInputProps {
  readonly ref: React.RefObject<HTMLInputElement | null>
  readonly type: 'file'
  readonly multiple: true
  readonly accept: string | undefined
  readonly onChange: (event: React.ChangeEvent<HTMLInputElement>) => void
}

export interface UseAttachmentsReturn {
  /** 当前附件（store 内部数组，只读语义：消费方一律复制后再改） */
  readonly attachments: Attachment[]
  readonly addFiles: (files: readonly File[]) => void
  readonly remove: (index: number) => void
  readonly clear: () => void
  /** 发送入口的一次性消费：取走当前附件并清空（与 clear 同步，不经渲染调度） */
  readonly takeForSend: () => Attachment[]
  /** 打开隐藏的 file input（由页面挂在 plus 菜单的「上传文件」上） */
  readonly openPicker: () => void
  readonly inputProps: AttachmentInputProps
}

/** 附件选择/移除/清空：state + 同步读双写，容量上限内累积 */
export function useAttachments(options: UseAttachmentsOptions = {}): UseAttachmentsReturn {
  const { maxCount = Number.POSITIVE_INFINITY, accept, onPicked } = options
  const storeRef = useRef<AttachmentStore | null>(null)
  storeRef.current ??= createAttachmentStore()

  const store = storeRef.current
  const attachments = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)

  const addFiles = useCallback((files: readonly File[]) => {
    void addFilesToStore(store, files, maxCount)
  }, [store, maxCount])

  const remove = useCallback((index: number) => { store.removeAt(index) }, [store])
  const clear = useCallback(() => { store.clear() }, [store])
  const takeForSend = useCallback(() => store.takeForSend(), [store])

  const inputRef = useRef<HTMLInputElement>(null)
  const openPicker = useCallback(() => { inputRef.current?.click() }, [])
  const inputProps = useMemo<AttachmentInputProps>(() => ({
    ref: inputRef,
    type: 'file',
    multiple: true,
    accept,
    onChange: (event) => {
      addFiles(Array.from(event.target.files ?? []))
      // 允许重复选择同一文件：重置 value 才能再次触发 change
      event.target.value = ''
      onPicked?.()
    },
  }), [accept, addFiles, onPicked])

  return { attachments, addFiles, remove, clear, takeForSend, openPicker, inputProps }
}
