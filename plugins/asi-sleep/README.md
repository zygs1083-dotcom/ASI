# asi-sleep

`asi-sleep`（`0.3.0`）是 ASI 系统的 **L2 睡眠与记忆整合插件**。它接入 `ctx.asiSense` 与 `ctx.asiDrives`（`tier: 2`），在用户闲置静默期自动执行仿生 **NREM + REM 双阶段睡眠记忆巩固**，结合 **FSRS 间隔重复遗忘衰减模型**与 **MiniSearch 中英混合全文索引**，将日常对话提炼为本地结构化长期记忆，并在 DSH 左侧栏注册独立的 **「记忆库」** 面板。

## 核心特性（`0.3.0`）

1. **仿生双阶段睡眠整合（NREM + REM）**：
   - **NREM 慢波阶段**：从已完成的普通用户对话轮次中增量提炼四类结构化记忆——**偏好（`preference`）**、**决策（`decision`）**、**踩坑（`pitfall`）**、**近期进展（`episode`）**，并做同批次聚类去重。
   - **REM 快速眼动阶段**：执行跨会话语义/词法去重强化、偏好与决策立场反转冲突消解（新立场自动取代过期未置顶旧记忆）、跨会话关联链接构建（`links`）及 FSRS 突触遗忘修剪。
   - 严格跳过后台自维护沙盒会话（`asi-maint-*` / `sandbox`）与子代理会话（`origin: 'subagent'`）。
2. **双因子困意曲线 + 静默窗口 + 每日配额门控（`ctx.asiDrives` L2）**：
   - **困意生成**：当未整合普通对话累计 `>= 12` 轮，或存在新未整合轮次且距上次睡眠 `>= 6 小时` 时，产生睡眠不适（`satisfaction < 60`），实时同步至 `ctx.asiDrives` 与 `asi-needs` 侧栏高阶仲裁区。
   - **静默自动执行**：仅当全部普通用户会话空闲 `>= 10 分钟` **或** 屏幕已锁定（`env.system.locked === true`），且 L1 生理需求全部舒适（非 `eco` 节能模式）时自动运行后台整合；一旦在途遭遇 L1 生理不适或 `eco` 模式立即抢占中断并回滚自动配额。
   - **配额与手动触发**：自动整合严格限制 `<= 6` 次/天（滚动 24 小时窗口），同时支持侧栏一键 **「立即睡眠整合」**。
3. **零缓存污染按需消费与 FSRS 回忆强化**：
   - 向普通对话暴露纯只读工具 `memory_recall`（BM25 + 前缀/模糊 + 中英分词检索）与 `memory_profile`（结构化高保留率记忆画像）。
   - **零动态消息注入、零动态系统提示词篡改**，100% 保护对话 Prompt Cache；每次 `memory_recall` 命中自动强化对应记忆的 FSRS 稳定度（`stability`）与保留率。
4. **独立侧栏「记忆库」（`id: 'asi-sleep'`）与双向凭据脱敏**：
   - 提供图形化搜索、四类记忆筛选、FSRS 保留率与稳定度可视化、记忆增删改与**置顶锁定（置顶项保留率恒定 100%，永不衰减或修剪）**、自动睡眠暂停开关及「立即睡眠整合」按钮。
   - 本地持久化为可读 `vault/MEMORY.md` + `vault/memories.jsonl` + `vault/sleep-journal.jsonl`，在**落盘前、读取后与模型/工具输出前**全链路强制执行 `sanitizeForModel` 脱敏与主目录 `~` 归一化。

## 开源复用与 MIT 署名说明

- **`Fozikio/cortex-engine`（MIT）**：仿生 NREM 增量聚类提炼 + REM 跨会话去重、立场冲突消解与关联链接双阶段睡眠巩固架构改造；
- **`open-spaced-repetition/ts-fsrs`（MIT）**：纯 TypeScript FSRS 间隔重复记忆保留衰减与回忆强化模型；
- **`lucaong/minisearch`（MIT）**：零依赖纯 TypeScript BM25、前缀与编辑距离模糊全文检索引擎（扩展中英双语二元/标识符分词器）。

## 开发与校验命令

```sh
pnpm --filter asi-sleep run check
pnpm --filter asi-sleep run e2e
pnpm --filter asi-sleep run release:check
```
