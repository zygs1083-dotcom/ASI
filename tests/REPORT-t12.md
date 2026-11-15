verdict: pass

# T12 最终打包与 magpie 网关冒烟报告

结论：自动检查、完整 E2E、打包版 faux 对话及获准的真实网关模型测试、对话与中止均通过。
本次未发现 blocker、should-fix 或 nit 级问题；以下结论仅覆盖所列测试范围。

## 环境与基线

- 基线：`hub/main` `716cfe13b8612b47f4aa5298bc2928c0ada94a7f`；
  macOS arm64、Node 26.13.0、npm 11.20.0、Electron 45.3.2。
- `npm ci --offline --ignore-scripts --no-audit --no-fund` 退出码 0，安装 561 个包。
  为遵守联网边界，未运行默认联网安装或安装脚本；Electron 45.3.2 从本机缓存的
  `electron-v45.3.2-darwin-arm64.zip` 解压到 `node_modules/electron/dist`。
  npm 报告若干依赖弃用警告，未运行联网 audit。
- 自动化和 faux 使用 `ASI_FAUX=1` 与临时数据目录。真实网关测试使用独立临时目录、
  未设置 `ASI_FAUX`，仅使用获准的 `http://127.0.0.1:3425/v1` 和占位 key；
  没有读取 magpie 配置或使用真实 key。

## 检查与打包

| 命令 | 实际结果 |
| --- | --- |
| `npm run check` | 退出码 0；typecheck、Biome 通过；Node 312 条、renderer 67 条，共 379 条通过。 |
| `npm run e2e -- --workers=2` | 退出码 0；24 通过、0 失败、0 跳过，25.0 秒；无需修复测试。 |
| `npm run dist:mac` | 退出码 0；生成 arm64 DMG 和 app；配置为不签名，使用默认 Electron 图标。 |

- DMG：`dist/ASI-0.1.0-arm64.dmg`，137492235 字节（约 131 MiB）；
  SHA-256 `a2b47f64013f8a244cb1dd00a3e7d12a272cea7be0d5bed04bb5041123296999`。
  `dist/mac-arm64/ASI.app` 约 371 MiB；打包产物未提交。
- 打包版 faux：通过 Playwright `_electron.launch({ executablePath })` 启动生成的 app，
  `app.isPackaged === true`，renderer 加载 `file://.../app.asar/out/renderer/index.html`。
  选择 `faux-chat`、发送“你好”，885 ms 后 `data-status=done`，回复“你好，我是测试模型。”；
  app 已关闭，临时数据目录已删除。
- 10 张 E2E 截图及 2 张真实网关截图均为 1100×720，存于仅含截图的孤立分支
  `shots/t12`，提交 `eea2a488b409951f73d5d5daf376a02c3883794b`，已 push hub。
  人工检查浅色流式、真实对话和真实厂商页截图；未与 magpie 实物逐像素对照。

## magpie 网关真实冒烟

使用上述打包 app、独立新建临时 `ASI_DATA_DIR`，`app.isPackaged === true`。
只执行 1 次模型测试和 2 条对话消息，均未超过授权上限。

| 步骤 | 实际结果 |
| --- | --- |
| 添加厂商 | 保存 OpenAI 兼容厂商 `magpie 本机`、指定 URL、`codex/gpt-6-astra` 和指定占位 key 成功；列表显示“已设置 Key”，重新编辑时 key 输入框为空。 |
| 模型测试 | `✓ 3632ms`。 |
| 普通对话 | 发送“用一句话介绍你自己”，5379 ms 后 `done`；完整回复（不足 80 字）：“我是 Codex，一个能帮你理解问题、编写代码并推动任务完成的 AI 助手。” |
| 流式中止 | 发送“从 1 数到 200，每个数字一行”；观察到 `streaming` 和部分可见文本“1 2 3”后点击 stop，最终状态 `aborted`，部分文本保留。 |
| 截图 | `magpie-chat-light.png`、`magpie-provider-light.png` 均已保存到 `shots/t12`；厂商页仅显示已保存状态，不回显 key。 |
| 明文扫描 | `safeStorage.isEncryptionAvailable() === true`；关闭 app 后扫描临时目录下 60 个常规文件，0 个包含占位 key 明文。 |
| 清理 | app 已关闭，两次冒烟产生的临时数据目录均已删除。 |

## 未验证

- 未以默认联网及启用安装脚本的方式运行 `npm ci`，也未运行依赖安全 audit。
- 未验证默认用户数据目录、签名/公证、DMG 安装及 Gatekeeper；E2E 外链测试使用 stub。
- 真实模型只验证上述一次测试和两条消息；不代表其他模型或后续网关状态。
