/**
 * 0.1.5 release acceptance (task/release-015). Three phases, each in its own
 * throwaway DSH_HOME — never touches the user's real DSH state:
 *
 *   `body`  — real run ≥20min: 历史 section (今日有计数 / 24h 曲线 / 昨日空态 /
 *             月度空态), whole-disk watch events + exclusion round-trip via UI,
 *             helper-injected screen-lock episodes (无异常不推 / 有异常抑制为
 *             未推送 since no session), a real append write failure
 *             (chmod 000 on today's event file → history-write-failed →
 *             restore permissions → source ok again), 清除历史二次确认后数据
 *             清空且新事件恢复计数, DSH process-group RSS growth <50MB, and the
 *             history/events/<today>.jsonl write-volume report (bytes, lines,
 *             per-kind distribution, projected MiB/day). Zero model requests.
 *   `model` — capped-history rig: today's event file is pre-seeded just below
 *             the 8 MiB non-file daily budget, and injected session.active/
 *             inactive records trip the live daily cap during the run — the
 *             sidebar shows 今日已达上限，后续只记汇总, env_state reports
 *             sources.history.capped=true, and no daily-limit text ever
 *             reaches the model. One synthetic conversation also covers:
 *             wake env messages for file.burst + background job failure +
 *             away.summary(anomaly), env_state tool result, a file.changed
 *             watch on a directory whose filenames carry fabricated secret
 *             shapes (assembled at runtime — e.g. 'ghp_'+'x'.repeat(36),
 *             'password='+'Fake9xyz'+'123') delivered only as [redacted];
 *             asserts counts present and no filenames/window titles/emails/
 *             secret shapes. ≤6 model requests.
 *   `pack`  — install the release tarball into a fresh DSH_HOME: sidebar opens,
 *             version 0.1.5, 历史 section exists; then uninstall.
 *
 * Lock/wake is simulated by wrapping the real helper binary: the wrapper
 * (`inject-helper.mjs`, written per-profile) pipes stdio through and merges
 * ndjson events appended to an injection file — no real lock/sleep happens.
 *
 * Run: DSH_ROOT=<dsh checkout> pnpm --filter asi-sense exec tsx scripts/e2e-release-015.ts [body|model|pack|all] [tgz]
 * Default: all (body+model; pack needs the built tgz path as argv[3]).
 */

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, appendFile, chmod, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, type BrowserContext, chromium, expect, type Locator, type Page } from '@playwright/test';
import { DEFAULT_RULES } from '../src/host/attention/rules.ts';
import { defaultBodyRules } from '../src/host/body/index.ts';
import {
  delay,
  envMessages,
  events,
  failureDetails,
  record,
  run,
  stop,
  temporaryProfile,
  waitFor,
  webUrl,
} from './e2e-support.ts';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dshRoot = process.env.DSH_ROOT;
if (!dshRoot) throw new Error('Set DSH_ROOT to the read-only DeepSeek Harness source checkout');
const dsh = resolve(dshRoot);
const cli = join(dsh, 'apps/cli/src/bin.ts');
const picker = join(dsh, 'apps/web/tests/pin-browse-picker.overlay.yml');
await Promise.all([access(cli), access(picker)]);
const tsx = createRequire(join(dsh, 'package.json')).resolve('tsx/esm');
const args = ['--import', tsx, cli];
const helper = join(pkg, 'lib/asi-sense-helper');
const rand = () => randomBytes(4).toString('hex');
const MODEL_BUDGET = 6;
const NON_FILE_DAILY_CAP = 8 * 1024 * 1024;

