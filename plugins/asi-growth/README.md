# asi-growth

`asi-growth`（`0.5.0`）是 ASI 系统的 **L4 程序性技能提炼与自进化插件**。它接入 `ctx.asiSense`、`ctx.asiDrives`（`tier: 4`）与只读 `ctx.asiSleep`，在 L1–L3 需求全部舒适且进入 20 分钟深静默窗口时，将反复踩坑的高保留率长期记忆与多步排障成功轨迹自动提炼为标准纯文本 `agentskills` `SKILL.md` 待审草案，经人工一键批准后通过 `@deepseek-ai/dsh-skill` `ctx.skills.registerProvider` 动态热挂载至 DSH 宿主，并在左侧栏注册独立的第 3 面板 **「技能工坊」**（`id: 'asi-growth'`，`order: 92`）。

## 核心特性（`0.5.0`）

1. **标准纯文本 `SKILL.md` 与原生 `ctx.skills` 动态热挂载**：
   - 所有草案、已启用技能与已归档技能均以纯文本 `SKILL.md` 保存在 `<storageRoot>/skills/`（默认 `~/.dsh/data/asi-growth/skills/`），**零可执行 `.sh`/`.mjs` 脚本生成、零未授权用户 Git 仓库写入**。
   - 批准启用、在线修改或切换作用域后立即触发 `control.invalidate()` 热刷新 `ctx.skills`，支持 **`global`（全局生效）** 与 **`workspace`（按 `options.cwd` 工作区隔离生效）** 切换，并支持由用户在侧栏一键安全导出至目标工作区 `.agents/skills/<name>/SKILL.md`（带 `lstat` 符号链接拦截与受保护目录校验）。
2. **高证据聚类 + 20 分钟深静默门控 + 跨层抢占（`ctx.asiDrives` L4）**：
   - **高证据门槛**：仅当同一主题累积 `>= 3` 条高保留率（`retention >= 0.5` 或置顶）`pitfall` + `decision`/`preference` 记忆（含至少 1 条 `pitfall`，`episode` 永不触发）**或**已完成的多步排障轨迹重复 `>= 2` 次（或已启用技能主题出现新踩坑触发 `v2+` 修订）时，才产生 L4 不适（`satisfaction < 60`）。
   - **深静默与 L1–L3 优先**：仅当 L1（`asi-needs`）、L2（`asi-sleep`）与 L3（`asi-care`）驱动**全部处于舒适区**（非 `eco` 节能模式）且全部普通会话空闲 `>= 20 分钟`（或屏幕已锁定）时自动起草草案，每日自动配额 `<= 2` 份；在途若任一 L1–L3 驱动激活或进入 `eco` 模式，立即中止并回滚配额。支持侧栏手动点击 **「立即提炼技能」**。
3. **严格人工审批门禁与 60 天技能新陈代谢**：
   - 新技能（`v1`）与增量修订（`v2+`）一律先进入「待审草案」，提供行级 `v1 → v2` 差异（`+`/`-`）审阅与在线 `SKILL.md` 预览/编辑，未经人工批准绝不影响 `ctx.skills`。
   - 持续追踪每项技能的调用次数、最近调用时间与关联回合完成率；连续 `60` 天零调用自动标记「建议归档」，一键归档即从 `ctx.skills` 卸载并保留磁盘 `SKILL.md` 可随时恢复。
4. **独立侧栏「技能工坊」（`order: 92`）与全链路脱敏**：
   - 使用独立 `growth-panel.module.css` 与 `.gw*` 类名前缀，确保与 `asi-needs`（`order: 90`）、`asi-sleep`（`order: 91`）客户端样式选择器 100% 零冲突。
   - 普通对话仅注册只读工具 `growth_status`（零动态消息/系统提示词注入，100% 保护 Prompt Cache）；所有输入、`SKILL.md` 落盘、`ctx.skills` 输出、RPC 报错与工具返回均强制执行 `sanitizeForModel` 凭据脱敏，并严格跳过 ASI 内部沙盒/记忆库/看护目录与子代理会话。

## 开源复用与 MIT 署名说明

- **`MineDojo/Voyager`（MIT）**：程序性技能库闭环（轨迹与高证据观察 → 技能提炼 → 验证评论家 Critic → `v1 → v2+` 迭代精炼）改造内化；
- **`agentskills/agentskills`（MIT）**：开放标准 `SKILL.md` YAML Frontmatter + Markdown 规范解析器、序列化器与校验器改造内化。

## 开发与校验命令

```sh
pnpm --filter asi-growth run check
pnpm --filter asi-growth run e2e
pnpm --filter asi-growth run release:check
```
