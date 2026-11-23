# 发布 ASI 插件（asi-sense + asi-needs）

本文是负责人批准并亲自执行的操作；准备分支不会发布任何包。自 `0.2.0` 起，ASI 采用模块化双插件架构，由纯后台感官模块 `asi-sense` 与生存需求及统一侧栏模块 `asi-needs` 两个独立 DSH 组合包组成，对外分发时需同步构建、审计并发布这两个包。

先选定**一个**目标 registry：npm 公网或下文的自建 registry。发布前检查两个包名的归属、权限和版本；registry 的 404 不保证包名尚未被他人抢先注册。

## 构建和检查

在 macOS arm64 上、仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm -r publish --dry-run --no-git-checks
pnpm --filter asi-sense release:check
pnpm --filter asi-needs release:check
```

两个插件的 `release:check` 分工如下：

- `pnpm --filter asi-sense release:check`：在 macOS arm64 上构建并验证 Swift helper（`strip -S` 删除含本机构建路径的调试符号并重新 ad-hoc `codesign` 签名），生成精简 `plugins/asi-sense/dist/asi-sense-<version>.tgz` 并校验 `0.2.2-rc.3 || 0.2.2-rc.5` 启动器，再用 `npm pack --dry-run` 列出文件及大小，运行 `plugins/asi-sense/scripts/release-audit.mjs` 检查包内内容、当前用户名和意外文件，最后向目标 registry（默认 npm 公网，或通过 `ASI_RELEASE_REGISTRY` 指定）查询当前版本。仅明确的 `E404` 视为版本不存在；其他查询错误会失败。
- `pnpm --filter asi-needs release:check`：生成 TypeRT 协议产物、构建 Host/Client bundle，生成精简 `plugins/asi-needs/dist/asi-needs-<version>.tgz` 并校验包清单与 `0.2.2-rc.3 || 0.2.2-rc.5` 启动器，再用 `npm pack --dry-run` 列出文件及大小，运行 `plugins/asi-needs/scripts/release-audit.mjs` 检查白名单文件、敏感内容与当前用户名，最后同样向目标 registry（默认 npm 公网，或通过 `ASI_RELEASE_REGISTRY` 指定）查询当前版本并断言返回 `E404`（`asi-needs` 为纯 JS/CSS 组合包，打包与审计在 Linux 与 macOS 上均可运行）。检查均不读取 npm 用户配置或 token，不能验证需要认证才能读取的 registry。

发布物是精简打包产物：

- `plugins/asi-sense/dist/asi-sense-<version>.tgz`（包含 `LICENSE`、`package.json`、`cordis.patch.yml`、`lib/index.js`、`lib/asi-sense-helper`、`scripts/dsh.sh`）
- `plugins/asi-needs/dist/asi-needs-<version>.tgz`（包含 `LICENSE`、`package.json`、`cordis.patch.yml`、`lib/index.js`、`lib/client.js`、`lib/typert.host.js`、`scripts/dsh.sh`）

不要直接发布含 `workspace:*` 依赖和源码的插件源码目录。所有源码 `package.json` 均保持 `private: true`，递归发布 dry-run 应显示没有源码包可发布；只有通过各自 `release:check` 的发行 tgz 才能用于发布。检查后不要替换或修改这两个 tgz。

两套 `release-audit.mjs` 均拒绝未允许的文件、凭据形态（`npm_` / `ghp_` / `github_pat_` / `glpat-` / `xox[abprs]-` / `AIza` / `sk-` 令牌、`AKIA`/`ASIA` AWS 密钥、`-----BEGIN` 私钥头）、邮箱、本机用户名、未放行的绝对路径和 sourcemap 引用（包括内联 base64 sourcemap），逐文件扫描单字节字符串和两种字节序的 UTF-16（包括 `asi-sense-helper` 二进制中的字符串）。对必要的系统库、命令路径和非文件路径字面量仅按文件及完整匹配值显式放行（见各插件 `scripts/release-audit.mjs`）；其中 Xcode 工具链路径是构建机环境信息。审计不能识别所有秘密、压缩或其他编码，发布前仍须人工审查两个产物及白名单。

## 发布到 npm 公网

以下命令仅由负责人在确认账号、两个包名和版本后，在仓库根目录执行：

```sh
npm login --registry=https://registry.npmjs.org/
pnpm --filter asi-sense release:check
pnpm --filter asi-needs release:check

