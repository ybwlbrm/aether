# DESIGN-READ — Aether 的设计读解（T6a）

> 本文件是 Codex-style 重构的**视觉宪法**。`src/frontend/src/styles/shell.css` 是它的可执行形式；
> 当两者冲突时，先改这里，再改 CSS，并说明为什么。
>
> 范围：T6a 只建立设计语言层。**不改任何组件渲染逻辑**，不迁移存量消费者（T19 / T25）。

---

## 1. Design Read（一句话）

> **一个密集的 off-black 仪表面板；一个去饱和的暖中性强调色（`--accent-brand` 青铜金）只用来标记实时状态；workbench 列是一块真实工具表面，不是装饰卡片。**

展开成三句可判定的读法：

1. **这是工具，不是落地页。** 默认状态是「密集」：13–15px 正文、紧凑行高（`--line-height-body` 1.5）、
   面板之间靠 `--space-4` 级距分隔。留白是稀缺资源，用来标层级，不用来呼吸。
2. **颜色是状态的函数。** 一个功能性 accent（`--color-accent`，交互/链接/选中）
   + 一个品牌暖中性（`--accent-brand`，实时/完成/空态），两者职责不重叠。
   状态色（success/warning/danger/info）只在数据里出现，不当装饰。
3. **workbench 是「那里面的机器」。** 它的列边框、拖拽手柄、tab 状态是物理事实，
   不是玻璃拟态的装饰。壳层可以有材质，工具表面必须有边界。

---

## 2. Anti-Default 禁令清单

这些不是「默认不好」，而是**这个品类里我们不用的默认解**。当一个轴是可自由选择的时候，
说明还没有在做决定；正确反应是重写元素，而不是软化它。

| # | 禁令 | 为什么 | 替代做法 |
|---|------|--------|----------|
| 1 | **不用 AI 紫蓝渐变**（`linear-gradient(135deg, #6366f1, #3b82f6)` 之类） | 这是 AI 生成界面的最强指纹，也和 `--color-accent` 的职责冲突 | 中性画布 + 单一 accent 承担强调；渐变只允许出现在玻璃光泽（`glass-card::after` 的径向弱光泽） |
| 2 | **不用居中 hero**（居中大标题 + 副标题 + 双按钮） | 工具的首要任务是让人看到当前状态，不是建立情绪 | 页面头左对齐：`.ui-page-header` + `.ui-page-header-copy`，标题自己撑住权重 |
| 3 | **不用三张等宽等高卡片**作为信息结构 | 等宽卡片 = 没有信息量的容器，删掉等宽就等于删掉假结构 | 按信息量分配宽度（2 列不对称 / 横向列表 / 表格）；卡片只在需要表达层级时存在 |
| 4 | **内容区不用玻璃**（`glass-card` 只属于壳层） | 毛玻璃让 68ch 正文浮在会移动的背景上，对比度不可控 | 内容区用 `.content-surface`：实底 + 1px 边框 + 柔和 tint 阴影；玻璃保留给 sidebar / workbench / overlay |
| 5 | **不用 Inter + slate-900 的 SaaS 配色** | 一个被用滥的组合，且与本项目的 `--bg-base: #0a0b10`（off-black，非纯黑非 slate）冲突 | `--font-family-sans: 'Geist Variable'`；灰阶统一从画布色相 tint，不引入第二套灰 |
| 6 | **不用全大写 eyebrow / kicker** | 小字 + 全大写 + 宽字距是「我在喊你看我」，且与标题争夺注意力 | 标题自己承担权重。导航分组标签已改为 caption + sentence case（`.aether-nav-group-label`） |
| 7 | **不用章节序号**（01 / 02 / 03） | 除非序号本身携带读者需要的信息（执行步骤），否则是纯装饰 | 用真实的语义标签（运行中 / 已完成 / 失败），让文字承担信息 |
| 8 | **不把等宽字体当「技术感」服装** | monospace 的职责是代码、数据、测量值 | 等宽只用于 code / kbd / 路径 / 时长 / 计数；叙述文字用 sans |
| 9 | **不用 emoji / Unicode 字形充当图标** | 字形随系统字体变化，笔画粗细不统一 | 统一从图标库取，同一套 stroke 宽度与尺寸 token（`--icon-nav` / `--icon-btn` / `--icon-card`） |
| 10 | **不用嵌套卡片** | 卡中卡没有层级含义，只是边框的叠加 | 层级用间距 + `--radius-subtle/control/surface` 表达；`--surface-elevated` 只提升一层 |
| 11 | **不用硬偏移阴影**（`box-shadow: 4px 4px 0`） | 零模糊的方块阴影是服装，不是深度系统 | 阴影带偏移 + 柔化模糊，并 tint 到画布色相（`--shadow-xs` … `--shadow-xl`） |
| 12 | **不编造 UI 状态** | 假 loading / 假 empty / 假进度环会让真实状态不可信 | 状态必须来自真实数据：空态就说清下一步，错误说清问题与恢复动作，loading 与布局同形 |

