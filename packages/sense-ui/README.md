# @asi/sense-ui

asi-sense 侧栏「环境感知」面板：React 18 + CSS Modules 的**纯 props** 组件 + 独立 Vite 预览/测试包。组件只消费宿主注入的 DSH 主题令牌（见 [THEME.md](./THEME.md)），不做取数、定时器、阈值学习或任何副作用——所有展示数据经 `model` 传入，所有操作经回调传出。

## 运行

```sh
cd packages/sense-ui
pnpm install --ignore-workspace   # 独立安装（非工作区成员）
pnpm dev                          # Vite 预览：?scenario=<名>&theme=light|dark&realtime=1
pnpm typecheck                    # tsc --noEmit
pnpm test                         # Vitest 浏览器模式（本机 Chromium）
pnpm e2e                          # Playwright：axe + 8 场景 × 2 宽度 × 2 主题截图
pnpm build                        # 构建预览页到 dist/（预览产物，非库产物）
pnpm check                        # typecheck + test
```

`pnpm-lock.yaml` 与 test-results/artifacts 已 gitignore；**截图 `test/screenshots/` 不入 gitignore，随包提交**供评审比对。

安装说明：pnpm 11 下 `.pnpmfile.cjs` 的 `updateConfig` 钩子把 `strictDepBuilds` 置为 false，依赖构建脚本被跳过（esbuild 的 postinstall 只是平台二进制校验，optional 依赖已提供二进制）；测试用本机安装的 Google Chrome channel，不下载浏览器。

## 使用

```tsx
import { SensePanel } from '@asi/sense-ui'
import type { SensePanelModel, SensePanelProps } from '@asi/sense-ui'
```

`package.json` 的 `exports["."]` 指向 `src/index.ts` 源码与类型——Vite 消费方直接编译源码，本包不预构建库产物。

## model 要点（单位与动态）

- **单位**：CPU `usage`/`perCore` 与 DSH 进程 `cpu` 为 0..1 比例，CPU `load1`/`load5`/`load15` 为系统平均负载（不限制在 0..1）；内存/磁盘 `used`/`total`/`free`、进程 `rss` 为**原始字节**；token `contextUsed`/`contextWindow`/sessionUsage 为**token 计数**；电池 `percent` 为 **0..100**；温控为档位枚举。
- **历史**：`history.*` 为 `{at, value}` 点列，UI 只渲染 `[now-300000, now]`，x 域固定为该窗口（稀疏点按真实时间摆位）。单位：cpu 为 0..1 比例、memory 与 disks 为**占用比例**（磁盘是 used/total）、networkRx/Tx 为 B/s、tokens 为 token 计数、thermal 为序数 0..3、battery 为百分值、processCpu 0..1、processRss 字节。
- **insights**：`baseline.low/high` 与 history 同单位（画基线带）；`sources`/`triggered` 为 `floor|rate|baseline`，UI 只展示不判定。可选 `thresholds.<层>` 提供宿主阈值（`{value, source, unit?}`）：floor 会画成虚线并优先于既有显示底线，`unit` 显式与 history 单位不符时不画线；rate/baseline 不做数值假设。
- **可选字段**：`body.memory.value.breakdown`（`{app, wired, compressed, cached}` 原始字节）提供时画四段细分条（App/联动/压缩/缓存），缺失时只画 used/free 单段并在明细明示「未提供」；`body.tokens.value.contextGrowthPerMinute`（tokens/分）有限且 >0、且 `contextWindow`/`contextUsed` 均有限时，卡片摘要估算「按当前速度约 N 分钟填满」；缺失/非正/非有限一律不估算。无 `contextWindow`/`contextUsed` 时不出现压缩措辞，「本会话」用量行仍然显示。
- **learning**：`collectedMs/targetMs` 由宿主给，UI 只算 `clamp(collected/target)`，target 非法显示"进度不可用"。
- **tuning**：参数列表 + 调整日志（`previous→next`、`agent|user|auto`、`reverted`）。锁定/撤销只是回调，宿主拥有护栏。
- **events**：`detail` 为宿主投影的告警明细（body.rate / body.anomaly / file.burst），`feedback` 状态只在 model 中。窗口类事件在 `sendTitles=false` 时隐藏主体/原因/规则名/detail。
- **预览的实时模式**是演示假数据 tick（`src/preview/tick.ts`），不属于组件。

## 视觉结构（当前迭代）

- **身体**：监护概览（严重度词 + 状态句 + ECG 脉冲，周期按 good/warn/critical/unknown 区分，减弱动态时静止；学习状态附进度条）+ 两列指标卡片网格（任何宽度都两列，Token 跨满行；卡片顺序 CPU/内存/Token/磁盘/网络/温控/电池/进程）。卡片为原生 `<details>`，头部带折叠箭头，summary 只放只读主数值（约 20px）与 30px 趋势图；明细放大图（~110px，y 轴标注真实绘图域含基线/padding、-5分钟/现在 坐标）、三层阈值/触发行、来源与「调整」入口（内部联动打开规则分区调整日志，不新增对外回调）。磁盘主数字为剩余空间、比例条按 free/total 填充；过期（stale）但保留值的事实仍显示值并整体去色，附「已过期 · 年龄」标记，严重度降级为未知、不引用 insight 或速率徽标。
- **现在**：位置链（四节点全部可用且同主机时合并为「全部在 x」，多主机用文字「异地」标注而非仅颜色；合并或「位置详情」折叠块都保留 endpoint/provider/os/pid/session/cwd 原始字段、FactMeta 与来源）+ 前台应用焦点卡（应用与窗口事实独立渲染，各自状态语义互不影响）；信号源折叠在明细里。
- **事件流**：当前页按分钟分桶，多事件组默认收起、含唤醒组默认展开（唤醒不被默认隐藏）；反馈为图标按钮，细指针下悬停/聚焦事件行显现，粗指针常显。
- **规则**：默认收起；调整日志旧→新值用语义化 prev/next 节点 + 箭头。

## 规模

每个 src 文件 ≤300 行。E2E 截图矩阵 32 张（8 场景 × 320/420 × 明暗）+ 卡片明细 4 张，存于 `test/screenshots/`。
