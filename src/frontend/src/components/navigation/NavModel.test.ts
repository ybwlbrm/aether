import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import { subscribeAppEvent, type AppEventName } from '../../lib/events'
import { useAppStore } from '../../store/app'
import { Sidebar } from '../shell/Sidebar'
import {
  NAV_GROUP_LABELS,
  NAV_ROUTE_PATHS,
  findNavSurface,
  findRouteSurfaceByPath,
  getPaletteSurfaces,
  getSecondarySurfaces,
  getSidebarSurfaces,
  runNavAction,
} from './NavModel'

/**
 * App.tsx 是路由的唯一真相源。本测试直接解析它的源码，而不是抄一份路径列表 ——
 * 新增一条 `<Route path="...">` 而忘记注册 NavModel（或反之）时，测试立即失败。
 */
const APP_ROUTE_SOURCE = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8')

/** App.tsx 中除 layout 壳（`/`）与 index 重定向外的具名路由 */
function appRoutePaths(): readonly string[] {
  return [...APP_ROUTE_SOURCE.matchAll(/<Route path="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((segment) => segment !== '/')
    .map((segment) => `/${segment}`)
}

const ORPHAN_ACTION_IDS = ['action:ui-mode', 'action:conv-panel', 'action:approvals'] as const

describe('NavModel：App.tsx 的 20 条路由全部注册', () => {
  it('App.tsx 恰好声明 20 条具名路由（守护本测试的前提）', () => {
    expect(appRoutePaths()).toHaveLength(20)
  })

  it('每条 App.tsx 路由在 NavModel 中都有同 path 的表面', () => {
    const registered = new Set(NAV_ROUTE_PATHS)
    expect([...appRoutePaths().filter((path) => !registered.has(path))]).toEqual([])
  })

  it('NavModel 不注册 App.tsx 不存在的路由（无幽灵表面）', () => {
    const declared = new Set(appRoutePaths())
    expect(NAV_ROUTE_PATHS.filter((path) => !declared.has(path))).toEqual([])
  })

  it('每条路由表面都带非空 keywords 与非空 description（palette 搜索依赖）', () => {
    for (const path of NAV_ROUTE_PATHS) {
      const surface = findRouteSurfaceByPath(path)
      expect(surface, `缺少路由表面：${path}`).toBeDefined()
      if (surface === undefined) continue
      expect(surface.keywords.length, `${path} 的 keywords 为空`).toBeGreaterThan(0)
      expect(surface.keywords.every((keyword) => keyword.trim().length > 0)).toBe(true)
      expect(surface.description.trim().length).toBeGreaterThan(0)
      expect(surface.label.trim().length).toBeGreaterThan(0)
    }
  })
})

describe('NavModel：primary / secondary 表面分工', () => {
  it('每条路由表面都出现在 sidebar 模型或 secondary（palette 可达）模型中', () => {
    const sidebarIds = new Set(getSidebarSurfaces().map((s) => s.id))
    const secondaryIds = new Set(getSecondarySurfaces().map((s) => s.id))
    for (const path of appRoutePaths()) {
      const surface = findRouteSurfaceByPath(path)
      if (surface === undefined) throw new Error(`未注册路由：${path}`)
      expect(
        sidebarIds.has(surface.id) || secondaryIds.has(surface.id),
        `路由 ${path} 既不在 sidebar 也不在 palette 模型中`,
      ).toBe(true)
    }
  })

  it('/dashboard 不再是 /command-center 的别名：它是独立的旧 dashboard 表面，且从 sidebar 隐藏', () => {
    const dashboard = findRouteSurfaceByPath('/dashboard')
    // T24 路由切换：/command-center 是 Thread 主线，/dashboard 是旧 dashboard —— 两者不是同一个表面
    expect(dashboard?.aliasOf).toBeUndefined()
    expect(dashboard?.id).toBe('dashboard')
    expect(getSidebarSurfaces().some((s) => s.id === 'dashboard')).toBe(false)
    // 摘掉 aliasOf 后它必须仍能在 palette 里以自己的名义被找到
    expect(getPaletteSurfaces().some((s) => s.id === 'dashboard')).toBe(true)
  })

  it('sidebar 与 secondary 互不相交，且 palette 是二者的超集', () => {
    const sidebarIds = new Set(getSidebarSurfaces().map((s) => s.id))
    for (const secondary of getSecondarySurfaces()) {
      expect(sidebarIds.has(secondary.id)).toBe(false)
    }
    const paletteIds = new Set(getPaletteSurfaces().map((s) => s.id))
    for (const surface of [...getSidebarSurfaces(), ...getSecondarySurfaces()]) {
      expect(paletteIds.has(surface.id)).toBe(true)
    }
  })

  it('surface id 唯一，组标签为 sentence case', () => {
    const ids = getPaletteSurfaces().map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const label of Object.values(NAV_GROUP_LABELS)) {
      expect(label).not.toBe(label.toUpperCase())
      expect(label[0]).toBe(label[0]?.toUpperCase())
    }
  })
})

describe('NavModel：3 个 orphan 事件获得真实 dispatcher', () => {
  it('ui-mode 表面切换 app store 的真实 uiMode（含 localStorage 持久化语义）', () => {
    const before = useAppStore.getState().uiMode
    const surface = findNavSurface('action:ui-mode')
    expect(surface?.surfaceKind).toBe('action')
    if (surface === undefined) return
    expect(runNavAction(surface)).toBe(true)
    expect(useAppStore.getState().uiMode).toBe(before === 'normal' ? 'coding' : 'normal')
  })

  it('conv-panel 与 approvals 表面把事件真派发到订阅端', () => {
    const seen: AppEventName[] = []
    const offs = [
      subscribeAppEvent('toggle-conv-panel', () => seen.push('toggle-conv-panel')),
      subscribeAppEvent('aether-open-approvals', () => seen.push('aether-open-approvals')),
    ]
    for (const id of ['action:conv-panel', 'action:approvals'] as const) {
      const surface = findNavSurface(id)
      expect(surface, `缺少 action 表面：${id}`).toBeDefined()
      if (surface !== undefined) expect(runNavAction(surface)).toBe(true)
    }
    offs.forEach((off) => off())
    expect(seen).toEqual(['toggle-conv-panel', 'aether-open-approvals'])
  })

  it('三个 orphan 表面全部注册为 action 表面', () => {
    for (const id of ORPHAN_ACTION_IDS) {
      expect(findNavSurface(id)?.surfaceKind, `${id} 未注册为 action 表面`).toBe('action')
    }
  })

  it('route 表面不由模型执行（交给 NavSurfaceList 导航）', () => {
    const route = findNavSurface('settings')
    if (route !== undefined) expect(runNavAction(route)).toBe(false)
  })
})

describe('Sidebar：从 NavModel 渲染且组标签非全大写', () => {
  const markup = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: ['/command-center'] },
      createElement(Sidebar),
    ),
  )

  it('不含 text-transform: uppercase', () => {
    expect(markup).not.toMatch(/text-transform:\s*uppercase/i)
  })

  it('渲染出 Codex 分组标签，且都不是全大写文本', () => {
    const labels = [...markup.matchAll(/aether-nav-group-label[^>]*>([^<]*)</g)].map((m) => m[1].trim())
    expect(labels.length).toBeGreaterThan(0)
    for (const label of labels) {
      expect(label.length, '组标签不得为空').toBeGreaterThan(0)
      expect(label, `组标签 ${label} 是全大写`).not.toBe(label.toUpperCase())
    }
  })

  it('渲染出 Work 组首位的实时 run 切换器与 More surfaces 入口', () => {
    expect(markup).toContain('aria-label="活动 Run"')
    expect(markup).toContain('More surfaces')
  })

  it('渲染出全部 sidebar 可见表面，且不含 secondary 表面', () => {
    for (const surface of getSidebarSurfaces()) {
      const reachableAs = surface.surfaceKind === 'route' ? surface.path : surface.workbenchTab
      expect(markup, `sidebar 未渲染 ${reachableAs}`).toContain(`>${surface.label}<`)
    }
    for (const surface of getSecondarySurfaces()) {
      expect(markup, `sidebar 泄漏了 secondary 表面 ${surface.id}`).not.toContain(`>${surface.label}<`)
    }
  })
})
