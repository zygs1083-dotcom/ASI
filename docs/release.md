# 发布 ASI 插件（统一单包 `asi`）

本文是负责人批准并亲自执行的操作；准备分支不会发布任何包。自 `0.6.0` 起，ASI 将原有的五个拆分插件合并收敛为**唯一 DSH 组合包 `asi`**（在左侧栏仅注册唯一入口 `id: 'asi'`，`order: 90`），对外分发时只需构建、审计并发布这一个包。

先选定**一个**目标 registry：npm 公网或下文的自建 registry。发布前检查 `asi` 包名的归属、权限和版本；registry 的 404 不保证包名尚未被他人抢先注册。

## 构建和检查

在 macOS arm64 上、仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm run e2e
pnpm -r publish --dry-run --no-git-checks
pnpm --filter asi release:check
```

`pnpm --filter asi release:check` 执行完整流水线：

- 生成 TypeRT 协议产物（`AsiRemote`）并打包 Host/Client bundle；在 macOS `arm64` 上编译 Swift helper（`strip -S` 删除含本机构建路径的调试符号并重新 ad-hoc `codesign` 签名），生成精简 `plugins/asi/dist/asi-<version>.tgz` 并通过 `pack-verify.mjs` 校验 Mach-O `arm64` 架构、签名、包清单及 `0.2.2-rc.3 || 0.2.2-rc.5` 启动器（在 Linux 开发机上运行 `release:check` 时执行纯 JS/CSS 清单、启动器、敏感内容审计与 registry 检查，最终对外发布包必须在 macOS `arm64` 上构建以包含 `lib/asi-sense-helper`）；
- 使用 `npm pack --dry-run` 列出文件及大小，运行 `plugins/asi/scripts/release-audit.mjs` 逐字节（含单字节与双字节序 UTF-16）扫描文件白名单、凭据形态、邮箱、本机用户名、未放行绝对路径与 sourcemap；
- 向目标 registry（默认 npm 公网，或通过 `ASI_RELEASE_REGISTRY` 指定）查询 `asi@<version>`，仅明确的 `E404` 视为版本可发布。

唯一发布物是精简打包产物：

- `plugins/asi/dist/asi-<version>.tgz`（包含 `LICENSE`、`package.json`、`cordis.patch.yml`、`lib/index.js`、`lib/client.js`、`lib/typert.host.js`、`lib/asi-sense-helper`、`scripts/dsh.sh`）

不要直接发布含 `workspace:*` 依赖和源码的插件源码目录。所有源码 `package.json` 均保持 `private: true`，递归发布 dry-run 应显示没有源码包可发布；只有通过 macOS `arm64` 上 `release:check` 的 `asi-<version>.tgz` 才能用于正式发布。

## 发布到 npm 公网

以下命令仅由负责人在确认账号、`asi` 包名和版本后，在 macOS `arm64` 仓库根目录执行：

```sh
npm login --registry=https://registry.npmjs.org/
pnpm --filter asi release:check

