/**
 * 0.1.3 release acceptance (task/release-013). Two phases, each in its own
 * throwaway DSH_HOME — never touches the user's real DSH state:
 *
 *   `body`  — real telemetry (≥60s network/CPU/mem/disk/battery/thermal,
 *             sidebar rate vs netstat -ibn on physical en* interfaces),
 *             scoped file.burst (in-scope dir vs out-of-scope sibling),
 *             σ deviation display + feedback-button gating via a seeded
 *             mature baseline (zero model requests).
 *   `model` — one synthetic conversation, in-scope file.burst + one
 *             background `sleep 8; exit 1` failure; asserts environment
 *             messages contain sanitized directory + created/deleted
 *             counts, never full temp paths/filenames/window titles.
 *
 * Run: DSH_ROOT=<dsh checkout> pnpm --filter asi-sense exec tsx scripts/e2e-release-013.ts [body|model|all]
 * Default: all.
 */

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, type BrowserContext, chromium, expect, type Locator, type Page } from '@playwright/test';
import { DEFAULT_RULES } from '../src/host/attention/rules.ts';
import { formatter, slotOf } from '../src/host/body/baseline-time.ts';
import { Baseline, defaultBodyRules } from '../src/host/body/index.ts';
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

function helperPids(): string[] {
  const result = spawnSync('pgrep', ['-f', helper], { encoding: 'utf8' });
  if (result.status !== 0 && result.status !== 1) throw new Error('pgrep failed');
  return result.stdout.trim().split('\n').filter(Boolean);
}

interface Rig {
  root: string;
  home: string;
  workspace: string;
  counter: string;
  sessionRoot: string;
  env: NodeJS.ProcessEnv;
  overlay: string;
  burstDir: string;
  siblingDir: string;
  fileDir: string;
}

