/**
 * CommandPalette 契约测试（T23）。
 *
 * 测试风格与 NavModel.test.ts 一致：`renderToStaticMarkup` + `createElement`（无 jsdom）。
 * 这迫使被测表面保持「无副作用的可组合件」，同时让三条核心不变量可以在无 DOM 下证明：
 *   1. `scoreMatch` 是纯函数（exact > prefix > subsequence，大小写不敏感，空查询全通过，无匹配 -1）
 *   2. 命令模型的**导航部分**完全由 NavModel 投影而来（20 条路由一不多一不少）
 *   3. 全部 app 级事件都经 `dispatchAppEvent` 契约派发，本文件不再手写 `new CustomEvent`
 */
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { subscribeAppEvent, type AppEventName } from '../lib/events'
import { useAppearanceStore } from '../store/appearance'
import { useWorkspaceStore } from '../store/workspace'
import { NAV_ROUTE_PATHS, getPaletteSurfaces } from './navigation'
import {
  PaletteResults,
  buildPaletteCommands,
  isPaletteHotkey,
  rankCommands,
  scoreMatch,
  type PaletteCommand,
  type PaletteContext,
} from './CommandPalette'

/* ------------------------------------------------------------------ *
 * runsApi 隔离：palette 是它唯一的命令调用点，故在此整体替身
 * ------------------------------------------------------------------ */

const { recoverStaleRuns, cancelRun, pauseRun, resumeRun } = vi.hoisted(() => ({
  recoverStaleRuns: vi.fn(() => Promise.resolve({ recovered: 0, message: '' })),
  cancelRun: vi.fn(() => Promise.resolve({})),
  pauseRun: vi.fn(() => Promise.resolve({})),
  resumeRun: vi.fn(() => Promise.resolve({})),
}))

vi.mock('../api/runs', () => ({ runsApi: { recoverStaleRuns, cancelRun, pauseRun, resumeRun } }))

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

const SOURCE = readFileSync(new URL('./CommandPalette.tsx', import.meta.url), 'utf8')

const noop = (): void => undefined

const navigate = vi.fn()

const CONTEXT: PaletteContext = {
  navigate,
  pathname: '/command-center',
  activeRunId: 'run-1',
  activeRunStatus: 'running',
  conversations: [
    { id: 'c-1', title: '重构 Command Palette' },
    { id: 'c-2', title: 'NavModel 评审' },
  ],
}

function model(ctx: Partial<PaletteContext> = {}): readonly PaletteCommand[] {
  return buildPaletteCommands({ ...CONTEXT, ...ctx })
}

function byId(commands: readonly PaletteCommand[], id: string): PaletteCommand {
  const found = commands.find((command) => command.id === id)
  if (found === undefined) throw new Error(`命令模型缺少：${id}`)
  return found
}

function run(commands: readonly PaletteCommand[], id: string): void {
  byId(commands, id).run()
}

/** 渲染结果列表（纯展示件，无 Router / 无 motion） */
function markupOf(commands: readonly PaletteCommand[]): string {
  return renderToStaticMarkup(
    createElement(PaletteResults, { commands, selectedIndex: 0, onSelect: noop, onHover: noop }),
  )
}

/** 收集订阅窗口内派发的已注册事件名 + detail */
function recordEvents(names: readonly AppEventName[], body: () => void): AppEventName[] {
  const seen: AppEventName[] = []
  const offs = names.map((name) =>
    subscribeAppEvent(name, () => {
      seen.push(name)
    }),
  )
  try {
    body()
  } finally {
    offs.forEach((off) => off())
  }
  return seen
}

afterEach(() => {
  navigate.mockClear()
  recoverStaleRuns.mockClear()
  cancelRun.mockClear()
  pauseRun.mockClear()
  resumeRun.mockClear()
})

/* ------------------------------------------------------------------ *
 * 1. scoreMatch —— 纯函数、无 DOM
 * ------------------------------------------------------------------ */