ASI_VERSION=$(node -p "require('./plugins/asi/package.json').version")
npm publish "./plugins/asi/dist/asi-$ASI_VERSION.tgz" --registry=https://registry.npmjs.org/ --access=public
npm view "asi@$ASI_VERSION" version --registry=https://registry.npmjs.org/
```

`npm publish` 是不可逆的对外发布；不要在插件源码目录直接运行。

## 将用户 Desktop Profile 迁移/切到单包 `asi`（保留 `dsh-context` 与 `dsh-superagent`）

仅在目标包已发布并验证后，由用户完全退出 Desktop；确认 CLI 与 Desktop 使用同一 `DSH_HOME`，并确保 Desktop profile 已初始化。以下流程同时兼容「从 `0.5.0` 五个拆分 `asi-*` 包迁移至单包 `asi@0.6.0`」与「后续 `asi` 原位版本升级」，且严格原样保留 profile 中既有的 `dsh-context`、`dsh-superagent` 等非 ASI 插件依赖与启用顺序。先备份 profile 文件并持久设置更新源：

```sh
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
PROFILE="${DSH_HOME:-$HOME/.dsh}/profiles/desktop"
REGISTRY=https://registry.npmjs.org/
ASI_VERSION=0.6.0
test -f "$PROFILE/package.json" || { echo "Desktop profile 未初始化" >&2; exit 1; }
umask 077
BACKUP=$(mktemp -d "${TMPDIR:-/tmp}/asi-profile-backup.XXXXXX")
cp -p "$PROFILE/package.json" "$BACKUP/package.json"
test ! -f "$PROFILE/pnpm-lock.yaml" || cp -p "$PROFILE/pnpm-lock.yaml" "$BACKUP/pnpm-lock.yaml"
test ! -f "$PROFILE/.npmrc" || cp -p "$PROFILE/.npmrc" "$BACKUP/npmrc"
npm --prefix "$PROFILE" config set registry "$REGISTRY" --location=project
pnpm --dir "$PROFILE" config get registry
```

确认最后一行是所选 registry，清理已退役的旧版拆分 `asi-*` 包（若存在），安装 `asi@$ASI_VERSION` 并核对非 ASI 既有插件完整性与 bundle 列表：

```sh
for legacy_pkg in asi-growth asi-care asi-sleep asi-needs asi-sense; do
  if node -e "process.exit(Object.hasOwn(require(process.argv[1]).dependencies ?? {}, process.argv[2]) ? 0 : 1)" "$PROFILE/package.json" "$legacy_pkg"; then
    "$DSH" plugin --profile desktop remove "$legacy_pkg"
  fi
done
"$DSH" plugin --profile desktop add "asi@$ASI_VERSION"
node -e '
const fs = require("node:fs");
const [pkgPath, bakPath] = process.argv.slice(1);
const cur = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const bak = JSON.parse(fs.readFileSync(bakPath, "utf8"));
const leg = ["asi-sense", "asi-needs", "asi-sleep", "asi-care", "asi-growth"];
const nameOf = (b) => (typeof b === "string" ? b : b?.name);
const hadAsi = Object.hasOwn(bak.dependencies ?? {}, "asi");
const hadLeg = leg.some((n) => Object.hasOwn(bak.dependencies ?? {}, n));
const anyEnabledLeg = (bak.dsh?.profile?.bundles ?? []).some((b) => leg.includes(nameOf(b)));
if (!hadAsi && hadLeg && !anyEnabledLeg && Array.isArray(cur.dsh?.profile?.bundles)) {
  cur.dsh.profile.bundles = cur.dsh.profile.bundles.filter((b) => nameOf(b) !== "asi");
  fs.writeFileSync(pkgPath, JSON.stringify(cur, null, 2) + "\n");
}
' "$PROFILE/package.json" "$BACKUP/package.json"
node - "$PROFILE" "$BACKUP/package.json" "$ASI_VERSION" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [profileDir, backupPath, expectedVer] = process.argv.slice(2);
const current = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
const before = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
const legacyNames = new Set(['asi-sense', 'asi-needs', 'asi-sleep', 'asi-care', 'asi-growth']);
const allAsiNames = new Set(['asi', ...legacyNames]);
const beforeDeps = before.dependencies ?? {};
const currentDeps = current.dependencies ?? {};

for (const [depName, depSpec] of Object.entries(beforeDeps)) {
  if (!allAsiNames.has(depName) && currentDeps[depName] !== depSpec) {
    throw new Error(`非 ASI 既有依赖被意外改动或丢失: ${depName}`);
  }
}
for (const legacy of legacyNames) {
  if (Object.hasOwn(currentDeps, legacy)) {
    throw new Error(`旧版拆分插件依赖未清理干净: ${legacy}`);
  }
}

