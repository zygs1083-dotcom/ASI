verdict: fix

# 0.1.2 发布前验收

基线 ASI `1834136`，DSH `39163dd30f703a79079e2d2446545cff3c453738`，
macOS arm64，Node 26.13.0，pnpm 11.13.0。只使用隔离 DSH_HOME 和 Web；
模型仅使用本机 `http://127.0.0.1:3425/v1`，未修改 DSH 或插件业务代码。

## 发现

- **should-fix（测试问题，非已确认的产品 blocker）**
  `plugins/asi-sense/scripts/e2e-target.ts:207-215`、
  `plugins/asi-sense/test/dsh/budget-plugin/index.js:8-12`：第二次真实模型验收在
  `7d1feb4` 的 `e2e-target.ts:205-213` 等待自动模式最后一轮
  `turn/end.reason.kind=completed`，实际为 `error`、错误码 `UNKNOWN`，
  原始错误为 `E2E model request budget exhausted`；该行等待超时，命令退出 1。
  前面的固定和自动路由断言均已在真实会话记录中得到验证。预算插件在第六次
  请求后拒绝了下一次请求，因此不能据此判定插件缺陷，也没有验证自动模式
  最后一轮的模型回复。`8e95860` 已仅在计数达到上限且错误与预算门禁精确匹配时
  接受该结果，其他模型错误仍失败；单测及保留记录离线复核通过，但修订后的
  完整真实模型命令未重跑。是否接受此限制由协调端决定。

## 1. 依赖和检查 — 通过

- `pnpm install --frozen-lockfile && pnpm check`：退出 0，类型检查和 Biome
  通过；初始 body-probe 231、sense-ui 111、asi-sense 920 项通过。
- 测试脚本修订后再次 `pnpm check`：退出 0，分别为 **231、111、923** 项。
- `pnpm --filter asi-sense exec vitest run test/dsh/e2e-support.test.ts`：
  最终退出 0，15 项通过；包含保留 profile、脱敏诊断及预算错误与其他错误的区分。

## 2. 零模型真实 DSH 冒烟 — 通过

`ASI_E2E_NO_MODEL=1 DSH_ROOT=/Users/wangying/orca/dsh pnpm --filter asi-sense run e2e:dsh`
在基线和测试修订后各运行一次，均退出 0，请求均为 0/0。侧栏打开、隐私设置、
CPU/内存/磁盘和响应式断言通过；两次工作树 helper 均在结束后为 0，临时 profile
均已删除。未复现进程组清理 `EPERM`，因此没有针对该错误修改清理逻辑。

## 3. 真实模型目标投递 — 路由断言通过，命令失败

- 首次使用临时测试副本 `ASI_E2E_ONLY_TARGET=1 ASI_E2E_MODEL_BUDGET=6
  DSH_ROOT=/Users/wangying/orca/dsh pnpm --filter asi-sense exec tsx
  scripts/e2e-release-dsh.ts`：退出 1，请求 4/6；已固定较早对话并观察到合成文件
  事件，但原脚本仅输出 `Error` 且自动删除了 profile，无法确定具体失败断言。
- 增强诊断后执行 `ASI_E2E_ONLY_TARGET=1 ASI_E2E_MODEL_BUDGET=6
  DSH_ROOT=/Users/wangying/orca/dsh pnpm --filter asi-sense run e2e:dsh`：
  退出 1，请求 6/6。搜索固定较早对话后，真实后台 bash 任务以退出码 1 结束；
  合成无归属文件 context 和 job 环境消息进入较早对话，较新对话的环境消息为 0。
  切回自动并使较新对话活跃后，第二个合成文件 context 进入较新对话，未进入较早
  对话。日志中的环境消息计数分别为较早 2、较新 1。
- 上述最后一轮回复被测试预算门禁拒绝，精确的期望/实际及定位见「发现」。
  失败后的 profile 保留到进程退出并检查：
  `/var/folders/5q/mvhdgpc50q9g60mdr59z_v1w0000gn/T/asi-sense-dsh-e2e-Xxym05`；
  离线对两份合成会话记录复核了任务退出、两种目标路由及精确预算错误，随后
  删除该目录。未保存真实会话标题或截图。
- 模型用量合计 **10/12**：首次 4，复测 6；协调端批准的追加预算为 6 条。
  预算门禁拒绝的后续尝试没有发送到模型。未再发请求。

## 4. 分发包和安装 — 通过

`pnpm --filter asi-sense pack:dist`：退出 0；产物为
`plugins/asi-sense/dist/asi-sense-0.1.2.tgz`，校验为 arm64、可执行且
ad-hoc 签名。使用从 `e2e-dsh.ts` 临时生成的验收脚本运行
`ASI_E2E_NO_MODEL=1 DSH_ROOT=/Users/wangying/orca/dsh pnpm --filter asi-sense
exec tsx scripts/e2e-release-pack.ts`：退出 0，请求 0/0；新 DSH_HOME 的
`dsh plugin --profile asi-dev add <tarball>` 成功，已安装 manifest 版本 0.1.2，
环境感知侧栏打开，DSH 插件详情显示 `v0.1.2`；停止 Web 后执行
`dsh plugin --profile asi-dev remove asi-sense`，profile 依赖不再包含该包，
临时 profile 和临时脚本均已删除。

## 5. 交付文件 — 通过

已复制到 `/Users/wangying/Downloads/asi-sense-0.1.2.tgz`，未覆盖既有文件。
仓库产物与交付副本的 `shasum -a 256` 均为
`e75b9857dcc14def70883f7c7fb27548cdd97bb48312594cf32138ce44648528`；
文件大小 **626867 bytes**。未发布到 npm 或 GitHub Releases。

## 进程和未验证事项

运行前已有 Desktop PID 58518、58519、58520、58523、58562，用户 helper
PID 58613，Chrome 主进程 PID 584；结束后上述 PID 均仍存在，未操作。
本任务 DSH/helper PID：零模型 69416/69445、22003/22279；首次目标
71545/71550；复测 80632/80793；包安装 85559/85638。目标测试浏览器主 PID
分别为 71573、80818；其他短时浏览器 PID 未记录。结束后列出的全部本任务 PID
均已退出，系统中无 Playwright headless 进程，工作树 helper 为 0。

未验证自动模式最后一轮模型回复，以及修订后完整真实模型命令的零退出；没有
超预算重跑，也不把记录离线复核描述为该命令通过。