补充两条与本层直接相关的：

13. **不做常驻循环动画。** 呼吸、脉冲、无限循环的光泽扫过（`GradientShimmer` 的 `infinite` 模式）
    都在禁列 —— 见 §4 Motion。
14. **不做渐变文字**（`background-clip: text`）。强调来自字重与字号，不来自填充效果。

---

## 3. 三旋钮

判断一个新元素是否属于这个世界时，依次拧这三个旋钮。任何一个拧不动，元素就是外来的。

### 旋钮 1 · Density（密度）

**问题：这块屏一次要让人看到多少真实信息？**

- 仪表、列表、workbench、日志流 → 高密度。行高 `var(--list-row-height)` 44px、
  正文 13–15px、面板间距 `--space-4`。
- 叙述性正文（Thread 消息、说明段落）→ 降密度，换行宽上限 `--content-prose: 68ch`。
  **68ch 是排版量度，不是栅格约束**：数据密集面板继续用 `--content-standard` / `--content-wide`。
- 判定线：如果一个元素的行距是「为了让内容好看」而加的，它就不属于高密度面板；
  如果一个表格用了 68ch 行宽，旋钮拧反了。

### 旋钮 2 · Restraint（克制）

**问题：这个元素真的需要这个视觉效果吗？**

- 玻璃 = 壳层专用（sidebar / workbench / overlay）。内容区一律实底。
- 阴影 = 表达层级，不是加一层好看。同层级不加阴影。
- 强调色 = 稀缺资源。一个视图里同时出现三处 accent tint 就是拧松了。
- 动效 = 只有一处作者时刻（内容区落位），其余状态变化走 `--motion-fast` 的过渡。
- 判定线：拿掉这个效果，信息量有没有变？没变就拿掉。

### 旋钮 3 · Honesty（诚实）

**问题：这个像素在说实话吗？**

- 状态是真的：loading 有真实进行中的任务，empty 是真的没有内容，不是插画占位。
- 层级是真的：边框与阴影对应真实的容器关系，不做装饰性假分隔。
- 数字是真的：计数、时长、百分比来自数据；表格数字用 `font-variant-numeric: tabular-nums` 对齐。
- 文案是真的：控件写动作（`Resume` 而不是 `OK`），错误写问题 + 恢复动作，
  不用感叹号，不用「Oops!」。
- 判定线：如果一个元素在向用户承诺系统做不到的事，拧回去。

---

## 4. Motion（补充说明）

- **单一动效对。** `--motion-authoring: var(--anim-duration) var(--anim-ease-emphasis)`。
  新的「作者时刻」从这里取值，不再手写 `cubic-bezier`。退出的对称值是 `--motion-exit`。
- **唯一允许的作者时刻：** `.content-surface` 的落位（`shell-content-settle`，
  220ms exponential ease-out，从 0.94 透明度与 2px 位移落定）。
  同样的入场动画不会复制到每个 section —— 那是 slop，不是节奏。
- **GradientShimmer 循环动画禁用原则：** 组件 `src/frontend/src/components/ui/gradient-shimmer.tsx`
  允许实现，但**不得以常驻循环（`infinite`）形态出现在产品表面**。光泽扫过只允许作为
  一次性、有触发条件的状态转换（例：一次任务完成的一次扫过），且必须：
  1. 有明确的触发状态（不是「页面加载就跑」）；
  2. 只扫一次就停在稳定终态；
  3. 在 `prefers-reduced-motion: reduce` 下完全不出现
     （沿用 `components.css` 已有的 reduce 块约定）。
  理由：常驻循环动画会持续消耗 GPU、抢走状态变化的注意力，并且在密集仪表里制造
  「哪里在动 = 哪里有事发生」的错误暗示。
- 现有的 `glass-shimmer` 8s 无限循环仅保留在 shell 材质层（`.glass-card::before`），
  且已被 `prefers-reduced-motion` 块关闭；内容区不再继承任何循环动画。

---

## 5. Contrast（对比度承诺）

> 比值按 alpha 合成 + WCAG 相对亮度公式推算（非工具实测），改 token 值后需重算。

| 角色 | 取值 | 目标对比度 | 说明 |
|------|------|-----------|------|
| 正文 `--text-primary` | `rgba(255,255,255,0.92)` | ≥ 4.5:1（暗 ≈16:1） | 未改动 |
| 辅助 `--text-secondary` | `rgba(255,255,255,0.55)` | ≥ 4.5:1（暗 ≈6.2:1） | 未改动 |
| 最弱一级 `--content-text-quiet` | `--text-primary 58% + --text-tertiary 36% + --accent-brand 6%` | ≥ 4.5:1（暗 ≈9.6:1 / 浅 ≈7.9:1） | **T6a 新增**，带暖色相 tint，非纯灰 |
| 装饰/大字 `--text-tertiary` | `rgba(255,255,255,0.35)` | 仅 ≥19px 大字或纯图形 | 暗 ≈3.1:1，浅 ≈3.3:1 |