const spec = currentDeps.asi?.replace(/^[~^]/, '');
const installedVer = JSON.parse(
  fs.readFileSync(path.join(profileDir, 'node_modules', 'asi', 'package.json'), 'utf8'),
).version;
if (!expectedVer || spec !== expectedVer || installedVer !== expectedVer) {
  throw new Error('asi 安装源或实际安装版本不符；不要重启，先检查备份');
}

const bundleNameOf = (b) => (typeof b === 'string' ? b : b?.name);
const beforeBundles = before.dsh?.profile?.bundles ?? [];
const currentBundles = current.dsh?.profile?.bundles ?? [];
if (currentBundles.some((b) => legacyNames.has(bundleNameOf(b)))) {
  throw new Error('dsh.profile.bundles 中仍残留旧版拆分 asi-* 条目');
}

const hadAsiDep = Object.hasOwn(beforeDeps, 'asi');
const hadLegacyDeps = [...legacyNames].some((n) => Object.hasOwn(beforeDeps, n));
const hadAnyEnabledLegacy = beforeBundles.some((b) => legacyNames.has(bundleNameOf(b)));
const expectedBundles = beforeBundles.filter((b) => !legacyNames.has(bundleNameOf(b)));
if (!hadAsiDep && (!hadLegacyDeps || hadAnyEnabledLegacy)) {
  if (!expectedBundles.some((b) => bundleNameOf(b) === 'asi')) {
    expectedBundles.push('asi');
  }
}
if (JSON.stringify(currentBundles) !== JSON.stringify(expectedBundles)) {
  throw new Error('安装源、启用状态或非 ASI bundle 顺序不符；不要重启，先检查备份');
}
console.log('单包 asi 依赖、已安装版本、旧版拆分包清理、既有插件保留与 bundle 顺序已核对');
NODE
```

若任一步失败，不要假定安装未变：先移除半途安装的包，再用旧版 tgz（单包 `asi` 旧版 tgz 或 `0.5.0` 五个拆分 tgz）回退并核对备份：

```sh
OLD_ASI_TGZ="" # 若升级前已是单包 asi，填旧版 asi tgz 绝对路径；若升级前为 0.5.0 五插件，留空 ""
OLD_SENSE_TGZ="/absolute/path/to/previous-asi-sense-0.5.0.tgz"
OLD_NEEDS_TGZ="/absolute/path/to/previous-asi-needs-0.5.0.tgz"
OLD_SLEEP_TGZ="/absolute/path/to/previous-asi-sleep-0.5.0.tgz"
OLD_CARE_TGZ="/absolute/path/to/previous-asi-care-0.5.0.tgz"
OLD_GROWTH_TGZ="/absolute/path/to/previous-asi-growth-0.5.0.tgz"

if [ -n "$OLD_ASI_TGZ" ]; then
  "$DSH" plugin --profile desktop add "$OLD_ASI_TGZ"
else
  "$DSH" plugin --profile desktop remove asi || true
  for pair in "asi-sense:$OLD_SENSE_TGZ" "asi-needs:$OLD_NEEDS_TGZ" "asi-sleep:$OLD_SLEEP_TGZ" "asi-care:$OLD_CARE_TGZ" "asi-growth:$OLD_GROWTH_TGZ"; do
    pkg_name="${pair%%:*}"
    pkg_tgz="${pair#*:}"
    if [ -n "$pkg_tgz" ]; then
      "$DSH" plugin --profile desktop add "$pkg_tgz"
    else
      "$DSH" plugin --profile desktop remove "$pkg_name" || true
    fi
  done
fi
node -e '
const fs = require("node:fs");
const [pkgPath, bakPath] = process.argv.slice(1);
const cur = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const bak = JSON.parse(fs.readFileSync(bakPath, "utf8"));
if (bak.dsh?.profile?.bundles) {
  cur.dsh = { ...cur.dsh, profile: { ...cur.dsh?.profile, bundles: bak.dsh.profile.bundles } };
  fs.writeFileSync(pkgPath, JSON.stringify(cur, null, 2) + "\n");
}
' "$PROFILE/package.json" "$BACKUP/package.json"

