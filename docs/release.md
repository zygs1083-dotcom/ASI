# 发布 asi-sense

本文是负责人批准并亲自执行的操作；准备分支不会发布任何包。先选定**一个**
目标 registry：npm 公网或下文的自建 registry。发布前检查包名归属、权限和版本；
registry 的 404 不保证包名尚未被他人抢先注册。

## 构建和检查

在 macOS arm64 上、仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm --filter asi-sense release:check
```

`release:check` 构建并验证 Swift helper、签名和精简 tgz，再用
`npm pack --dry-run` 列出文件及大小，检查包内路径、当前用户名和意外文件，
最后向 npm 公网查询当前版本。仅明确的 E404 视为版本不存在；其他查询错误会失败。
检查不读取 npm 用户配置或 token，不能验证需要认证才能读取的 registry。

发布物是 `plugins/asi-sense/dist/asi-sense-<version>.tgz`，而不是含 workspace
依赖和源码的插件源码目录。包包含 MIT LICENSE；helper 构建时删除含本机构建路径的
调试符号并重新 ad-hoc 签名。`npm pack` 清单及源码不会进入发行包。

## 发布到 npm 公网

以下命令仅由负责人在确认账号、名称和版本后执行：

```sh
npm login --registry=https://registry.npmjs.org/
pnpm --filter asi-sense release:check
VERSION=$(node -p "require('./plugins/asi-sense/package.json').version")
cd plugins/asi-sense/dist
npm publish "./asi-sense-$VERSION.tgz" --registry=https://registry.npmjs.org/ --access=public
npm view "asi-sense@$VERSION" version --registry=https://registry.npmjs.org/
```

在构建检查之后、发布之前若产物或版本变动，重新运行检查。`npm publish` 是
不可逆的对外发布；不要在源码目录直接运行。

## 将用户安装源切到 registry

仅在目标包已经发布并验证后，由用户完全退出 Desktop；确认 CLI 与 Desktop 使用同一
`DSH_HOME`，并确保 Desktop profile 已初始化。公网示例：

```sh
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile desktop remove asi-sense
"$DSH" plugin --profile desktop add asi-sense --registry=https://registry.npmjs.org/
```

先卸载是为了将原 `file:` tgz 依赖换成同名 registry 依赖。安装失败时不要假定旧包
仍然存在：可用保留的旧 tgz 重新 `add`，确认原因后再试。重启 Desktop 后，在「插件」
页进入 asi-sense；只要 registry 有更新的兼容稳定版，详情会出现更新按钮，并需确认。
通过 tgz 回退后，不会继续自动发现 registry 更新，须再次切回包名安装。

## 自建 registry 方案

若负责人无法注册或访问 npm，可另行批准在 U2 部署 Verdaccio；本任务未部署。
下面是私有分发方案，不会把包同步发布到 npm。它假定 MacPro、U2 都在受控
Tailscale 网络，U2 的 Tailscale IPv4 当前为 `100.108.45.41`；部署前由负责人核实。
只监听该地址，并用 Tailscale ACL/防火墙限制可访问设备。HTTP 在 Tailscale 隧道内传输；
如经过其他网络，应配置 HTTPS。不要把服务暴露到公网。

负责人在 U2 新的专用目录安装已固定版本的 Verdaccio，并创建 `config.yaml`：

```sh
mkdir -p "$HOME/asi-registry"
cd "$HOME/asi-registry"
npm init -y
npm install --save-exact verdaccio@6.6.0
```

```yaml
storage: ./storage
listen: 100.108.45.41:4873
auth:
  htpasswd:
    file: ./htpasswd
    max_users: 1
uplinks: {}
packages:
  asi-sense:
    access: $all
    publish: $authenticated
    unpublish: $authenticated
  '**':
    access: $all
