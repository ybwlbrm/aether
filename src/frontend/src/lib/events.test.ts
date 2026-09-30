import { describe, expect, it } from 'vitest'
import type { RemoteCommandPayload } from '../routes/ThreadPage'
import {
  APP_EVENT_NAMES,
  APP_EVENT_REGISTRY,
  dispatchAppEvent,
  subscribeAppEvent,
  type AppEventDetail,
  type AppEventName,
} from './events'

/**
 * 样例 detail 表 —— 它的 key 集合被编译期强制等于 AppEventName。
 * 少写一个 key（少一个事件）或写错一个 detail 形状，tsc 立即失败。
 */
const SAMPLE_DETAILS: { readonly [K in AppEventName]: AppEventDetail<K> } = {
  'aether-open-approvals': undefined,
  'bg-slideshow-start': { images: ['/bg/a.png', '/bg/b.png'], interval: 8 },
  'bg-slideshow-stop': undefined,
  'bg-slideshow-clear': undefined,
  'bg-slideshow-interval': { interval: 12 },
  'conversations-changed': undefined,
  'custombg-change': 'data:image/png;base64,AAAA',
  'remote-command': { content: '帮我看下构建', commandId: 'cmd-1', receivedAt: 1_700_000_000_000 },
  'select-conversation': { conversationId: 'conv-42' },
  'sync-data-changed': { time: 1_700_000_000_000 },
  'toggle-command-palette': undefined,
  'toggle-conv-panel': undefined,
  'toggle-ui-mode': undefined,
  'workbench-open': { tab: 'terminal' },
  'workbench-toggle': undefined,
}

/** 注册表声明为单向（只有一端）的 3 个事件 */
const ORPHAN_EVENTS: readonly AppEventName[] = [
  'aether-open-approvals',
  'toggle-ui-mode',
  'workbench-toggle',
]

const NO_RECEIPT = Symbol('no-receipt')

/** 订阅 → 派发 → 退订，返回订阅端实际收到的 detail */
function roundTrip<K extends AppEventName>(name: K, detail: AppEventDetail<K>): AppEventDetail<K> | typeof NO_RECEIPT {
  let received: AppEventDetail<K> | typeof NO_RECEIPT = NO_RECEIPT
  const unsubscribe = subscribeAppEvent(name, (incoming) => {
    received = incoming
  })
  dispatchAppEvent(name, detail)
  unsubscribe()
  return received
}

describe('app 事件注册表', () => {
  it('恰好 15 个事件名，且无重复', () => {
    expect(APP_EVENT_NAMES).toHaveLength(15)
    expect(new Set(APP_EVENT_NAMES).size).toBe(15)
  })

  it('注册表与名称列表都是冻结的', () => {
    expect(Object.isFrozen(APP_EVENT_REGISTRY)).toBe(true)
    expect(Object.isFrozen(APP_EVENT_NAMES)).toBe(true)
  })

  it('注册表为每个事件名都给出了描述', () => {
    for (const name of APP_EVENT_NAMES) {
      const descriptor = APP_EVENT_REGISTRY[name]
      expect(descriptor.summary.length).toBeGreaterThan(0)
      expect(['dispatch-only', 'listen-only', 'live']).toContain(descriptor.orphan)
    }
  })
})

