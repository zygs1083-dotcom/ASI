# T5 集成验收报告

基线：`762990c`（`hub/main`）；macOS，Electron/Playwright，测试使用 `ASI_FAUX=1` 和临时数据目录。未使用真实 API Key，未修改产品代码或测试代码。

## 执行结果

| 命令 | 结果 |
| --- | --- |
| `npm ci` | 退出码 0；安装 561 个包；npm 报告 11 个依赖漏洞（6 moderate、5 high），未自动修复。 |
| `npm run check` | 退出码 0；typecheck、Biome 通过，9 个测试文件、155 个单测通过。 |
| 首次 `npm run e2e` | 退出码 0；21 通过、0 失败、0 跳过（1.1 分钟）。 |
| 最终 `npm run e2e` | 退出码 0；21 通过、0 失败、0 跳过（43.3 秒）。 |

两次完整 E2E 均通过，没有需要修复的测试失败；没有出现“重跑即过”的失败，因此没有判定为不稳定的用例，也无需对失败用例连跑三次。这里的通过结果不代表所有视觉契约已有断言覆盖。

## 产品缺陷

共 0 blocker、0 should-fix、2 nit；均为截图验收发现，而非 E2E 失败。

1. **nit：流式光标不在正文末尾。** `src/renderer/views/ChatView.tsx:23-24` 将光标放在块级 Markdown 容器之后，`src/renderer/components/Markdown.tsx:38` 定义该块级容器。复现：启动 faux，选 faux 模型、发送消息，在流式响应中查看 `msg-assistant`。实际光标独占下一行；预期按 `docs/DESIGN.md:67` 紧接响应末尾。证据：`chat-streaming-light.png`、`chat-streaming-dark.png`。
2. **nit：深色主题的启用开关颜色反转。** `src/renderer/styles/app.css:142-147` 分别用 `--card` 作圆点、`--fg` 作启用背景；深色主题下两者在 `src/renderer/styles/tokens.css:26-30` 分别为深色和浅色。复现：设置页切换 `theme-dark`，查看已启用厂商的 `provider-toggle`，或打开其编辑页查看启用开关。实际为浅色轨道、深色圆点；`docs/DESIGN.md:50,85` 描述的是深色轨道、白色圆点。规范中深色 `--fg` 令牌与这段文字存在冲突，建议协调端确认预期。

## 截图与视觉对照

最终 E2E 生成 10 张 1100×720 PNG，位于独立无父提交分支 `shots/t5`，提交 `d55035d9fc590e456a7e27adaffc9f02c8f0b4eb`；该分支只含截图。截图来自 renderer 的 `page.screenshot()`，不包含原生 macOS 窗口装饰，不能凭其验收红绿灯。

已查看 `/Applications/magpie.app` 现有的「供应商」页：可见浅色灰底、白卡片和深色启用开关。参考窗口仅以很小的预览可见，尝试调整尺寸及恢复原尺寸均未获工具确认，故无法做同尺寸像素或字号比较；以下差异以 ASI 截图与 DESIGN 文字为依据，深色参考未单独验证。为保护现有数据，未提交 magpie 画面。

| 截图 | 元素 | 预期 vs 实际 |
| --- | --- | --- |
| `chat-streaming-light.png`、`chat-streaming-dark.png` | 流式光标 | 预期紧接正文末尾；实际另起一行。 |
| `providers-list-dark.png`、`provider-edit-dark.png` | 已启用开关 | 文字规范预期深色底白圆点；实际浅色底深色圆点，且存在上述令牌/文字冲突。 |

验收限制：magpie 窗口在尝试调整后，窗口列表报告的尺寸和位置不同于初始值；恢复未获确认，未再强行操作。需在可正常显示的参考窗口下复核精确视觉尺寸和深色参照。
