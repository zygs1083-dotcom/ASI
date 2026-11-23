# 安装和更新 ASI 插件（asi-sense + asi-needs）

## 支持版本

`asi-sense`（纯感官后台服务）与 `asi-needs`（生存需求评估、后台自维护与统一侧栏）在 **0.2.0** 起采用模块化双插件设计，支持的 DeepSeek Harness（DSH）宿主版本恰好为 **`0.2.2-rc.3`** 和 **`0.2.2-rc.5`**（`engines.dsh: "0.2.2-rc.3 || 0.2.2-rc.5"`）。

## 安装（Desktop Profile）

默认数据目录为 `~/.dsh`，Desktop 使用的 profile 为 `~/.dsh/profiles/desktop`（若自定义了 `DSH_HOME`，请保持终端与 Desktop 一致）。

1. 检查 Desktop 自带 CLI 版本（输出须为 `0.2.2-rc.3` 或 `0.2.2-rc.5`）：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" --version
```

2. 完全退出 DeepSeek Harness Desktop（含后台进程），依次安装两个插件包：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add "$HOME/Downloads/asi-sense-0.2.0.tgz"
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add "$HOME/Downloads/asi-needs-0.2.0.tgz"
```

3. 重新打开 Desktop：
   - `asi-sense` 作为纯后台感官服务自动运行，不占用左侧栏图标；
   - 左侧栏出现唯一面板图标 **生存需求**（英文界面为 **Survival needs**），点击即可查看五大生存需求、自发维护记录、核心体征、当前环境、求助卡及暂停/隐私开关。

## 隔离 Web Profile 本地验证

在仓库根目录构建发行包并在独立临时 `DSH_HOME` 中验证（不触碰现有 Desktop 数据）：

```sh
export ASI_ROOT="$PWD"
pnpm install --frozen-lockfile
pnpm --filter asi-sense pack:dist
pnpm --filter asi-needs pack:dist

export DSH_LAUNCHER="$ASI_ROOT/plugins/asi-needs/scripts/dsh.sh"
export DSH_HOME="$(mktemp -d "${TMPDIR:-/tmp}/asi-dsh.XXXXXX")"
node -e 'require("node:fs").writeFileSync(process.env.DSH_HOME + "/workspace.json", JSON.stringify([{id:"workspace-controller",config:{documentsDirectory:process.env.DSH_HOME}}]))'

"$DSH_LAUNCHER" --profile asi-dev --from-default-profile web --dump-config
"$DSH_LAUNCHER" plugin --profile asi-dev add "$ASI_ROOT/plugins/asi-sense/dist/asi-sense-0.2.0.tgz"
"$DSH_LAUNCHER" plugin --profile asi-dev add "$ASI_ROOT/plugins/asi-needs/dist/asi-needs-0.2.0.tgz"
"$DSH_LAUNCHER" --profile asi-dev --patch "$DSH_HOME/workspace.json" --no-open --host 127.0.0.1 --port 0
```

## 更新与卸载

- **本地 tgz 更新**：取得新版 `asi-sense-<version>.tgz` 与 `asi-needs-<version>.tgz` 后，完全退出 Desktop，再次执行 `dsh plugin --profile desktop add <新 tgz 路径>` 即可覆盖升级，保留在本地的数据目录设置不会被重置。
- **从 0.1.x 单插件升级到 0.2.0 双插件**：先覆盖安装 `asi-sense-0.2.0.tgz`，再新增安装 `asi-needs-0.2.0.tgz`；原「环境感知」侧栏自动由新的统一「生存需求」侧栏接管。
- **卸载**：停止 DSH 后执行 `dsh plugin --profile desktop remove asi-needs` 与 `dsh plugin --profile desktop remove asi-sense`。