describe('dispatchAppEvent → subscribeAppEvent 往返', () => {
  it('全部 15 个事件名往返成功，detail 原样送达', () => {
    for (const name of APP_EVENT_NAMES) {
      expect(roundTrip(name, SAMPLE_DETAILS[name])).toEqual(SAMPLE_DETAILS[name])
    }
  })

  it('select-conversation 送达结构化 detail', () => {
    const seen: string[] = []
    const unsubscribe = subscribeAppEvent('select-conversation', (detail) => {
      seen.push(detail.conversationId)
    })
    dispatchAppEvent('select-conversation', { conversationId: 'conv-7' })
    unsubscribe()
    expect(seen).toEqual(['conv-7'])
  })

  it('remote-command 送达全部可选字段', () => {
    const detail: AppEventDetail<'remote-command'> = {
      content: '执行同步',
      conversationId: 'conv-9',
      commandId: 'cmd-9',
      id: 'legacy-9',
      receivedAt: 42,
    }
    expect(roundTrip('remote-command', detail)).toEqual(detail)
  })

  it('cancel 订阅后不再收到事件', () => {
    const seen: string[] = []
    const unsubscribe = subscribeAppEvent('select-conversation', (detail) => {
      seen.push(detail.conversationId)
    })
    dispatchAppEvent('select-conversation', { conversationId: 'conv-1' })
    unsubscribe()
    dispatchAppEvent('select-conversation', { conversationId: 'conv-2' })
    expect(seen).toEqual(['conv-1'])
  })

  it('多个订阅者各自独立收到同一事件', () => {
    const a: string[] = []
    const b: string[] = []
    const offA = subscribeAppEvent('workbench-open', (detail) => {
      a.push(detail?.tab ?? 'none')
    })
    const offB = subscribeAppEvent('workbench-open', (detail) => {
      b.push(detail?.tab ?? 'none')
    })
    dispatchAppEvent('workbench-open', { tab: 'browser' })
    dispatchAppEvent('workbench-open')
    offA()
    offB()
    expect(a).toEqual(['browser', 'none'])
    expect(b).toEqual(['browser', 'none'])
  })
})

describe('orphan 标注', () => {
  it('3 个单向事件与注册表 orphan 标注一致（2 dispatch-only + 1 listen-only）', () => {
    const orphans = APP_EVENT_NAMES
      .filter((name) => APP_EVENT_REGISTRY[name].orphan !== 'live')
      .slice()
      .sort()
    expect(orphans).toEqual(ORPHAN_EVENTS.slice().sort())
    expect(APP_EVENT_REGISTRY['aether-open-approvals'].orphan).toBe('dispatch-only')
    expect(APP_EVENT_REGISTRY['toggle-ui-mode'].orphan).toBe('dispatch-only')
    expect(APP_EVENT_REGISTRY['workbench-toggle'].orphan).toBe('listen-only')
  })

  it('其余 12 个事件是双向的 live 事件', () => {
    const live = APP_EVENT_NAMES.filter((name) => APP_EVENT_REGISTRY[name].orphan === 'live')
    expect(live).toHaveLength(12)
    expect(live.slice().sort()).toEqual([
      'bg-slideshow-clear',
      'bg-slideshow-interval',
      'bg-slideshow-start',
      'bg-slideshow-stop',
      'conversations-changed',
      'custombg-change',
      'remote-command',
      'select-conversation',
      'sync-data-changed',
      'toggle-command-palette',
      'toggle-conv-panel',
      'workbench-open',
    ])
  })
})

describe('RemoteCommandPayload 迁移', () => {
  it("AppEventDetail<'remote-command'> 与 ThreadPage re-export 的 RemoteCommandPayload 双向兼容", () => {
    const forward: AppEventDetail<'remote-command'> = {
      content: 'c',
      conversationId: 'conv-1',
      commandId: 'cmd-1',
      id: 'legacy-1',
      receivedAt: 1,
    }
    const backward: RemoteCommandPayload = forward
    const again: AppEventDetail<'remote-command'> = backward
    expect(again).toEqual(forward)
  })
})

/**
 * 编译期断言 —— 由 tsc --noEmit 校验，运行时永不执行。
 * 任何一条不再报错，tsc 就会以 "Unused '@ts-expect-error' directive" 失败。
 */
function compileTimeOnly(): void {
  // @ts-expect-error 未知事件名不在 AppEventName 联合内
  dispatchAppEvent('aether-open-approvalsx')
  // @ts-expect-error 未知 key 无法索引 AppEventDetail
  const missing: AppEventDetail<'not-an-event'> = undefined
  // @ts-expect-error select-conversation 的 conversationId 必填
  dispatchAppEvent('select-conversation', {})
  // @ts-expect-error select-conversation 的 detail 不接受未知字段
  dispatchAppEvent('select-conversation', { conversationId: 'conv-1', extra: 1 })
  // @ts-expect-error workbench-open 的 tab 只接受 WorkbenchTab
  dispatchAppEvent('workbench-open', { tab: 'database' })
  // @ts-expect-error toggle-conv-panel 的 detail 是 undefined
  dispatchAppEvent('toggle-conv-panel', { anything: true })
  // @ts-expect-error custombg-change 的 detail 是 string | null
  dispatchAppEvent('custombg-change', 42)
  void missing
}
void compileTimeOnly
