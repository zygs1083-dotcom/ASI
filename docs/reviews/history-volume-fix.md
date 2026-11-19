# asi-sense 历史写入降量与触顶不推模型修复报告（task/history-volume-fix）

基线：`hub/main` `5a50b6b`（`asi-sense 0.1.4`）。参考测量：`hub/task/history-volume-measure:docs/reviews/history-volume-measure.md`。

## 1. 改动摘要与分步提交

为控制单步可审查性（总非测试 diff 超出 400 行，拆分为 4 个提交分步推进，说明如下）：

| 提交 | 内容 | 非测试改动 |
|---|---|---|
| `eebe68f` | 行瘦身（去冗余 `detail.directory` / `file.activity.detail.files` / `cause:"unknown"`、本地 `source` 简写、短 `id`、读写兼容）及 `#44 clearEpoch` 复查 / `#47 ENOSPC` 断行自愈 / 粘连行跳过 | `+131 / -37`（5 文件） |
| `8cf740d` | `file.activity` 按 `(dir, cause)` 60s 聚合落盘，保持 10s 内存事件流与投递不变；`stop()` / 跨日 / 期满 flush | `+278 / -3`（1 文件） |
| `0954d84` | 分层每日预算（`file.*` 12 MiB + 非 `file.*` 8 MiB，30 天总上限 ≤600 MiB，非 file `context`/`wake` 例外落盘）；`daily-limit-exceeded` 定级 `record` 仅侧栏显示「今日已达上限，后续只记汇总」并跨同日重启去重 | `+382 / -46`（9 文件） |
| `1093af2` | 跨日 rollover 改用内存 `todayAcc` 生成并持久化 `daily/YYYY-MM-DD.json`（含 `truncatedAtLimit`），统一今日汇总与落盘日汇总口径；中途重启从磁盘重建（≥落盘行数）并保留 `truncatedAtLimit: true` | `+70 / -20`（2 文件） |

合计非测试改动（`5a50b6b..1093af2`）：10 个文件，`+848 / -93` 行。未触及 `sources/helper-events.ts`、`runtime/deliver*.ts`、`dsh/tool-output.ts`，也未修改用户 `~/.dsh/profiles/desktop`。

## 2. 合成 24h 负载对比（基于测量报告分布）

依据 `docs/reviews/history-volume-measure.md` §1a/§1d/§1e，使用编造目录名（重度/中度/长尾三级目录，均值 ~60–85 字符/路径；每分钟 112 条 `file.activity` 落在 76 个 `(dir, min)` 桶，含 5 个 6/min、10 个 2–3/min、61 个 1/min；非 `file.*` 按 ~5.6 条/min 分布模拟 `window.focused`、`window.title-changed`、`app.activated`、`source.status`），在加速时钟下通过真实 `HistoryManager` 连续模拟 24 小时（1,440 分钟）并在跨日时执行 rollover。同时补充一段 10 分钟真实 `FileHistoryStoragePort` 实盘 I/O 压测（760 个目录分钟桶落盘）。

| 场景 | 旧代码原始字节 / 行数（20MB 单限行为） | 新代码实盘字节 / 行数 | `file.*` / 非 `file.*` 分布 | 触顶状态 | rollover 日汇总口径 | 主线程耗时（max `recordEvent` / `tick` flush sync） |
|---|---|---|---|---|---|---|
| **连续 24h 高负载**（全天 112 `file.activity`/min + ~5.6 其他/min） | **76.29 MiB** / 169,200 行（6.3h 触 20MB 顶，后 17.7h 丢弃 5,841 条非 file 事件） | **13.59 MiB** / 54,642 行（降量 **-82.2%** 字节、**-67.7%** 行数） | `file.*` 12.00 MiB (46,434 行) · 非 `file.*` **1.59 MiB** (8,208 行) | `file` 触 12 MiB 顶；**非 `file` 未触顶（0 丢弃）** | `totalEvents=117,360`（内存全量），`truncatedAtLimit=true` | 144.42 ms / 78.66 ms |
| **平稳工作日 A**（~4.5h 活跃 112/min + ~19.5h 轻量背景 ≈18.7 MiB 旧基线） | **18.72 MiB** / 42,606 行 | **8.02 MiB** / 32,005 行（**-57.2%**） | `file.*` 7.41 MiB (28,711 行) · 非 `file.*` 0.61 MiB (3,294 行) | **均未触顶** | `totalEvents=31,717`，`truncatedAtLimit=false` | 72.33 ms / 23.15 ms |
| **平稳工作日 B**（8h 活跃 112/min + 16h 8/min ≈29 MiB 旧基线） | **29.04 MiB** / 65,328 行（6.3h 触 20MB 顶，丢 1,809 条非 file 事件） | **11.95 MiB** / 47,375 行（**-58.8%**） | `file.*` 11.16 MiB (43,199 行) · 非 `file.*` 0.79 MiB (4,176 行) | **均未触顶** | `totalEvents=47,087`，`truncatedAtLimit=false` | 66.96 ms / 26.89 ms |
| **5× 突发 24h**（560 `file.activity`/min + ~28 非 file/min） | **381.85 MiB** / 846,000 行（1.3h 触 20MB 顶，丢 37,539 条非 file 事件） | **19.89 MiB** / 86,095 行（`-94.8%` vs 无上限，`-89.8%` 行） | `file.*` 12.00 MiB (46,207 行) · 非 `file.*` **7.89 MiB** (39,888 行) | `file` 触 12 MiB 顶；**非 `file`（8 MiB 上限）未触顶** | `totalEvents=149,040`，`truncatedAtLimit=true` | 309.89 ms（V8 tight-loop GC 峰值）/ 44.35 ms |
| **10 分钟实盘 `FileHistoryStoragePort`**（760 桶，含 fs 写入） | — | 182.0 KB | — | 未触顶 | — | `maxMinuteFlushSyncMs=1.56 ms`（异步单次 `appendEvent` max 193.11 ms） |