`--text-tertiary` 的**值**属 T6b 重调范围（`--color-accent` 等一并处理），本任务不动。
在 T6b 落地前，凡是需要正文级对比度的地方一律用 `--content-text-quiet`：

- `.aether-nav-group-label` 已切换（它是导航分组标签，13px，属正文级）。
- `.content-surface` 内的 `small` / `figcaption` / `.ui-state-description` 已切换。

浏览器表面同样从主题取色，不用纯黑纯灰：选区 = accent 26% tint，
光标 = `--color-accent`，滚动条 thumb = `--text-primary` 16% tint（浅色主题有兜底，
修掉了 `themes.css` 只定义暗色 `--scrollbar-thumb` 导致浅色滚动条消失的问题）。

---

## 6. 材质边界（glass 的适用范围）

| 层 | 材质 | 允许的类 |
|----|------|-----------|
| Shell | 玻璃 / 实底（`--surface-shell`，`[data-material="opaque"]` 下自动实底化） | `.sidebar-glass`、`.glass-card`（仅壳层容器） |
| Overlay | 玻璃 + blur | `.glass-modal`、`.glass-menu`、popover |
| **内容区** | **实底 + 1px 边框 + 柔和 tint 阴影** | **`.content-surface`** |
| 数据密集 | 无材质（靠分隔线与行高） | 表格、日志流、workbench 列表 |

`.content-surface` 内部禁止再出现 `.glass-card`（那等于嵌套卡片 + 玻璃内容区，
同时违反 §2 的第 4 与第 10 条）。

**存量迁移不在 T6a**：现存玻璃消费者保持原样，迁移排期见 T19（内容区）/ T25（overlay 收敛）。

---

## 7. 本层落地清单（可核对）

| 项 | 位置 |
|----|------|
| 正文行宽 68ch | `tokens.css` → `--content-prose`；用法 `.prose-measure` |
| 标题节奏（上方 32 / 下方 16） | `tokens.css` → `--heading-margin-top` / `--heading-margin-bottom`；用法 `.content-surface :is(h1…h6, .md-heading)` |
| 内容区实底 | `shell.css` → `.content-surface` |
| 选区 / 光标 / 滚动条 | `shell.css` → 浏览器表面段 |
| 单一动效对 | `shell.css` → `:root { --motion-authoring }` |
| 导航标签去大写 | `components.css` → `.aether-nav-group-label` |
| z-index 离刻度 | `components.css` → `.aether-wb-divider`（`var(--z-fixed)`）、`Layout.tsx` 对话抽屉（`var(--z-sticky)`） |
| 重复边框清理 | `WorkspaceFrame.tsx` 删除外层 `borderLeft`，保留 `Workbench.tsx` 内层 |

---

## 8. Skill 来源（provenance）

本设计读解应用了 4 个前端设计 skills 的原则（重构前置任务已下载到
`~/.config/opencode/skills/`）：

| Skill | 仓库 | 本设计读解中落地的原则 |
|-------|------|------------------------|
| **impeccable** | `pbakaus/impeccable` | §1 设计读解句式；§2 禁令 1-3/7-9/11-12（craft-floor.md：无 eyebrow、无渐变文字、阴影带偏移、不嵌套卡片）；§4 Motion 单一作者时刻 + `prefers-reduced-motion`；§5 浏览器表面定制（选区/光标/滚动条） |
| **redesign-skill** | `Leonxlnx/taste-skill` 子 skill | §2 禁令 4（无 AI 蓝紫渐变）、10（无三等宽卡片）；§3 旋钮 1-2（密度/克制）；字体有性格（Geist Variable）、标题负字距、sentence case |
| **taste-skill** | `Leonxlnx/taste-skill` | §1 Design Read 必须先输出一行读解；§3 三旋钮基线（DESIGN_VARIANCE/MOTION_INTENSITY/VISUAL_DENSITY）；Anti-Default（无 Inter+slate-900、无玻璃遍地） |
| **frontend-design** | `anthropics/skills` | §2 禁令 5-6（无全大写 eyebrow、无中点分隔 meta）；「5 条 AI 味特征」自我审查清单（暖奶油底/近黑+酸绿/大报版/卡片套装/模板 chrome） |

> 注意：§5 对比度数值与 §6 材质边界是 Aether 自身 token 体系的实际约束，
> 非 skill 直接产出；skills 提供的是「要检查什么」的审查框架。