describe('scoreMatch：exact > prefix > subsequence，大小写不敏感', () => {
  it('三级匹配强度严格递减', () => {
    const exact = scoreMatch('chat', 'chat')
    const prefix = scoreMatch('cha', 'chat')
    const subsequence = scoreMatch('cht', 'chat')

    expect(exact).toBeGreaterThan(prefix)
    expect(prefix).toBeGreaterThan(subsequence)
    expect(subsequence).toBeGreaterThan(-1)
  })

  it('大小写不敏感：query 与 candidate 的大小写形态都命中同一强度', () => {
    expect(scoreMatch('CHAT', 'chat')).toBe(scoreMatch('chat', 'chat'))
    expect(scoreMatch('chat', 'CHAT')).toBe(scoreMatch('chat', 'chat'))
    expect(scoreMatch('ChAt', 'cHaT')).toBe(scoreMatch('chat', 'chat'))
  })

  it('子序列按字符顺序命中（cht ⊂ chat），乱序则不命中', () => {
    expect(scoreMatch('cht', 'chat')).toBeGreaterThan(-1)
    expect(scoreMatch('tca', 'chat')).toBe(-1)
  })

  it('空查询 / 纯空白查询返回「全部通过」而不是拒绝', () => {
    for (const candidate of ['chat', 'zzz', '']) {
      expect(scoreMatch('', candidate)).toBeGreaterThanOrEqual(0)
      expect(scoreMatch('   ', candidate)).toBeGreaterThanOrEqual(0)
    }
  })

  it('无匹配返回 -1（且与空查询的全通过区分开）', () => {
    expect(scoreMatch('zzz', 'chat')).toBe(-1)
    expect(scoreMatch('chat', 'zzz')).toBe(-1)
    expect(scoreMatch('q', '')).toBe(-1)
  })

  it('前后空白被裁剪，不影响匹配强度', () => {
    expect(scoreMatch('  chat  ', 'chat')).toBe(scoreMatch('chat', 'chat'))
    expect(scoreMatch('chat', '  chat  ')).toBe(scoreMatch('chat', 'chat'))
  })
})

/* ------------------------------------------------------------------ *
 * 2. 命令模型 —— NavModel 是导航部分的唯一真相源
 * ------------------------------------------------------------------ */

