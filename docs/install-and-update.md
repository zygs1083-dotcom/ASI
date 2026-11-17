# 安装和更新 asi-sense

## 安装

本机检查：PATH 中没有 `dsh`；DeepSeek Harness Desktop 和其自带 CLI 均为
`0.2.2-rc.3`，与插件要求一致。默认数据目录是 `~/.dsh`，Desktop 的 profile
是 `~/.dsh/profiles/desktop`；若设置了 `DSH_HOME`，以实际设置为准。

先在终端检查版本：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" --version
```

输出必须是 `0.2.2-rc.3`。然后完全退出 Desktop（包括后台进程），再执行：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add "$HOME/Downloads/asi-sense-0.1.2.tgz"
```

安装成功后重启 Desktop，打开侧栏的「环境感知」；
保留 Downloads 中的安装包。确保终端的 `DSH_HOME` 与 Desktop 使用的一致。
Desktop profile 须已由 Desktop 初始化；若尚未初始化，先打开一次 Desktop 后完全退出。
本机安装包已在隔离的 Web profile 中验证，没有操作现有 Desktop profile。

如果版本不匹配，先安装或使用匹配的 `0.2.2-rc.3`，或等待适配该 DSH 版本的新插件；
不要使用兼容性豁免。独立 Web profile 和其他安装方式见
[插件 README](../plugins/asi-sense/README.md#安装)。

## 更新

当前 tgz 是本地文件源，**不会自动发现 GitHub 新版本**。发布新包后，需取得新 tgz，
完全退出 Desktop，再用上述 CLI 的 `plugin --profile desktop add` 指向新文件安装。

负责人批准发布后，可按[发布指南](release.md)将发行包发布到 npm 或受控自建 registry，
并在备份和持久配置 profile registry 后原位替换本地 tgz 来源，无需移除插件；
迁移和回退均需核对启用状态及 bundle 顺序。DSH「插件」页查询所配置 registry 中比
已装版本新的兼容版本，显示更新按钮并要求确认；不是直接追踪 GitHub 每个提交，
也不是零确认的自动更新。预发布版不会成为默认推荐版本；尚未执行公网发布。
Desktop 应用菜单里的「检查更新」检查的是 Desktop 本身，不是插件更新。

更新页遵循 profile 的 pnpm 默认 registry 或 DSH plugin-manager 的显式 registry
配置；仅在 add 命令传 `--registry` 不会持久改变更新源。公网及自建 registry 的
profile 配置、操作命令和离线验证见[发布指南](release.md#将用户安装源切到-registry)。

DSH 也接受目录、本地或 HTTP(S) tgz、npm 包名、Git URL 和 GitHub 等简写；
`plugin --profile <名称> update` / `upgrade` 是转发给 pnpm 的命令，不是独立的
GitHub 最新版检查。Git 更新接口要求同一仓库目录的完整 commit 和更高版本号，
不会自动列出 Git 新版；GitHub Release tgz 也不会变成 registry 更新源。

源码依据（固定版 DSH commit `39163dd30f703a79079e2d2446545cff3c453738`）：

- 安装源：`packages/boot/plugin-manager/src/install-spec.ts:22-31,70-92`；
  CLI 转发：`apps/cli/src/args.ts:187-201`、`apps/cli/src/plugin.ts:71-98`。
- profile 默认位置：`packages/util/home-paths/src/index.ts:11-18,66-71,124-136`、
  `packages/boot/app-boot/src/profile.ts:5`。
- 更新限制和 registry 查询：`packages/boot/plugin-manager/src/index.ts:187-205,688-704,727-741,817-826`、
  `packages/boot/plugin-manager/src/versions.ts:32-55`、
  `packages/boot/plugin-manager/src/operations.ts:642-686`、
  `packages/boot/plugin-manager/src/registry.ts:39-75`。
- 界面与推荐版本：`packages/client/ui-plugin-manager/src/client/index.ts:82-90`、
  `packages/client/ui-plugin-manager/src/client/versions.tsx:230-248`、
  `packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx:530-540,759-783`、
  `packages/client/ui-plugin-manager/src/client/manager-store.ts:344-352,947-961`；
  Desktop 自身更新：`apps/desktop/src/main.ts:1043-1054,1203-1212`。
