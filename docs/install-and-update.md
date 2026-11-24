# 安装和更新 ASI 插件（asi-sense + asi-needs + asi-sleep + asi-care + asi-growth）

## 支持版本

ASI 采用模块化五插件设计（当前版本 **`0.5.0`**），支持的 DeepSeek Harness（DSH）宿主版本恰好为 **`0.2.2-rc.3`** 和 **`0.2.2-rc.5`**（`engines.dsh: "0.2.2-rc.3 || 0.2.2-rc.5"`）：

- `asi-sense`：纯后台感官服务（无侧栏图标），暴露 `ctx.asiSense` 与只读工具 `env_state` / `env_detail`；
- `asi-needs`：L1 五大生存需求评估、全景病因嗅探、行动效果记忆、`ctx.asiDrives` 马斯洛多层仲裁服务，注册 **生存需求**（`id: 'asi-needs'`，`order: 90`）侧栏与只读工具 `needs_status`；
- `asi-sleep`：L2 仿生 NREM+REM 睡眠记忆整合、FSRS 衰减、MiniSearch 中英检索与 `MEMORY.md` 双向对账，暴露只读 `ctx.asiSleep` 服务，注册独立 **记忆库**（`id: 'asi-sleep'`，`order: 91`）侧栏与只读工具 `memory_recall` / `memory_profile`；
- `asi-care`：L3 本地工作区、Git 多工作树卫生、孤儿开发端口与闲置构建产物看护（无独立侧栏图标，复用「生存需求」侧栏静默求助卡与动作收益账本），仅向普通对话暴露只读工具 `care_status`；
- `asi-growth`：L4 程序性技能提炼与自进化，在 L1–L3 舒适且深静默（空闲 `>= 20m` 或锁屏）时从高保留率踩坑记忆与排障轨迹自动起草标准纯文本 `SKILL.md`，经人工一键批准后通过 `ctx.skills.registerProvider` 动态热挂载（支持 `global`/`workspace` 作用域切换、60 天零调用代谢提醒与一键导出至 `.agents/skills/`），注册独立 **技能工坊**（`id: 'asi-growth'`，`order: 92`）侧栏与只读工具 `growth_status`。

## 安装（Desktop Profile）

默认数据目录为 `~/.dsh`，Desktop 使用的 profile 为 `~/.dsh/profiles/desktop`（若自定义了 `DSH_HOME`，请保持终端与 Desktop 一致）。`dsh plugin add` 仅原位覆盖同名依赖或向末尾追加新插件，**完整保留 Desktop profile 中已安装的 `dsh-context`、`dsh-superagent` 等其他插件及其启用顺序**（切勿对其他插件执行 `remove` 或直接覆盖 `~/.dsh/profiles/desktop/package.json`）。

1. 检查 Desktop 自带 CLI 版本（输出须为 `0.2.2-rc.3` 或 `0.2.2-rc.5`）：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" --version
```

2. 完全退出 DeepSeek Harness Desktop（含后台进程），依次安装五个插件包：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add "$HOME/Downloads/asi-sense-0.5.0.tgz"
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add "$HOME/Downloads/asi-needs-0.5.0.tgz"
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add "$HOME/Downloads/asi-sleep-0.5.0.tgz"
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add "$HOME/Downloads/asi-care-0.5.0.tgz"
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add "$HOME/Downloads/asi-growth-0.5.0.tgz"
```

3. 重新打开 Desktop：
   - `asi-sense` 与 `asi-care` 作为无侧栏图标的后台服务自动运行；
   - 左侧栏依次出现 **生存需求**（`asi-needs`，英文 **Survival needs**）、**记忆库**（`asi-sleep`，英文 **Memory vault**）与 **技能工坊**（`asi-growth`，英文 **Skill studio**）三个面板图标：分别用于查看 L1–L4 稳态与静默求助卡、管理长期记忆与睡眠整合，以及审阅批准/编辑/导出纯文本 `SKILL.md` 技能；
   - 原有 `dsh-context`、`dsh-superagent` 等插件保持原有配置与启用状态不变。

## 隔离 Web Profile 本地验证

在仓库根目录构建发行包并在独立临时 `DSH_HOME` 中验证（不触碰现有 Desktop 数据）：

```sh
export ASI_ROOT="$PWD"
pnpm install --frozen-lockfile
pnpm --filter asi-sense pack:dist
pnpm --filter asi-needs pack:dist
pnpm --filter asi-sleep pack:dist
pnpm --filter asi-care pack:dist
pnpm --filter asi-growth pack:dist

export DSH_LAUNCHER="$ASI_ROOT/plugins/asi-needs/scripts/dsh.sh"
export DSH_HOME="$(mktemp -d "${TMPDIR:-/tmp}/asi-dsh.XXXXXX")"
node -e 'require("node:fs").writeFileSync(process.env.DSH_HOME + "/workspace.json", JSON.stringify([{id:"workspace-controller",config:{documentsDirectory:process.env.DSH_HOME}}]))'

"$DSH_LAUNCHER" --profile asi-dev --from-default-profile web --dump-config
"$DSH_LAUNCHER" plugin --profile asi-dev add "$ASI_ROOT/plugins/asi-sense/dist/asi-sense-0.5.0.tgz"
"$DSH_LAUNCHER" plugin --profile asi-dev add "$ASI_ROOT/plugins/asi-needs/dist/asi-needs-0.5.0.tgz"
"$DSH_LAUNCHER" plugin --profile asi-dev add "$ASI_ROOT/plugins/asi-sleep/dist/asi-sleep-0.5.0.tgz"
"$DSH_LAUNCHER" plugin --profile asi-dev add "$ASI_ROOT/plugins/asi-care/dist/asi-care-0.5.0.tgz"
"$DSH_LAUNCHER" plugin --profile asi-dev add "$ASI_ROOT/plugins/asi-growth/dist/asi-growth-0.5.0.tgz"
"$DSH_LAUNCHER" --profile asi-dev --patch "$DSH_HOME/workspace.json" --no-open --host 127.0.0.1 --port 0
```

## 更新、回退与卸载

- **本地 tgz 升级（如从 `0.4.0` 升级至 `0.5.0`）**：继续保留上一版 `0.4.0` tgz 包作即时回退备份，完全退出 Desktop，先备份 `~/.dsh/profiles/desktop/package.json` 与 `pnpm-lock.yaml`，再依次执行 `dsh plugin --profile desktop add` 安装五个 `0.5.0` tgz 包（版本号递增至 `0.5.0` 可避免 `pnpm-lock.yaml` tarball 缓存冲突；`dsh-context` 与 `dsh-superagent` 自动原样保留，本地状态、记忆库与技能目录不会被重置）。
- **快速回退至 `0.4.0`**：停止 Desktop 后执行 `dsh plugin --profile desktop remove asi-growth`，再重新执行 `dsh plugin --profile desktop add` 装回四个 `0.4.0` tgz 包。
- **卸载**：停止 DSH 后依次执行 `dsh plugin --profile desktop remove asi-growth`、`dsh plugin --profile desktop remove asi-care`、`dsh plugin --profile desktop remove asi-sleep`、`dsh plugin --profile desktop remove asi-needs` 与 `dsh plugin --profile desktop remove asi-sense`。
