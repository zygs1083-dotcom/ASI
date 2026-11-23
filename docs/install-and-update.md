# 安装和更新 ASI 插件（asi-sense + asi-needs + asi-sleep）

## 支持版本

`asi-sense`（纯感官后台服务）、`asi-needs`（生存需求评估、全景病因嗅探、行动效果记忆、后台自维护、`ctx.asiDrives` 多层需求仲裁与「生存需求」侧栏）与 `asi-sleep`（L2 仿生睡眠记忆整合、FSRS 衰减、MiniSearch 中英检索与独立「记忆库」侧栏）采用模块化多插件设计（当前版本 **`0.3.0`**），支持的 DeepSeek Harness（DSH）宿主版本恰好为 **`0.2.2-rc.3`** 和 **`0.2.2-rc.5`**（`engines.dsh: "0.2.2-rc.3 || 0.2.2-rc.5"`）。

## 安装（Desktop Profile）

默认数据目录为 `~/.dsh`，Desktop 使用的 profile 为 `~/.dsh/profiles/desktop`（若自定义了 `DSH_HOME`，请保持终端与 Desktop 一致）。

1. 检查 Desktop 自带 CLI 版本（输出须为 `0.2.2-rc.3` 或 `0.2.2-rc.5`）：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" --version
```

2. 完全退出 DeepSeek Harness Desktop（含后台进程），依次安装三个插件包：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add "$HOME/Downloads/asi-sense-0.3.0.tgz"
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add "$HOME/Downloads/asi-needs-0.3.0.tgz"
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add "$HOME/Downloads/asi-sleep-0.3.0.tgz"
```

3. 重新打开 Desktop：
   - `asi-sense` 作为纯后台感官服务自动运行，不占用左侧栏图标；
   - 左侧栏出现 **生存需求**（`asi-needs`，英文为 **Survival needs**）与 **记忆库**（`asi-sleep`，英文为 **Memory vault**）两个面板图标：前者查看五大生存需求、高阶需求仲裁状态、动作收益账本、自发维护记录与隐私开关；后者检索、筛选、置顶和管理本地长期记忆并支持一键立即睡眠整合。

## 隔离 Web Profile 本地验证

在仓库根目录构建发行包并在独立临时 `DSH_HOME` 中验证（不触碰现有 Desktop 数据）：

```sh
export ASI_ROOT="$PWD"
pnpm install --frozen-lockfile
pnpm --filter asi-sense pack:dist
pnpm --filter asi-needs pack:dist
pnpm --filter asi-sleep pack:dist

export DSH_LAUNCHER="$ASI_ROOT/plugins/asi-needs/scripts/dsh.sh"
export DSH_HOME="$(mktemp -d "${TMPDIR:-/tmp}/asi-dsh.XXXXXX")"
node -e 'require("node:fs").writeFileSync(process.env.DSH_HOME + "/workspace.json", JSON.stringify([{id:"workspace-controller",config:{documentsDirectory:process.env.DSH_HOME}}]))'

"$DSH_LAUNCHER" --profile asi-dev --from-default-profile web --dump-config
"$DSH_LAUNCHER" plugin --profile asi-dev add "$ASI_ROOT/plugins/asi-sense/dist/asi-sense-0.3.0.tgz"
"$DSH_LAUNCHER" plugin --profile asi-dev add "$ASI_ROOT/plugins/asi-needs/dist/asi-needs-0.3.0.tgz"
"$DSH_LAUNCHER" plugin --profile asi-dev add "$ASI_ROOT/plugins/asi-sleep/dist/asi-sleep-0.3.0.tgz"
"$DSH_LAUNCHER" --profile asi-dev --patch "$DSH_HOME/workspace.json" --no-open --host 127.0.0.1 --port 0
```

## 更新与卸载

- **本地 tgz 更新（如 `0.2.0 -> 0.3.0`）**：取得新版 `asi-sense-0.3.0.tgz`、`asi-needs-0.3.0.tgz` 与 `asi-sleep-0.3.0.tgz` 后，完全退出 Desktop，依次执行 `dsh plugin --profile desktop add <新 tgz 路径>` 即可原位覆盖升级，保留在本地的数据目录设置与记忆库不会被重置。
- **从 0.1.x 单插件升级**：先覆盖安装 `asi-sense-0.3.0.tgz`，再依次新增安装 `asi-needs-0.3.0.tgz` 与 `asi-sleep-0.3.0.tgz`。
- **卸载**：停止 DSH 后执行 `dsh plugin --profile desktop remove asi-sleep`、`dsh plugin --profile desktop remove asi-needs` 与 `dsh plugin --profile desktop remove asi-sense`。
