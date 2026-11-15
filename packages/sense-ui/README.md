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
- **历史**：`history.*` 为 `{at, value}` 点列，UI 只渲染 `[now-300000, now]`，x 域固定为该窗口（稀疏点按真实时间摆位）。单位：cpu 为 0..1 比例、memory 与 disks 为**占用比例**（磁盘是 used/total）、networkRx/Tx 为 B/s、tokens 为 token 计数、thermal 为序数 0..3、battery 为百分值、processCpu 0..1、processRss 字节。降采样为软上限：≤240 普通采样点（119 桶 min/max + 首末），另加全部阈值穿越/相等迁移的边界点对（含未激活参考线）——同桶多次越界 excursion 不会被聚合抹掉，越界点数不设上限。同时间戳按输入顺序稳定，末点为最晚时间戳的最后一个点。
- **insights**：`baseline.low/high` 与 history 同单位（画基线带）；`sources`/`triggered` 为 `floor|rate|baseline`，UI 只展示不判定。可选 `thresholds.<层>` 提供宿主阈值（`{value, source, unit?}`）：floor 优先于既有显示底线，warn 虚线、critical 实线；`unit` 显式与 history 单位不符时不画线；rate/baseline 同值可比较时也会画线（标签「变化率」/「基线」），单位不符只在明细文本展示。`severity` 缺失但 `triggered` 非空时按 warn 处理并在明细标注「宿主未给严重度」。`currentEta` 为宿主当前投影（`{asOf, sampleIntervalMs, timeToThresholdMs?, ratePerMinute}`）：仅 asOf ≤ now、now-asOf ≤ 2×间隔、速率为恶化方向（磁盘/电池负、其余正）、原始 timeToThresholdMs ≤7 天，且**剩余时间** `timeToThresholdMs - (now - asOf)` > 0 时在监护句显示「N 分钟后见底/触及阈值」（timeToThresholdMs 是 asOf 时刻估计，显示前扣除已流逝时间）；同指标更新的 body.rate 信号使旧投影失效，事件里的历史 ETA 只作「当时预计」。
- **token 容量来源**：`body.tokens.value.contextWindowSource` 为 `configured`（配置值）/`catalog`（模型目录）/`fallback`（回退估值）。`fallback` 表示容量未确认：环与百分比降饱和、明示「容量未确认」、不显示剩余量/填满估算/压缩距离，行级视为未知但不计入聚合未知与告警；缺省保持旧版行为。
- **可选字段**：`body.memory.value.breakdown`（`{app, wired, compressed, cached}` 原始字节）提供时画四段细分条（App/联动/压缩/缓存），缺失时只画 used/free 单段并在明细明示「未提供」；`body.tokens.value.contextGrowthPerMinute`（tokens/分）有限且 >0、且 `contextWindow`/`contextUsed` 均有限时，新鲜且容量已确认的卡片摘要估算「按当前速度约 N 分钟填满」；结果非有限或超过 7 天也不估算。无 `contextWindow`/`contextUsed` 时不出现压缩措辞，「本会话」用量行仍然显示。
- **磁盘卷级状态（增量契约，全可选）**：`body.disks.value[]` 各卷可加 `status: 'ok'|'stale'|'unknown'`、`observedAt`、`ttlMs` 覆盖父事实的新鲜度（父事实有效状态仍是上界：整列 stale/denied 不能被卷级 ok 复活）；父事实可加 `unavailableMounts: string[]` 声明读不出的挂载点（即使 value 带数也只显示「挂载点 · 无法读取」，无数字/无历史/无图）。stale 卷灰显「上次读数 + 已过期 · 年龄」并保留读数，unknown/unavailable 卷不显示数值；非新鲜卷不参与告警聚合与 insight/ETA 并入。根卷 `/` 非新鲜（声明 stale/unknown、被标 unavailable 或 TTL 过期）时磁盘卡报 unknown——除非其他新鲜卷有更高告警；无根卷/旧版只含 `mount/total/free` 的 payload 保持旧版最差卷语义。
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

每个 src 文件 ≤300 行。E2E 截图矩阵 32 张（8 场景 × 320/420 × 明暗）+ 卡片明细 4 张 + fallback 容量 2 张（420px 明暗），存于 `test/screenshots/`。

## 评审修复对应测试

| 评审发现 | 回归测试 |
|---|---|
| 触发无 severity 误判健康 | `health.test.ts` 缺省严重度用例、`regressions.test.tsx`「宿主未给严重度」 |
| fallback 容量与真容量不分 | `regressions.test.tsx`「容量未确认」用例、`panel.spec.ts`「容量未确认」截图 |
| 历史事件 ETA 冒充当前 | `attention.test.ts`「insight 无 currentEta 时不从事件 detail 推导见底时间」等 |
| stale 仍称「当前速度」 | `regressions.test.tsx`「过期事实禁用当前推算」 |
| 极小增速溢出 Infinity | `format.test.ts`「formatDuration 边界」、`regressions.test.tsx`「fillMinutes 结果护栏」 |
| 阈值层/单位/边界/线型 | `attention.test.ts`「阈值解析」、`panel.spec.ts`「告警线为虚线、严重线为实线」 |
| 大 history 渲染崩溃/磁贴重复渲染 | `sparkline.test.tsx`「sampleHistory 降采样」200k 用例、`regressions.test.tsx`「磁贴渲染隔离」 |
| 无效磁盘读数误报健康 | `health.test.ts` diskValid 用例、`regressions.test.tsx`「无有效磁盘读数」 |
| 工具栏无 landmark | `panel.spec.ts` axeCheck（region 也拒绝） |
| 标签拥挤/末位半空行 | `panel.spec.ts`「不与标签重叠」「末位配对」 |
