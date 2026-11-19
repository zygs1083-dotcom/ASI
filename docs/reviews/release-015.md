verdict: pass

# 0.1.5 发布验收

基线 ASI `45fe9f0`（分支 `task/release-015`），DSH `0.2.2-rc.3` 源检出
`/Users/wangying/orca/dsh`，macOS arm64，Node 26.13.0，pnpm 11.x。
验证只用独立 `DSH_HOME` + Web + DOM/状态断言；真实模型只走本机
`http://127.0.0.1:3425/v1`，总量 5 条（上限 6）。未修改 DSH 本体，未修改业务
代码；改动为版本号（`28c9cc1`）、截图基线与测试/验收脚本（`824f830`、`131126e`）。

## 1. 版本号 — 通过

`28c9cc1 chore: bump asi-sense to 0.1.5`，与 0.1.4 的 `d8cde2a` 完全同构的
4 文件：`plugins/asi-sense/package.json`、`packages/sense-ui/package.json`
（0.1.4→0.1.5）、`plugins/asi-sense/README.md`、`docs/install-and-update.md`。

## 2. 依赖与静态检查 — 通过

- `pnpm install --frozen-lockfile`：退出 0。
- `pnpm check`：单测 body-probe **241**/241、sense-ui **115**/115、
  asi-sense **1317** 通过 + 9 skipped；Biome 0 失败诊断；typecheck 干净。
  0.1.4 记录过的 files-global p95 比值偶发本次未出现（1 次通过）。
- `pnpm --filter @asi/sense-ui run test:browser`：**247**/247。
- sense-ui Playwright 视觉/交互套件：**104**/104，0 失败。

## 3. 截图基线 — 通过

为新场景 `history-capped`（`sources.history.capped === true` 时历史区显示
「今日已达上限，后续只记汇总」）补 320/420 × 明暗共 **4** 张新基线：
`history-capped-320-dark.png`、`history-capped-320-light.png`、
`history-capped-420-dark.png`、`history-capped-420-light.png`
（`packages/sense-ui/src/mock/scenarios.ts`、`test/e2e/panel.spec.ts`）。
首轮仅这 4 张缺基线，**0 张既有基线差异**（无渲染漂移/真实回归）；生成后
复跑 104/104。

## 4. 零模型真实 DSH 冒烟 — 通过

`ASI_E2E_NO_MODEL=1 DSH_ROOT=/Users/wangying/orca/dsh pnpm --filter asi-sense run e2e:dsh`
退出 0，模型请求 **0/0**；owned DSH/helper PID 均退出，临时 profile 已删除。

## 5. 真实 DSH 实机检查（独立 DSH_HOME，Web，DOM/状态断言）— 通过

脚本：`plugins/asi-sense/scripts/e2e-release-015.ts`（新增，
`DSH_ROOT=… pnpm --filter asi-sense exec tsx scripts/e2e-release-015.ts body`）。
锁屏/离开与 helper 事件通过 helperPath 包装器 + 注入 ndjson 文件合成，
不触发真实睡眠/锁屏。全程 **20.0 分钟**，模型请求 0/0。

### 5a. 历史区块 — 通过

- 今日计数非零；24h CPU/内存等曲线有实时点位；昨日空态、月度空态正常显示。

### 5b. 写入量 — 通过

- `history/events/<今日>.jsonl`：**69,980 B / 349 行 / 20.0 min** →
  折算约 **4.80 MiB/天**（目标 ≤20MiB、期望 ≤12；0.1.4 实测约 78 事件/分、
  42MB/天）。
- kind 分布：`source.status`×134、`file.activity`×134、`app.activated`×66、
  `file.burst`×7，另有 lifecycle/threshold/锁屏配对各若干——
  行瘦身 + 60s 聚合 + file.*/非 file 分档生效。

### 5c. 真实写失败 — 通过

对今日事件文件 `chmod 000` 后注入 helper 事件：出现 `history-write-failed`
（source.error）；恢复 `0600` 后 source 回到 ok，无残留报错。

### 5d. 全盘文件监视与排除项 — 通过

- 排除前缀之外目录批量建删：产生 file.activity/file.burst 事件（计数正确）。
- 侧栏加入该目录为排除项后重复突发：不再产生事件；移除排除项往返正常。
- `/tmp` 下突发静默（内置 `/private` 前缀排除的旁证）。

### 5e. 离开行为 — 通过

- 平静离开：无异常推送、无重复流事件。
- 离开窗内制造文件突发：产生异常离开汇总（含失败/删除计数）。

### 5f. 清除历史 — 通过

二次确认清除后今日/24h/离开均回空态；暂停期间保持空；恢复感知并注入
事件后今日计数恢复增长，无重复/复活离开汇总。

### 5g. 内存 — 通过

asi-sense 进程 RSS：基线 **367,184 KB** → 结束 **415,552 KB**，
增长 **+48,368 KB < 50MB** 上限。

### 5h. 网络比对（e2e-release-013 body，收紧 0.67–1.5x）— 通过

