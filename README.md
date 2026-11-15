# ASI

基于 pi-ai 的 macOS 极简对话工具：对话 + 配置模型厂商。外观参考 magpie。

- 协作规则：[AGENTS.md](AGENTS.md)
- 架构与接口契约：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 外观规范：[docs/DESIGN.md](docs/DESIGN.md)

## 常用命令

```bash
npm ci              # 安装依赖（postinstall 自动下载 Electron 二进制）
npm run dev         # Electron 开发模式（electron-vite dev）
npm run dev:web     # 纯浏览器预览：无 window.asi 时注入内存 mock，不调用任何真实 API
npm run check       # typecheck + lint + 单测
npm run e2e         # 构建后跑 Playwright _electron 冒烟（截图到 artifacts/）
npm run build       # 产物到 out/
npm run dist:mac    # 打 arm64 dmg（未签名）
```

当前为 T1 骨架：主进程 17 个 IPC handle 有意 reject `not implemented`，真实后端在后续任务实现。