SENSE_VERSION=$(node -p "require('./plugins/asi-sense/package.json').version")
NEEDS_VERSION=$(node -p "require('./plugins/asi-needs/package.json').version")

npm publish "./plugins/asi-sense/dist/asi-sense-$SENSE_VERSION.tgz" --registry=https://registry.npmjs.org/ --access=public
npm publish "./plugins/asi-needs/dist/asi-needs-$NEEDS_VERSION.tgz" --registry=https://registry.npmjs.org/ --access=public

npm view "asi-sense@$SENSE_VERSION" version --registry=https://registry.npmjs.org/
npm view "asi-needs@$NEEDS_VERSION" version --registry=https://registry.npmjs.org/
```

在构建检查之后、发布之前若任一产物或版本变动，必须重新运行检查。`npm publish` 是不可逆的对外发布；不要在插件源码目录直接运行。

## 将用户安装源切到 registry

仅在两个目标包均已发布并验证后，由用户完全退出 Desktop；确认 CLI 与 Desktop 使用同一 `DSH_HOME`，并确保 Desktop profile 已初始化。以下示例中的版本必须替换为已验证的 registry 版本（当前为 `0.3.0`），旧 tgz 必须继续保留以备回退。先备份 profile 文件并持久设置更新源：

```sh
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
PROFILE="${DSH_HOME:-$HOME/.dsh}/profiles/desktop"
REGISTRY=https://registry.npmjs.org/
SENSE_VERSION=0.3.0
NEEDS_VERSION=0.3.0
test -f "$PROFILE/package.json" || { echo "Desktop profile 未初始化" >&2; exit 1; }
umask 077
BACKUP=$(mktemp -d "${TMPDIR:-/tmp}/asi-profile-backup.XXXXXX")
cp -p "$PROFILE/package.json" "$BACKUP/package.json"
test ! -f "$PROFILE/pnpm-lock.yaml" || cp -p "$PROFILE/pnpm-lock.yaml" "$BACKUP/pnpm-lock.yaml"
test ! -f "$PROFILE/.npmrc" || cp -p "$PROFILE/.npmrc" "$BACKUP/npmrc"
npm --prefix "$PROFILE" config set registry "$REGISTRY" --location=project
pnpm --dir "$PROFILE" config get registry
```

确认最后一行是所选 registry，再依次原位安装/替换两个插件依赖，不要 `remove`：

```sh
"$DSH" plugin --profile desktop add "asi-sense@$SENSE_VERSION"
"$DSH" plugin --profile desktop add "asi-needs@$NEEDS_VERSION"
node - "$PROFILE" "$BACKUP/package.json" "$SENSE_VERSION" "$NEEDS_VERSION" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [profileDir, backupPath, senseVer, needsVer] = process.argv.slice(2);
const current = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
const before = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
const senseSpec = current.dependencies?.['asi-sense']?.replace(/^[~^]/, '');
const needsSpec = current.dependencies?.['asi-needs']?.replace(/^[~^]/, '');
const installedSense = JSON.parse(
  fs.readFileSync(path.join(profileDir, 'node_modules/asi-sense/package.json'), 'utf8'),
).version;
const installedNeeds = JSON.parse(
  fs.readFileSync(path.join(profileDir, 'node_modules/asi-needs/package.json'), 'utf8'),
).version;
const beforeDeps = before.dependencies ?? {};
const expectedBundles = [...(before.dsh?.profile?.bundles ?? [])];
for (const name of ['asi-sense', 'asi-needs']) {
  if (!Object.hasOwn(beforeDeps, name) && !expectedBundles.some(b => (typeof b === 'string' ? b : b?.name) === name)) {
    expectedBundles.push(name);
  }
}
const currentBundles = current.dsh?.profile?.bundles ?? [];
if (
  senseSpec !== senseVer ||
  needsSpec !== needsVer ||
  installedSense !== senseVer ||
  installedNeeds !== needsVer ||
  JSON.stringify(currentBundles) !== JSON.stringify(expectedBundles)
) {
  throw new Error('安装源、实际安装版本、启用状态或 bundle 顺序不符；不要重启，先检查备份');
}
console.log('双插件 registry 依赖、已安装版本、启用状态和 bundle 顺序已核对');
NODE
```

必须显式指定版本号：实测无版本的 `add asi-sense` / `add asi-needs` 可能保留已有 `file:` 源。原位替换不删除已有依赖名；仅新增安装的依赖名会追加到 `dsh.profile.bundles` 末尾（例如从 `0.1.x` 单插件首次升级到 `0.2.0` 双插件时，`asi-sense` 原位保留原选择和顺序，`asi-needs` 追加启用）。若任一步失败，不要假定安装未变：先检查 profile、依赖和诊断，再用旧 tgz 回退并对比备份（若升级前为 `0.1.x` 单插件无旧 `asi-needs` tgz，将 `OLD_NEEDS_TGZ` 留空以移除新增的 `asi-needs`）：

```sh
OLD_SENSE_TGZ="/absolute/path/to/previous-asi-sense.tgz"
OLD_NEEDS_TGZ="/absolute/path/to/previous-asi-needs.tgz" # 若升级前为 0.1.x 单插件无此包，留空 ""
"$DSH" plugin --profile desktop add "$OLD_SENSE_TGZ"
if [ -n "$OLD_NEEDS_TGZ" ]; then
  "$DSH" plugin --profile desktop add "$OLD_NEEDS_TGZ"
