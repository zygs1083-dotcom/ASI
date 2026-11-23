# ASI

一组模块化 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）组合包插件，围绕本机感官采集、婴儿期生存需求稳态评估与沙盒化自发维护构建。插件之间仅通过 Cordis 服务（`ctx.asiSense`）与共享类型契约协作；其中 `asi-sense` 作为无侧栏 UI 的纯后台感官服务运行，仅由 `asi-needs` 在 DSH 左侧栏注册唯一的统一面板 **生存需求**（英文界面为 `Survival needs`）。

## 核心插件（`0.2.0`）

| 插件 | 角色与职责 | 侧栏 UI | 说明 |
|---|---|---|---|
| [`asi-sense`](plugins/asi-sense/README.md) | **纯感官模块**：采集本机身体体征（电源、内存、磁盘、CPU、温控、网络、DSH 进程、Token）、当前环境快照与最近 5 分钟短期趋势环，提供 `ctx.asiSense` 服务及只读工具 `env_state` / `env_detail`，绝不主动向对话注入动态事件消息 | 无（纯后台服务） | `0.2.0` |
| [`asi-needs`](plugins/asi-needs/README.md) | **生存需求与自发维护**：订阅 `ctx.asiSense`，按连续稳态张力与回滞模型实时评估五大生存需求（能量、空间、内存与进程、心智容量、体温负荷），通过零 Token 本能反射、独立后台安全沙盒自维护会话与按需啼哭求助（`<asi-cry>` 与求助卡）自主维护运行环境，暴露全局只读工具 `needs_status` | **生存需求**（`id: 'asi-needs'`） | `0.2.0` |

共享工作区库位于 `packages/`：`@asi/sense-types`（感官与需求共享契约及凭据脱敏）、`@asi/body-probe`（macOS 体征探针）与 `@asi/sense-ui`（统一 `NeedsPanel` 界面组件）。

## 兼容性与文档

- **兼容宿主**：DeepSeek Harness `0.2.2-rc.3 || 0.2.2-rc.5`（Apple Silicon macOS `arm64`，Node `^22.12.0 || ^24.0.0 || >=26.0.0`）
- **架构设计**：[docs/DESIGN.md](docs/DESIGN.md)
- **安装与升级指南**：[docs/install-and-update.md](docs/install-and-update.md)
- **打包审计与发布流程**：[docs/release.md](docs/release.md)
- **协作与安全规范**：[AGENTS.md](AGENTS.md)（日常开发门禁执行 `pnpm check`）

## License

MIT
