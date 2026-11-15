# ASI 项目规则（AGENTS.md）

本项目只按本文件协作，**不套用全局 mesh 规则**（U1/U3/MacAir 分工、hub 钩子 CI、三条通道等都不适用）。
所有 agent（协调端和 worker）开工前先读本文件和 `docs/ARCHITECTURE.md`、`docs/DESIGN.md`。

## 1. 产品范围

ASI 是一个 macOS 桌面对话工具，基于 [`@mariozechner/pi-ai`](https://www.npmjs.com/package/@mariozechner/pi-ai)。只有两项功能：

1. **对话**：多会话、流式输出、可中止、本地持久化、每个会话可选模型。
2. **配置模型厂商**：添加/编辑/删除厂商（pi-ai 内置厂商 + 任意 OpenAI 兼容地址），保存 API Key，选择模型，测试连通。

不做：工具调用、附件/图片、插件、账号/云同步、OAuth 登录类厂商。新增范围须协调端写进本文件。

## 2. 角色

| 角色 | 谁 | 职责 |
|---|---|---|
| 负责人 | 用户 | 产品决策、批准对外操作（push GitHub、发布） |
| 协调端 | U2 上的 Claude（仓库 `/home/desktop/pro/ASI`） | 拆任务、写契约和任务说明、派发、裁决评审、合并 `main`、汇报 |
| 开发 worker | MacPro 上的 devin，模型 `fusion-gpt-6-1-sol-xhigh-sidekick-swe-2-high` | 在自己的工作树/分支实现、自测、提交、push 到 hub |
| 测试/评审 worker | MacPro 上的 devin，模型 `gpt-6-1-terra-xhigh` | 写测试、跑全量测试/e2e/截图验收、独立评审（只读代码） |

- worker 只在 **MacPro** 上运行，**同时最多 5 个**。
- 协调端不在 worker 工作树里改代码；worker 不替负责人做产品决策，口径不清用 `orca orchestration ask` 问。
- 评审 worker 必须是新会话、没参与实现。

## 3. 派发方式（协调端）

Orca 不会把 `--model` 传给 devin，所以按模型自建终端再挂成 worker：

```bash
# 1) 在 MacPro 建工作树（基于 hub/main）
orca worktree create --environment MacPro --repo path:/Users/wangying/orca/ASI \
  --name <task> --base-branch hub/main --json
# 2) 在该工作树启动指定模型的 devin
orca terminal create --environment MacPro --worktree path:<wt> --title <task> \
  --command "devin --permission-mode bypass --respect-workspace-trust false --model <model-id>" --json
# 3) 把任务说明挂到这个终端
orca orchestration worker-start --on MacPro --terminal <handle> --worktree path:<wt> --spec-file <task>_spec.md
```

- 任务说明写在 `/home/desktop/pro/ASI-work/<task>_spec.md`（仓库外），必须自包含：基线、Target、Change、Constraints、Ownership、Observable acceptance、交付格式。
- 派完后台挂 `orca orchestration check --wait ...` 等消息，不轮询 worker 屏幕。
- worker 完成后协调端释放 worker 并删除工作树。

## 4. Git

- 中转仓库（hub）= U2 `ssh://desktop@100.108.45.41/home/desktop/pro/ASI`，MacPro 克隆里的 remote 名为 `hub`。
- worker：从 `hub/main` 拉分支 `task/<name>`；**只允许** `git push hub task/<name>`；禁止 push `main`、禁止 push `origin`/GitHub、禁止 force、禁止改写已 push 的历史。
- 协调端：在 U2 评审后合入 `main`。推 GitHub 由负责人决定。
- 提交信息：`<type>: <摘要>`（feat/fix/test/docs/chore/refactor），小步提交。

## 5. 技术栈与命令

Electron + electron-vite + React + TypeScript，包管理用 **npm**（提交 `package-lock.json`）。

| 命令 | 内容 | 谁跑 |
|---|---|---|
| `npm run check` | typecheck + lint + 单测（vitest） | 每个 worker 交付前必跑，必须 0 退出 |
| `npm run e2e` | Playwright `_electron`，用 faux 厂商，截图到 `artifacts/` | 测试 worker；开发 worker 改了界面时跑相关用例 |
| `npm run dev` | 开发运行 | — |
| `npm run dist:mac` | electron-builder 打 arm64 dmg（未签名） | 收尾任务 |

## 6. 安全与数据

- **API Key 只存在主进程**，用 Electron `safeStorage` 加密落盘；渲染进程永远拿不到明文 key（只知道 `hasApiKey`）。
- 测试一律用 pi-ai 的 faux 厂商（`ASI_FAUX=1`）和临时数据目录（`ASI_DATA_DIR`），**不使用任何真实 API Key**，不读 `~/.secrets/`，不连公司生产环境（192.168.0.34/.35）。
- 日志、截图、测试夹具里不得出现 key、邮箱等个人信息。
- 渲染进程：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；只通过 preload 暴露的 `window.asi` 通信。

## 7. worker 交付要求

- 结束时恰好发一次 `worker_done`，带 `--outcome succeeded|failed`。
- 交付说明 ≤20 行：做了什么 / 怎么验证（命令 + 真实结果，如 `npm run check` 退出码与测试数）/ 没做或有疑问。
- 评审报告首行 `verdict: pass` 或 `verdict: fix`，每条发现标 `blocker|should-fix|nit` 并给 `文件:行号`。
- 完成即停，不在 MacPro 留后台进程（dev server、Electron 实例要关掉）。
