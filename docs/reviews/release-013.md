verdict: pass

# 0.1.3 发布验收

基线 ASI `6dc72f5`（分支 `task/release-013`），DSH `0.2.2-rc.3` 源检出
`/Users/wangying/orca/dsh`，macOS 15.7.7 arm64，Node 26.13.0，pnpm 11.13.0。
验证只用独立 `DSH_HOME` + Web + DOM/状态断言；真实模型只走本机
`http://127.0.0.1:3425/v1`，总量 3 条（上限 6）。未修改 DSH 本体，未修改业务
代码；改动为版本号（`035b81c`）与测试脚本（`test:` 提交 `7beeaf7`、`b65f5a6`、
`ce1fc40`、`f137e1a`、`61ff7f8`、`c9b2883`）。

## 1. 版本号 — 通过

`035b81c chore: bump asi-sense to 0.1.3`，与 `1834136` 完全同构的 4 文件
6+/6-：`plugins/asi-sense/package.json`、`packages/sense-ui/package.json`
（0.1.2→0.1.3）、`plugins/asi-sense/README.md`、`docs/install-and-update.md`。

## 2. 依赖与静态检查 — 通过

- `pnpm install --frozen-lockfile`：退出 0，5 个 workspace 项目。
- `pnpm check`：退出 0。单测 body-probe **239**、sense-ui **112**、
  asi-sense **990** 项全部通过；Biome 仅 458 条 `noNonNullAssertion` 等既有
  警告，无失败诊断。
- `pnpm --filter @asi/sense-ui run test:browser`：退出 0，8 文件 **235** 项。
- sense-ui Playwright 视觉/交互套件：退出 0，**84** 项（面板截图、响应式、
  阈值线对比度、调参操作、键盘交互、视觉基线）。

## 3. 零模型真实 DSH 冒烟 — 通过

`ASI_E2E_NO_MODEL=1 DSH_ROOT=/Users/wangying/orca/dsh pnpm --filter asi-sense run e2e:dsh`
退出 0，模型请求 **0/0**。侧栏打开、隐私设置（窗口标题开关未勾选）、
CPU/内存/磁盘数字、面板滚动与响应式断言通过；owned DSH PID 73655、helper
PID 73662 均退出，临时 profile 已删除。
说明：首次运行功能断言全部通过，但清理时 `kill(-pgid)` 命中已被复用的外来
进程组返回 EPERM（`scripts/e2e-support.ts:99`）。`7beeaf7` 把 EPERM 与
ESRCH 同样视为进程组已结束（同 uid 的自有进程组不可能产生 EPERM），复跑
退出 0。

## 4. 真实 DSH 实机检查（独立 DSH_HOME，Web，DOM/状态断言）— 通过

脚本：`plugins/asi-sense/scripts/e2e-release-013.ts`（`b65f5a6` 新增，
命令 `DSH_ROOT=/Users/wangying/orca/dsh pnpm --filter asi-sense exec tsx
scripts/e2e-release-013.ts body`），临时规则 `{kind:'file.burst',
subject:'/tmp/asi-e2e-burst-<rand>/**', level:record}`，模型预算 0。

### 4a. ≥60 秒遥测 — 通过

启动 62 秒后侧栏读数（非 unknown/不可用/无权限）：

- CPU 25%（负载 14.4/16.4/15.8）、内存 56.2/64.0 GB（压力偏高·注意级）、
  磁盘 159.2/926.4 GB（83%）、电池 89% 未充电、温控 正常。
- 网络实时读数（两次采样）`↓ 183 / 99 KB/s`、`↑ 47 / 83 KB/s · 已连接`，
  使用物理 en* 接口。`netstat -ibn` 同期 12 秒窗口估算 vs 侧栏同刻值：
  运行 A：侧栏 rx≈68 KB/s tx≈42 KB/s | 物理接口 rx≈209 KB/s tx≈121 KB/s |
  全接口（含 utun 等隧道）rx≈566 KB/s tx≈297 KB/s；运行 B：侧栏 rx≈350 KB/s
  tx≈49 KB/s | 物理 ≈745/161 KB/s | 全接口 ≈2265/389 KB/s。侧栏始终与物理
  口径同量级、未跟随虚拟接口总量翻倍（VPN 隧道流量存在时仍不重复计数）。
  断言 `tile ≤ max(5×phys, 512KB)` 两次均通过。

### 4b. 作用域 file.burst — 通过

在 `/tmp/asi-e2e-burst-<rand>` 内创建再删除 80 个文件：事件区产生
file.burst 事件（2 条，`1 分 0 秒内 新增 26 · 删除 51 / 删除 75`，
规则 file-burst-external-deletion；无活动会话故按设计显示「已抑制」）。
在规则范围外的兄弟目录 `/tmp/asi-e2e-burst-<rand2>` 做同样操作并等待
15 秒：无任何包含该目录名的事件。