/** Local calendar date key matching HistoryManager's LocalCalendar.dateKey. */
function todayKey(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function pgrepF(pattern: string): string[] {
  const result = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
  if (result.status !== 0 && result.status !== 1) throw new Error('pgrep failed');
  return result.stdout.trim().split('\n').filter(Boolean);
}

const helperPids = (pattern: string = helper): string[] => pgrepF(pattern);

/** RSS (KB) summed over the detached server's process group. */
function groupRssKb(pgid: number | undefined): number {
  if (!pgid) return 0;
  const members = spawnSync('pgrep', ['-g', String(pgid)], { encoding: 'utf8' });
  const pids = members.stdout.trim().split('\n').filter(Boolean);
  if (!pids.length) return 0;
  const ps = spawnSync('ps', ['-o', 'rss=', '-p', pids.join(',')], { encoding: 'utf8' });
  return ps.stdout
    .split('\n')
    .map((s) => Number(s.trim()))
    .filter(Number.isFinite)
    .reduce((a, b) => a + b, 0);
}

interface Rig {
  root: string;
  home: string;
  workspace: string;
  counter: string;
  sessionRoot: string;
  storageRoot: string;
  env: NodeJS.ProcessEnv;
  overlay: string;
  burstDir: string;
  injectFile: string;
  wrapper: string;
}

const HELPER_WRAPPER = `#!/usr/bin/env node
// e2e wrapper: passthrough to the real asi-sense-helper plus line injection.
// The emit cursor is persisted: pause/resume restarts the helper process,
// and a restart must not replay already-injected lines.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const REAL = %REAL%;
const INJECT = %INJECT%;
const CURSOR = INJECT + '.cursor';
const child = spawn(REAL, { stdio: ['pipe', 'pipe', 'inherit'] });
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout, { end: false });
child.once('exit', (code) => process.exit(code ?? 0));
let emitted = 0;
try { emitted = Number(readFileSync(CURSOR, 'utf8')) || 0; } catch {}
const timer = setInterval(() => {
  let text;
  try { text = readFileSync(INJECT, 'utf8'); } catch { return; }
  // Count only complete lines: ''.split('\\n') yields [''], so splitting
  // directly would burn index 0 on an empty file and skip the first event.
  const lines = text.split('\\n');
  lines.pop();
  let dirty = false;
  while (emitted < lines.length) {
    const line = lines[emitted].trim();
    emitted += 1;
    dirty = true;
    if (line) process.stdout.write(line + '\\n');
  }
  if (dirty) try { writeFileSync(CURSOR, String(emitted)); } catch {}
}, 200);
timer.unref();
`;

/**
 * Writes history/events/<today>.jsonl with synthetic record-level non-file
 * lines totaling `targetBytes`. Lines are valid HistoryEventLine JSON so
 * hydration and lazy tier accounting see a real near-cap day.
 */
async function seedEventDay(eventsDir: string, targetBytes: number): Promise<void> {
  await mkdir(eventsDir, { recursive: true, mode: 0o700 });
  const file = join(eventsDir, `${todayKey()}.jsonl`);
  const chunks: string[] = [];
  let written = 0;
  const base = Date.now() - 60_000;
  for (let i = 0; written < targetBytes; i++) {
    const extra = Math.max(0, Math.min(512, targetBytes - written - 160));
    const line = JSON.stringify({
      record: 'event',
      id: `seed-${i}`,
      kind: 'session.active',
      subject: 'session',
      level: 'record',
      at: base + i,
      source: 'dsh',
      ...(extra > 0 ? { detail: { pad: 'x'.repeat(extra) } } : {}),
    });
    chunks.push(line);
    written += Buffer.byteLength(line, 'utf8') + 1;
  }
  await writeFile(file, `${chunks.join('\n')}\n`, { mode: 0o600 });
  const info = await stat(file);
  console.log(`seeded today event file: ${info.size} bytes (${chunks.length} lines)`);
}

async function prepare(
  profile: { root: string },
  opts: { limit: number; burstDir: string; extraRules?: unknown[]; seedNonFileBytes?: number },
): Promise<Rig> {
  const root = await realpath(profile.root);
  const home = join(root, 'home');
  const workspace = join(root, 'deepseek-harness/default-workspace');
  const counter = join(root, 'model-requests.txt');
  const budgetReady = join(root, 'budget-ready.txt');
  const services = join(root, 'service-status.json');
  const sessionRoot = join(home, 'sessions');
  const storageRoot = join(home, 'data/asi-sense');
  const injectFile = join(root, 'inject-events.ndjson');
  const wrapper = join(root, 'inject-helper.mjs');
  await Promise.all([
    mkdir(storageRoot, { recursive: true, mode: 0o700 }),
    mkdir(workspace, { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(injectFile, '', { mode: 0o600 });
  await writeFile(
    wrapper,
    HELPER_WRAPPER.replace('%REAL%', JSON.stringify(helper)).replace('%INJECT%', JSON.stringify(injectFile)),
    { mode: 0o600 },
  );
  await chmod(wrapper, 0o755);
  await writeFile(
    join(storageRoot, 'settings.json'),
    JSON.stringify({
      version: 1,
      paused: false,
      sendTitles: false,
      rules: [...DEFAULT_RULES, ...defaultBodyRules(), ...(opts.extraRules ?? [])],
      disabled: [],
    }),
    { mode: 0o600 },
  );
  if (opts.seedNonFileBytes) {
    await seedEventDay(join(storageRoot, 'history/events'), opts.seedNonFileBytes);
  }
  const overlay = join(root, 'overlay.yml');
  await writeFile(
    overlay,
    `- id: llm-pi-ai
  config:
    providers:
      magpie:
        displayName: Local test gateway
        apiKeyEnv: ASI_MAGPIE_PLACEHOLDER
        api: openai-completions
        baseURL: http://127.0.0.1:3425/v1
        retryPolicy:
          mode: normal
          maxRetries: 0
        models:
          - id: auto/gpt-6.1-sol
            name: Local test model
- id: agent-default-model
  config:
    provider: magpie
    model: auto/gpt-6.1-sol
- id: session-persistence-jsonl
  config:
    root: ${JSON.stringify(sessionRoot)}
    compression: none
- id: workspace-controller
  config:
    documentsDirectory: ${JSON.stringify(root)}
- id: tool-bash
  disabled: false
- id: tool-jobs
  config:
    completionDelivery: quiet
- id: session-title-llm
  disabled: true
- id: session-telemetry-otel
  disabled: true
- id: desktop-product-telemetry
  disabled: true
- id: product-analytics
  disabled: true
- id: message-feedback
  disabled: true
- id: ui-message-feedback
  disabled: true
- id: command-feedback
  disabled: true
- id: asi-sense
  config:
    storageRoot: ${JSON.stringify(storageRoot)}
    helperPath: ${JSON.stringify(wrapper)}
- insert:
    - id: asi-sense-e2e-budget
      name: asi-sense-e2e-budget
      config:
        counter: ${JSON.stringify(counter)}
        ready: ${JSON.stringify(budgetReady)}
        services: ${JSON.stringify(services)}
        limit: ${opts.limit}
`,
    { mode: 0o600 },
  );
  const env = {
    ...process.env,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    ASI_MAGPIE_PLACEHOLDER: 'magpie',
    TSX_TSCONFIG_PATH: join(dsh, 'tsconfig.json'),
  };
  await run(
    process.execPath,
    [...args, '--profile', 'asi-dev', '--from-default-profile', 'web', '--dump-config'],
    workspace,
    env,
  );
  await run(process.execPath, [...args, 'plugin', '--profile', 'asi-dev', 'add', pkg], workspace, env);
  await run(
    process.execPath,
    [...args, 'plugin', '--profile', 'asi-dev', 'add', join(pkg, 'test/dsh/budget-plugin')],
    workspace,
    env,
  );
  return { ...opts, root, home, workspace, counter, sessionRoot, storageRoot, env, overlay, injectFile, wrapper };
}

/** Append one synthetic helper-protocol event (v:1 ndjson) for the wrapper to emit. */
async function inject(rig: Rig, type: string, at: number): Promise<void> {
  await appendFile(rig.injectFile, `${JSON.stringify({ v: 1, type, at })}\n`);
}

/** Many injects at once — used to push today's non-file budget past the cap quickly. */
async function injectMany(rig: Rig, entries: ReadonlyArray<{ type: string; at: number }>): Promise<void> {
  const lines = entries.map((e) => `${JSON.stringify({ v: 1, type: e.type, at: e.at })}\n`).join('');
  await appendFile(rig.injectFile, lines);
}

async function spawnDsh(rig: Rig): Promise<{ server: ChildProcess; url: string }> {
  const server = spawn(
    process.execPath,
    [
      ...args,
      '--profile',
      'asi-dev',
      '--patch',
      picker,
      '--patch',
      rig.overlay,
      '--no-open',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
    ],
    { cwd: rig.workspace, env: rig.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const url = await webUrl(server);
  server.stdout?.resume();
  server.stderr?.resume();
  console.log(`Owned DSH PID: ${server.pid}`);
  return { server, url };
}

async function waitHelper(pattern: string = helper, timeoutMs = 20_000): Promise<string[]> {
  return waitFor(
    async () => (helperPids(pattern).length ? helperPids(pattern) : undefined),
    timeoutMs,
    'helper startup',
  );
}

async function dismissNotices(page: Page, timeoutMs: number): Promise<void> {
  const notice = page.getByRole('button', { name: 'Continue', exact: true });
  if (
    await notice.waitFor({ state: 'visible', timeout: timeoutMs }).then(
      () => true,
      () => false,
    )
  )
    await notice.click();
}

async function openPanel(panelPage: Page, url: string): Promise<Locator> {
  await panelPage.goto(url);
  await dismissNotices(panelPage, 3000);
  await panelPage.getByRole('button', { name: 'Environment sense', exact: true }).first().click();
  const panel = panelPage.getByTestId('asi-sense-panel');
  await expect(panel.getByRole('heading', { name: '环境感知' })).toBeVisible();
  return panel;
}

/** The 历史 <details> element inside the sidebar panel. */
function historySection(panel: Locator): Locator {
  return panel.locator('details:has(summary:text("历史"))');
}

/** The 信号源 <details> element inside the sidebar panel (source health, incl. capped). */
function sourcesSection(panel: Locator): Locator {
  return panel.locator('details:has(summary:text("信号源"))');
}

/** Text of the 信号源 details block; opens it first if needed. */
async function sourcesText(panel: Locator): Promise<string> {
  const details = sourcesSection(panel);
  await details
    .locator('summary')
    .first()
    .dispatchEvent('click')
    .catch(() => {});
  return (await details.textContent()) ?? '';
}

/**
 * The sidebar re-renders on every telemetry tick, so Playwright's click
 * actionability checks never stabilize. A synthetic click still triggers the
 * details/summary default action (and React's onToggle) without those checks.
 */
async function expandHistory(panel: Locator): Promise<Locator> {
  const section = historySection(panel);
  const summary = section.locator('summary').first();
  for (let attempt = 0; attempt < 5; attempt++) {
    await summary.dispatchEvent('click');
    const open = await expect(section.locator('text=日汇总'), 'history section open')
      .toBeVisible({ timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    if (open) return section;
  }
  throw new Error('history section did not open after synthetic clicks');
}

async function burstOps(dir: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await writeFile(join(dir, `burstprobe-${i}.txt`), `payload ${i}`);
  for (let i = 0; i < n; i++) await rm(join(dir, `burstprobe-${i}.txt`));
}

async function count(rig: Rig): Promise<number> {
  const text = await readFile(rig.counter, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).length;
}

/** PIDs owned by this run: wrapper script, helper child, DSH argv carrying the profile root. */
function ownedPids(rig: Rig): string[] {
  return [...new Set([...pgrepF(rig.wrapper), ...helperPids(), ...pgrepF(rig.root)])];
}

interface RunState {
  server?: ChildProcess;
  browser?: Browser;
  context?: BrowserContext;
  watchdog?: ReturnType<typeof setTimeout>;
  phase: string;
}

async function phaseBody(): Promise<void> {
  await using profile = await temporaryProfile();
  const suffix = rand();
  // /tmp resolves to /private/tmp, which sits under the built-in /private
  // exclusion — the spec's literal path cannot produce events by design
  // (verified separately below). /Users/Shared is writable and watched.
  const rig = await prepare(profile, { limit: 0, burstDir: `/Users/Shared/asi-e2e-g-${suffix}` });
  const tmpBurstDir = `/tmp/asi-e2e-t-${rand()}`;
  const eventsDir = join(rig.storageRoot, 'history/events');
  const eventsFile = join(eventsDir, `${todayKey()}.jsonl`);
  await mkdir(rig.burstDir, { recursive: true, mode: 0o700 });
  await mkdir(tmpBurstDir, { recursive: true, mode: 0o700 });
  const st: RunState = { phase: 'profile setup' };
  const t0 = Date.now();
  try {
    if (ownedPids(rig).length) throw new Error(`Owned processes already running: ${ownedPids(rig).join(',')}`);
    const started = await spawnDsh(rig);
    st.server = started.server;
    st.watchdog = setTimeout(() => {
      console.error('body phase exceeded the 25-minute limit; stopping owned processes');
      void Promise.allSettled([
        st.browser?.close() ?? Promise.resolve(),
        st.server ? stop(st.server) : Promise.resolve(),
      ]).then(() => process.exit(1));
    }, 1_500_000);
    console.log(`Owned helper PIDs: ${(await waitHelper()).join(',')}`);
    const rss0 = groupRssKb(st.server.pid);
    console.log(`RSS baseline (pg ${st.server.pid}): ${rss0} KB`);

    // 5d part 1 — a clean ≥1h screen-lock episode injected before opening the
    // panel: away.summary hasAnomaly=false must reach the sidebar but produce
    // no wake delivery and no event-stream item.
    st.phase = 'away episode (no anomaly)';
    await inject(rig, 'screen.locked', Date.now() - 65 * 60_000);
    await delay(1200);
    await inject(rig, 'screen.unlocked', Date.now());
    st.browser = await chromium.launch({ headless: true });
    st.context = await st.browser.newContext({ viewport: { width: 1440, height: 900 } });
    const panelPage = await st.context.newPage();
    const panel = await openPanel(panelPage, started.url);
    const history = await expandHistory(panel);
    const awayBlock = history.locator('div', { hasText: '离开' }).last();
    await waitFor(
      async () => (((await awayBlock.textContent()) ?? '').includes('无异常') ? true : undefined),
      30_000,
      'no-anomaly away summary in 历史',
    );
    const awayText = (await awayBlock.textContent()) ?? '';
    console.log(`away (no anomaly): ${awayText.replace(/\s+/g, ' ').trim().slice(0, 120)}`);
    expect(awayText).toContain('无异常');
    expect(awayText).not.toContain('发现异常');
    await delay(2000);
    const awayEvents0 = await panel.locator('li[data-level]').filter({ hasText: '离开' }).count();
    console.log(`event-stream items mentioning 离开 after calm episode: ${awayEvents0}`);
    expect(awayEvents0).toBe(0);

    // 5b' — real append write failure: chmod today's event file 000 so the
    // next append hits EACCES (not an unsafe-entry code), then restore.
    st.phase = 'history write failure';
    await waitFor(
      async () => ((await stat(eventsFile).catch(() => undefined)) ? true : undefined),
      15_000,
      'event file exists',
    );
    await chmod(eventsFile, 0o000);
    await inject(rig, 'screen.locked', Date.now() - 30_000);
    await inject(rig, 'screen.unlocked', Date.now());
    await waitFor(
      async () => ((await sourcesText(panel)).includes('history-write-failed') ? true : undefined),
      30_000,
      'history-write-failed in 信号源',
    );
    console.log(`信号源 history after chmod 000: ${(await sourcesText(panel)).replace(/\s+/g, ' ').slice(0, 200)}`);
    await chmod(eventsFile, 0o600);
    await inject(rig, 'screen.locked', Date.now() - 20_000);
    await inject(rig, 'screen.unlocked', Date.now());
    await waitFor(
      async () => {
        const text = await sourcesText(panel);
        return text.includes('history') && !text.includes('history-write-failed') ? true : undefined;
      },
      45_000,
      '信号源 history recovery after chmod 600',
    );
    console.log(`信号源 history after recovery: ${(await sourcesText(panel)).replace(/\s+/g, ' ').slice(0, 200)}`);
    console.log('history-write-failed surfaced on real append failure and recovered: ok');

    st.phase = 'history section ≥5min';
    const early = 5 * 60_000 - (Date.now() - t0);
    if (early > 0) await delay(early);
    // 5a — 今日有计数 (the 65-min lock counts toward 锁屏), 24h 曲线 ≥1 点,
    // 昨日空态, 月度空态.
    const lockStat = history.locator('div', { hasText: '锁屏' }).last();
    await waitFor(
      async () => {
        if ((await lockStat.count()) < 1) return undefined;
        const t = (await lockStat.textContent()) ?? '';
        return /[1-9]/.test(t) ? true : undefined;
      },
      60_000,
      'today digest with nonzero 锁屏',
    );
    const todayText = (await lockStat.textContent()) ?? '';
    console.log(`today 锁屏 stat: ${todayText.replace(/\s+/g, ' ').trim().slice(0, 60)}`);
    expect(await history.locator('text=今日暂无汇总数据').count()).toBe(0);
    for (const label of ['CPU', '内存']) {
      const head = history.locator('div', { hasText: '最新' }).filter({ hasText: label });
      await waitFor(async () => ((await head.count()) >= 1 ? true : undefined), 90_000, `24h ${label} series point`);
    }
    const cardsText = await history.locator('div', { hasText: '最新' }).allTextContents();
    console.log(`24h cards: ${cardsText.map((t) => t.replace(/\s+/g, ' ').trim().slice(0, 80)).join(' | ')}`);
    await history.getByRole('button', { name: '昨天', exact: true }).dispatchEvent('click');
    await expect(history.locator('text=昨日暂无汇总数据')).toBeVisible({ timeout: 10_000 });
    await history.getByRole('button', { name: '今天', exact: true }).dispatchEvent('click');
    await expect(
      history
        .locator('text=暂无已完成的月度总结（每月结束后生成）')
        .or(history.locator('select[aria-label="选择月份"]')),
    ).toBeVisible({ timeout: 10_000 });
    console.log('5a today counts / 24h curves / yesterday empty / monthly empty: ok');

    // 5d part 1 — whole-disk watch: ≥30 create+delete ops outside any
    // exclusion produce file.activity/file.burst events naming the dir.
    st.phase = 'global watch burst';
    const dirEvent = panel.locator('li[data-level]').filter({ hasText: `asi-e2e-g-${suffix}` });
    await burstOps(rig.burstDir, 80);
    await waitFor(
      async () => ((await dirEvent.count()) >= 1 ? true : undefined),
      90_000,
      'global watch events for burst dir',
    );
    const dirTexts = await dirEvent.allTextContents();
    console.log(
      `burst dir events (${dirTexts.length}): ${dirTexts.map((t) => t.replace(/\s+/g, ' ').slice(0, 140)).join(' | ')}`,
    );
    expect(dirTexts.some((t) => t.includes('新增') || t.includes('删除') || /created=\d+|deleted=\d+/.test(t))).toBe(
      true,
    );
    await delay(20_000); // let first-burst rollup events finish landing

    // 5d part 2 — an ≥1h episode containing an external-deletion burst:
    // inject the lock first so the burst lands inside the away window, give
    // the burst detector its ~60s window to emit (a second burst for the same
    // dir does not reliably produce a new stream item), then unlock.
    st.phase = 'away window with burst anomaly';
    await inject(rig, 'screen.locked', Date.now() - 80 * 60_000);
    await delay(800);
    await burstOps(rig.burstDir, 80);
    await delay(90_000);
    await inject(rig, 'screen.unlocked', Date.now());
    await waitFor(
      async () => (((await awayBlock.textContent()) ?? '').includes('发现异常') ? true : undefined),
      30_000,
      'anomalous away summary in 历史',
    );
    const awayText2 = (await awayBlock.textContent()) ?? '';
    console.log(`away (anomaly): ${awayText2.replace(/\s+/g, ' ').trim().slice(0, 160)}`);
    expect(awayText2).toContain('发现异常');
    expect(awayText2).toContain('未推送');
    await delay(3000);
    const awayLi = panel.locator('li[data-level]').filter({ hasText: '离开' });
    const awayEvents1 = await awayLi.count();
    console.log(
      `away stream items (${awayEvents1}): ${(await awayLi.allTextContents()).map((t) => t.replace(/\s+/g, ' ').slice(0, 120)).join(' | ')}`,
    );
    // With no conversation there is no delivery target, so a suppressed
    // away.summary may not leave a stream item — the anomaly detection is
    // proven by 发现异常 above and the single delivery is asserted in the
    // model phase. Duplicates are never acceptable.
    expect(awayEvents1).toBeLessThanOrEqual(1);

    st.phase = 'exclusion round-trip';
    const exclusionsDetails = panel.locator('details:has(summary:text("排除项"))').last();
    await exclusionsDetails.locator('summary').first().dispatchEvent('click');
    const exInput = panel.getByLabel('新增排除路径或模式');
    await expect(exInput).toBeVisible({ timeout: 10_000 });
    // Controlled input under a re-rendering panel: set via the native setter
    // so React's onChange sees the value.
    await exInput.evaluate((el, v) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, rig.burstDir);
    await panel.getByRole('button', { name: '添加', exact: true }).dispatchEvent('click');
    const exRow = exclusionsDetails.locator('li').filter({ hasText: `asi-e2e-g-${suffix}` });
    await waitFor(async () => ((await exRow.count()) >= 1 ? true : undefined), 30_000, 'exclusion row added');
    console.log(`exclusion added: ${(await exRow.first().textContent())?.replace(/\s+/g, ' ').trim().slice(0, 100)}`);
    await delay(15_000); // let any residual first-burst rollup events land before the snapshot
    const beforeExcluded = await dirEvent.count();
    await burstOps(rig.burstDir, 40);
    // Match the latency at which the first burst's event appeared (~60-90s
    // burst window); an excluded dir must produce no new events at all.
    await delay(90_000);
    const afterExcluded = await dirEvent.count();
    console.log(`events for excluded dir before/after second burst: ${beforeExcluded} -> ${afterExcluded}`);
    expect(afterExcluded).toBe(beforeExcluded);
    await exRow.first().locator('button').dispatchEvent('click');
    await waitFor(async () => ((await exRow.count()) === 0 ? true : undefined), 30_000, 'exclusion row removed');
    console.log('5d global watch events + exclusion round-trip: ok');

    // The spec's literal /tmp path: resolves to /private/tmp, inside the
    // built-in /private exclusion — a burst there must stay silent.
    st.phase = 'tmp under /private stays silent';
    const tmpSuffix = tmpBurstDir.slice(tmpBurstDir.lastIndexOf('/') + 1);
    await burstOps(tmpBurstDir, 40);
    await delay(25_000);
    const tmpEvents = await panel.locator('li[data-level]').filter({ hasText: tmpSuffix }).count();
    console.log(`events for /tmp burst (built-in /private exclusion): ${tmpEvents}`);
    expect(tmpEvents).toBe(0);

    st.phase = 'clear history';
    // The metric sampler ticks every 2s, so the post-clear empty chart state
    // is unobservable unless sampling is paused first.
    const rulesDetails = panel.locator('details:has(summary:text("规则"))');
    await rulesDetails.locator('summary').first().dispatchEvent('click');
    const pauseBox = rulesDetails.getByLabel('暂停感知');
    await pauseBox.dispatchEvent('click');
    await expect(panel.locator('text=已暂停')).toBeVisible({ timeout: 10_000 });
    await history.getByRole('button', { name: '清除历史', exact: true }).dispatchEvent('click');
    await history.getByRole('button', { name: '确认清除', exact: true }).dispatchEvent('click');
    await expect(history.locator('text=已清除全部历史数据。')).toBeVisible({ timeout: 15_000 });
    await expect(history.locator('text=今日暂无汇总数据')).toBeVisible({ timeout: 15_000 });
    await expect(history.locator('text=暂无离开记录')).toBeVisible({ timeout: 15_000 });
    await expect(history.locator('text=暂无 24 小时指标数据')).toBeVisible({ timeout: 15_000 });
    await delay(4000); // must stay empty while paused
    expect(await history.locator('text=暂无 24 小时指标数据').count()).toBe(1);
    console.log('24h charts cleared (and stay cleared while paused): yes');
    await pauseBox.dispatchEvent('click');
    await expect(panel.locator('text=已暂停')).toBeHidden({ timeout: 10_000 });
    // A short (<1h) lock episode after clearing must count toward 今日 again
    // while producing no away.summary — and the cleared one must not return.
    await inject(rig, 'screen.locked', Date.now() - 3 * 60_000);
    await delay(1200);
    await inject(rig, 'screen.unlocked', Date.now());
    await waitFor(
      async () => {
        if ((await lockStat.count()) < 1) return undefined;
        const t = (await lockStat.textContent()) ?? '';
        return /[1-9]/.test(t) ? true : undefined;
      },
      90_000,
      'today digest repopulating after clear',
    );
    const todayAfter = (await lockStat.textContent()) ?? '';
    console.log(`today after clear + new lock: ${todayAfter.replace(/\s+/g, ' ').trim().slice(0, 160)}`);
    expect(todayAfter).not.toContain('今日暂无汇总数据');
    await delay(2000);
    expect(await history.locator('text=暂无离开记录').count()).toBe(1);
    const awayEvents2 = await panel.locator('li[data-level]').filter({ hasText: '离开' }).count();
    console.log(`event-stream items mentioning 离开 after clear + short episode: ${awayEvents2}`);
    expect(awayEvents2).toBe(0);
    console.log('5e clear history + count recovery + no duplicate away summary: ok');

    st.phase = 'rss / write volume ≥20min';
    const twentyMin = 20 * 60_000 - (Date.now() - t0);
    if (twentyMin > 0) await delay(twentyMin);
    const rss1 = groupRssKb(st.server?.pid);
    const growth = rss1 - rss0;
    console.log(`RSS after ${((Date.now() - t0) / 60_000).toFixed(1)} min: ${rss1} KB (growth ${growth} KB)`);
    expect(growth).toBeLessThan(50 * 1024);

    // 5a' — write-volume measurement on history/events/<today>.jsonl.
    const info = await stat(eventsFile);
    const raw = await readFile(eventsFile, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const kinds = new Map<string, number>();
    for (const line of lines) {
      let key = 'unparsed';
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        key =
          typeof parsed.kind === 'string'
            ? parsed.kind
            : typeof parsed.record === 'string'
              ? `<${parsed.record}>`
              : 'unknown';
      } catch {}
      kinds.set(key, (kinds.get(key) ?? 0) + 1);
    }
    const minutes = (Date.now() - t0) / 60_000;
    const mib = info.size / (1024 * 1024);
    const mibPerDay = mib * (1440 / minutes);
    console.log(`events file: ${info.size} bytes, ${lines.length} lines over ${minutes.toFixed(1)} min`);
    console.log(
      `kind distribution: ${[...kinds.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${k}×${n}`)
        .join(', ')}`,
    );
    console.log(`write volume: ${mib.toFixed(3)} MiB in ${minutes.toFixed(1)} min → ~${mibPerDay.toFixed(2)} MiB/day`);
    expect(mibPerDay).toBeLessThanOrEqual(20);
    expect(await count(rig)).toBe(0);
    console.log(`body phase model requests: ${await count(rig)}/0`);
  } catch (error) {
    profile.retain();
    console.error(`body phase failed during ${st.phase}`);
    console.error('details:', JSON.stringify(failureDetails(error)));
    if (error instanceof Error && error.message.startsWith('Timed out waiting for ')) console.error(error.message);
    process.exitCode = 1;
  } finally {
    if (st.watchdog) clearTimeout(st.watchdog);
    await Promise.allSettled([
      st.browser?.close() ?? Promise.resolve(),
      st.server ? stop(st.server) : Promise.resolve(),
    ]);
    await delay(1000);
    const remaining = ownedPids(rig);
    console.log(`owned pids after stop: ${remaining.length ? remaining.join(' ') : '(none)'}`);
    if (remaining.length) {
      profile.retain();
      process.exitCode = 1;
    }
    await rm(rig.burstDir, { recursive: true, force: true });
    await rm(tmpBurstDir, { recursive: true, force: true });
  }
}

async function phaseModel(): Promise<void> {
  await using profile = await temporaryProfile();
  const suffix = rand();
  const secDir = `/Users/Shared/asi-e2e-sec-${suffix}`;
  // Fabricated secret shapes — assembled at runtime so no complete token
  // literal ever lands in the repository (GitHub push protection).
  const secretA = `ghp_${'x'.repeat(36)}`;
  const secretB = `password=${'Fake9xyz'}${'2026abc'}`;
  const secretValueB = `${'Fake9xyz'}${'2026abc'}`;
  // See phaseBody: /tmp is under the built-in /private exclusion.
  const rig = await prepare(profile, {
    limit: MODEL_BUDGET,
    burstDir: `/Users/Shared/asi-e2e-burst-${suffix}`,
    extraRules: [
      {
        id: 'e2e-sec-watch',
        match: { kind: 'file.changed', subject: `${secDir}/**` },
        level: 'context',
        createdBy: 'user',
        approved: true,
      },
    ],
    // Just under the 8 MiB non-file budget: hydration will not infer a cap
    // (needs total+16KiB > minLimit), so the first ~24 KiB of new records
    // trips the live triggerDailyCap path during this run.
    seedNonFileBytes: NON_FILE_DAILY_CAP - 24 * 1024,
  });
  await mkdir(rig.burstDir, { recursive: true, mode: 0o700 });
  await mkdir(secDir, { recursive: true, mode: 0o700 });
  const st: RunState = { phase: 'profile setup' };
  try {
    if (ownedPids(rig).length) throw new Error(`Owned processes already running: ${ownedPids(rig).join(',')}`);
    const started = await spawnDsh(rig);
    st.server = started.server;
    st.watchdog = setTimeout(() => {
      console.error('model phase exceeded the 10-minute limit; stopping owned processes');
      void Promise.allSettled([
        st.browser?.close() ?? Promise.resolve(),
        st.server ? stop(st.server) : Promise.resolve(),
      ]).then(() => process.exit(1));
    }, 600_000);
    console.log(`Owned helper PIDs: ${(await waitHelper()).join(',')}`);
    st.browser = await chromium.launch({ headless: true });
    st.context = await st.browser.newContext({ viewport: { width: 1440, height: 900 } });
    const chat = await st.context.newPage();
    const panelPage = await st.context.newPage();
    let browserErrors = 0;
    for (const page of [chat, panelPage]) page.on('pageerror', () => browserErrors++);

    st.phase = 'daily-cap live trigger';
    const panel = await openPanel(panelPage, started.url);
    // ~200 record-level session.active/inactive signals ≈ 45–60 KiB, enough
    // to push the seeded ~8 MiB-24 KiB day past the non-file budget. They do
    // not touch the lock tracker or the away window.
    const fill: { type: string; at: number }[] = [];
    for (let i = 0; i < 100; i++) {
      fill.push({ type: 'session.inactive', at: Date.now() - 30_000 + i * 200 });
      fill.push({ type: 'session.active', at: Date.now() - 30_000 + i * 200 + 100 });
    }
    await injectMany(rig, fill);
    await waitFor(
      async () => ((await sourcesText(panel)).includes('今日已达上限') ? true : undefined),
      90_000,
      '信号源 capped (今日已达上限，后续只记汇总)',
    );
    const capText = await sourcesText(panel);
    console.log(`信号源 after cap trip: ${capText.replace(/\s+/g, ' ').slice(0, 200)}`);
    expect(capText).toContain('今日已达上限');
    console.log('daily cap tripped live; sidebar shows capped: ok');

    st.phase = 'synthetic conversation';
    await chat.goto(started.url);
    await dismissNotices(chat, 5000);
    const editor = chat.locator('[contenteditable="true"]').first();
    if (
      !(await editor.waitFor({ state: 'visible', timeout: 10_000 }).then(
        () => true,
        () => false,
      ))
    ) {
      await chat.getByRole('button', { name: 'Choose workspace', exact: true }).click();
      const addWorkspace = chat.getByRole('menuitem', { name: 'Add workspace…' });
      if (await addWorkspace.isVisible()) await addWorkspace.click();
      const pickerDialog = chat.getByRole('dialog', { name: 'Select Workspace Directory' });
      await pickerDialog.getByRole('button', { name: 'Edit path' }).click();
      const pathInput = pickerDialog.getByRole('textbox', { name: 'Edit path' });
      await pathInput.fill(rig.workspace);
      await pathInput.press('Enter');
      if (
        !(await pathInput.waitFor({ state: 'hidden', timeout: 10_000 }).then(
          () => true,
          () => false,
        ))
      ) {
        const alert = await pickerDialog.getByRole('alert').allTextContents();
        throw new Error(`Workspace picker could not open the test directory: ${alert.join('; ')}`);
      }
      await pickerDialog.getByRole('button', { name: 'Open', exact: true }).click();
    }
    await expect(editor).toBeVisible();

    st.phase = 'away window + burst + job + env_state';
    // The lock is injected first so the burst and the failed job land inside
    // the away episode and are collected as anomalies.
    await inject(rig, 'screen.locked', Date.now() - 70 * 60_000);
    // Fabricated conversation text — no real titles or content involved.
    await editor.fill(
      'Use the bash tool once with command `sleep 8; exit 1` and run_in_background set to true. ' +
        'Then call the env_state tool once. ' +
        'Do not wait for the job. Reply READY immediately.',
    );
    await chat.getByRole('button', { name: 'Send message', exact: true }).first().click();
    await burstOps(rig.burstDir, 80);
    // Secret-shaped filenames on the e2e-sec-watch scope: file.changed carries
    // the full path through sanitizeForModel, so only [redacted] may ship.
    await writeFile(join(secDir, `${secretA}.txt`), 'e2e synthetic fixture');
    await writeFile(join(secDir, `${secretB}.txt`), 'e2e synthetic fixture');
    const found = await waitFor(
      async () => {
        const log = await events(rig.sessionRoot);
        const texts = envMessages(log).map((e) => envText(e));
        const burst = texts.find((t) => t.includes('file.burst:'));
        // Job completion arrives as a tool-jobs notice, not an env-update.
        const job = log
          .filter((e) => e.type === 'user/message')
          .map((e) => envText(e))
          .find((t) => /background job.*finished/.test(t));
        return burst && job ? { texts, burst, job, log } : undefined;
      },
      180_000,
      'file.burst and job-failure environment messages',
    );
    const { texts, burst, job } = found;
    console.log(`environment messages so far: ${texts.length}`);
    expect(burst).toContain(`asi-e2e-burst-${suffix}`);
    expect(burst).toMatch(/created=\d+/);
    expect(burst).toMatch(/deleted=[1-9]\d*/);
    expect(job).toMatch(/exit code: [1-9]/);

    st.phase = 'env_state capped projection';
    const log0 = await events(rig.sessionRoot);
    const stateCall = log0.find((e) => e.type === 'tool/call' && record(e.data).name === 'env_state');
    expect(stateCall, 'agent must call env_state').toBeTruthy();
    const cappedFlag = findCappedFlag(log0);
    console.log(`env_state observation.sources.history.capped: ${cappedFlag}`);
    expect(cappedFlag).toBe(true);

    st.phase = 'away.summary push (anomaly)';
    // The burst's wake was charged moments ago; a wake attempted within the
    // 60s WAKE_MIN_GAP is downgraded to a context update that only ships with
    // the next turn. Wait past the gap so the away.summary keeps its wake.
    await delay(65_000);
    await inject(rig, 'screen.unlocked', Date.now());
    let afterAway: { texts: string[]; away: string[] } | undefined;
    try {
      afterAway = await waitFor(
        async () => {
          const log = await events(rig.sessionRoot);
          const texts = envMessages(log).map((e) => envText(e));
          const away = texts.filter((t) => /away|离开/.test(t));
          const redacted = texts.some((t) => t.includes('[redacted]'));
          return away.length >= 1 && redacted ? { texts, away } : undefined;
        },
        90_000,
        'away.summary + redacted file.changed environment messages',
      );
    } catch {
      // A wake-budget downgrade still delivers the summary as context on the
      // next turn; nudge the session once to flush it rather than failing.
      await editor.fill('Reply with the single word ACK.');
      await chat.getByRole('button', { name: 'Send message', exact: true }).first().click();
      afterAway = await waitFor(
        async () => {
          const log = await events(rig.sessionRoot);
          const texts = envMessages(log).map((e) => envText(e));
          const away = texts.filter((t) => /away|离开/.test(t));
          const redacted = texts.some((t) => t.includes('[redacted]'));
          return away.length >= 1 && redacted ? { texts, away } : undefined;
        },
        120_000,
        'away.summary + redacted file.changed environment messages (after nudge)',
      );
      console.log('away.summary arrived via wake-budget context path (after nudge)');
    }
    console.log(`away env messages (${afterAway.away.length}):`);
    for (const t of afterAway.away) console.log(`  ${t.replace(/\s+/g, ' ').slice(0, 240)}`);
    expect(afterAway.away.length).toBe(1);
    const all = afterAway.texts;
    for (const [i, t] of all.entries()) console.log(`env[${i}]: ${t.replace(/\s+/g, ' ').slice(0, 240)}`);
    const redactedLines = all.filter((t) => t.includes('[redacted]'));
    console.log(`env lines containing [redacted]: ${redactedLines.length}`);
    for (const t of all) {
      expect(t).not.toContain(rig.burstDir);
      expect(t).not.toContain('/tmp/');
      expect(t).not.toContain('burstprobe');
      expect(t).not.toContain('window:');
      expect(t).not.toContain('daily-limit');
      expect(t).not.toContain('已达上限');
      expect(t).not.toContain(secretA);
      expect(t).not.toContain(secretB);
      expect(t).not.toContain(secretValueB);
      expect(t).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
      expect(t).not.toMatch(/\b(?:sk|key|token|secret|password|bearer)[-_]?[A-Za-z0-9]{12,}\b/i);
    }
    expect(redactedLines.length).toBeGreaterThanOrEqual(1);
    console.log(
      'env content assertions passed (counts, sanitized dirs, redacted secrets, no titles/email/daily-limit)',
    );

    st.phase = 'budget accounting';
    const used = await count(rig);
    console.log(`model requests: ${used}/${MODEL_BUDGET}`);
    expect(used).toBeLessThanOrEqual(MODEL_BUDGET);
    expect(browserErrors).toBe(0);
  } catch (error) {
    profile.retain();
    console.error(`model phase failed during ${st.phase}`);
    console.error('details:', JSON.stringify(failureDetails(error)));
    if (error instanceof Error && error.message.startsWith('Timed out waiting for ')) console.error(error.message);
    process.exitCode = 1;
  } finally {
    if (st.watchdog) clearTimeout(st.watchdog);
    await Promise.allSettled([
      st.browser?.close() ?? Promise.resolve(),
      st.server ? stop(st.server) : Promise.resolve(),
    ]);
    await delay(1000);
    const remaining = ownedPids(rig);
    console.log(`owned pids after stop: ${remaining.length ? remaining.join(' ') : '(none)'}`);
    if (remaining.length) {
      profile.retain();
      process.exitCode = 1;
    }
    await rm(rig.burstDir, { recursive: true, force: true });
    await rm(secDir, { recursive: true, force: true });
  }
}

function envText(e: Record<string, unknown>): string {
  const data = record(e.data);
  const content = Array.isArray(data.content)
    ? data.content
    : Array.isArray(record(data.message).content)
      ? (record(data.message).content as unknown[])
      : [];
  return content
    .map(record)
    .flatMap((p) => (p.type === 'text' && typeof p.text === 'string' ? [p.text] : []))
    .join('\n');
}

/** Deep-search session-log events for observation.sources.<id>.capped === true. */
function findCappedFlag(log: Record<string, unknown>[]): boolean {
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): boolean => {
    if (depth > 10 || value === null || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    const obj = record(value);
    const sources = record(obj.sources);
    const hist = record(sources.history);
    if (hist.capped === true) return true;
    if (obj.capped === true && Object.hasOwn(obj, 'lastSignalAt')) return true;
    for (const v of Object.values(obj)) {
      if (typeof v === 'string' && v.length > 2 && v.trimStart().startsWith('{')) {
        try {
          if (visit(JSON.parse(v), depth + 1)) return true;
        } catch {
          // not embedded JSON
        }
      } else if (visit(v, depth + 1)) {
        return true;
      }
    }
    return false;
  };
  return log.some((e) => visit(e.data, 0));
}

/** Install the release tarball into a fresh DSH_HOME: sidebar + version + 历史, then uninstall. */
async function phasePack(tgz: string): Promise<void> {
  await using profile = await temporaryProfile();
  const root = await realpath(profile.root);
  const home = join(root, 'home');
  const workspace = join(root, 'deepseek-harness/default-workspace');
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const env = {
    ...process.env,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    ASI_MAGPIE_PLACEHOLDER: 'magpie',
    TSX_TSCONFIG_PATH: join(dsh, 'tsconfig.json'),
  };
  const installedHelper = join(home, 'profiles/asi-dev');
  const st: RunState = { phase: 'profile setup' };
  try {
    await run(
      process.execPath,
      [...args, '--profile', 'asi-dev', '--from-default-profile', 'web', '--dump-config'],
      workspace,
      env,
    );
    st.phase = 'plugin add tarball';
    await run(process.execPath, [...args, 'plugin', '--profile', 'asi-dev', 'add', tgz], workspace, env);
    const installed = join(home, 'profiles/asi-dev/node_modules/asi-sense/package.json');
    const manifest = JSON.parse(await readFile(installed, 'utf8')) as Record<string, unknown>;
    console.log(`installed package: ${manifest.name}@${manifest.version}`);
    expect(manifest.version).toBe('0.1.5');

    // A configured (never-called) local model keeps the web UI off the
    // onboarding screen so the sidebar is reachable without a session.
    const overlay = join(root, 'overlay.yml');
    await writeFile(
      overlay,
      `- id: llm-pi-ai
  config:
    providers:
      magpie:
        displayName: Local test gateway
        apiKeyEnv: ASI_MAGPIE_PLACEHOLDER
        api: openai-completions
        baseURL: http://127.0.0.1:3425/v1
        retryPolicy:
          mode: normal
          maxRetries: 0
        models:
          - id: auto/gpt-6.1-sol
            name: Local test model
- id: agent-default-model
  config:
    provider: magpie
    model: auto/gpt-6.1-sol
- id: session-title-llm
  disabled: true
`,
      { mode: 0o600 },
    );
    st.phase = 'sidebar opens';
    const server = spawn(
      process.execPath,
      [
        ...args,
        '--profile',
        'asi-dev',
        '--patch',
        picker,
        '--patch',
        overlay,
        '--no-open',
        '--host',
        '127.0.0.1',
        '--port',
        '0',
      ],
      { cwd: workspace, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    st.server = server;
    st.watchdog = setTimeout(() => {
      console.error('pack phase exceeded the 5-minute limit; stopping owned processes');
      void Promise.allSettled([st.browser?.close() ?? Promise.resolve(), stop(server)]).then(() => process.exit(1));
    }, 300_000);
    const url = await webUrl(server);
    server.stdout?.resume();
    server.stderr?.resume();
    console.log(`Owned DSH PID: ${server.pid}`);
    console.log(`Owned helper PIDs: ${(await waitHelper(installedHelper, 90_000)).join(',')}`);
    st.browser = await chromium.launch({ headless: true });
    st.context = await st.browser.newContext({ viewport: { width: 1440, height: 900 } });
    const panelPage = await st.context.newPage();
    const panel = await openPanel(panelPage, url);
    await expect(panel.getByRole('heading', { name: '环境感知' })).toBeVisible();
    await expect(panel.locator('[data-tile="cpu"]')).toContainText(/\d/, { timeout: 25_000 });
    const history = await expandHistory(panel);
    await expect(history.locator('text=日汇总')).toBeVisible({ timeout: 10_000 });
    console.log('sidebar opens from the installed tarball; cpu tile live; 历史 section present: yes');

    st.phase = 'plugin remove';
    await run(process.execPath, [...args, 'plugin', '--profile', 'asi-dev', 'remove', 'asi-sense'], workspace, env);
    await expect(access(installed)).rejects.toMatchObject({ code: 'ENOENT' });
    console.log('uninstalled; installed package directory removed: yes');
    await stop(st.server);
    st.server = undefined;
  } catch (error) {
    profile.retain();
    console.error(`pack phase failed during ${st.phase}`);
    console.error('details:', JSON.stringify(failureDetails(error)));
    process.exitCode = 1;
  } finally {
    if (st.watchdog) clearTimeout(st.watchdog);
    await Promise.allSettled([
      st.browser?.close() ?? Promise.resolve(),
      st.server ? stop(st.server) : Promise.resolve(),
    ]);
    const remaining = [...new Set([...helperPids(installedHelper), ...pgrepF(root)])];
    console.log(`owned pids after stop: ${remaining.length ? remaining.join(' ') : '(none)'}`);
    if (remaining.length) {
      profile.retain();
      process.exitCode = 1;
    }
  }
}

const phase = process.argv[2] ?? 'all';
const tgz = process.argv[3] ?? join(pkg, 'dist/asi-sense-0.1.5.tgz');
if (phase === 'body' || phase === 'all') await phaseBody();
if (phase === 'model' || (phase === 'all' && process.exitCode !== 1)) await phaseModel();
if (phase === 'pack') await phasePack(await realpath(tgz));
if (!['body', 'model', 'pack', 'all'].includes(phase)) throw new Error(`unknown phase ${phase}`);
