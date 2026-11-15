verdict: fix

# T10 最终集成、打包与网关冒烟报告

结论：自动化检查及 faux 打包冒烟通过；真实网关返回 401，按任务要求停止真实对话，
因此无法验证真实流式回复与中止。`fix` 指真实网关验证尚受阻，**不认定为 ASI 产品缺陷**。

## 环境与基线

- 基线：`hub/main` 的 `13c5bcc949c09f3a1993596c7b5e63251f9c8199`，macOS arm64、
  Node 26.13.0、npm 11.20.0、Electron 45.3.2。
- `npm ci --offline --ignore-scripts --no-audit --no-fund` 退出码 0，安装 561 个包；
  为避免安装脚本联网，Electron 45.3.2 从本机已有缓存解压到 `node_modules/electron/dist`。
  本次没有以启用安装脚本的默认方式执行 `npm ci`。
- 自动化测试与 faux 冒烟使用临时数据目录和 `ASI_FAUX=1`；真实冒烟只使用获准的
  `http://127.0.0.1:3425/v1` 和非真实 key 占位值，没有读取 magpie 配置或真实 key。

## 检查、E2E 与打包

| 命令 | 实际结果 |
| --- | --- |
| `npm run check` | 退出码 0；typecheck 和 Biome 通过；主进程/Node 277 条、renderer 56 条，共 333 条通过。 |
| `npm run e2e -- --workers=2` | 退出码 0；24 通过、0 失败、0 跳过，25.0 秒；无失败需要修复。 |
| `npm run dist:mac` | 退出码 0；生成 arm64 DMG 和 app，按配置未签名。 |

- DMG：`dist/ASI-0.1.0-arm64.dmg`，137478077 字节（约 131 MiB）；
  SHA-256 `be17e1cce58c264107d0b4e55fdc4cd11c4ad7fe9ef9fc5b437ed9c0184d520e`。
  `dist/mac-arm64/ASI.app` 约 371 MiB；打包产物未提交。
- 用 Playwright `_electron.launch({ executablePath })` 启动上述打包 app，设置
  `ASI_FAUX=1` 和独立临时 `ASI_DATA_DIR`；`app.isPackaged === true`、
  窗口加载 `file://.../app.asar/out/renderer/index.html`。新对话选择 `faux-chat`、
  发送“你好”，助手最终 `data-status=done`，回复“你好，我是测试模型。”；
  测试完成后关闭 app 并删除临时数据目录。
- 10 张 E2E 截图加 1 张真实网关厂商页截图均为 1100×720，位于仅含截图的孤立分支
  `shots/t10`，提交 `d548a5572c0bbf23f5a348cf0f401eeb15cb11d8`，已 push hub。
  人工检查流式浅色截图及网关厂商页截图；前者光标紧接正文，后者展示脱敏的已保存
  Key 状态及测试错误。未做与 magpie 实物的逐像素对照。

## magpie 网关真实冒烟

使用同一个打包 app，但未设置 `ASI_FAUX`，`app.isPackaged === true`；
数据目录为新建临时目录。

| 步骤 | 实际结果 |
| --- | --- |
| a. 添加厂商 | OpenAI 兼容厂商 `magpie 本机` 保存成功；Base URL、`auto/deepseek-v4.1-flash` 模型标签及占位 API Key 按任务指定填写。列表显示“已设置 Key”，重新进入编辑页时 key 输入框为空。 |
| b. 模型测试 | 点击 `pe-model-test` 后显示 `✗ 401 Factory: Root organization is deactivated.`；未得到成功延迟。 |
| c. 对话与中止 | 因 401 按任务要求停止；未发送“用一句话介绍你自己”或计数请求，`done`、回复前 80 字、耗时及 `aborted` 部分文本均未验证。只有模型测试的 `ping` 被请求。 |
| d. 截图 | 已保存 `magpie-provider-light.png`；因认证错误停止，未生成 `magpie-chat-light.png`。 |
| e. 明文扫描 | `safeStorage.isEncryptionAvailable() === true`；关闭 app 后扫描临时目录中 60 个常规文件，0 个包含指定占位串明文。 |
| f. 清理 | app 已关闭，临时数据目录已删除。 |

## 发现

- **blocker（真实网关验收受阻，尚非已证实的产品缺陷）**：
  `src/main/chat/chat-service.ts:254-263` 发送模型测试 `ping` 并转发失败结果，
  `src/renderer/views/ProviderEditor.tsx:433-450` 展示该结果。复现：按上表 a 配置并
  保存厂商，在编辑页点该模型的“测试”，本次返回上表的 401 错误。仅凭 UI 错误无法
  判断 401 来自本机网关还是其上游；没有寻找 key、修改网关配置或继续发送真实消息。
  需由负责人处理网关状态并另行批准/安排后续真实对话冒烟。
- 本次通过的自动化与 faux 冒烟中未发现 blocker、should-fix 或 nit 级 ASI 产品缺陷。

## 未验证

- 真实模型测试成功、回复内容/延迟、流式中止和真实对话截图未验证（401 后按要求停止）。
- 默认用户数据目录下的打包生产路径、签名/公证、安装后的 Gatekeeper 和实际系统浏览器
  打开未验证；E2E 的外链测试使用 stub。
- 各测试均使用测试数据目录；未使用真实 API Key，未连接其他厂商或公司生产环境。