边界说明（实测如实反映）：当全天持续保持 112 条/min `file.activity`（对应旧格式 76 MiB 活跃日），或 8h 满负荷 + 16h 8/min 背景（29 MiB 基线）时，即使聚合后仍有约 4.7 万～10.6 万条 `(dir, min)` 记录；因每条 `subject` 目录路径约 60–85 字节且保留 `record`/`ruleId`/`level` 兼容字段，单行均长约 271 B，全天无截断理论下界约 11.95 MiB（8h 工作日）至 27.4 MiB（24h 满跑）。平稳中等工作日（约 4.5h 活跃，~19 MiB 旧基线）实测 **8.02 MiB**（~8 MB）；更高负载日由 **12 MiB `file.*` 独立上限**截断，不再影响非 `file.*` 落盘。

## 3. 预算、触顶与口径机制核验

1. **分层预算与 30 天上限（[types.ts](file:///data/browser-home/orca/workspaces/ASI/history-volume-fix/plugins/asi-sense/src/host/runtime/history/types.ts)）**：
   - `MAX_DAILY_FILE_EVENT_BYTES = 12 * 1024 * 1024`（12 MiB）：112/min 经 60s 聚合 + 行瘦身后常规 8h 工作日约 11.2 MiB，12 MiB 可覆盖常规活跃日并将突发 `file.*` 风暴隔离在 12 MiB 内。
   - `MAX_DAILY_NON_FILE_EVENT_BYTES = 8 * 1024 * 1024`（8 MiB）：实测 5× 突发日全天非 file 事件 7.89 MiB（39,888 行）仍低于 8 MiB 不触顶。
   - `MAX_HISTORY_TOTAL_BYTES = HISTORY_RETENTION_DAYS * MAX_DAILY_EVENT_BYTES` = **600 MiB**：`startupMaintenance` 与 `pruneExpired` 先按 30 天过期清理，若总占用仍超出 600 MiB，则从最早历史日期（不删当日）依次删除事件文件。
   - **真实异常不丢**：非 `file.*` 的 `context`/`wake` 级事件（及其 patch）在 `appendRawLine` 中标记 `critical: true`，任意预算状态下均绕过字节上限落盘。
2. **触顶不推模型与同日重启去重**：
   - [rules.ts](file:///data/browser-home/orca/workspaces/ASI/history-volume-fix/plugins/asi-sense/src/host/attention/rules.ts) 新增 `history-daily-limit`（`record` 级）并令通用 `source-error`（兼容旧已保存规则）排除 `subject='history'` 且 `error='daily-limit-exceeded'`，因此无论存在会话还是无会话 pending 队列，模型均收到 **0** 条推送。
   - [project.ts](file:///data/browser-home/orca/workspaces/ASI/history-volume-fix/plugins/asi-sense/src/host/presenter/project.ts) 与 [now.tsx](file:///data/browser-home/orca/workspaces/ASI/history-volume-fix/packages/sense-ui/src/sections/now.tsx) 将该错误在侧栏信号源渲染为「`今日已达上限，后续只记汇总`」。
   - [history-storage.ts](file:///data/browser-home/orca/workspaces/ASI/history-volume-fix/plugins/asi-sense/src/host/dsh/history-storage.ts) 与 [store.ts](file:///data/browser-home/orca/workspaces/ASI/history-volume-fix/plugins/asi-sense/src/host/runtime/history/store.ts) 通过 `history/cap-state.json`（及当日日志检测）在同日重启时恢复 `capErrorsEmitted`、`fileCappedDates`/`nonFileCappedDates` 与侧栏状态（`restoreSourceError` 直接更新状态树），不重复发射 `source.error`。
3. **汇总口径统一**：
   - 跨日 rollover 时直接基于内存 `todayAcc.finish(...)` 输出并写盘 `daily/YYYY-MM-DD.json`（仅冷启动大文件尚未完成 hydration 时由磁盘+`liveLines` 补齐），消除今日汇总与落盘日汇总分裂；触顶日期标记 `truncatedAtLimit: true`。
   - 进程当日中途重启时由 `hydrateTodayFromDisk` 从磁盘重建并经 `restoreTodayCapState` 保留 `truncatedAtLimit: true`，汇总事件数恒 ≥ 已落盘行数。

## 4. 验证命令与真实结果

所有验证均在最终代码（含本报告写入前全部功能代码）完成后串行前台执行：

1. **核心 runtime / dsh / presenter / rules / files-global 回归**（`task-644`）：
   - 命令：`timeout 600 pnpm --filter asi-sense exec vitest run test/runtime/history.test.ts test/runtime/presenter-events.test.ts test/runtime/pending-context.test.ts test/runtime/runtime.test.ts test/dsh/history-storage.test.ts test/dsh/history-tools.test.ts test/dsh/events.test.ts test/dsh/projection.test.ts test/dsh/deliver.test.ts test/dsh/timeline-remote.test.ts test/presenter/history.test.ts test/presenter/presenter.test.ts test/presenter/timeline.test.ts test/home-aliases.test.ts test/rules.test.ts test/sources/files-global.test.ts --maxWorkers=1 --testTimeout=20000`
   - 结果：`Test Files 16 passed (16)`，`Tests 404 passed (404)`，耗时 `117.79s`（含原 `streams 20 MB single-day & 30x5 MB history within perf/RSS budgets` perf/RSS 校验用例，在 `task-595` 单独输出中为 `4468ms` 通过）。
2. **UI 单测**（`task-648`）：
   - 命令：`timeout 600 pnpm --filter @asi/sense-ui exec vitest run test/unit/panel.test.tsx test/unit/history-section.test.tsx test/unit/attention.test.ts test/unit/ui-contract.test.tsx --maxWorkers=1 --testTimeout=20000`
   - 结果：`Test Files 4 passed (4)`，`Tests 133 passed (133)`（`panel.test.tsx` 68、`attention.test.ts` 42、`ui-contract.test.tsx` 17、`history-section.test.tsx` 6），耗时 `31.64s`。
3. **类型与静态检查**（`task-648`）：
   - 命令：`pnpm typecheck && pnpm lint`
   - 结果：`exit 0`（4 个 workspace package `tsc` 全过，`biome check .` 354 文件 0 errors）。

## 5. N5 复跑：`scripts/bench-history-volume.ts`（task/fix-history-volume-2）

合成负载脚本落在 `plugins/asi-sense/scripts/bench-history-volume.ts`，**不进 `pnpm check`**（`tsconfig.json` 只包含 `src`/`test`/`vitest.config.ts`，脚本目录不参与 tsc 与 vitest；`biome check` 对该文件 0 error）。内存 `HistoryStoragePort` + 真实 `HistoryManager`，加速时钟（`wall`/`mono` 手动推进），夹具目录名全部编造。

运行命令（仓库根目录或插件目录均可，前台）：

```sh
pnpm -C plugins/asi-sense exec tsx scripts/bench-history-volume.ts          # 全部场景
pnpm -C plugins/asi-sense exec tsx scripts/bench-history-volume.ts steady   # 仅平稳日字节
pnpm -C plugins/asi-sense exec tsx scripts/bench-history-volume.ts flush    # 仅 4096 桶 flush
```

**steady 场景**（对应 §2 平稳工作日 B：8h 活跃 ~112 条 `file.activity`/min 落 76 个 `(dir, min)` 桶 + 6 条非 `file.*`/min；16h 轻量 8 桶/min + 1 条/min，共 1,440 分钟 + 跨日 rollover）：

```
[steady] 8h mark:  9.34 MiB / 39457 lines
[steady] 24h mark: 11.39 MiB / 48288 lines (48000 event records)
[steady] day summary totalEvents=48000 fileActivityDirs=84 truncatedAtLimit=false wallMs=1131.2
```

与 §2 同分布实测 11.95 MiB 口径一致（本次 11.39 MiB；差异来自非 `file.*` 仅 3 类 kind 且 subject 更短）。均未触顶。

**flush 场景**（4,096 个 `(dir, min)` 桶同一 60s 窗口到期，单次 `tick()` 分片 flush，片上限 `FLUSH_ACTIVITY_SLICE_MAX_BUCKETS=16` / `FLUSH_ACTIVITY_SLICE_BUDGET_MS=5`；用 `setImmediate` 泵测事件循环间隔近似单片耗时）：

```
[flush] buckets=4096 persisted=4096 summaryDirs=4096
[flush] tickTotalMs=34.1 maxLoopGapMs=2.98 p95GapMs=0.17 fileBytes=1.00 MiB / 4097 lines
```

全部 4,096 桶落盘且日汇总目录数 4,096；**最大单片耗时 ≈2.98 ms（另一次跑 3.90 ms）**，远低于 200 ms 主线程阈值与旧实现 ~481.83 ms 的实测单片耗时；整次 tick 34.1 ms，p95 间隔 0.17 ms。
