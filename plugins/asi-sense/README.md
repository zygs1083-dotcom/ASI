# asi-sense

`asi-sense` 是 ASI 系统的**纯感官模块**（无侧栏 UI 的后台 Cordis 服务插件），在本地采集机器身体体征、当前环境快照与最近 5 分钟短期趋势环，通过 `ctx.asiSense` 向 `asi-needs` 等上层模块提供实时感官订阅，并向模型提供只读查询工具 `env_state` 与 `env_detail`。

## 核心特性

- **纯粹感官职责，零打扰日常对话**：不注册侧栏图标，不包含事件匹配规则（`WatchRule`）或自动唤醒管线，绝不主动向用户对话注入 `<env-update>` 动态消息。
- **实时身体体征 + 5 分钟短期趋势环**：采集 CPU、内存压力、各磁盘卷剩余空间与新鲜度、电池/电源、macOS 温控档位、网络速率、DSH 进程占用与会话 Token 容量，在内存中维护 5 分钟环形趋势缓冲（含 `diskFree` 字节级变化序列）。
- **本能节能采样档位**：支持由 `asi-needs` 通过 `ctx.asiSense.setPowerMode('normal' | 'eco', reason)` 零 Token 切换采样周期（正常模式 2s，节能降频模式 10s）。
- **macOS Helper 瞬态 AX 容错**：Swift 辅助进程对应用切换期间的瞬态辅助功能读取失败上报 `ax-retryable`，宿主仅针对匹配的当前前台应用将焦点窗口标为 `unknown`，不触发辅助进程重启或污染温控与权限状态。
- **只读模型工具**：仅全局注册 `env_state` 与 `env_detail`，输出统一经过 `sanitizeForModel` 凭据脱敏与主目录 `~` 化。

## 兼容性与安装

- **系统要求**：Apple Silicon Mac（macOS 13+），Node `^22.12.0 || ^24.0.0 || >=26.0.0`。
- **DSH 兼容版本**：`0.2.2-rc.3 || 0.2.2-rc.5`。

在仓库根目录构建并打包（macOS arm64）：

```sh
pnpm install --frozen-lockfile
pnpm --filter asi-sense pack:dist
pnpm --filter asi-needs pack:dist
```

使用匹配的 DSH CLI（`0.2.2-rc.3` 或 `0.2.2-rc.5`）同时安装感官模块与生存需求模块：

```sh
dsh plugin --profile desktop add ./plugins/asi-sense/dist/asi-sense-0.2.0.tgz
dsh plugin --profile desktop add ./plugins/asi-needs/dist/asi-needs-0.2.0.tgz
```

完整的隔离 Web profile 启动与升级说明见 [docs/install-and-update.md](../../docs/install-and-update.md)。

## 隐私说明

所有观察数据与设置均只保存在本机；默认不截图、不录屏、不读取窗口正文内容，且「窗口标题发给模型」默认开启。若不希望模型通过只读工具看到焦点窗口标题，可在 `asi-needs` 的「生存需求 → 控制与隐私」侧栏中随时关闭该开关，或一键暂停全部感知采集。

## 开发校验命令

```sh
pnpm --filter asi-sense run check
pnpm --filter asi-sense run build
```