else
  "$DSH" plugin --profile desktop remove asi-needs
fi
node - "$PROFILE/package.json" "$BACKUP/package.json" <<'NODE'
const fs = require('node:fs');
const [current, before] = process.argv.slice(2, 4).map(p => JSON.parse(fs.readFileSync(p, 'utf8')));
const hadNeeds = Object.hasOwn(before.dependencies ?? {}, 'asi-needs');
const needsOk = hadNeeds
  ? Boolean(current.dependencies?.['asi-needs']?.startsWith('file:'))
  : !Object.hasOwn(current.dependencies ?? {}, 'asi-needs');
if (
  !current.dependencies?.['asi-sense']?.startsWith('file:') ||
  !needsOk ||
  JSON.stringify(current.dsh?.profile?.bundles ?? []) !== JSON.stringify(before.dsh?.profile?.bundles ?? [])
) {
  throw new Error('回退后的来源或 bundle 列表不符；不要重启，先检查备份');
}
console.log('tgz 回退来源、启用状态和 bundle 顺序已核对');
NODE
```

如果核对失败，停止并保留备份供排查，不要覆盖其他用户更改。备份可能含凭据，应限制权限并按本机保密要求处理。重启 Desktop 后，左侧栏仅展示唯一的「生存需求」入口（`asi-needs`），而在「插件」管理页中可分别查看 `asi-sense` 与 `asi-needs`；只要 registry 有更新的兼容稳定版，详情会出现更新按钮并需确认。通过 tgz 回退后，不会继续自动发现 registry 更新，须再次原位切回包名安装。

`asi-sense` 与 `asi-needs` 均没有 npm 作用域，不能仅给这两个包设置 scope registry；上述命令修改此 profile 的默认 registry，可能影响其他无作用域包，但会保留其他 `.npmrc` 设置和凭据。先评估其他包和代理；如单独配置了 DSH plugin-manager 的 `registry`，其首选源也须与目标一致。一次性 `--registry` 不会持久改变重启后的更新源。

## 自建 registry 方案

若负责人无法注册或访问 npm，可另行批准在 U2 部署 Verdaccio；本任务未部署。下面是私有分发方案，不会把包同步发布到 npm。它假定 MacPro、U2 都在受控 Tailscale 网络，U2 的 Tailscale IPv4 当前为 `100.108.45.41`；部署前由负责人核实。只监听该地址，并用 Tailscale ACL/防火墙限制可访问设备。HTTP 在 Tailscale 隧道内传输；如经过其他网络，应配置 HTTPS。不要把服务暴露到公网。

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
  asi-needs:
    access: $all
    publish: $authenticated
    unpublish: $authenticated
  '**':
    access: $all
```