async function prepare(
  profile: { root: string },
  opts: { limit: number; burstDir: string; siblingDir: string; fileDir: string },
): Promise<Rig> {
  const root = await realpath(profile.root);
  const home = join(root, 'home');
  const workspace = join(root, 'deepseek-harness/default-workspace');
  const counter = join(root, 'model-requests.txt');
  const budgetReady = join(root, 'budget-ready.txt');
  const services = join(root, 'service-status.json');
  const sessionRoot = join(home, 'sessions');
  await Promise.all([
    mkdir(join(home, 'data/asi-sense'), { recursive: true, mode: 0o700 }),
    mkdir(workspace, { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(
    join(home, 'data/asi-sense/settings.json'),
    JSON.stringify({
      version: 1,
      paused: false,
      sendTitles: false,
      rules: [
        ...DEFAULT_RULES,
        ...defaultBodyRules(),
        // Step 4b: a rule matching ONLY file.burst, scoped to the temp dir.
        {
          id: 'e2e-burst-scope',
          match: { kind: 'file.burst', subject: `${opts.burstDir}/**` },
          level: 'record',
          createdBy: 'user',
          approved: true,
        },
        // Step 4c: record-level file.changed on a separate dir produces an
        // alert that is never registered for tuning feedback.
        {
          id: 'e2e-file-record',
          match: { kind: 'file.changed', subject: `${opts.fileDir}/**` },
          level: 'record',
          createdBy: 'user',
          approved: true,
        },
      ],
      disabled: [],
    }),
    { mode: 0o600 },
  );
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
  return { ...opts, root, home, workspace, counter, sessionRoot, env, overlay };
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

async function waitHelper(): Promise<string[]> {
  return waitFor(
    async () => {
      const pids = helperPids();
      return pids.length ? pids : undefined;
    },
    20_000,
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

/** Physical-interface byte totals, mirroring the probe's own selection. */
function netstatTotals(): { physical: { rx: number; tx: number }; all: { rx: number; tx: number } } {
  const out = spawnSync('netstat', ['-ibn'], { encoding: 'utf8' });
  if (out.status !== 0) throw new Error('netstat -ibn failed');
  const physical = { rx: 0, tx: 0 };
  const all = { rx: 0, tx: 0 };
  for (const line of out.stdout.split('\n')) {
    const c = line.trim().split(/\s+/);
    if (c.length < 10) continue;
    const rx = Number(c[6]);
    const tx = Number(c[9]);
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) continue;
    all.rx += rx;
    all.tx += tx;
    if (/^(?:en|pdp_ip)\d+$/.test(c[0])) {
      physical.rx += rx;
      physical.tx += tx;
    }
  }
  return { physical, all };
}

function parseRate(text: string, arrow: '↓' | '↑'): number | undefined {
  const m = text.match(new RegExp(`${arrow}\\s+([\\d.]+)\\s*(MB/s|KB/s)`));
  if (!m) return undefined;
  const v = Number(m[1]);
  return m[2] === 'MB/s' ? v * 1024 * 1024 : v * 1024;
}

async function burstOps(dir: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await writeFile(join(dir, `burstprobe-${i}.txt`), `payload ${i}`);
  for (let i = 0; i < n; i++) await rm(join(dir, `burstprobe-${i}.txt`));
}

/** Mature memory baseline (~0.05 mean) for the CURRENT hour-of-week slot. */
function seededBaselineJson(now: number): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const fmt = formatter(zone);
  const target = slotOf(fmt, now).index;
  const b = new Baseline({ installedAt: now - 14 * 86_400_000, elapsedMs: 25 * 3_600_000, timeZone: zone });
  // Candidate observation days far enough apart to cover any DST hour shift;
  // keep only timestamps that land in the current slot, oldest first.
  const ats: number[] = [];
  for (const week of [14, 13, 9, 8, 7, 6, 5]) {
    for (let i = 0; i < 20; i++) {
      const at = now - week * 86_400_000 + i * 5_000;
      if (slotOf(fmt, at).index === target) ats.push(at);
    }
  }
  ats.sort((a, b2) => a - b2);
  for (const at of ats.slice(0, 60)) b.observe('memory', 0.05, at);
  const stat = b.read('memory', now);
  if (!stat || stat.count < 8 || stat.dates < 2) {
    throw new Error(`seeded baseline is not eligible: ${JSON.stringify(stat)}`);
  }
  return b.serialize();
}

async function count(rig: Rig): Promise<number> {
  const text = await readFile(rig.counter, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).length;
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
  const rig = await prepare(profile, {
    limit: 0,
    burstDir: `/tmp/asi-e2e-burst-${suffix}`,
    siblingDir: `/tmp/asi-e2e-burst-${rand()}`,
    fileDir: `/tmp/asi-e2e-files-${rand()}`,
  });
  for (const d of [rig.burstDir, rig.siblingDir, rig.fileDir]) await mkdir(d, { recursive: true, mode: 0o700 });
  const st: RunState = { phase: 'profile setup' };
  try {
    if (helperPids().length) throw new Error('An ASI helper from this worktree is already running');
    const started = await spawnDsh(rig);
    st.server = started.server;
    st.watchdog = setTimeout(() => {
      console.error('body phase exceeded the 8-minute limit; stopping owned processes');
      void Promise.allSettled([
        st.browser?.close() ?? Promise.resolve(),
        st.server ? stop(st.server) : Promise.resolve(),
      ]).then(() => process.exit(1));
    }, 480_000);
    console.log(`Owned helper PIDs: ${(await waitHelper()).join(',')}`);
    st.browser = await chromium.launch({ headless: true });
    st.context = await st.browser.newContext({ viewport: { width: 1440, height: 900 } });
    const panelPage = await st.context.newPage();
    const panel = await openPanel(panelPage, started.url);

    st.phase = 'telemetry ≥60s';
    await delay(62_000);
    for (const metric of ['cpu', 'memory', 'disks', 'network', 'battery', 'thermal']) {
      const tile = panel.locator(`[data-tile="${metric}"]`);
      const text = (await tile.textContent()) ?? '';
      console.log(`tile ${metric}: ${text.replace(/\s+/g, ' ').trim().slice(0, 120)}`);
    }
    for (const metric of ['cpu', 'memory', 'disks'])
      await expect(panel.locator(`[data-tile="${metric}"]`)).toContainText(/\d/, { timeout: 10_000 });
    const netTile = panel.locator('[data-tile="network"]');
    const netText = (await netTile.textContent()) ?? '';
    expect(netText).not.toMatch(/未知|不可用|无权限|待补全/);
    expect(netText).toMatch(/↓\s+[\d.]+\s*(?:MB|KB)\/s/);
    expect(netText).toMatch(/↑\s+[\d.]+\s*(?:MB|KB)\/s\s*·\s*已(?:连接|断开)/);

    const snap0 = netstatTotals();
    await delay(12_000);
    const snap1 = netstatTotals();
    const dt = 12;
    const est = {
      physRx: (snap1.physical.rx - snap0.physical.rx) / dt,
      physTx: (snap1.physical.tx - snap0.physical.tx) / dt,
      allRx: (snap1.all.rx - snap0.all.rx) / dt,
      allTx: (snap1.all.tx - snap0.all.tx) / dt,
    };
    const netText2 = (await netTile.textContent()) ?? '';
    const tileRx = parseRate(netText2, '↓');
    const tileTx = parseRate(netText2, '↑');
    console.log(
      `network compare: tile rx=${tileRx?.toFixed(0)}B/s tx=${tileTx?.toFixed(0)}B/s | ` +
        `netstat phys rx=${est.physRx.toFixed(0)}B/s tx=${est.physTx.toFixed(0)}B/s | ` +
        `all-iface rx=${est.allRx.toFixed(0)}B/s tx=${est.allTx.toFixed(0)}B/s`,
    );
    expect(tileRx).toBeDefined();
    expect(tileTx).toBeDefined();
    const floor = 512 * 1024;
    expect(tileRx as number).toBeLessThanOrEqual(Math.max(est.physRx * 5, floor));
    expect(tileTx as number).toBeLessThanOrEqual(Math.max(est.physTx * 5, floor));
    if (est.allRx > est.physRx * 2 + floor || est.allTx > est.physTx * 2 + floor) {
      console.log('virtual-interface traffic detected; verifying tile tracks the physical sum');
      expect(tileRx as number).toBeLessThanOrEqual(Math.max(est.physRx * 3, floor));
      expect(tileTx as number).toBeLessThanOrEqual(Math.max(est.physTx * 3, floor));
    }

    st.phase = 'scoped file.burst';
    await burstOps(rig.burstDir, 80);
    const burstEvent = panel.locator('li[data-level]').filter({ hasText: `asi-e2e-burst-${suffix}` });
    await waitFor(
      async () => ((await burstEvent.count()) >= 1 ? true : undefined),
      60_000,
      'in-scope file.burst event',
    );
    const texts = await burstEvent.allTextContents();
    console.log(
      `file.burst events (${texts.length}): ${texts.map((t) => t.replace(/\s+/g, ' ').slice(0, 140)).join(' | ')}`,
    );
    expect(texts.some((t) => t.includes('新增') && t.includes('删除'))).toBe(true);

    await burstOps(rig.siblingDir, 80);
    await delay(15_000);
    expect(
      await panel
        .locator('li[data-level]')
        .filter({ hasText: rig.siblingDir.slice(5) })
        .count(),
    ).toBe(0);
    console.log('out-of-scope sibling burst produced no event: yes');

    st.phase = 'feedback gating';
    await writeFile(join(rig.fileDir, 'single.txt'), 'one');
    const recordEvent = panel.locator('li[data-level="record"]').filter({ hasText: 'asi-e2e-files-' });
    await waitFor(
      async () => ((await recordEvent.count()) >= 1 ? true : undefined),
      30_000,
      'record-level file.changed event',
    );
    expect(await recordEvent.first().getAttribute('data-feedback')).toBeNull();
    expect(await recordEvent.first().locator('button[aria-label="有用"]').count()).toBe(0);
    console.log('unregistered record alert has no feedback controls: yes');

    st.phase = 'σ deviation after restart';
    await stop(st.server);
    st.server = undefined;
    const bodyPath = join(rig.home, 'data/asi-sense/body.json');
    const snapshot = JSON.parse(await readFile(bodyPath, 'utf8')) as Record<string, unknown>;
    snapshot.baseline = seededBaselineJson(Date.now());
    await writeFile(bodyPath, JSON.stringify(snapshot), { mode: 0o600 });
    const restarted = await spawnDsh(rig);
    st.server = restarted.server;
    console.log(`Owned helper PIDs (restarted): ${(await waitHelper()).join(',')}`);
    const panel2 = await openPanel(panelPage, restarted.url);
    const anomaly = panel2.locator('li[data-level]').filter({ hasText: 'baseline:memory' }).filter({ hasText: 'σ' });
    await waitFor(
      async () => ((await anomaly.count()) >= 1 ? true : undefined),
      90_000,
      'body.anomaly σ deviation event',
    );
    const anomalyText = (await anomaly.first().textContent()) ?? '';
    console.log(`anomaly event: ${anomalyText.replace(/\s+/g, ' ').trim().slice(0, 200)}`);
    expect(anomalyText).toContain('偏离');
    expect(anomalyText).toContain('σ');
    await waitFor(
      async () => ((await anomaly.first().getAttribute('data-feedback')) !== null ? true : undefined),
      20_000,
      'registered alert feedback controls',
    );
    expect(await anomaly.first().locator('button[aria-label="有用"]').count()).toBe(1);
    expect(await anomaly.first().locator('button[aria-label="噪音"]').count()).toBe(1);
    console.log('registered body.anomaly alert shows feedback controls: yes');
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
    const remaining = helperPids();
    console.log(`pgrep owned helper after stop: ${remaining.length ? remaining.join(' ') : '(none)'}`);
    if (remaining.length) {
      profile.retain();
      process.exitCode = 1;
    }
    await rm(rig.burstDir, { recursive: true, force: true });
    await rm(rig.siblingDir, { recursive: true, force: true });
    await rm(rig.fileDir, { recursive: true, force: true });
  }
}

async function phaseModel(): Promise<void> {
  await using profile = await temporaryProfile();
  const suffix = rand();
  const rig = await prepare(profile, {
    limit: MODEL_BUDGET,
    burstDir: `/tmp/asi-e2e-burst-${suffix}`,
    siblingDir: `/tmp/asi-e2e-burst-${rand()}`,
    fileDir: `/tmp/asi-e2e-files-${rand()}`,
  });
  await mkdir(rig.burstDir, { recursive: true, mode: 0o700 });
  const st: RunState = { phase: 'profile setup' };
  try {
    if (helperPids().length) throw new Error('An ASI helper from this worktree is already running');
    const started = await spawnDsh(rig);
    st.server = started.server;
    st.watchdog = setTimeout(() => {
      console.error('model phase exceeded the 8-minute limit; stopping owned processes');
      void Promise.allSettled([
        st.browser?.close() ?? Promise.resolve(),
        st.server ? stop(st.server) : Promise.resolve(),
      ]).then(() => process.exit(1));
    }, 480_000);
    console.log(`Owned helper PIDs: ${(await waitHelper()).join(',')}`);
    st.browser = await chromium.launch({ headless: true });
    st.context = await st.browser.newContext({ viewport: { width: 1440, height: 900 } });
    const chat = await st.context.newPage();
    const panelPage = await st.context.newPage();
    let browserErrors = 0;
    for (const page of [chat, panelPage]) page.on('pageerror', () => browserErrors++);

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
    await openPanel(panelPage, started.url);

    st.phase = 'background job + in-scope burst';
    // Fabricated conversation text — no real titles or content involved.
    await editor.fill(
      'Use the bash tool once with command `sleep 8; exit 1` and run_in_background set to true. ' +
        'Do not wait for it or call other tools. Reply READY immediately.',
    );
    await chat.getByRole('button', { name: 'Send message', exact: true }).first().click();
    await burstOps(rig.burstDir, 80);
    const found = await waitFor(
      async () => {
        const log = await events(rig.sessionRoot);
        const texts = envMessages(log).map((e) => {
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
        });
        const burst = texts.find((t) => t.includes('file.burst:'));
        const job = texts.find((t) => /exited/.test(t));
        return burst && job ? { texts, burst, job } : undefined;
      },
      180_000,
      'file.burst and job-failure environment messages',
    );
    const { texts, burst, job } = found;
    console.log(`environment messages: ${texts.length}`);
    for (const [i, t] of texts.entries()) console.log(`env[${i}]: ${t.replace(/\s+/g, ' ').slice(0, 240)}`);
    expect(burst).toContain(`asi-e2e-burst-${suffix}`);
    expect(burst).toMatch(/created=\d+/);
    expect(burst).toMatch(/deleted=[1-9]\d*/);
    expect(job).toMatch(/exited 1/);
    for (const t of texts) {
      expect(t).not.toContain(rig.burstDir);
      expect(t).not.toContain('/tmp/');
      expect(t).not.toContain('burstprobe');
      expect(t).not.toContain('window:');
    }
    console.log('env content assertions passed (sanitized dir, counts, no full path/filenames/titles)');

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
    const remaining = helperPids();
    console.log(`pgrep owned helper after stop: ${remaining.length ? remaining.join(' ') : '(none)'}`);
    if (remaining.length) {
      profile.retain();
      process.exitCode = 1;
    }
    await rm(rig.burstDir, { recursive: true, force: true });
    await rm(rig.siblingDir, { recursive: true, force: true });
    await rm(rig.fileDir, { recursive: true, force: true });
  }
}

const phase = process.argv[2] ?? 'all';
if (phase === 'body' || phase === 'all') await phaseBody();
if (phase === 'model' || (phase === 'all' && process.exitCode !== 1)) await phaseModel();
if (!['body', 'model', 'all'].includes(phase)) throw new Error(`unknown phase ${phase}`);