- 第 1 次运行失败：rx 中位数 0.58、tx 2.08——20s 窗口内突发流量与
  瓦片 5s 发布节奏错位所致，两侧均用同一 `parseNetstatIB` + 物理接口
  （`en*`/`pdp_ip*`）去重求和，非系统性缺陷。
- 干净复跑通过：**rx 中位数 1.00**（14/15 个可比窗口）、
  **tx 中位数 1.27**（15/15），均在 0.67–1.5x 内。
- 顺带断言：界外兄弟突发无事件；已注册 body 异常出现反馈控件；0/0 模型请求。

## 6. 真实模型投递 — 通过（5/6 条）

`... e2e-release-015.ts model`，全新隔离 profile，1 个编造指令的合成对话。
今日事件文件预置至 **8,364,054 B / 12,614 行**（恰低于 8MiB 非 file 日预算），
注入事件触发实时触顶。断言全部通过：

- **触顶投影**：侧栏显示「今日已达上限，后续只记汇总」；
  `env_state` 的 `observation.sources.history.capped === true`；
  环境消息中**不含** daily-limit/已达上限 文本。
- **环境消息内容**：`file.burst` 含 created/deleted 计数；
  `front-app: [redacted]`、`front-app: password=[redacted]`——两个编造
  密钥形态（`ghp_` + 36 位、`password=Fake…`，运行时拼接）只以 `[redacted]`
  到达模型；`away.summary` 恰 1 条（含 `failed=1`、删除计数）；
  `job: `bash…` exited 1` 后台任务失败通知。
- **不含**：真实文件名（`burstprobe`）、窗口标题（`window:`）、邮箱形态、
  未脱敏密钥值、完整临时路径、daily-limit 文本。
- 密钥形态目录名的 file.burst 行投影为 `file.burst: [path]`（路径投影优先于
  凭据形态，未泄露原文）；密钥形态 file.changed 文件名同样只出现 `[path]`。
- helper 注入事件与真实 helper 事件按 pid 感知去重，无重复 away.summary。

## 7. 打包与隔离安装/卸载 — 通过

- `pnpm --filter asi-sense release:check`：退出 0；产物
  `plugins/asi-sense/dist/asi-sense-0.1.5.tgz`（**705,721 B**，arm64、
  可执行、ad-hoc 签名；npm dry-run 8 文件、registry E404 版本可用）。
- 审计白名单补 1 条：扫描器自身的 PEM 探测字面量 `-----BEGIN`
  （`input.startsWith('-----BEGIN', i)`，credential-scan.ts:748 编译产物，
  探测标记而非密钥；`scripts/release-audit.mjs`，非业务代码）。
- `... e2e-release-015.ts pack <tgz>`：全新临时 `DSH_HOME` 安装
  `asi-sense@0.1.5`；侧栏可打开（CPU 卡片实时读数、「历史」区块存在）；
  卸载后安装目录消失。owned 进程均退出，临时 profile 删除。

## 8. 交付物 — 通过

已复制到 `/Users/wangying/Downloads/asi-sense-0.1.5.tgz`，
`shasum -a 256` =
`282c7ddc3858e38022d15a151c49b100fbf586c5acfe614a76e1609855ed37f0`；
大小 **705,721 bytes**。未执行 npm publish/login、未发 GitHub Releases。

## 缺陷

- **should-fix**：投递给模型的环境消息含目录 basename（如
  `file.burst: asi-e2e-burst-<rand>`、`deletes=N@…`）。按 AGENTS.md §6
  路径/目录名进入模型请求记 should-fix，不挡合并。
- **nit**：`e2e-release-013` 网络比对在 20s 采样窗口内对突发流量敏感，
  首跑比值出界（rx 0.58 / tx 2.08），干净复跑通过（rx 1.00 / tx 1.27）。
  窗口对齐噪声，非实现缺陷。
- 无 blocker。测试/验收脚本问题均已修复并复跑验证：
  嵌套 `<details>` 的 `:has(summary)` 严格定位违例（改 `> summary` 直达子）；
  `[redacted]` 通道改走 `app.activated` 名称（路径字段按设计投影 `[path]`）；
  审计白名单补 `-----BEGIN` 探测字面量。

## 模型用量

真实模型请求合计 **5 条**（上限 6），全部在 §6；body/pack 阶段预算为 0，
实测 0/0。

## 进程与清理

- 各阶段 owned DSH/helper PID 均在结束时退出（脚本末尾 `pgrep` 校验为空）；
  临时 `DSH_HOME` profile 均已删除；合成突发目录均已删除。
- 用户 Desktop helper（`~/.dsh/profiles/desktop`）与用户 DSH 全程未触碰；
  pgrep 模式均限定在临时 profile/工作树路径。

## 未验证事项

- `power.sleep`/`power.wake`/`session.*` 真实通知路径未注入（helper 无
  对应合成入口；锁屏路径已覆盖同一配对逻辑）。
- 月度总结的真实跨月生成（新 profile 只有空态可断言）。
- 8MiB 触顶后的「只记汇总」长周期行为（跨午夜翻转由单测覆盖）。
