# 安装、迁移与更新 ASI 插件（统一单包 `asi`）

## 支持版本

自 `0.6.0` 起，ASI 整合为**单一 DeepSeek Harness（DSH）组合包 `asi`**（当前版本 **`0.7.0`**），支持的 DSH 宿主版本恰好为 **`0.2.2-rc.3`** 和 **`0.2.2-rc.5`**（`engines.dsh: "0.2.2-rc.3 || 0.2.2-rc.5"`）：

- 仅需安装一个包 `asi-0.7.0.tgz`，在 DSH 左侧栏仅注册**唯一一个侧栏图标**「ASI 稳态」（`id: 'asi'`，`order: 90`，英文 **ASI Homeostasis**）；
- 内部完整包含 L0 感官服务（`ctx.asiSense`、`env_state` / `env_detail`）、L1 生存稳态与马斯洛多层仲裁（`ctx.asiDrives`、`needs_status`）、L2 仿生睡眠记忆库（`ctx.asiSleep`、`memory_recall` / `memory_profile`）、L3 多工作树与孤儿运行时看护（`care_status`）、L4 程序性技能提炼与热挂载（`ctx.skills.registerProvider`、`growth_status`），以及 L5 前额叶直觉与前瞻记忆（`ctx.asiIntuition`、`intuition_status` / `prospective_*`）、心智理论搭档状态感知（`ctx.asiTom`、`partner_state`）与 DMN 跨项目做梦顿悟（`ctx.asiDream`、`dream_insights`）；
- 启动时自动将旧版 `0.5.0` 五个拆分插件的数据目录（`~/.dsh/data/asi-{sense,needs,sleep,care,growth}`）**无损迁移**至 `~/.dsh/data/asi/{sense,needs,sleep,care,growth}`，并在磁盘上完整保留旧目录作为回退备份。

## 全新安装（Desktop Profile）

默认数据目录为 `~/.dsh`，Desktop 使用的 profile 为 `~/.dsh/profiles/desktop`（若自定义了 `DSH_HOME`，请保持终端与 Desktop 一致）。`dsh plugin add` 仅原位覆盖同名依赖或追加 `asi`，**完整保留 Desktop profile 中已安装的 `dsh-context`、`dsh-superagent` 等其他插件及其启用顺序**。

1. 检查 Desktop 自带 CLI 版本（输出须为 `0.2.2-rc.3` 或 `0.2.2-rc.5`）：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" --version
```

2. 完全退出 DeepSeek Harness Desktop（含后台进程），安装单一 `asi` 插件包：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add "$HOME/Downloads/asi-0.7.0.tgz"
```

3. 重新打开 Desktop：左侧栏出现唯一 **ASI 稳态**（`asi`）图标，内含顶部全局状态胶囊、跨 Tab 待批焦点条以及「稳态看护 | 记忆库 | 技能工坊」三段导航；原有 `dsh-context`、`dsh-superagent` 等插件保持不变。

## 从旧版五插件（`0.5.0` `asi-*`）无损迁移至单插件 `asi@0.7.0`

若当前 Desktop profile 已安装旧版拆分包（`asi-sense`、`asi-needs`、`asi-sleep`、`asi-care`、`asi-growth`）：

1. 完全退出 Desktop，先备份 profile 配置（切勿触碰 `dsh-context` 与 `dsh-superagent`）：

```sh
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
PROFILE="${DSH_HOME:-$HOME/.dsh}/profiles/desktop"
BACKUP=$(mktemp -d "${TMPDIR:-/tmp}/asi-070-backup.XXXXXX")
cp -p "$PROFILE/package.json" "$BACKUP/package.json"
test ! -f "$PROFILE/pnpm-lock.yaml" || cp -p "$PROFILE/pnpm-lock.yaml" "$BACKUP/pnpm-lock.yaml"
```

2. 卸载五个旧版拆分插件包并安装单一 `asi-0.7.0.tgz`：

```sh
for old_pkg in asi-growth asi-care asi-sleep asi-needs asi-sense; do
  "$DSH" plugin --profile desktop remove "$old_pkg" || true
done
"$DSH" plugin --profile desktop add "$HOME/Downloads/asi-0.7.0.tgz"
```

3. 启动 Desktop：
   - `asi@0.7.0` 启动时自动把 `~/.dsh/data/asi-sleep/vault/{memories.jsonl,MEMORY.md,sleep-journal.jsonl}`、`state.json` 已整合会话水位线以及其余模块配置与已启用技能 100% 无损复制到 `~/.dsh/data/asi/{sense,needs,sleep,care,growth}`，历史会话不会重复触发睡眠整合；
   - 原有 `~/.dsh/data/asi-*` 目录完整保留在磁盘上不作任何修改或删除；
   - `dsh-context`、`dsh-superagent` 等非 ASI 插件原样保留。

## 隔离 Web Profile 本地验证

在仓库根目录（macOS `arm64`）构建发行包并在独立临时 `DSH_HOME` 中验证：

```sh
export ASI_ROOT="$PWD"
pnpm install --frozen-lockfile
pnpm --filter asi pack:dist

export DSH_LAUNCHER="$ASI_ROOT/plugins/asi/scripts/dsh.sh"
export DSH_HOME="$(mktemp -d "${TMPDIR:-/tmp}/asi-dsh.XXXXXX")"
node -e 'require("node:fs").writeFileSync(process.env.DSH_HOME + "/workspace.json", JSON.stringify([{id:"workspace-controller",config:{documentsDirectory:process.env.DSH_HOME}}]))'

"$DSH_LAUNCHER" --profile asi-dev --from-default-profile web --dump-config
"$DSH_LAUNCHER" plugin --profile asi-dev add "$ASI_ROOT/plugins/asi/dist/asi-0.7.0.tgz"
"$DSH_LAUNCHER" --profile asi-dev --patch "$DSH_HOME/workspace.json" --no-open --host 127.0.0.1 --port 0
```

## 更新、回退与卸载

- **后续单包升级（如 `0.6.0` → `0.7.0` 或 `0.7.0` → `0.7.1`）**：保留上一版 `asi-0.7.0.tgz` 备份，退出 Desktop 后直接执行 `dsh plugin --profile desktop add "$HOME/Downloads/asi-0.7.1.tgz"` 原位更新，`~/.dsh/data/asi` 数据与既有非 ASI 插件自动保留。
- **快速回退至 `0.5.0` 五插件**：退出 Desktop 后执行 `dsh plugin --profile desktop remove asi`，再用备份的五个 `0.5.0` tgz 包依次执行 `dsh plugin --profile desktop add`（由于 `~/.dsh/data/asi-*` 原目录未受改动，可直接无缝回退）。
- **卸载**：停止 DSH 后执行 `dsh plugin --profile desktop remove asi`。
