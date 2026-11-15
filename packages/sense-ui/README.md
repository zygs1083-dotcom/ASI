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
- **历史**：`history.*` 为 `{at, value}` 点列，UI 只渲染 `[now-300000, now]`。单位：cpu 为 0..1 比例、memory 与 disks 为**占用比例**（磁盘是 used/total）、networkRx/Tx 为 B/s、tokens 为 token 计数、thermal 为序数 0..3、battery 为百分值、processCpu 0..1、processRss 字节。
- **insights**：`baseline.low/high` 与 history 同单位（画基线带）；`sources`/`triggered` 为 `floor|rate|baseline`，UI 只展示不判定。
- **learning**：`collectedMs/targetMs` 由宿主给，UI 只算 `clamp(collected/target)`，target 非法显示"进度不可用"。
- **tuning**：参数列表 + 调整日志（`previous→next`、`agent|user|auto`、`reverted`）。锁定/撤销只是回调，宿主拥有护栏。
- **events**：`detail` 为宿主投影的告警明细（body.rate / body.anomaly / file.burst），`feedback` 状态只在 model 中。窗口类事件在 `sendTitles=false` 时隐藏主体/原因/规则名/detail。
- **预览的实时模式**是演示假数据 tick（`src/preview/tick.ts`），不属于组件。

## 规模

src 非 mock 代码 3,462 行、mock 夹具 481 行、测试 1,110 行。超出最初 ≤2,000 的目标——§2.2c 范围扩展新增了阈值来源/基线带、基线学习进度、调整日志与参数锁定、告警明细与有用/噪音反馈界面及相应测试。每个 src 文件 ≤300 行（最大 `sections/body.tsx` 279 行）。
