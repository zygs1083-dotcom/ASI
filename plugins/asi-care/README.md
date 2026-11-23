# `asi-care`（L3 本地工作区与项目看护插件 · `0.3.0`）

`asi-care` 是 ASI 模块化架构中的 **马斯洛 L3 高阶看护插件**，专注本机工作区、Git 仓库与兄弟工作树（`git worktree`）卫生、孤儿开发监听端口及闲置构建产物膨胀的持续巡检与受控整理。插件无独立侧栏图标，通过 `ctx.asiDrives`（`tier: 3`）接入 `asi-needs` 统一侧栏与动作收益账本，普通前台对话仅暴露只读工具 `care_status`，**全程禁用 `<asi-cry>` 动态消息注入（零对话打断）**。

## 核心特性

1. **零配置目录发现 + Git 兄弟工作树自动展开**：
   - 自动聚合 DSH `workspaceRegistry` 与普通会话 `cwd`（辅以可选 `extraRoots` / `ignorePaths`），自动排除 ASI 内部目录及 `~/.secrets`、`~/.ssh`、`~/.Trash` 等敏感路径；
   - 对命中的 Git 仓库执行 `git worktree list --porcelain` 自动展开全部兄弟工作树及悬空元数据。
2. **正交三分 L3 驱动（独立熔断，互不阻塞）**：
   - `asi-care:repo_hygiene`（仓库与工作树卫生）：冲突残留（`>2h`）、无进程占用的陈旧 Git 锁、悬空工作树元数据、干净且已合入主干的闲置工作树（`>=3d`）、长期未提交改动（`>24h`）；
   - `asi-care:orphan_runtime`（僵尸进程与孤儿端口）：非活跃工作树下运行 `>2h` 的本地开发监听端口、DSH 无主孤儿后台任务及僵尸子进程提示；
   - `asi-care:workspace_bloat`（闲置工作树产物膨胀）：非活跃工作树中闲置 `>=7d` 且累计 `>=1 GiB` 的可重生成构建产物（`node_modules`、`target`、`.next` 等）。
3. **快慢双速探针 + 2 小时活跃豁免**：
   - 快探针默认每 `3 分钟` 巡检 Git 卫生与 `lsof` 端口（携带 `GIT_OPTIONAL_LOCKS=0` 绝不争抢 `.git/index.lock`），慢探针默认每 `30 分钟` 扫描非活跃工作树构建产物；
   - 有活跃 DSH 会话或 `2 小时` 内有文件变动的工作树自动享受 **2h 活跃豁免**；当 L1 生理不适或进入 `eco` 节能模式时自动由 `ctx.asiDrives` 挂起。
4. **三级分层自治护栏**：
   - **一级（无人值守零损收尾）**：仅允许 `git worktree prune` 悬空元数据、删除经 `lsof` 实证零进程占用的超时 `.git/*.lock`、回收无主 DSH 后台任务；
   - **二级（侧栏静默求助卡一键批准）**：清理闲置构建产物、移除干净已合入工作树（`git worktree remove` 不带 `--force`）、向本地孤儿开发端口发送 `SIGTERM`（执行前二次复核 PID/命令/端口与 2h 活跃保护）；
   - **三级（永远只读提示）**：未提交改动、未推送提交与合并/变基冲突绝不自动 `stash` / `commit` / `reset`。

## MIT 开源裁剪内化署名

100% 源码级裁剪改造为纯 TypeScript 模块（零第三方运行时 npm 依赖，底层仅通过带超时的 `execFile` 调用系统 `git` / `lsof` / `ps`）：

- `voidcosmos/npkill`（MIT）：多语言可重生成构建产物目录字典与项目清单校验规则；
- `steveukx/git-js`（`simple-git`，MIT）：`git status --porcelain` 与 `git worktree list --porcelain` 解析模型；
- `fcsonline/git-cleaner`（MIT）：已合入主干分支与干净工作树安全核验规则；
- `sindresorhus/fkill` & `sindresorhus/pid-port`（MIT）：本地监听端口去重归属与进程身份复核逻辑；
- `tw93/Mole`（MIT）：受保护根路径包含校验护栏。