负责人先限制网络访问，再用 `./node_modules/.bin/verdaccio --config ./config.yaml` 启动，并从受信终端执行一次 `npm adduser --auth-type=legacy --registry=http://100.108.45.41:4873/` 创建唯一发布者。立即将 `max_users` 改为 `-1` 并重启，禁止继续注册；妥善保管 htpasswd、storage 及发布凭据并备份。默认 Verdaccio 允许公开注册，**不要**直接采用其默认权限。`access: $all` 只适合上述访问受限的内网；匿名读取是下面的版本检查所必需的。不配置 uplink 时其他包不会从 npm 代理，安装或更新其他插件可能失败；如确需代理，由负责人审查并配置独立 uplink，且 `asi-sense` 与 `asi-needs` 条目均不要配置 `proxy`。参考 [Verdaccio 配置](https://www.verdaccio.org/docs/configuration/)和[包权限](https://www.verdaccio.org/docs/packages/)。

负责人在构建机仓库根目录运行（发布操作仍需单独批准）：

```sh
REGISTRY=http://100.108.45.41:4873/
npm login --auth-type=legacy --registry="$REGISTRY"
ASI_RELEASE_REGISTRY="$REGISTRY" pnpm --filter asi-sense release:check
ASI_RELEASE_REGISTRY="$REGISTRY" pnpm --filter asi-needs release:check

SENSE_VERSION=$(node -p "require('./plugins/asi-sense/package.json').version")
NEEDS_VERSION=$(node -p "require('./plugins/asi-needs/package.json').version")

npm publish "./plugins/asi-sense/dist/asi-sense-$SENSE_VERSION.tgz" --registry="$REGISTRY" --access=public
npm publish "./plugins/asi-needs/dist/asi-needs-$NEEDS_VERSION.tgz" --registry="$REGISTRY" --access=public

npm view "asi-sense@$SENSE_VERSION" version --registry="$REGISTRY"
npm view "asi-needs@$NEEDS_VERSION" version --registry="$REGISTRY"
```

在 MacPro，负责人退出 Desktop 后，按上节备份、设置 profile `.npmrc`、依次原位迁移 `asi-sense` 与 `asi-needs` 并核对；将 `REGISTRY` 换成自建地址，并检查其他包的代理限制。重启后再检查左侧栏「生存需求」与「插件」页。凭据只由负责人在自己的终端输入和保存，不写入仓库、命令示例或聊天。

## 后续版本

1. 在分支中按兼容性选择递增的稳定 semver，同步更新 `plugins/asi-sense/package.json` 与 `plugins/asi-needs/package.json`（或本次变更涉及的目标插件）中的版本，同步安装说明中的示例版本，提交并按项目流程评审。不要修改已发布版本。
2. 在 macOS arm64 上运行 `pnpm install --frozen-lockfile`、`pnpm check`、`pnpm --filter asi-sense release:check` 与 `pnpm --filter asi-needs release:check`；检查目标 registry 上对应版本均不存在（`E404`），并审查两个发行包的文件清单与审计白名单。
3. 负责人批准后对所选 registry 发布对应 tgz，验证精确版本，再在隔离 profile 中同时验证 `asi-sense` + `asi-needs` 的包名安装、升级与双插件联动；预发布版本须在版本列表中显式选择，不会成为默认推荐。

本地无发布的 registry 机制回归验证：设置 `DSH_ROOT` 指向固定版 DSH 源码，先运行 `pnpm --filter asi-sense pack:dist`，再运行 `pnpm --filter asi-sense e2e:registry`。测试在本地只读模拟 registry 提供构建出的当前版本和临时下一 patch 版本，在独立 `DSH_HOME` 验证从 tgz 原位迁移、回退及失败后保持启用状态和顺序，更改已有私有默认源并保留其他配置，重启后断言更新按钮、确认后安装版本及无模型请求，随后关闭进程并删除临时目录；不会调用 `npm publish`。

## 宿主版本兼容与固定版 DSH 的依据

当前 `asi-sense` 与 `asi-needs` 统一声明 `engines.dsh: "0.2.2-rc.3 || 0.2.2-rc.5"`，开发构建固定针对 `0.2.2-rc.3` 源码提交 `39163dd30f703a79079e2d2446545cff3c453738` 核验以下插件管理器行为：

- CLI 的 `plugin --profile <p> add` 将参数转给 profile 内的 pnpm：`apps/cli/src/args.ts:187-201`、`apps/cli/src/plugin.ts:71-98`。
- 原位替换：`packages/boot/plugin-manager/src/operations.ts:323-326,386-387,495-505` 将同一依赖名的 add 转给 pnpm 并检查结果；`:96-107,119-125` 仅把新增依赖追加到 bundle 列表，同名依赖保留现有选择和顺序。安装失败或后置检查拒绝时不应假定所有文件都未变（`:289-301,544-563`），所以步骤中保留备份和核对。
- 更新只接受 profile 中以自身包名安装的 registry 依赖：`packages/boot/plugin-manager/src/index.ts:187-205`。打开详情触发检查（`packages/client/ui-plugin-manager/src/client/versions.tsx:230-248`）；Host 使用 `pnpm view` 查询更新版本和每版的 manifest（`packages/boot/plugin-manager/src/index.ts:688-724,897-905`）。
- 更新检查需要 `name`、有效的更高 semver、`dsh.bundle` 对象，以及通过兼容检查的 `engines.dsh`（若声明该字段则优先于 DSH peers）；bundle 的 `patch` 必须指向存在的文件。`dsh.bundle.platforms` 是 DSH 的主机平台检查；npm 的 `os`/`cpu` 和 Node `engines` 由包管理器处理，不是这个版本列表兼容检查的字段：`packages/boot/plugin-manager/src/versions.ts:8-9,38-79`、`packages/boot/app-boot/src/plugin-compatibility.ts:55-80`、`packages/boot/app-boot/src/profile.ts:54-70,695-702`、`packages/boot/app-boot/src/bundle-platform.ts:27-34`。
- 推荐按钮选择最新的非预发布、未弃用、兼容 bundle；也可在版本列表手选可安装的预发布版。确认后 DSH 检查并安装精确版本，失败时尝试恢复旧版本：`packages/client/ui-plugin-manager/src/client/manager-store.ts:344-361,952-966`、`packages/client/ui-plugin-manager/src/client/versions.tsx:131-155`、`packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx:759-783`、`packages/boot/plugin-manager/src/index.ts:727-805,860-874`。
- registry 配置：`packages/boot/plugin-manager/src/operations.ts:642-657,660-686` 在 profile 目录调用 `pnpm config get registry` 和 `pnpm view`，无显式 registry 时遵循 pnpm 的 `.npmrc` 链及 workspace 配置；`index.ts:327-336,383-387,612-617,688-704` 和 `registry.ts:39-75` 定义 DSH 自身首选 registry 与 fallback，私有默认源不会自动回退到公网。`asi-sense` 与 `asi-needs` 均为无作用域包，作用域 registry 对它们不适用；DSH 未单独解析各 scope 的 registry，其他 scoped 包的最终选择仍由 pnpm 决定。