describe('命令模型：NavModel 的 20 条路由全部可达', () => {
  it('NavModel 恰好注册 20 条路由（守护本测试的前提）', () => {
    expect(NAV_ROUTE_PATHS).toHaveLength(20)
  })

  it('palette 的路由命令集与 NAV_ROUTE_PATHS 逐条相等（不多不少）', () => {
    const paths = model().flatMap((command) => (command.path === null ? [] : [command.path]))
    expect([...paths].sort()).toEqual([...NAV_ROUTE_PATHS].sort())
  })

  it('NavModel 的全部表面（route / workbench / action）都进入 palette 模型', () => {
    const ids = new Set(model().map((command) => command.id))
    for (const surface of getPaletteSurfaces()) {
      expect(ids.has(surface.id), `palette 缺少 NavModel 表面 ${surface.id}`).toBe(true)
    }
  })

  it('只有 NavModel 的 route 表面携带 path（workbench / action 表面为 null）', () => {
    for (const command of model()) {
      const isNavRoute = command.id in Object.fromEntries(getPaletteSurfaces().filter((s) => s.surfaceKind === 'route').map((s) => [s.id, 1]))
      expect(command.path !== null, `${command.id} 的 path 与 NavModel 表面形态不符`).toBe(isNavRoute)
    }
  })

  it('每条命令都带非空 label / description / keywords（搜索与可读性契约）', () => {
    for (const command of model()) {
      expect(command.label.trim().length, `${command.id} label 为空`).toBeGreaterThan(0)
      expect(command.description.trim().length, `${command.id} description 为空`).toBeGreaterThan(0)
      expect(command.keywords.length, `${command.id} keywords 为空`).toBeGreaterThan(0)
    }
  })

  it('命令 id 唯一（React key 与 select 定位的前提）', () => {
    const ids = model().map((command) => command.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('label / keywords 模糊匹配可达：查询 "selfcheck" 跨空格命中 "Self check"', () => {
    const commands = model()
    const label = byId(commands, 'selfcheck')
    // 标签命中的是子序列级（"self check" 的空格被跳过），不是 exact
    expect(scoreMatch('selfcheck', label.label)).toBeGreaterThan(0)
    expect(scoreMatch('Self check', label.label)).toBe(3)
  })

  it('label / keywords 模糊匹配可达：查询 "诊断" 命中任一 surface 的中文 keyword', () => {
    const selfcheck = byId(model(), 'selfcheck')
    expect(selfcheck.keywords).toContain('诊断')
    expect(scoreMatch('诊断', '诊断')).toBe(3)
  })

  it('rankCommands 只让 label / group / keywords 参与匹配，并按强度降序', () => {
    const commands = model()
    // 空查询 → 原样返回全部
    expect(rankCommands(commands, '   ')).toHaveLength(commands.length)

    // group 名也是匹配面：'workbench' 命中 Workbench 组
    const workbenchHits = rankCommands(commands, 'workbench')
    expect(workbenchHits.length).toBeGreaterThan(0)
    expect(workbenchHits.every((entry) => entry.group === 'Workbench')).toBe(true)

    // exact 排在 subsequence 之前
    const mixed = rankCommands(commands, 'chd')
    expect(mixed.length).toBeGreaterThan(0)
    const exactFirst = mixed.findIndex((entry) => scoreMatch('chd', entry.label) === 3)
    const subsequenceFirst = mixed.findIndex((entry) => scoreMatch('chd', entry.label) === 1)
    if (exactFirst >= 0 && subsequenceFirst >= 0) expect(exactFirst).toBeLessThan(subsequenceFirst)

    // 无匹配 → 空数组（不是「全部」）
    expect(rankCommands(commands, 'qqqqzz')).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ *
 * 3. Run 组 —— 含 recoverStaleRuns（此前无 UI 的后端能力）
 * ------------------------------------------------------------------ */

describe('Run 组：run 控制命令直连 runsApi', () => {
  it('recover stale runs 命令存在且调用 runsApi.recoverStaleRuns()', () => {
    const commands = model()
    expect(byId(commands, 'run:recover-stale')).toBeDefined()

    run(commands, 'run:recover-stale')

    expect(recoverStaleRuns).toHaveBeenCalledTimes(1)
  })

  it('recover stale runs 在没有活动 run 时依然存在（崩溃恢复与当前 run 无关）', () => {
    const commands = model({ activeRunId: null, activeRunStatus: null })
    run(commands, 'run:recover-stale')
    expect(recoverStaleRuns).toHaveBeenCalledTimes(1)
  })

  it('new run 导航到 command center', () => {
    run(model(), 'run:new')
    expect(navigate).toHaveBeenCalledWith('/command-center')
  })

  it('running 态：暴露 pause / cancel，二者打活动 run id', () => {
    const commands = model()
    run(commands, 'run:pause')
    run(commands, 'run:cancel')
    expect(pauseRun).toHaveBeenCalledWith('run-1')
    expect(cancelRun).toHaveBeenCalledWith('run-1')
    // running 不可 resume
    expect(commands.some((command) => command.id === 'run:resume')).toBe(false)
  })

  it('waiting 态：暴露 resume 而非 pause', () => {
    const commands = model({ activeRunStatus: 'waiting' })
    expect(commands.some((command) => command.id === 'run:resume')).toBe(true)
    expect(commands.some((command) => command.id === 'run:pause')).toBe(false)
  })

  it('终态 run 不暴露 pause / resume / cancel（不发必然 409 的请求）', () => {
    const commands = model({ activeRunStatus: 'completed' })
    for (const id of ['run:pause', 'run:resume', 'run:cancel']) {
      expect(commands.some((command) => command.id === id), `${id} 不应存在`).toBe(false)
    }
  })
})

/* ------------------------------------------------------------------ *
 * 4. Workbench 组 —— 5 个面板 + pin / maximize / close
 * ------------------------------------------------------------------ */

describe('Workbench 组：5 个面板各一条 + 三个窗口动作', () => {
  const TABS = ['browser', 'code', 'files', 'terminal', 'preview'] as const

  it('5 个 workbench 面板各有一条命令并复用 NavModel 的表面 id', () => {
    const commands = model()
    for (const tab of TABS) {
      expect(byId(commands, `workbench-${tab}`)).toBeDefined()
    }
  })

  it('打开面板派发 workbench-open 并带上目标 tab', () => {
    for (const tab of TABS) {
      const seen: unknown[] = []
      const off = subscribeAppEvent('workbench-open', (detail) => seen.push(detail))
      run(model(), `workbench-${tab}`)
      off()
      expect(seen).toEqual([{ tab }])
    }
  })

  it('pin / maximize / close 三个动作驱动 workspace store', () => {
    const ws = useWorkspaceStore.getState()
    const before = ws.workbench

    run(model(), 'workbench:pin')
    expect(useWorkspaceStore.getState().workbench.pinned).toBe(!before.pinned)

    run(model(), 'workbench:maximize')
    expect(useWorkspaceStore.getState().workbench.maximized).toBe(true)

    run(model(), 'workbench:close')
    expect(useWorkspaceStore.getState().workbench.open).toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 * 5. Appearance 组 —— uiTheme × 7 / colorScheme × 2 / material × 2 / slideshow
 * ------------------------------------------------------------------ */

describe('Appearance 组：7 主题 + 2 明暗 + 2 材质 + 轮播', () => {
  const THEMES = [
    'liquid-glass',
    'shadcn',
    'geist',
    'magic',
    'origin',
    'dark-minimal',
    'light',
  ] as const

  it('uiTheme 恰好 7 条命令，覆盖 appearance store 的全部 7 个取值', () => {
    const themes = model().filter((command) => command.id.startsWith('appearance:theme:'))
    expect(themes.map((command) => command.id.replace('appearance:theme:', '')).sort()).toEqual([...THEMES].sort())
  })

  it('每条主题命令把 uiTheme 设成自己的取值', () => {
    const store = useAppearanceStore.getState()
    for (const theme of THEMES) {
      useAppearanceStore.setState({ uiTheme: store.uiTheme })
      run(model(), `appearance:theme:${theme}`)
      expect(useAppearanceStore.getState().uiTheme, `${theme} 未生效`).toBe(theme)
    }
    useAppearanceStore.setState({ uiTheme: store.uiTheme, colorScheme: store.colorScheme })
  })

  it('colorScheme 2 条命令：dark / light', () => {
    const store = useAppearanceStore.getState()
    run(model(), 'appearance:scheme:light')
    expect(useAppearanceStore.getState().colorScheme).toBe('light')
    run(model(), 'appearance:scheme:dark')
    expect(useAppearanceStore.getState().colorScheme).toBe('dark')
    useAppearanceStore.setState({ colorScheme: store.colorScheme })
  })

  it('material 2 条命令：glass / opaque', () => {
    const store = useAppearanceStore.getState()
    run(model(), 'appearance:material:opaque')
    expect(useAppearanceStore.getState().material.mode).toBe('opaque')
    run(model(), 'appearance:material:glass')
    expect(useAppearanceStore.getState().material.mode).toBe('glass')
    useAppearanceStore.setState({ material: store.material })
  })

  it('slideshow 是一条幂等可读的 toggle（翻转 wallpaper.slideshow）', () => {
    const store = useAppearanceStore.getState()
    run(model(), 'appearance:slideshow')
    expect(useAppearanceStore.getState().wallpaper.slideshow).toBe(!store.wallpaper.slideshow)
    run(model(), 'appearance:slideshow')
    expect(useAppearanceStore.getState().wallpaper.slideshow).toBe(store.wallpaper.slideshow)
  })
})

/* ------------------------------------------------------------------ *
 * 6. Conversation 组
 * ------------------------------------------------------------------ */

describe('Conversation 组：新建 / 选最近 / 删除 / 打开抽屉', () => {
  it('打开抽屉派发 toggle-conv-panel（复用 NavModel 的 action:conv-panel 表面）', () => {
    const seen = recordEvents(['toggle-conv-panel'], () => run(model(), 'action:conv-panel'))
    expect(seen).toEqual(['toggle-conv-panel'])
  })

  it('已在 command center 时只派发 select-conversation，不重复导航', () => {
    const seen: string[] = []
    const off = subscribeAppEvent('select-conversation', (detail) => seen.push(detail.conversationId))

    run(model(), 'conversation:open:c-1')
    run(model(), 'conversation:open:c-2')
    off()

    expect(seen).toEqual(['c-1', 'c-2'])
    expect(navigate).not.toHaveBeenCalled()
  })

  it('在别的表面时导航到 command center 并带上 selectConv（沿用抽屉的既有契约）', () => {
    const seen = recordEvents(['select-conversation'], () =>
      run(model({ pathname: '/chat' }), 'conversation:open:c-1'),
    )
    expect(navigate).toHaveBeenCalledWith('/command-center?selectConv=c-1')
    expect(seen).toEqual([])
  })

  it('打开会话命令的 label 携带会话标题（面板里可辨认）', () => {
    expect(byId(model(), 'conversation:open:c-1').label).toContain('重构 Command Palette')
  })

  it('每个最近会话各有一条「删除」命令', () => {
    const commands = model()
    expect(byId(commands, 'conversation:delete:c-1').group).toBe('Conversation')
    expect(byId(commands, 'conversation:delete:c-2').group).toBe('Conversation')
  })

  it('新建会话导航到 chat', () => {
    run(model(), 'conversation:new')
    expect(navigate).toHaveBeenCalledWith('/chat')
  })

  it('无会话时不产生逐会话命令（只留新建与抽屉）', () => {
    const commands = model({ conversations: [] })
    expect(commands.filter((command) => command.id.startsWith('conversation:open:'))).toHaveLength(0)
    expect(commands.filter((command) => command.id.startsWith('conversation:delete:'))).toHaveLength(0)
    expect(byId(commands, 'conversation:new')).toBeDefined()
  })
})

/* ------------------------------------------------------------------ *
 * 7. System 组
 * ------------------------------------------------------------------ */

describe('System 组：审批中心 / self-check / monitoring', () => {
  it('审批中心派发 aether-open-approvals（复用 NavModel 的 action:approvals 表面）', () => {
    const seen = recordEvents(['aether-open-approvals'], () => run(model(), 'action:approvals'))
    expect(seen).toEqual(['aether-open-approvals'])
  })

  it('self-check 与 monitoring 各有一条 System 快捷命令并导航到对应路由', () => {
    run(model(), 'system:selfcheck')
    expect(navigate).toHaveBeenCalledWith('/selfcheck')
    run(model(), 'system:monitoring')
    expect(navigate).toHaveBeenCalledWith('/monitoring')
  })

  it('interface mode 复用 NavModel 的 action:ui-mode 表面（走 app store，不自己造 toggle）', () => {
    const seen = recordEvents(['toggle-ui-mode'], () => run(model(), 'action:ui-mode'))
    expect(seen).toEqual(['toggle-ui-mode'])
  })
})

/* ------------------------------------------------------------------ *
 * 8. 全部 app 事件改走 dispatchAppEvent（T1 契约）
 * ------------------------------------------------------------------ */

describe('事件契约：不再手写 CustomEvent', () => {
  it('源文件不含任何 new CustomEvent(', () => {
    expect(SOURCE).not.toMatch(/new\s+CustomEvent/)
  })

  it('源文件从 T1 注册表导入 dispatchAppEvent', () => {
    expect(SOURCE).toMatch(/import\s*\{[^}]*dispatchAppEvent[^}]*\}\s*from\s*'[^']*lib\/events'/)
  })

  it('5 类原本裸派发的事件全部真到达订阅端', () => {
    const commands = model()
    const seen = recordEvents(
      ['workbench-open', 'toggle-conv-panel', 'aether-open-approvals', 'toggle-ui-mode', 'select-conversation'],
      () => {
        run(commands, 'workbench-browser')
        run(commands, 'action:conv-panel')
        run(commands, 'action:approvals')
        run(commands, 'action:ui-mode')
        run(commands, 'conversation:open:c-1')
      },
    )
    expect(seen).toEqual([
      'workbench-open',
      'toggle-conv-panel',
      'aether-open-approvals',
      'toggle-ui-mode',
      'select-conversation',
    ])
  })
})

/* ------------------------------------------------------------------ *
 * 9. ⌘K 双向开关 + 分组渲染契约
 * ------------------------------------------------------------------ */

describe('⌘K 与分组渲染', () => {
  it('isPaletteHotkey 认 ⌘K 与 Ctrl+K，忽略其它键与无修饰键', () => {
    expect(isPaletteHotkey('k', true, false)).toBe(true)
    expect(isPaletteHotkey('k', false, true)).toBe(true)
    expect(isPaletteHotkey('K', true, false)).toBe(true)
    expect(isPaletteHotkey('j', true, false)).toBe(false)
    expect(isPaletteHotkey('k', false, false)).toBe(false)
  })

  it('面板订阅 toggle-command-palette（与 Sidebar 的派发端配对）', () => {
    expect(SOURCE).toMatch(/'toggle-command-palette'/)
  })

  it('分组头为 sentence case，且不落 text-transform: uppercase', () => {
    const markup = markupOf(model())
    const labels = [...markup.matchAll(/data-palette-group="([^"]+)">([^<]*)</g)].map((match) => ({
      group: match[1],
      text: match[2],
    }))

    expect(labels.length).toBeGreaterThan(0)
    for (const { group, text } of labels) {
      expect(text, `${group} 组头为空`).toBe(group)
      expect(text, `组头 ${text} 是全大写`).not.toBe(text.toUpperCase())
      expect(text[0], `组头 ${text} 首字母未大写`).toBe(text[0]?.toUpperCase())
    }
    expect(markup).not.toMatch(/text-transform:\s*uppercase/i)
  })

  it('组头复用 .aether-nav-group-label（与侧栏同一 class，字号/颜色不漂）', () => {
    const markup = markupOf(model())
    const headers = [...markup.matchAll(/<[^>]*class="[^"]*aether-nav-group-label[^"]*"[^>]*>/g)]
    expect(headers.length).toBeGreaterThan(0)
  })

  it('六组按固定顺序渲染，缺组不留空标题', () => {
    const markup = markupOf(model())
    const order = [...markup.matchAll(/data-palette-group="([^"]+)"/g)].map((match) => match[1])
    expect(order).toEqual(['Navigate', 'Run', 'Workbench', 'Appearance', 'Conversation', 'System'])
  })

  it('空结果渲染空态而不是空白列表', () => {
    const markup = markupOf([])
    expect(markup).toContain('No matching commands')
  })

  it('每条命令渲染为 listbox option，且 aria-label 携带 label 与 description', () => {
    const markup = markupOf(model())
    expect(markup).toContain('role="listbox"')
    expect(markup).toContain('role="option"')
    const command = byId(model(), 'run:recover-stale')
    expect(markup).toContain(`aria-label="${command.label}：${command.description}"`)
  })
})