```

负责人先限制网络访问，再用 `./node_modules/.bin/verdaccio --config ./config.yaml`
启动，并从受信终端执行一次
`npm adduser --auth-type=legacy --registry=http://100.108.45.41:4873/` 创建唯一发布者。
立即将 `max_users` 改为 `-1` 并重启，禁止继续注册；妥善保管 htpasswd、storage
及发布凭据并备份。默认 Verdaccio 允许公开注册，**不要**直接采用其默认权限。
`access: $all` 只适合上述访问受限的内网；匿名读取是下面的版本检查所必需的。
不配置 uplink 时其他包不会从 npm 代理，安装或更新其他插件可能失败；如确需代理，
由负责人审查并配置独立 uplink，且 `asi-sense` 条目不要配置 `proxy`。
参考 [Verdaccio 配置](https://www.verdaccio.org/docs/configuration/)和
[包权限](https://www.verdaccio.org/docs/packages/)。

负责人在构建机运行（发布操作仍需单独批准）：

```sh
REGISTRY=http://100.108.45.41:4873/
npm login --auth-type=legacy --registry="$REGISTRY"
ASI_RELEASE_REGISTRY="$REGISTRY" pnpm --filter asi-sense release:check
VERSION=$(node -p "require('./plugins/asi-sense/package.json').version")
cd plugins/asi-sense/dist
npm publish "./asi-sense-$VERSION.tgz" --registry="$REGISTRY" --access=public
npm view "asi-sense@$VERSION" version --registry="$REGISTRY"
```

在 MacPro，负责人在退出 Desktop 后，**手工**在 Desktop 实际使用的
`$DSH_HOME/profiles/desktop/.npmrc` 中设置 `registry=http://100.108.45.41:4873/`
（未设置 `DSH_HOME` 时为 `~/.dsh/profiles/desktop/.npmrc`）；不要覆盖已有内容或
凭据。然后按上节 remove/add，将 add 的 `--registry` 换成此地址，重启并检查「插件」
页。安装时的一次性 `--registry` 不会永久设置重启后的更新源；profile 配置须保持。
这会改变该 profile 中其他**未限定作用域**包的默认 registry，需考虑上面的代理限制。
如另设 DSH plugin-manager 的 `registry`，它优先作为管理页的首选源，应与之保持一致。
凭据只由负责人在自己的终端输入和保存，不写入仓库、命令示例或聊天。

## 后续版本

1. 在分支中按兼容性选择递增的稳定 semver，更新插件 `package.json` 中的版本；
   同步安装说明中的示例版本，提交并按项目流程评审。不要修改已发布版本。
2. 在 macOS arm64 上运行 `pnpm install --frozen-lockfile`、`pnpm check` 和
   `release:check`；检查目标 registry 的版本不存在，并审查文件清单。
3. 负责人批准后对所选 registry 发布该 tgz，验证精确版本，再在隔离 profile 中验证
   包名安装和更新；预发布版本须在版本列表中显式选择，不会成为默认推荐。

本地无发布的回归验证：设置 `DSH_ROOT` 指向固定版 DSH 源码，先运行
`pnpm --filter asi-sense pack:dist`，再运行 `pnpm --filter asi-sense e2e:registry`。
测试在本地只读模拟 registry 提供构建出的当前版本和临时下一 patch 版本，
在独立 `DSH_HOME` 用包名安装，断言更新按钮、确认后安装版本及无模型请求，
随后关闭进程并删除临时目录；不会调用 `npm publish`。
在固定版 DSH 上已实测 `0.1.2 → 0.1.3`：profile `.npmrc` 指向模拟 registry，
页面出现 `Update to 0.1.3`，确认后磁盘中的插件版本为 `0.1.3`。
测试用稳定版本才能触发默认推荐；`0.1.3` 只存在于临时模拟数据。

## 固定版 DSH 的依据

固定版 `39163dd30f703a79079e2d2446545cff3c453738`：

- CLI 的 `plugin --profile <p> add` 将参数转给 profile 内的 pnpm：
  `apps/cli/src/args.ts:187-201`、`apps/cli/src/plugin.ts:71-98`。
- 更新只接受 profile 中以自身包名安装的 registry 依赖：
  `packages/boot/plugin-manager/src/index.ts:187-205`。打开详情触发检查
  (`packages/client/ui-plugin-manager/src/client/versions.tsx:230-248`)；
  Host 使用 `pnpm view` 查询更新版本和每版的 manifest
  (`packages/boot/plugin-manager/src/index.ts:688-724,897-905`)。
- 更新检查需要 `name`、有效的更高 semver、`dsh.bundle` 对象，以及通过兼容检查的
  `engines.dsh`（若声明该字段则优先于 DSH peers）；bundle 的 `patch` 必须指向存在的
  文件。`dsh.bundle.platforms` 是 DSH 的主机平台检查；npm 的 `os`/`cpu` 和 Node
  `engines` 由包管理器处理，不是这个版本列表兼容检查的字段：
  `packages/boot/plugin-manager/src/versions.ts:8-9,38-79`、
  `packages/boot/app-boot/src/plugin-compatibility.ts:55-80`、
  `packages/boot/app-boot/src/profile.ts:54-70,695-702`、
  `packages/boot/app-boot/src/bundle-platform.ts:27-34`。
- 推荐按钮选择最新的非预发布、未弃用、兼容 bundle；也可在版本列表手选可安装的
  预发布版。确认后 DSH 检查并安装精确版本，失败时尝试恢复旧版本：
  `packages/client/ui-plugin-manager/src/client/manager-store.ts:344-361,952-966`、
  `packages/client/ui-plugin-manager/src/client/versions.tsx:131-155`、
  `packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx:759-783`、
  `packages/boot/plugin-manager/src/index.ts:727-805,860-874`。
- registry 配置：`packages/boot/plugin-manager/src/operations.ts:642-657,660-686`
  在 profile 目录调用 `pnpm config get registry` 和 `pnpm view`，无显式 registry
  时遵循 pnpm 的 `.npmrc` 链及 workspace 配置；`index.ts:327-336,383-387,612-617,688-704`
  和 `registry.ts:39-75` 定义 DSH 自身首选 registry 与 fallback，私有默认源不会
  自动回退到公网。本任务对 profile `.npmrc` 的自定义默认 registry 完成包名安装、
  页面查询和更新实测。`asi-sense` 是无作用域包，作用域 registry 对它不适用；
  DSH 未单独解析各 scope 的 registry，其他 scoped 包的最终选择仍由 pnpm 决定，
  本任务未实测其与 DSH 显式 `--registry` 的优先级。