### 4c. σ 偏离显示与反馈按钮门控 — 通过

干净停止后向 `data/asi-sense/body.json` 注入人工成熟基线（memory 均值
0.05、60 个观测、跨 2 个本地日期、elapsedMs>24h）并重启：事件区出现
`baseline:memory（规则 body-anomaly-warn）指标 memory · 当前 88% · 基线 5%
· 偏离 27.51σ`（σ 正常显示）。该已注册告警出现「有用」「噪音」反馈按钮；
对照的未注册 record 级 file.changed 事件无 `data-feedback` 属性、无反馈
按钮。两次运行 owned DSH PID 77611/78827、helper 77616/78851 均退出。

## 5. 真实模型投递（≤6 条，编造对话）— 通过

`... e2e-release-013.ts model`，全新隔离 profile，1 个合成对话
（文本为编造的验收指令，无真实标题/内容）。提示后台执行
`sleep 8; exit 1` 并在其作用域目录创建再删除 80 个文件。会话 JSONL 共
**3 条**环境消息（`user/message` + `source.kind=environment`）：

- `file.burst: asi-e2e-burst-<rand> ruleId=file.burst windowMs=60000
  created=0 modified=0 deleted=51 externalDeleted=51 agentDeleted=0
  externalDeletionExceeded=true alertId="…"` — 含 created/deleted 计数与
  脱敏目录（仅 basename）；
- `job: `bash-…` exited 1 suppressed: 1` — 后台任务失败投递；
- `body.rate: rss ruleId=rss-surge warn …` — 真实遥测顺带投递。

断言通过：所有环境消息均**不含**临时目录完整路径（无 `/tmp/`）、不含
文件名（无 `burstprobe`）、不含 `window:` 标题行。模型请求 **3/6**。

## 6. 打包与隔离安装/卸载 — 通过

- `pnpm --filter asi-sense release:check`：退出 0；产物
  `plugins/asi-sense/dist/asi-sense-0.1.3.tgz`（584,827 B，arm64、可执行、
  ad-hoc 签名；npm dry-run 与 registry E404 检查通过，产物未再被修改）。
- 首次运行审计误报 `Possible absolute path in lib/index.js`：命中为审计批 A
  新增网络探针的正则字面量 `/^\s*interface:\s*(\S+)/m`（Windows 路径臂
  从 `interface:` 的 `e:` 起匹配）。`f137e1a` 按既有精确串约定加入白名单，
  复跑退出 0。
- `... e2e-release-013.ts pack`：全新临时 `DSH_HOME` 内
  `dsh plugin --profile asi-dev add <tgz>` 成功，已安装 manifest 为
  `asi-sense@0.1.3`；侧栏可打开（环境感知标题可见、CPU 卡片实时读数）；
  `dsh plugin remove asi-sense` 后安装目录消失。owned DSH PID 95097、
  helper 95134 均退出，临时 profile 删除。

## 7. 交付物 — 通过

已复制到 `/Users/wangying/Downloads/asi-sense-0.1.3.tgz`，与仓库产物
`shasum -a 256` 均为
`7d5e218b1de75c099d2d399d94bd5f7c575476e68cc3701c0a47189bd77c4d69`；
大小 **584,827 bytes**。未执行 npm publish/login、未发 GitHub Releases。

## 缺陷

无业务缺陷。测试脚本问题均已修复并复跑验证（见 §3/§6 说明与 `test:` 提交）。

## 模型用量

真实模型请求合计 **3 条**（上限 6），全部在 §5；其余阶段预算为 0，
实测 0/0。

## 进程与清理

- 运行前（基线）：用户 Desktop PID 82436/82442/82443/82454/82457、用户
  helper PID 82473、既有 dsh 进程 5459/93207 —— 均未触碰，结束后仍存在。
- 任务启动（owned）：冒烟 DSH 73655/helper 73662；body 阶段
  77611+77616、78827+78851；model 阶段 79754+79775；pack 阶段
  95097+95134。结束后 `pgrep` 各模式均为空，无 owned 进程遗留。
- 失败诊断保留过的临时 profile 均已删除；最终各阶段 profile 均正常清理。
- `/tmp/asi-e2e-burst-*`、`/tmp/asi-e2e-files-*` 临时目录均已删除。

## 未验证事项

- 侧栏 UI 本身不显示插件版本号；版本 0.1.3 通过安装后 manifest（状态断言）
  与 `plugin add/list` 流程验证。
- 电池/温控读数为桌面机真实状态（未充电、正常档），未覆盖告警路径。
- VPN 是否开启无法从会话内确认，但两次采集中虚拟接口流量与物理接口流量
  并存且侧栏口径未翻倍。