node - "$PROFILE/package.json" "$BACKUP/package.json" <<'NODE'
const fs = require('node:fs');
const [current, before] = process.argv.slice(2, 4).map((p) => JSON.parse(fs.readFileSync(p, 'utf8')));
const beforeDeps = before.dependencies ?? {};
const currentDeps = current.dependencies ?? {};
const allAsiNames = new Set(['asi', 'asi-sense', 'asi-needs', 'asi-sleep', 'asi-care', 'asi-growth']);

for (const [depName, depSpec] of Object.entries(beforeDeps)) {
  if (!allAsiNames.has(depName) && currentDeps[depName] !== depSpec) {
    throw new Error(`回退后非 ASI 既有依赖不符: ${depName}`);
  }
}
for (const name of allAsiNames) {
  const expectedPresent = Object.hasOwn(beforeDeps, name);
  const actualSpec = currentDeps[name];
  if (expectedPresent ? !actualSpec?.startsWith('file:') : Object.hasOwn(currentDeps, name)) {
    throw new Error(`回退后 ${name} 依赖来源不符；不要重启，先检查备份`);
  }
}
if (JSON.stringify(current.dsh?.profile?.bundles ?? []) !== JSON.stringify(before.dsh?.profile?.bundles ?? [])) {
  throw new Error('回退后的 bundle 列表或顺序不符；不要重启，先检查备份');
}
console.log('tgz 回退来源、既有插件保留、启用状态和 bundle 顺序已核对');
NODE
```

重启 Desktop 后，左侧栏仅展示唯一「ASI 稳态」（`asi`）面板入口，在「插件」管理页中可查看 `asi`（以及原样保留的 `dsh-context` / `dsh-superagent`），且 `~/.dsh/data/asi-*` 中的既有记忆库与技能已无损自动迁移至 `~/.dsh/data/asi/`。

## 自建 registry 方案

若采用受控 Tailscale 内网 Verdaccio（例如 U2 `100.108.45.41:4873`），在 `config.yaml` 中配置单一 `asi` 包权限：

```yaml
storage: ./storage
listen: 100.108.45.41:4873
auth:
  htpasswd:
    file: ./htpasswd
    max_users: -1
uplinks: {}
packages:
  asi:
    access: $all
    publish: $authenticated
    unpublish: $authenticated
  '**':
    access: $all
```

在 macOS `arm64` 构建机仓库根目录运行（发布操作仍需负责人单独批准）：

```sh
REGISTRY=http://100.108.45.41:4873/
npm login --auth-type=legacy --registry="$REGISTRY"
ASI_RELEASE_REGISTRY="$REGISTRY" pnpm --filter asi release:check

ASI_VERSION=$(node -p "require('./plugins/asi/package.json').version")
npm publish "./plugins/asi/dist/asi-$ASI_VERSION.tgz" --registry="$REGISTRY" --access=public
npm view "asi@$ASI_VERSION" version --registry="$REGISTRY"
```

本地无发布的 registry 机制回归验证：在固定版 DSH 源码检出下设置 `DSH_ROOT`，先运行 `pnpm --filter asi pack:dist`，再运行 `pnpm --filter asi e2e:registry`。

## 宿主版本兼容与固定版 DSH 的依据

`asi` 声明 `engines.dsh: "0.2.2-rc.3 || 0.2.2-rc.5"`，开发构建固定针对 `0.2.2-rc.3` 源码提交 `39163dd30f703a79079e2d2446545cff3c453738` 核验插件管理器行为（`apps/cli/src/plugin.ts`、`packages/boot/plugin-manager/src/operations.ts`、`packages/boot/plugin-manager/src/versions.ts`、`packages/boot/app-boot/src/plugin-compatibility.ts`）。
