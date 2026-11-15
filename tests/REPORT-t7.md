# T7 修复后集成复测报告

基线：`7d36c4d`（`hub/main`）；macOS arm64，Electron 45.3.2，Node 26.13.0。
测试均使用 `ASI_FAUX=1` 和临时 `ASI_DATA_DIR`，未使用真实 API Key 或生产环境。
依赖通过 `npm ci --offline --ignore-scripts --no-audit --no-fund` 从本地缓存安装，
Electron 二进制从本地缓存解压；打包工具按批准联网下载。

## 执行结果

| 命令 | 结果 |
| --- | --- |
| `npm run check` | 退出码 0；typecheck、Biome 通过；node 侧 231 条、renderer 侧 47 条，共 278 条通过。 |
| 修复前 `npm run e2e -- --workers=2` | 退出码 1；20 通过、1 失败、0 跳过（26.5 秒）。 |
| 修复后 `npm run e2e -- --workers=2` | 退出码 0；24 通过、0 失败、0 跳过（20.9 秒）。 |
| `npm run dist:mac` | 退出码 0；arm64 DMG 和 app 已生成，未签名。 |

唯一的初次完整 E2E 失败是测试代码问题：`tests/e2e/smoke.spec.ts` 的 preload API
白名单未包含契约新增的 `chat.retry`，实际 API 正确包含该方法；补入期望后相关
smoke 2/2 通过，再跑完整套件通过。没有发现完整套件中“重跑即过”的不稳定用例。

新增用例开发时，重试测试第一次因 Playwright 主进程 `evaluate` 不支持动态
`import()` 而失败；改用 Node `createRequire` 访问同一个 pi-ai 注册表后通过。
这属于测试构造问题，不是产品故障，也不是重跑即过。

## 新增覆盖

- `tests/e2e/chat.spec.ts`：`/error` 出错后点击重试，最终 assistant 为 `done`，
  原用户消息只有一条。由于 faux 对 `/error` 每次都固定报错，测试在第一次报错后
  在主进程替换 faux 响应为成功，模拟上游恢复；不修改产品代码。
- `tests/e2e/persistence.spec.ts`：`/slow` 流式中停止，关闭并用同一数据目录重启，
  原会话中的回复仍为 `aborted`，不是 `streaming`。
- `tests/e2e/security.spec.ts`：assistant Markdown 的 HTTPS 链接点击后，stub 记录到
  `shell.openExternal`，应用 URL 不变且没有新应用窗口。
- `tests/e2e/smoke.spec.ts`：API 白名单补充 `chat.retry`。

## 产品缺陷与不稳定项

- **nit** `src/renderer/views/ChatView.tsx:40-45`、`:56-61`：错误/中止后的重试按钮
  没有 `data-testid`。复现：发送 `/error` 或中止 `/slow` 后检查“重试”按钮；
  测试使用 `getByRole('button', { name: '重试' })`。功能通过，仅影响测试锚点一致性。
- 本轮未发现 blocker 或 should-fix；未发现完整 E2E 不稳定用例。

## 截图和打包

- 10 张截图均为 1100×720，孤立分支 `shots/t7` 仅含 PNG，提交
  `2242f8b690600955118bc839367f61783fa2bc9a`。流式浅色截图中光标紧接正文末尾。
- DMG：`dist/ASI-0.1.0-arm64.dmg`，137473847 字节（约 131 MiB）；
  SHA-256 `9272d16d975fcdb478635ab44f2f9bf4c976b2970a0b2f59d84a37ef82a5b3a8`。
  `dist/mac-arm64/ASI.app` 约 371 MiB；DMG 不提交。
- 打包版 Playwright `_electron.launch({ executablePath })` 冒烟通过：临时数据目录、
  faux 模型发送“你好”后回复为 `done`；`app.isPackaged === true`，即使设置
  `ELECTRON_RENDERER_URL=http://127.0.0.1:9/`，窗口仍加载 `file://.../app.asar/out/renderer/index.html`。

## 未验证

未验证真实厂商或外部网络连通、系统浏览器实际打开、签名/公证和安装后 Gatekeeper；
外链只验证 stub 调用及应用窗口边界。未模拟进程在仍为 `streaming` 时意外崩溃后的
启动恢复；重启用例验证的是用户中止后的持久化。截图不包含 macOS 原生窗口装饰，
本轮未与 magpie 实物做逐像素或深色主题对照。
