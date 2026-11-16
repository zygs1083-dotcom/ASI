# asi-sense (M1 core)

Pure-TypeScript local core: fact store, attention pipeline, body thresholds,
and deterministic environment-update formatting.

## 安装

### 前置条件

- Apple Silicon Mac，macOS 13 或更新版本；本项目在 macOS 15.7.7 上验收。
- Node `^22.12.0 || ^24.0.0 || >=26.0.0` 和 pnpm；从仓库构建还需要 Swift 和 Apple Command Line Tools。
- DSH `0.2.2-rc.3`：可以安装[官方 npm 包](https://github.com/deepseek-ai/deepseek-harness#run-from-npm)，或使用已构建的[官方源码](https://github.com/deepseek-ai/deepseek-harness#run-from-source)，固定 commit `39163dd30f703a79079e2d2446545cff3c453738`。

官方包安装方式：

```sh
npm install --global @deepseek-ai/dsh@0.2.2-rc.3
dsh --version
```

或者，首次源码安装（`$HOME/deepseek-harness-asi` 必须不存在）：

```sh
export DSH_ROOT="$HOME/deepseek-harness-asi"
git clone https://github.com/deepseek-ai/deepseek-harness.git "$DSH_ROOT"
git -C "$DSH_ROOT" checkout --detach 39163dd30f703a79079e2d2446545cff3c453738
pnpm --dir "$DSH_ROOT" install
pnpm --dir "$DSH_ROOT" run build
```

已有匹配版本的已构建源码时，只需在本终端设置 `DSH_ROOT` 为该检出目录：

```sh
export DSH_ROOT="/path/to/deepseek-harness"
git -C "$DSH_ROOT" rev-parse HEAD
```

确认输出为上述 commit。后续命令需在同一终端执行。启动脚本优先使用 PATH 中的 `dsh`，并严格检查版本；若版本不匹配会报错，不会退回源码。没有 `dsh` 时使用 `DSH_ROOT` 的 `tsx/esm` 和 CLI 源码，并检查运行版本。脚本设置 `TSX_TSCONFIG_PATH=$DSH_ROOT/tsconfig.json`（设置了 `DSH_ROOT` 时）和 `DSH_TELEMETRY_DISABLED=1`，不自行设置 `DSH_HOME`。

### 构建、隔离和安装

在 ASI 仓库根目录执行：

```sh
export ASI_ROOT="$PWD"
pnpm install --frozen-lockfile
pnpm --filter asi-sense pack:dist
export DSH_LAUNCHER="$ASI_ROOT/plugins/asi-sense/scripts/dsh.sh"
export DSH_HOME="$(mktemp -d "${TMPDIR:-/tmp}/asi-sense-dsh.XXXXXX")"
node -e 'require("node:fs").writeFileSync(process.env.DSH_HOME + "/workspace.json", JSON.stringify([{id:"workspace-controller",config:{documentsDirectory:process.env.DSH_HOME}}]))'
"$DSH_LAUNCHER" --profile asi-dev --from-default-profile web --dump-config
"$DSH_LAUNCHER" plugin --profile asi-dev add "$ASI_ROOT/plugins/asi-sense/dist/asi-sense-0.1.1.tgz"
```

这里为本次安装新建独立 `DSH_HOME` 并从 `web` 模板初始化 `asi-dev` profile，不影响已有 DSH profile 数据。`workspace.json` 让首次启动的默认工作区也位于独立 home 内，而不是共享的 Documents 目录；启动时必须加上该 patch。示例 home 位于系统临时目录，可能被系统清理；需要长期保留数据时，将 `mktemp` 的模板改为持久目录中的新路径。后续每次操作同一 profile 时都要使用同一个 `DSH_HOME`；不要重复执行 `--from-default-profile`，它会重新初始化 profile。

产物是 `plugins/asi-sense/dist/asi-sense-0.1.1.tgz`（文件名中的版本取自包的 `version`）。安装后保留该文件，profile 的依赖指向它。启动脚本也随 tarball 的 `package/scripts/dsh.sh` 分发：打包它是为了把产物复制到其他机器时仍可使用同一启动方式；上面的命令使用仓库中的副本。

### 只有安装包时

满足前置条件后，把第一行改为安装包的绝对路径，在同一终端执行：

```sh
export ASI_TGZ="/absolute/path/to/asi-sense-0.1.1.tgz"
export ASI_INSTALL="$(mktemp -d "${TMPDIR:-/tmp}/asi-sense-install.XXXXXX")"
tar -xzf "$ASI_TGZ" -C "$ASI_INSTALL" package/scripts/dsh.sh
export DSH_LAUNCHER="$ASI_INSTALL/package/scripts/dsh.sh"
export DSH_HOME="$(mktemp -d "${TMPDIR:-/tmp}/asi-sense-dsh.XXXXXX")"
node -e 'require("node:fs").writeFileSync(process.env.DSH_HOME + "/workspace.json", JSON.stringify([{id:"workspace-controller",config:{documentsDirectory:process.env.DSH_HOME}}]))'
"$DSH_LAUNCHER" --profile asi-dev --from-default-profile web --dump-config
"$DSH_LAUNCHER" plugin --profile asi-dev add "$ASI_TGZ"
```

保留安装包和提取的启动脚本；后续启动使用下面的命令和同一 `DSH_HOME`。临时目录可能被系统清理，需要长期使用时应改为持久目录中的新路径。

### 启动

在设置了上述变量的终端中运行：

```sh
"$DSH_LAUNCHER" --profile asi-dev --patch "$DSH_HOME/workspace.json" --no-open --host 127.0.0.1 --port 0
```

在浏览器打开终端输出的本地地址，打开侧栏的 **环境感知**（英文界面为 **Environment sense**）；按 Ctrl-C 停止 DSH。固定版 DSH 的 `apps/cli/src/plugin.ts:65-98` 将 `plugin` 参数交给 profile 包管理器，`packages/boot/plugin-manager/src/install-spec.ts:30-31,70-76` 识别 `.tgz`，官方 `docs/user/develop/basic/publish.zh.md:412-415` 也说明 tarball 安装。产物包含已打包的 host、client 和 `./typert`、配置 patch、已签名的 arm64 helper、启动脚本及 README；不包含源码、测试或 workspace 依赖。Host 的 `./typert` 是 DSH 自动发现的入口（`packages/typert/loader/src/index.ts:2-12,39-40`），client 由 DSH 按 `./client` 加载（`packages/client/modules/src/index.ts:206`）。`@asi/*` 和 host 的 zod 已打包；client 的 React、zod 和声明的 `@deepseek-ai/*` peer 由 DSH 提供，不另设第三方运行时依赖。pnpm 可能报告 peer 警告。

`engines.dsh` 固定为 `0.2.2-rc.3`。DSH 安装 tarball 后检查兼容性：不满足时拒绝安装，恢复 profile manifest、锁文件并尝试恢复 node_modules；已经安装但不兼容的 bundle 在启动时被跳过。DSH 允许用户在明确接受崩溃或数据损坏风险后，对精确的插件版本和 DSH 版本授权豁免；推荐改用匹配版本，而非豁免。依据：`packages/boot/plugin-manager/src/operations.ts:496-565`、`packages/boot/app-boot/src/profile.ts:671-705`。

### 辅助功能授权

helper 不主动弹出授权对话框，也不需要屏幕录制权限。窗口信息显示「无权限」时可点击侧栏的「授权」，或打开 macOS **系统设置 → 隐私与安全性 → 辅助功能**，在列表中启用启动 DSH 的应用（例如终端或 DSH Desktop）；必要时用「+」添加该应用。授权后用 Ctrl-C 停止并重启 DSH，然后重新打开侧栏：

```sh
"$DSH_LAUNCHER" --profile asi-dev --patch "$DSH_HOME/workspace.json" --no-open --host 127.0.0.1 --port 0
```

如果重新构建或更换 ad-hoc 签名的 helper 后权限失效，请重新检查授权。

### 卸载

```sh
"$DSH_LAUNCHER" plugin --profile asi-dev remove asi-sense
"$DSH_LAUNCHER" --profile asi-dev --patch "$DSH_HOME/workspace.json" --no-open --host 127.0.0.1 --port 0
```

先用 Ctrl-C 停止正在运行的 DSH，再执行上面两条命令；重启后插件不再加载，用 Ctrl-C 停止。卸载不会自动删除保存在 DSH home 的本地设置和数据。

### 隐私

观察数据和插件设置保存在本机；默认不截图、不录屏、不读取窗口内容，且「窗口标题发给模型」默认关闭。注意力规则可能把选中的环境事件发给当前会话配置的模型服务；启用窗口标题开关后，标题也可能随允许的事件发送。可在侧栏暂停感知或关闭该开关。

## Layout

- `src/host/state/`: `StateStore` (reentrancy-safe fact table) and the shared
  `sourceObservation` health normalization.
- `src/host/attention/`: rules, self-cause, merge buckets/drain and
  `FloorEvaluator`.
- `src/host/delivery/`: `formatEnvUpdate`, including the title privacy switch.
- `@asi/sense-types`: shared contracts, including the pure `BodyEvaluator` seam.

## Host contract

- **Async API**: `accept(signal, session)`, `flush(now?)` and
  `preStep(sessionId, now?)` return promises — always await them. `accept`
  is pure intake — it never drains or awaits delivery.
  `Deliverer.deliver(intent)` also returns a promise that is awaited before
  any bucket is dropped; the wake budget is charged on a fresh monotonic
  sample taken at delivery completion, not at drain start. While a `deliver`
  is **in flight**, every `flush`/`preStep` call inside its async
  context rejects immediately with `ReentrantDeliveryError` — awaited or
  not — so return or reject from `deliver` instead. The token is
  per-delivery: work scheduled inside `deliver` (a `setImmediate` callback,
  a detached promise) inherits the context but calls pipeline APIs freely
  after its wrapper continuation: between promise settlement and that
  continuation, microtask `flush`/`preStep` MAY still reject. Use
  `setImmediate`, not `queueMicrotask`, or avoid drains inside `deliver`.
  Concurrent callers _outside_ `deliver` queue normally.
- **Scheduling**: no core timers — the host MUST schedule its flush timer
  from monotonic `nextDeadline()` (earliest pending merge deadline,
  retained failures included) and refresh it after `accept`/drains;
  `undefined` means none — ready context/failed inject need `preStep`, a
  past deadline is host-owned retry/backoff.
- **Durable intake**: `accept` runs all mutable intake (session refresh,
  source marks, dedup/match/enqueue) inside the store's
  apply callback — shared synchronous FIFO, so the signal is durable before
  the promise resolves. Exception: an
  `accept` issued **reentrantly** from a subscriber or apply callback is
  queued until the outer intake finishes. To retry a failed delivery call
  `flush`/`preStep` again — never re-`accept` the same signal.
- **Retry entries**:

  | failed delivery          | retry via                                                             |
  | ------------------------ | --------------------------------------------------------------------- |
  | wake (`send`/`followup`) | `flush()` or any `preStep`                                            |
  | context `inject`         | `preStep` of the **same session** only — `flush` never retries inject |

- **At-least-once + `deliveryId`**: a rejection may already have committed
  externally, so the host dedups deliveries by `deliveryId` — a stable
  SHA-256 over `sessionId` + the sorted original signal ids. A retry always
  carries the same underlying signal set, `deliveryId` and `EnvUpdate.at`
  (frozen at the first attempt), but routing and effective level are
  re-evaluated: busy/user flags may switch `send`/`followup`, and a wake
  that loses its budget check on retry ships as a separate `inject` keeping
  its original `at`/`deliveryId` — across buckets there is **no FIFO** (e.g.
  `followup(new)` then `inject(old)`). Only frozen inject batches retry
  verbatim; fresh context always ships as its own batch.
- **Independent failures**: every eligible bucket (of every session) is
  attempted — detached and sealed before its awaited delivery, so in-flight
  arrivals never join an attempted bucket; a rejection retains it uncharged
  and never prevents the others. Original rejection objects propagate after
  all attempts — a single one (even an empty `AggregateError`) rethrown by
  identity, several combined as `AggregateError` without flattening.
  Delivery intents are deep-cloned before reaching the adapter.
- **Serialization**: drain work inside `flush`/`preStep` runs on a
  promise tail, so concurrent calls can never duplicate or lose a delivery.
- **Clocks**: `clock` is injected _monotonic_ time (default
  `performance.now`) used for merge deadlines, the wake sliding window and
  the min wake gap; `wallClock` (default `Date.now`) is used only for rule
  expiry and the `EnvUpdate.at` display timestamp. `Signal.at` and
  `ToolWindow` bounds remain event wall timestamps. An explicit `flush`/
  `preStep` `now` must be a timestamp of that same monotonic clock — never
  `Date.now` (a future cutoff is clamped, a non-finite one is a
  `TypeError`); omit it normally.
- **Merge windows**: buckets group by session+subject, hold a half-open
  `[start, start+window)` receipt interval fixed by the _first_ signal's kind
  (5s for `file.changed`, else 2s), and keep one merged detail per
  **(kind, effective level)** pair — one delivery carries every pair's
  change, so a context and a wake `job.exited` on the same subject never
  collapse into a single count. At `preStep` the session's context
  ships first: pure context groups close early and inject, context details
  _split out_ of still-open mixed buckets inject too, and the wake remainder
  keeps its deadline — its later update reports `alreadyInjected`
  (`另有 N 条已在上一步注入`) instead of repeating them. An attempted mixed
  bucket is sealed: it retries whole, never split.
- **Job tracking**: `StateStore(wallClock?, defaultTtlMs?, monotonicClock?)` — exit
  tombstones use the injected _monotonic_ clock over the half-open
  `[receivedAt, receivedAt+600s)` window. Live fact TTL uses monotonic
  receipt time; explicit `snapshot(now)` remains a wall-time replay seam.
  Samples, source health, file changes and job events use receipt order.
  A safe integer `data.sequence` can identify an earlier sample only when
  both observations have comparable sequences from the same source; wall
  `at` is display metadata, not an ordering key. An `env.activeJobs`
  snapshot merges with explicitly newer comparable per-job events, and an
  `unknown` report changes only the status while advancing its report
  sequence. Exit tombstones prevent earlier comparable events from resurrecting
  jobs until pruning; an unsequenced later arrival is accepted.
- **Self-cause**: a causal-kind signal during a tool window is agent-caused
  when its `pid`, `ppid` or any `ancestors` entry equals the shell pid, or
  when its path lies under `window.cwd`. After completion, only a job exit
  with the same shell pid receives the job grace; descendants do not.
  A failed tool's own post-execute result is always agent-caused.
- **Rules**: `validateRule(input)` returns violations (`[]` = valid);
  constructor rules and `addRule` throw `TypeError` on invalid input and
  store defensive clones; `addRule` upserts by id; `removeRule(id)` returns
  whether a rule was removed. `matchesRule` fails closed and never throws.

## Runtime 与端口

`src/host/runtime/index.ts` exports `createSenseRuntime(ports, options)`, a
Node-only composition layer with no Cordis or DSH imports. The DSH adapter
owns the concrete ports declared in `runtime/ports.ts`:

- `dsh`: subscribe to agent lifecycle, tool and job events; callbacks return
  promises and the adapter must await them, particularly `pre-step`. Supply
  `tokenSnapshot(sessionId)` and awaitable `deliver(sessionId, intent)`.
  Delivery retains the pipeline's at-least-once / `deliveryId` contract;
  the adapter must handle idempotency and never call a drain from `deliver`.
- `storage`: asynchronous `load(key)` / `save(key, json)` for `settings`
  and `body`. `save` rejects only when the new snapshot was **not**
  installed; after an atomic rename, report later errors separately and do
  not reject. A bad settings snapshot fails startup rather than widening
  watching or privacy permissions.
- `probe`: `create()` supplies a `BodyProbe`-compatible object; `helper`:
  `spawn(path)` supplies a child process with piped stdin/stdout/stderr, or
  `undefined` when not installed. `files.watch(path, callback)` watches the
  supplied path and returns a closeable handle; events report absolute paths
  and `add` / `modify` / `delete`. Only explicit absolute file-rule subjects
  are watched; globs watch their static root and events are filtered again.
- `clock`: `wall()` and `mono()` return milliseconds; monotonic deadlines
  drive runtime scheduling, merge windows and helper retries. The probe and
  body persistence retain their own internal sampling/save timers.

The DSH adapter adds context to the accepted `agent/pre-step` decision, not
the already-claimed inbox. DSH logs the admitted messages in the current step;
context is retained in memory if that step is canceled before admission and
the title setting is checked again when it is formatted. Staged context is not
durable across a process restart before admission.

Wake deliveries use a message id derived from the delivery id. A session
projection records both inbox insertions and admitted messages, including
messages already claimed, so an accepted call that throws is not repeated.
If acceptance cannot be determined, a `delivery-unknown` event is recorded
and the delivery is not retried. The projection retains accepted ids for the
session lifetime and therefore grows with delivered messages.

Failed runtime deliveries retry after 1, 2, 4 seconds and so on, capped at
60 seconds, for at most ten attempts or ten monotonic minutes. Context retries
wait for a pre-step; wake retries use the host timer. The `delivery` source
reports failures and their retry count, then reports that retries have stopped
at the limit. Exhausted deliveries are recorded without another wake. The
source returns to ok after a later delivery succeeds. The retry budget resets
on session selection changes; a staged context clears degradation only after
DSH records it in the session.

Regression tests: `adds context to the claimed step and reconstructs it without
another inbox entry`, `retains staged context if cancellation prevents admission,
then admits it on the next step`, `does not enqueue twice after a message is
accepted, claimed and the call throws`, `stops retrying after ten failures,
reports degradation and recovers after a later delivery`, `expires a retry
after ten monotonic minutes even if fewer than ten attempts ran`, and `resets
the retry budget when the selected session changes`. Additional regressions
cover concurrent identical deliveries, unknown outcomes, and waiting for
staged context to commit before clearing degradation.

`selfCauseGraceMs` is an optional DSH plugin configuration and
`createSenseRuntime` option, defaulting to 2000 ms; set it to 0 to disable the
trailing grace. A file event under a tool's absolute cwd is self-caused when
its monotonic receipt falls in `[pre, post + grace)`.
This can also suppress user edits inside that cwd during the grace interval.
Job exit events from the DSH port with the same known shell pid receive the
same half-open trailing grace; descendants, cwd-only matches and other
job/process events do not. A delayed event arriving after the grace is not
self-caused, regardless of its mtime. If either side lacks a pid, no
post-completion job correlation is inferred from cwd or ancestry.
The pinned DSH adapter currently supplies neither tool nor job pids, so this
job correlation applies only when a port supplies both.
The local watcher uses `lstat` mtime for adds/modifications when it is not
older than watcher startup; otherwise (including deletes) it uses callback time.

The DSH adapter implements `storage` with its own `FileStoragePort`, not
`storageDomain`: it writes and syncs a temporary file, atomically renames it,
then attempts to sync the containing directory. Failures before rename reject
and clean up the temporary file; a directory-sync failure after rename is
logged without rejecting the already-installed snapshot. DSH's
`storage-json/src/atomic.ts` instead propagates directory-sync failures after
rename, so its rejection does not imply that the old snapshot is still installed.

`env_detail` returns local structured facts and source status without invoking
computer-use or reading window contents. The current runtime projection does
not expose the foreground PID or window count, so those fields are explicitly
reported as unknown.

To run the isolated real-DSH check, set `DSH_ROOT` to a read-only DSH checkout
and run `pnpm --filter asi-sense e2e:dsh`. The fixture uses a private temporary
profile, disables title sharing and caps model requests at six per run. Profiles
are removed even when initialization or execution fails. Real observations are
used only for assertions and are never photographed.
Set `ASI_E2E_NO_MODEL=1` for sidebar, responsive layout and cleanup checks
without model requests. Add `ASI_E2E_SYNTHETIC=1` to replace the host plugin
with a fabricated frame and save panel-only screenshots under
`/tmp/asi-sense-e2e-shots/`; this mode never starts body-probe or the helper.
On macOS, delayed filesystem notifications are handled
using the monotonic receipt time and trailing grace described above;
notifications arriving after the grace can still cause a wake.

DSH bundle regressions: `marks the old frame stale on carrier loss, accepts a
new baseline and cancels on dispose`; `cancels while waiting for a replacement
baseline`; `shows disconnected facts and independently fresh disk volumes as
stale without altering the baseline`; `uses invented observations and replaces
the real host entry before plugin installation`; `removes the profile after
%s`; `removes the actual fixture profile when DSH initialization fails`; and
`terminates and waits for a stubborn child after its parent has exited`.

For the dangerous-action sidebar check, build the bundle and run
`DSH_ROOT=/path/to/dsh pnpm --filter asi-sense exec tsx test/dsh/danger-e2e.ts`.
It uses a synthetic runtime with isolated storage, blocks model requests, checks
resume pending/persistence and reset confirmation focus, and removes its
temporary profile and cropped screenshots on exit.

`start()` restores before starting sources and may be called once. `stop()`
closes subscriptions, watchers, probe, helper and timers, then waits for
pending body/settings saves; it rejects on a shutdown timeout (950 ms) or
save failure. A helper ignoring SIGTERM is sent SIGKILL before shutdown
finishes. `state()`, `subscribe(listener)`, `events()`, `rules`, `body`,
`actions` and `tools` are available to the presenter/adapter. `events()` is
a defensive snapshot of the last 200 signal decisions. `rules.settings()`
reports the effective pause/title switches. Actions are trusted user calls;
model tools must use `tools` and cannot choose their own identity. Pausing
stops collection and defers pending deliveries until resumed.

The latest active session to issue `pre-step` is selected. Without one,
context is retained for a subsequent `pre-step` (200 subjects, at most 16
kind groups per subject including `other`), while wake is recorded with
`reason: 'no-session'`. Helper title events are stripped until the latest
matching process-session/id/generation acknowledgement; queued deliveries
are stripped again when titles are disabled. Five restarts per ten monotonic
minutes are allowed. On excess the helper emits `source.status` with
`status: 'error'`, `reason: 'restart-limit'` and the restart count; the
existing state store deliberately normalizes that status to `unavailable`
with the reason in `error`, and the event log retains the reason/count.
Fallback token capacity remains visible with its source tag but is omitted
from threshold and rate evaluations.
Drains recheck the selected session after every delivery; unattempted and
failed buckets migrate to the new session. Helper overflow marks helper
facts stale; recovery applies all snapshot fields and concurrent deltas and
keeps the source degraded if a required field is missing.

`bodyTune` accepts only the parameters wired to `BodyMonitor`/`Tuner`:
`floor.{disk,context,battery}.{warn,critical}`, `rate.disk.maxDelta`,
`rate.rss.maxRatio`, `rate.context.maxEtaMs`, `anomaly.{cpu,memory,network}.sigma`,
and `file.burst.{windowMs,maxChanges,maxDeleted}`. Unsupported parameters,
including merge-window and delivery-level tuning, reject with
`unsupported-param`; `envWatch` also rejects a tuning `param`. Rule changes
remain available through `envWatch` with agent-proposed wake rules pending
user approval. `bodyTune({ action: 'feedback', alertId, verdict })` and the
trusted-user feedback action accept alerts registered by the runtime. The
body monitor's `evaluateAuto` and all tuning operations are awaited; tuning
failures are surfaced without discarding confirmed state.

The presenter keeps per-metric five-minute, interval-slotted ring buffers
(at most 300 points) and projects rate ETA from the monitor's current
monotonic evidence, not the bounded event log. A body sample notifies change
subscribers once after its facts, latches and events commit.

Presenter tuning entries expose `status` (`undoable`, `reverted`,
`superseded`, `rejected`, or `other`) and `undoable`. Only an applied revert
sets the existing UI `reverted` field; non-undoable and rejected entries carry
a corresponding explanation in `reason`. The current sense-ui contract has
no disable-undo field, so it may still show an undo button for those entries;
the tuner rejects invalid or superseded IDs.

## M1 boundaries

The M1 attention/state implementation remains unchanged: no persistence,
watchers, helpers, DSH/Cordis integration or model requests in that layer.
Body detection adds local evaluators and persistence ports, not host IO.

## Adaptive Body Monitoring

`src/host/body/index.ts` exports `BodyMonitor`, `Tuner`, `Baseline`,
`defaultBodyRules()` and the individual evaluator seams. No body API sends
model requests, watches files or delivers attention intents.

- `new BodyMonitor()` installs disk loss (>2GiB/60s), RSS growth (>50%/5min),
  context exhaustion (ETA <=10min) and external file deletion (>50/60s).
  The first three use body samples; pass `file.changed` signals to
  `monitor.accept(signal, monotonicAt)` for the fourth. Configure `fileBurst.roots` to
  aggregate a watched tree's scattered subdirectories; absent roots, each
  directory has its own independent watermark/window.
- Baseline and CPU/memory/network anomaly detection are assembled by default.
  Anomalies wait 24 full hours since persisted installation time, then require
  eight valid samples on two different local dates **in that weekly-hour
  bucket**. Cold installations can therefore take more than a week to qualify
  a bucket. The first eight readings calibrate mean/median/MAD, followed by
  clipped EWMA and stochastic median/MAD updates. Pending outliers and readings
  sustaining a warning do not train their own baseline, including across hour
  boundaries; normal readings continue learning.
- `rateRules` and `anomalyRules` explicitly replace their respective defaults;
  `[]` deliberately disables that adaptive layer. Fixed safety floors remain
  active. An injected `baseline` is an immutable seed, forked in caller state.
  `timeZone` defaults to the current runtime IANA zone; repeated DST hours
  share a bucket and skipped hours create none. A runtime zone change affects
  subsequent lookups without migrating stored buckets.
- Evaluator state belongs to the caller. Thread `result.state` into the next
  `evaluate(prev, next, state)`; histories, streaks and per-source latches live
  under the enumerable `BODY_HISTORY` symbol. Keep that symbol when copying
  state (object spread does); JSON persistence uses the dedicated monitor
  snapshot instead. Retry a failed evaluation with its original input state.
  After restore, resume with `monitor.restoredState ?? {}`.
- For rebaseline suggestions, wire a tuner and combined persistence,
  then await `monitor.evaluateAuto(prev, next, state)` for each sample. Thread
  the exact returned state into the next call; stale concurrent state is
  rejected. A bucket with three distinct alerting local dates within 21 days
  and at least eight alert samples yields one context-level `body.anomaly`
  with `data.type === 'rebaseline-suggestion'`; missing samples do not interrupt
  the candidate, but a non-alert reading in that bucket does. Incomplete
  candidates expire after 21 days; generated suggestions expire 7 days after
  their last evidence using wall time or accumulated monotonic sample age.
  Display, restore, and acceptance all clear expired suggestions; a wall clock
  before the last evidence also expires them. Suggestions are available through
  `monitor.rebaselineSuggestions`; they never replace buckets automatically.
  Display and acceptance calculate monotonic age without updating the saved
  per-stream baseline age. Even a clean shutdown can therefore lose elapsed
  time since the last adaptive sample. If wall time stops, a restart can leave
  a suggestion available beyond seven real days, especially with repeated
  restarts.
  This trade-off avoids continuous persistence solely for the expiration timer;
  user confirmation is still required before changing the baseline.
  The pure synchronous `evaluate` seam clears existing suggestion evidence and
  does not collect new evidence.
  Floor and rate rules remain active.

### Trusted Tuning Boundary

Construct `new Tuner(whitelist, { actor, clock, wallClock })`; `actor()` is a
**trusted host resolver**, defaulting to `agent`. Only authenticated sidebar
user calls may resolve to `user`; never forward a tool's `by`/`actor` field
into that resolver. `propose({ param, to, reason })`, `lock`, `unlock`,
`revert(id)`, `feedback`, `resumeTuning()`, `resetTuning()` and `monitor.acceptRebaseline(id)`
do not accept caller-declared identity.

Every `floor.*` spec needs a finite numeric value and `tighten: 'up'|'down'`;
known free-disk/context/battery floors must use `'up'`. AI checks against the
**current** effective value, never the original default. Agent and automatic
feedback changes share +/-50% amplitude, locks and sliding caps of two per
parameter/hour, six per parameter/day and 24 total/day. User changes bypass
those AI limits but retain whitelist/type/bounds checks and audit records;
only users can lock/unlock or loosen floors. User revert also bypasses a
lock; agent revert uses the same AI guards. Superseded IDs cannot be reverted.
The 500-entry display log is separate from retained applied/undo history.
Rejected attempts stay in memory only, do not write or consume durable IDs,
and disappear on restart; quota clock freeze/catch-up state is retained in
memory and included in the next successful snapshot. Applied history retains 30 days or 200 changes,
whichever is greater, plus every currently undoable change.
`tuner.undoableChanges` lists the currently reversible changes, including
accepted rebaselines. Only a trusted user may call
`monitor.acceptRebaseline(id)` or undo a rebaseline. User acceptance is logged,
bypasses AI limits and immediately rejudges the affected latch. Await
`tuner.revert(id)` for a sidebar undo, then resume sampling from
`monitor.restoredState`; undo restores the earlier metric latch and streak.

### Persistence And Clocks

Supply `BodyPersistence` with `load(): Promise<string | undefined>` and
`save(data: string): Promise<void>`. `undefined` means first installation.
The host owns local access control and **atomic temp-file + rename writes**.
`save` must resolve only after installation and reject only when the new
snapshot was not installed; rename must be the last step that can reject.
Report any post-rename directory fsync or
other errors separately, never by rejecting `save`.
Pass the plugin-owned file port to the monitor
for one versioned snapshot containing baseline, installation time, zone,
latches, tuner values, locks, audits, quota windows and ID lineage. Do not
also configure a separate tuner store when the monitor owns the combined one.

Always `await monitor.restore()` before use (or `tuner.restore()` standalone).
AI and automatic saving stay blocked before restore. Tuner mutations are
asynchronous and require a persistence port; always await them. Critical
changes, locks, budgets and undo records are saved before they become visible
or return success. Non-critical baseline statistics may coalesce to 10-second
saves. `persist()` explicitly flushes, and shutdown must await `monitor.close()`
(or standalone `tuner.close()`). Any save failure rejects its caller where
applicable and disables tuning with `tuningDisabled === 'storage-failed'`,
unless the stronger `restore-failed` reason is already present.
The core makes one best-effort write of the last confirmed state with a
disabled marker; if that write also fails, a crash leaves the previous snapshot
intact and the rejected change absent. When a disabled snapshot is restored,
AI stays disabled until a trusted user calls and awaits `tuner.resumeTuning()`
for `storage-failed`; the marker is removed only after a successful save.
The host must surface the failure and recovery status to the user.
Legacy automatic-rebaseline undo snapshots without the former metric latch and
streak fail closed; the host must explicitly repair or reset those snapshots.

Malformed/unknown-version/non-finite snapshots fail closed:
`tuningDisabled === 'restore-failed'` is exposed for the sidebar, baseline
learning resets, AI stays disabled across restarts and IDs get a new random
prefix. No automatic "fresh start" can clear quota/lock protection.
Only an authenticated user may call and await `tuner.resetTuning()` to clear a
`restore-failed` marker: this irreversibly discards tuner values, locks, quota
windows and prior tuner history, starts from declared defaults and writes a
user reset audit record atomically. A failed reset leaves tuning disabled.
The sidebar must request a second explicit confirmation before calling it;
sidebar wiring is deferred to M4. Never expose reset as an agent tool.

Use injected monotonic milliseconds (default `performance.now()`) for rate
windows, quotas, accumulated installation age and save throttling; all samples
must carry a finite `monotonicAt`. Wall time (default `Date.now()`) serves
audit display and local weekly buckets; non-finite inputs are rejected. Restart recovery
persists remaining quota durations plus a wall high-water mark: downtime,
including forward wall jumps, never expires saved budgets. A wall rollback
freezes AI as fully used until wall time catches up, then remaining windows
age on the new process's monotonic clock. Rate windows restart cold because
old process monotonic stamps are meaningless; wall jumps cannot erase a
running rate window.

### Attention Installation

The host/M3 installs `defaultBodyRules()` alongside M1 `DEFAULT_RULES`, or
explicitly replaces them with its own validated `WatchRule[]`. Built-ins
route rate/anomaly warnings to `context`, recoveries to `record`, and external
deletion-overage bursts to pre-approved `wake`; self-caused add/modify/delete
activity remains `record` with `cause: 'agent'`. Body detection only produces
signals: M1 `accept` intakes them, then `preStep`/`flush` controls delivery.
Regression evidence and the offline multi-seed report live in
`scripts/eval-body.md`.

## Requirements

Node `^22.12.0 || ^24.0.0 || >=26.0.0` (declared in every package; developed
on 26; ES2022 runtime). `pnpm check`: typecheck + lint + tests;
`pnpm test:coverage`: attention lines >=90%.

The disk snapshot property test covers all 2,016 parent/volume combinations
and 11,658 comparisons with a fixed-seed sample of snapshot times by default.
Run every snapshot time and all 58,464 comparisons with
`ASI_PROPERTY_FULL=1 pnpm --filter asi-sense exec vitest run test/disk-contract-fix3.test.ts`.

## M1 review findings → regression tests

1. Durable intake before awaited drain; independent cross-session attempts —
   `accept queues new signals before cross-session delivery failures and recovers`
2. Self-cause via shell pid ancestry (pid/ppid/ancestors) and cwd —
   `classifies shell children and grandchildren across concurrent tool windows`
3. Monotonic `clock` vs `wallClock` separation —
   `wall-clock jumps do not change monotonic merge deadlines or wake budget`
4. `validateRule` export, fail-closed `where`, boundary `TypeError`s —
   `invalid where values fail closed and are rejected at rule boundaries`
5. Session+subject buckets, per-kind details, half-open generations —
   `merges different kinds by subject without double charging`;
   `starts a new half-open generation exactly at the deadline, retained failure included`;
   `counts suppressed groups, not wake-budget details, in update.suppressed`
6. Early context close at `preStep`, open wake stays pending —
   `preStep closes context early without injecting an open wake bucket`
7. Independent jobs, exit tombstones, stale/tie ordering —
   `tracks interleaved jobs independently and retains exit tombstones`;
   `seeds tracking from fact.updated replacements and clears on null`
8. Serialized/awaited delivery; budget charged at completion —
   `serializes concurrent flush and preStep drains without duplicate or lost delivery`;
   `awaits rejected wake delivery without charging or losing the bucket`;
   `awaits rejected context delivery and retries only the retained batch`;
   `charges the wake budget at delivery completion, not drain start`
9. Source mark on any nonduplicate signal; recovery before second denied —
   `ordinary successful signals recover source status before a second denied`
10. Context threshold reads `contextUsed` only —
    `uses actual context usage and ignores projected usage for thresholds`
11. Reentrant `apply` queueing, per-listener snapshot clones, error isolation —
    `serializes reentrant subscriber snapshots and isolates listener errors`
12. Exact Node engines in all three manifests —
    `declares supported Node engines in every package`

## M1 re-review findings → regression tests

In `m1-rereview-regressions.test.ts` unless noted:

1. Raw rejection objects (empty `AggregateError` by identity; unflattened combinations) — `rethrows an empty AggregateError by identity instead of swallowing it` / `combines independent raw failures without flattening adapter AggregateErrors`
2. Reentrant `accept` shares the store FIFO — `delivers the first denied before a nested accept marks recovery` / `merges a nested same-subject signal into the outer bucket window` / `queues a pipeline accept triggered from a store.apply subscriber`
3. `env.activeJobs` replacement watermark + retained exit tombstones — `blocks pre-snapshot starts for replaced and unknown ids but accepts independent late jobs`
4. Mixed-bucket context split + `alreadyInjected` — `injects split context at preStep while the wake keeps its deadline and count`
5. Monotonic tombstones, half-open `[receivedAt, +600s)` — `ignores wall-clock jumps and prunes exit tombstones at exactly 600s monotonic`
6. Sealed in-flight buckets; monotonic cutoff clamp — `clamps future cutoffs, rejects non-finite ones and keeps same-subject arrivals in a fresh bucket`
7. `ReentrantDeliveryError` inside `deliver` — `rejects drains awaited inside adapter.deliver while accept stays durable`
8. Stable `deliveryId`/frozen `at`; frozen inject batches; once-per-step, non-FIFO downgrade retries; mutation isolation — `retries a failed wake with the same deliveryId and frozen display time` / `downgrades a failed wake retry to a separate frozen inject once the budget moved` / `injects a same-step budget downgrade once and propagates inject failure` / `isolates adapter mutations of a delivered intent from the retained retry` / `awaits rejected context delivery and retries only the retained batch` (m1-pipeline, updated)
9. Retry entries, at-least-once dedup, downgrade/no-FIFO, adapter reentrancy — **Host contract** above; exercised by the fix-8 tests (the updated pipeline test proves `flush` never retries inject; the downgrade tests prove once-per-step attempts and `followup(new)`-then-`inject(old)` ordering)

## M1 fix-3 regressions → tests

In `m1-fix3-regressions.test.ts`:

1. `env.activeJobs` snapshot ordering independent of `fact.status`; `unknown` reports change status only — `keeps job tombstones when unknown is followed by an older snapshot` / `keeps the newest watermark across three out-of-order snapshots` / `accepts constructor-delayed snapshots but rejects reports older than explicit unknown` (semantics refined by M1 fix-4 below)
2. Bucket details keyed by (kind, effective level) — `injects same-kind context before the wake deadline (success first)` / `injects same-kind context before the wake deadline (failure first)` / `keeps same-kind outcome counts separate without a preStep split`
3. Per-delivery active token for `ReentrantDeliveryError` — `allows inherited setImmediate intake after delivery resolved` / `allows inherited setImmediate intake after delivery rejected` (also queueMicrotask intake)

## M1 fix-4 regressions → tests

1. Blocker: `started@1 → exited@30 → unknown@40 → snapshot@35`, and `snapshot@30 → unknown@40 → snapshot@35` — `keeps job tombstones when unknown is followed by an older snapshot` / `keeps the newest watermark across three out-of-order snapshots` (m1-fix3); `jobsFactAt` orders all explicit statuses while snapshots merge newer per-job events.
2. Blocker: `queueMicrotask(() => accept())` before a resolved/rejected adapter promise's continuation — `allows inherited setImmediate intake after delivery %s` (m1-fix3, also asserts microtask intake for both outcomes); `rejects drains awaited inside adapter.deliver while accept stays durable` (m1-rereview) guards the remaining drain rejection.

## M3 待定契约

1. 去重范围：`send` / `followup` / `inject` 是否共享同一 `deliveryId` 去重记录，跨 session 的边界是什么？
2. 未知提交时的保留期：DSH 可能已提交但确认丢失时，未确认的 `deliveryId` 和待重试消息应保留多久，何时重试或释放？
3. DSH 是否支持原子提交的幂等键？仅靠本地 ID 集合无法同时消除提交前记账导致的丢失和提交后记账导致的重复；当前只能承诺 at-least-once，不能保证 exactly-once。

## Host runtime review fixes → regression tests

In `test/runtime/runtime.test.ts` unless otherwise noted:

1. Lifecycle generation: `rejects a start stopped while settings load is pending without installing resources`; `closes a body restore that finishes after stop without starting its probe`; `does not deliver when a stopped pre-step resumes after token lookup`; `waits for an in-flight action and rejects it after the runtime stops`.
2. Session ownership, busy routing, target budget and identity: `reassigns a pending wake to the busy selected session and charges its budget`.
3. Failed wake retained through session disposal: `retains a failed wake across disposal until another session pre-step`.
4. Job/tool self-cause, including ancestry and cwd: `classifies job and tool exits using the active tool pid window`.
5. Serialized watcher refresh: `serializes overlapping rule refreshes and never reopens deleted roots`.
6. Monotonic TTL: `notifies stale at the monotonic deadline after wall clock rollback`; `renews a repeated fact on receipt even when its wall timestamp is unchanged`; `notifies at independent disk-volume deadlines after wall-clock rollback`; `uses monotonic receipt time for live TTL after wall-clock rollback` (`test/store.test.ts`). Explicit `StateStore.snapshot(now)` remains a wall-time replay seam.
7. Missing window title: `clears the old title when the next focused window has no readable title` (`test/runtime/helper.test.ts`).
8. Overlapping roots: `deduplicates one event delivered by overlapping watched roots`.
9. Bounded pending, sessions and paths: `bounds no-session context by subject and reports evictions`; `reclaims disposed session state after ten minutes of monotonic time` (`test/pipeline.test.ts`); `bounds watched paths at 5000 and evicts the least recently used path` (`test/store.test.ts`).
10. Bounded helper writes and deadline: `coalesces title switches behind a blocked stdin write`; `does not extend the handshake deadline during repeated title switches`; `never applies an older enable after a newer disable was requested` (`test/runtime/helper.test.ts`).
11. Alert feedback capacity and registration failure: `evicts the oldest unfeedbacked alert at capacity and records the eviction` (`test/body/tuner.test.ts`); `marks an alert non-feedbackable when registration returns false`.
12. Helper error and recovery: `records helper output overflow, marks the source degraded and requests a snapshot`; `does not recover from a snapshot requested before output overflow` (`test/runtime/helper.test.ts`).
13. Resource snapshot stability: `leaves no additional active timer or child process resources after stop` (`test/runtime/helper.test.ts`).

## Host runtime re-review fixes → regression tests

1. In-flight routing: `moves the due wake after an in-flight context delivery changes session`; `retains a failed wake and moves all later buckets before another delivery`; `invalidates an in-flight drain even if a disposed session id is reused` (`test/runtime/routing-rereview.test.ts`).
2. Receipt ordering and monotonic TTL: `accepts new same-source samples after wall rollback and expires from receipt time`; `uses receipt order for job samples, job events and source health after wall rollback`; `does not advance a fact sequence on an invalid sample or compare different sources` (`test/store.test.ts`); `recognizes source-health transitions in receipt order after a wall-clock rollback` (`test/pipeline.test.ts`).
3. Complete helper recovery: `retains thermal and app deltas during overflow recovery and rejects an older snapshot`; `keeps a missing snapshot field unknown and the helper degraded`; `applies critical thermal from a recovery snapshot and emits the critical alert` (`test/runtime/helper.test.ts`).
4. Source-root file deduplication: `preserves same-root same-millisecond deletions while pairing overlapping copies`; `deduplicates one event delivered by overlapping watched roots` (`test/runtime/runtime.test.ts`).
5. No-session subject capacity: `counts subjects rather than kinds when retaining 200 subjects`; `bounds per-subject kinds and merges excess into other` (`test/runtime/routing-rereview.test.ts`).

## Presenter and runtime fix-2

The panel's display timeline is the presenter's startup wall time plus monotonic
elapsed time. Fact `observedAt`, event and history times, ETA `asOf`, tuning
times and frame `now` use this timeline; wall-clock adjustments do not change
their relative ages. Fact status comes from the runtime; `staleInMs` is the
remaining monotonic duration at frame creation. Histories cover five minutes,
using at least one-second slots and at most 300 points.

Rate evidence deduplicates each metric by the first occurrence of its
`observedAt`, converting that timestamp to monotonic time using its age at
receipt, as for the fact's display time. A wall-clock jump between acquisition
and receipt can make this conversion inaccurate; without acquisition-time
monotonic stamps the original interval cannot be recovered. Another known
limitation: if a clock rollback makes a genuinely new reading's `observedAt`
identical to the preceding reading, it is indistinguishable from a cache
republish and is not counted. Exposing per-metric acquisition generations or
monotonic timestamps from body-probe is future work.

Alert registration is persisted asynchronously after the alert is published.
Its initial `feedbackAvailable` is conservatively `false`; queued and already
delivered signals are not rewritten if registration later succeeds. Feedback
is usable after successful registration, but the original signal does not
reflect that later change; publishing updated availability is future work.

Regression tests:

1. Five-minute history: `covers at least 295 seconds after five minutes of 100ms CPU samples` (`test/presenter/history.test.ts`).
2. Fresh evidence: `does not add rate evidence or refresh asOf when cached disk readings are republished`; `stamps the first occurrence of each reading on the monotonic observation timeline`.
3. Runtime freshness: `projects runtime status and a monotonic stale countdown across wall jumps`.
4. Independent notifications: `notifies independent events and later samples while alert storage is hung`.
5. Display timeline: `keeps all frame time differences stable across a %i ms wall jump` (±61 seconds).
6. Undoability: `distinguishes reverted, superseded, rejected and undoable tuning entries`.
7. Pre-step races: `discards an older pre-step when another session pre-steps during token lookup`; `discards a pre-step for a disposed session even if the same id is recreated`.
8. Helper recovery: `accepts a snapshot without an app or window as a known empty desktop`; `retries incomplete snapshots with bounded exponential backoff and recovers`; `stops retrying incomplete snapshots after ten attempts`.

## Core re-review 3 regressions

1. Atomic facts, monitor and events, including reentrant intake: `publishes complete body commits to every subscriber with session=%s` (`test/presenter/presenter.test.ts`).
2. Delayed observation and ETA anchor: `anchors delayed rate points and ETA to the same observation time as the fact` (`test/presenter/presenter.test.ts`).
3. Parent and per-volume expiry: `counts down a disk parent until its last fresh volume expires` (`test/presenter/presenter.test.ts`).
4. Recovery after retry exhaustion: `starts another bounded recovery round after %s` (`test/runtime/helper.test.ts`).
5. Stop/replacement race: `discards an in-flight snapshot continuation after stop or replacement (%s)` and `does not apply later snapshot fields after stop interrupts an awaited field` (`test/runtime/helper-recovery.test.ts`).

## Core re-review 4 regressions

1. Atomic expiry metadata: `commits every fact deadline before batched notifications with session=%s` and `keeps reentrant reads on the old or fully committed fact deadlines`.
2. Delayed event evidence: `anchors delayed disk rate events to their evidence without hiding the current ETA` and `keeps delayed rate event evidence aligned across a %i ms wall jump`.
3. Evaluation-time ETA: `uses elapsed monotonic time for delayed context ETA alerts and event details`, `evaluates ETA when a received sample waits before publication`, and `clamps an already elapsed observation ETA to zero at evaluation` (`test/body/rate.test.ts`).
4. Disk aggregation and cache expiry: `aggregates disk parent from final volume deadlines after cached republishes` and `never revives an expired cached disk when its TTL metadata changes`.

Tests are in `test/presenter/presenter.test.ts` unless otherwise noted. Rate signals retain their evaluation-time `at` and remaining ETA, alongside the observation `evidenceAt`; panel events project the evaluation time to the display timeline, while current ETA remains anchored to the observation. Disk parent status and deadline reflect the final fresh-volume set; repeated cached volume timestamps cannot extend a volume's deadline. Collection-level `denied` and `unsupported` remain unchanged even with no volumes or an explicitly fresh volume, as covered by `preserves disk collection status %s with or without fresh volumes`.

## DSH runtime regressions

Pause and resume are serialized through resource changes and persistence; a failed
save restores the preceding resource state. If rollback itself fails, further
pause requests fail until restart rather than claiming an inconsistent state.
File rules with an explicit subject require an absolute path. Missing roots are
watched through their nearest existing directory, with unrelated events filtered.
Directories are watched directly; single-file roots are watched through their
parent so atomic replacements remain observable. A failing root reports `unavailable` as
`files:<rule id>` without stopping other rules; a later rule refresh retries it.
Agent-added rules are activated before saving, and failed activations are not saved.

1. Pause ordering and failures: `serializes overlapping pause and resume transactions until resources and storage agree`; `recovers from a failed pause save before processing the next pause intent`; `restores the paused resources if saving a resume fails`; `rejects subsequent pause requests after rollback fails` (`test/runtime/runtime.test.ts`).
2. Missing roots and restart: `watches the nearest existing ancestor, filters siblings, and switches when the target appears` (`test/dsh/local-ports.test.ts`); `restores a missing file root and observes it after creation and recreation`; `reports changes to an existing file root using the file path itself` (`test/dsh/file-restart.test.ts`).
3. Rule isolation and commit: `isolates failed restored file rules and keeps other watches active`; `marks only the affected rule unavailable on an asynchronous watcher error`; `serializes a watcher error with later rule refresh and reports recovery`; `does not persist a file rule if validation or watch activation fails`; `does not save a newly staged rule when its watcher fails before commit`; `rechecks a staged watcher when its settings commit was queued`; `closes a staged watch when saving the new rule fails`; `closes staged watches when pausing during a pending rule save` (`test/runtime/runtime.test.ts`).

## DSH bundle fix-3 regressions

1. Cross-session budget: `rechecks a cancelled budget downgrade for the target session after dispose=%s`; `restores all kinds of a budget-suppressed group as one target wake`; `keeps the budget downgrade when a disposed session is restored under the same id`.
2. Deferred outcomes: `records confirmed inject outcomes, not cancelled or transferred attempts`; `confirms a transferred wake against an already-spent target budget`; `confirms every retained no-session context event in a merged inject`; `retains an outstanding outcome across more than 1024 unconfirmed transfers`.

All tests are in `test/dsh/port.test.ts`. A staged inject remains unreported as delivered until the adapter confirms its session message; confirmation publishes the actual outcome for all retained merged events.

## DSH bundle fix-4 regressions

1. Visible merged IDs: `confirms visible merged events after more than 1024 offline groups`; `releases merged mappings as events leave the visible log`.
2. Transferred batch aliases: `clears every alias after 1025 transfers when attempt %i confirms and ignores late confirmations`; `preserves unconfirmed parts of a split batch when one transferred part commits`; `keeps independent batches staged when another batch confirms`.

These tests are in `test/runtime/pending-context.test.ts`. Merged mappings retain only visible events; confirming an attempt removes its events from all historical attempts while leaving other unconfirmed batch parts intact. Confirmed events remain deduplicated until they leave the 200-entry log.
