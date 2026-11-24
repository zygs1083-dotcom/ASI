# asi-needs

`asi-needs`（`0.5.0`）是 ASI 系统的**生存需求评估、自发维护与跨插件需求仲裁插件**。它订阅 `asi-sense`（`ctx.asiSense`）提供的实时感官快照与 5 分钟体征趋势环，按连续稳态张力与回滞模型实时计算五大 L1 基础生理需求，在后台安全沙盒内通过全景只读嗅探、白名单工具与行动效果记忆维护运行环境，对外暴露 `ctx.asiDrives` 马斯洛多层仲裁服务，并在侧栏注册 **生存需求** 面板（`order: 90`，统一承载 L1 生存需求、`ctx.asiDrives` L2–L4 高阶仲裁与 L3 `asi-care` 静默求助卡，与 L2 `asi-sleep` 的「记忆库」及 L4 `asi-growth` 的「技能工坊」侧栏并存）。

## 五大 L1 生存需求与稳态回滞

| 需求                       | 关注体征                                           | 稳态分区与回滞规则                                                                                                           |
| -------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **能量（`energy`）**       | 电池电量/充放电状态 + 模型网关连通性               | `<25%` 危急（`critical`），`<60%` 不适（`uncomfortable`）；激活驱动力后须回升至 `>=70%` 舒适区才解除驱动并自动归档关联求助卡 |
| **空间（`space`）**        | 新鲜磁盘卷剩余空间/比例 + 5 分钟骤降速率           | 自动忽略过期或不可读挂载点；综合评估绝对余量与快速耗尽斜率                                                                   |
| **内存与进程（`memory`）** | 系统内存压力 + DSH 进程 RSS + 超时/无主任务        | 识别系统内存告警、自身进程膨胀与残留后台任务                                                                                 |
| **心智容量（`mind`）**     | 上下文窗口余量（区分已确认容量与 `fallback` 估值） | 上下文偏紧时触发空闲会话整理；回退估值下不误报危急轰炸                                                                       |
| **体温负荷（`thermals`）** | macOS 温控档位 + 2 分钟持续 CPU 过载               | 过滤瞬时单点尖峰，持续过载或高温时驱动降频降温                                                                               |

## 核心机制（`0.5.0`）

1. **零 Token 本能反射**：低电量（未插电）、高温/持续高负荷或模型网关失联时，立即将 `asi-sense` 切至 `eco` 节能降频采样，并以指数退避静默探活模型网关，全程零模型 Token 消耗。
2. **独立后台自维护会话与全景病因嗅探**：
   - 普通用户对话全局仅注册只读工具 `needs_status`，零维护动作工具、零环境动态消息打扰。
   - 专用后台自维护会话通过 `tools.restrict` + `tools.guard` 剥离 `shell` / `write_file` 等危险工具，仅开放只读诊断（`env_state` / `env_detail` / `needs_status` / `needs_sniff_causes`）与安全沙盒工具：
     - `needs_sniff_causes`：扫描受控开发者缓存（Xcode `DerivedData`/Archives、Homebrew、pnpm、npm、pip、uv、Cargo、Go、Gradle、Playwright）总体积与超 1 小时可清理体积排行，只读统计废纸篓体积作提示，并采样 Top CPU/内存进程摘要（统一经 `sanitizeForModel` 脱敏）；
     - `needs_clean_cache`：无人值守时仅清理 ASI 自有 `tmp/` 与 `cache/`，绝不触碰外部缓存、废纸篓或用户文件；
     - `needs_stop_job`：仅结束超时或无主的 DSH 托管任务，绝不强杀外部系统进程；
     - `needs_compact_context`：仅压缩空闲会话上下文或标记自维护会话轮换；
     - `needs_request_help`：提交脱敏求助卡；对外部 `safe/caution` 缓存仅接受受控白名单 `actionTarget`（拒绝任意路径与废纸篓）。
3. **求助卡一键批准外部缓存清理（含 1 小时活跃保护期）**：用户在侧栏点击「批准清理外部缓存」后，宿主校验防符号链接越界与根路径保护，直接清除修改时间超过 1 小时的陈旧缓存项释放空间，自动跳过最近 1 小时内活跃修改子项以保护正在运行的编译或下载。
4. **行动效果记忆（Action-Outcome Memory）与零收益静默熔断**：自动实测并持久化每次动作前后的真实增益与 `(需求 × 动作)` 有效率账本；同一剧集内若安全自救零收益且已挂出求助卡，自动静默熔断省 Token，直至环境出现实质变化、恶化至 `critical` 或用户批准处理求助卡。
5. **`ctx.asiDrives` 跨插件马斯洛多层需求仲裁**：支持独立插件（L2 `asi-sleep`、L3 `asi-care`、L4 `asi-growth`）注册需求源（含 `autoMaintain` 控制）、专属沙盒工具与受控静默求助卡回调（`proposeHelpCard` / `resolveHelpCards` / `executeHelpAction`），共享维护预算与动作收益账本，并在 L1 生理不适或 `eco` 模式时自动压制挂起及抢占中断高阶需求与工具。

## 开源复用与 MIT 署名说明

内部缓存规则与进程采样模块基于以下 MIT 开源项目裁剪改造内化（无需安装外部第三方 CLI）：

- `bysiber/cleardisk`（MIT）：开发者缓存分类字典与 `safe / caution / risky` 风险分级；
- `guhcostan/mac-cleaner-cli`（MIT）：构建产物识别、符号链接隔离与近期活跃保护策略；
- `tw93/Mole`（MIT）：受保护系统/主目录根路径删除校验逻辑；
- `sindresorhus/ps-list` 与 `soyuka/pidusage`（MIT）：POSIX `ps` 进程 CPU/内存表解析核心。

## 开发与校验命令

```sh
pnpm --filter asi-needs run check
pnpm --filter asi-needs run build
pnpm --filter asi-needs run release:check
```
