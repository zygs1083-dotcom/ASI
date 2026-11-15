# THEME.md — sense-ui 主题接入说明

本包只**消费**宿主（DSH Web）注入的 `--dsw-*`/`--ds-*` 令牌，不重新定义令牌、不写 `body[data-ds-dark-theme]` 选择器。明暗由宿主在 `body[data-ds-dark-theme]` 上切换（`data-ds-dark-theme` 存在 = dark，缺省 = light），`html.style.colorScheme` 与 `html[data-ds-theme-source]` 由宿主 theme-presenter 维护。

参考实现（dsh `master@39163dd3`）：

- `packages/client/ui-theme/src/styles/base.css`（字体、半径、过渡令牌）
- `packages/client/ui-theme/src/styles/design-platform.css`（alias 调色板，light/dark 两段）
- `packages/client/ui-layout/src/client/theme-presenter.ts`（`data-ds-dark-theme` / `colorScheme` / `data-ds-theme-source` 写入处）
- `packages/client/ui-sidebar/src/client/SidebarRoot.module.css`、`packages/experimental/client-ui-stats/src/client/stats.module.css`（侧栏密度与字号用法）

## 使用的令牌与 fallback

fallback 取自 DSH light 值，仅用于脱离宿主预览兜底。

| 用途 | 令牌 | light fallback | dark 对应值（design-platform.css） |
|---|---|---|---|
| 正文色 | `--dsw-alias-label-primary` | `#0f1115` | `#f9fafb` |
| 次级文本 | `--dsw-alias-label-secondary` | `#61666b` | `#cfd3d6` |
| 弱化文本 | `--dsw-alias-label-tertiary` | `#81858c` | `#adb2b8` |
| 面板底色 | `--dsw-specific-sidebar-fill` | `#f9fafb` | `#1b1b1c` |
| 弱分隔线 | `--dsw-alias-border-l1` | `rgba(0,0,0,.04)` | `rgba(255,255,255,.06)` |
| 分隔线 | `--dsw-alias-border-l2` | `rgba(0,0,0,.1)` | `rgba(255,255,255,.12)` |
| 按钮描边 | `--dsw-alias-border-l4` | `rgba(0,0,0,.16)` | `rgba(255,255,255,.2)` |
| 按钮底 | `--dsw-alias-bg-layer-1` | `#fff` | `#232324` |
| 主色/链接/焦点 | `--dsw-alias-state-business-primary` | `#4176e6` | `#7aaaff` |
| 错误 | `--dsw-alias-state-error-primary` | `#ec1313` | `#f25a5a` |
| 成功 | `--dsw-alias-state-success-primary` | `#22c55e` | `#22c55e` |
| 警告 | `--dsw-alias-state-warn-primary` | `#f59e0b` | `#f59e0b` |
| 正文字体 | `--dsw-font-family` | `-apple-system …` | 同 |
| 等宽 | `--ds-font-family-code` | SF Mono … | 同 |
| 圆角 | `--dsw-radius-xs` / `--dsw-radius-sm` | `4px` / `8px` | 同 |
| 过渡 | `--ds-transition-duration(-fast)`、`--ds-ease-in-out` | `.2s`/`.1s`、`cubic-bezier(.4,0,.2,1)` | 同 |

**字号说明**：DSH 源码里没有 13/12px 的字号角色令牌（`base.css` 仅定义 `--dsw-font-family`/`-brand` 与 markdown 排版变量；`rg -- '--dsw-font-'` 验证无 `--dsw-font-xs-13`/`--dsw-font-xxs-12` 这类令牌）。组件因此在 `.panel` 上定义本地常量 `--sense-fs: 13px` / `--sense-fs-s: 12px`，字体族仍消费 `--dsw-font-family`。

**分隔线**：DSH 发丝线用 0.5px（`SidebarRoot.module.css` 的 `0.5px solid var(--dsw-alias-border-l3)`、`--dsw-elevation-stroke: 0 0 0 0.5px`），本组件分隔线统一 0.5px；控件描边（按钮）保持 1px 以保证可点区域边界清晰。

状态色只用于图标、描边、进度条等小面积元素；状态**文字**一律用 `color-mix` 调和后的墨色（`--sev-*-ink`，good/warn 为状态色 35% + 主墨色，critical 75%，business 60%），避免小字直接吃绿/橙色导致对比度不足（axe 4.5:1）。

## 缺失的共享间距令牌（处理办法）

DSH 没有全局 spacing scale。`SidebarRoot.module.css` 里只有局部变量：`--dsh-sidebar-inline-padding: 8px`、`--dsh-sidebar-row-padding: 12px`、`--dsh-sidebar-label-gap: 6px`。本组件在 `.panel` 上映射为本地变量并带 fallback，间距节奏 4/6/8/12px：

- `--sense-pad-inline: var(--dsh-sidebar-inline-padding, 12px)`
- `--sense-pad-row: var(--dsh-sidebar-row-padding, 8px)`
- `--sense-gap: var(--dsh-sidebar-label-gap, 6px)`

（这些侧栏变量作用域在侧栏内部，宿主里取不到时回落到括号内常量。）

## 预览的调色板

`src/preview/preview.css` 在 `:root` / `body[data-ds-dark-theme]` 定义了上述令牌的**最小子集**（light + dark 两组 alias 值，抄自 design-platform.css），只为了让组件在独立 Vite 页面里看到真实主题效果；它不是组件的一部分，不随组件分发。
