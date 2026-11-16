import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, expect, type Page } from '@playwright/test';
import { checkFileHost, setupFileHost } from './e2e-file-host.ts';
import { setup } from './e2e-setup.ts';
import {
  bashCommands,
  delay,
  emptyResponse,
  envFollowups,
  envInjections,
  envMessages,
  events,
  record,
  run,
  stop,
  temporaryProfile,
  waitFor,
  wakeDiagnostics,
  webUrl,
} from './e2e-support.ts';
import { syntheticBundle } from './e2e-synthetic.ts';
import { checkResponsive, screenshotDesktop } from './e2e-ui.ts';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await using profile = await temporaryProfile();
const dshRoot = process.env.DSH_ROOT;
if (!dshRoot) throw new Error('Set DSH_ROOT to the read-only DeepSeek Harness source checkout');
const dsh = resolve(dshRoot);
const cli = join(dsh, 'apps/cli/src/bin.ts');
const picker = join(dsh, 'apps/web/tests/pin-browse-picker.overlay.yml');
await Promise.all([access(cli), access(picker)]);
const tsx = createRequire(join(dsh, 'package.json')).resolve('tsx/esm');
const args = ['--import', tsx, cli];
const root = await realpath(profile.root);
const home = join(root, 'home');
const workspace = join(root, 'deepseek-harness/default-workspace');
const counter = join(root, 'model-requests.txt');
const budgetReady = join(root, 'budget-ready.txt');
const services = join(root, 'service-status.json');
const sessionRoot = join(home, 'sessions');
const helper = join(pkg, 'lib/asi-sense-helper');
const synthetic = process.env.ASI_E2E_SYNTHETIC === '1';
const fileTest = process.env.ASI_E2E_FILE_TEST === '1';
if (synthetic && process.env.ASI_E2E_NO_MODEL !== '1') throw new Error('Synthetic mode requires ASI_E2E_NO_MODEL=1');
if (fileTest && (synthetic || process.env.ASI_E2E_NO_MODEL !== '1'))
  throw new Error('File test requires real no-model mode');
const limit = process.env.ASI_E2E_NO_MODEL === '1' ? 0 : Number(process.env.ASI_E2E_MODEL_BUDGET ?? '6');
if (!Number.isInteger(limit) || limit < 0 || limit > 6) throw new Error('Invalid E2E model request budget');
const env = {
  ...process.env,
  DSH_HOME: home,
  DSH_TELEMETRY_DISABLED: '1',
  ASI_MAGPIE_PLACEHOLDER: 'magpie',
  TSX_TSCONFIG_PATH: join(dsh, 'tsconfig.json'),
};
const fixtureFile = join(workspace, 'agent-created.txt');

function helperPids(): string[] {
  const result = spawnSync('pgrep', ['-f', helper], { encoding: 'utf8' });
  if (result.status !== 0 && result.status !== 1) throw new Error('pgrep failed');
  return result.stdout.trim().split('\n').filter(Boolean);
}
async function count(): Promise<number> {
  const text = await readFile(counter, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).length;
}
async function prompt(page: Page, text: string): Promise<void> {
  await page.locator('[contenteditable="true"]').first().fill(text);
  await page.getByRole('button', { name: 'Send message', exact: true }).first().click();
}

let server: ChildProcess | undefined;
let browser: Browser | undefined;
let phase = 'profile setup';
let backgroundTurn: number | undefined;
try {
  if (helperPids().length) throw new Error('An ASI helper from this worktree is already running');
  const overlay = await setup({ root, home, workspace, sessionRoot, counter, budgetReady, services, limit });
  const bundle = synthetic ? await syntheticBundle(root, pkg) : pkg;
  await run(
    process.execPath,
    [...args, '--profile', 'asi-dev', '--from-default-profile', 'web', '--dump-config'],
    workspace,
    env,
  );
  if (fileTest) {
    const plugin = await setupFileHost(root, workspace, overlay);
    await run(process.execPath, [...args, 'plugin', '--profile', 'asi-dev', 'add', plugin], workspace, env);
  }
  await run(process.execPath, [...args, 'plugin', '--profile', 'asi-dev', 'add', bundle], workspace, env);
  await run(
    process.execPath,
    [...args, 'plugin', '--profile', 'asi-dev', 'add', join(pkg, 'test/dsh/budget-plugin')],
    workspace,
    env,
  );
  phase = 'DSH startup';
  server = spawn(
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
  console.log(`Owned DSH PID: ${server.pid}`);
  const url = await webUrl(server);
  server.stdout?.resume();
  server.stderr?.resume();
  await waitFor(
    async () =>
      (await access(budgetReady).then(
        () => true,
        () => false,
      )) || undefined,
    10_000,
    'request budget',
  );
  if (!synthetic) {
    const pids = await waitFor(
      async () => {
        const pids = helperPids();
        return pids.length ? pids : undefined;
      },
      20_000,
      'helper startup',
    );
    console.log(`Owned helper PIDs: ${pids.join(',')}`);
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const chat = await context.newPage();
  const panelPage = await context.newPage();
  let browserErrors = 0;
  for (const page of [chat, panelPage]) page.on('pageerror', () => browserErrors++);
  phase = 'sidebar and privacy';
  await chat.goto(url);
  const notice = chat.getByRole('button', { name: 'Continue', exact: true });
  if (
    await notice.waitFor({ state: 'visible', timeout: 5000 }).then(
      () => true,
      () => false,
    )
  )
    await notice.click();
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
    await pathInput.fill(workspace);
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
  await expect(chat.getByRole('button', { name: 'Send message', exact: true }).first()).toBeVisible();
  await panelPage.goto(url);
  const otherNotice = panelPage.getByRole('button', { name: 'Continue', exact: true });
  if (
    await otherNotice.waitFor({ state: 'visible', timeout: 3000 }).then(
      () => true,
      () => false,
    )
  )
    await otherNotice.click();
  await panelPage.getByRole('button', { name: 'Environment sense', exact: true }).first().click();
  const panel = panelPage.getByTestId('asi-sense-panel');
  await expect(panel.getByRole('heading', { name: '环境感知' })).toBeVisible();
  await panel.locator('summary').filter({ hasText: '规则' }).click();
  await expect(panel.getByLabel('窗口标题发给模型')).not.toBeChecked();
  for (const metric of ['cpu', 'memory', 'disks']) {
    await expect(panel.locator(`[data-tile="${metric}"]`)).toContainText(/\d/, { timeout: 25_000 });
  }
  if (fileTest) {
    phase = 'real DSH file monitoring and latency';
    await checkFileHost(root, workspace, sessionRoot, panel);
  }
  if (process.env.ASI_E2E_NO_MODEL !== '1' && process.env.ASI_E2E_ONLY_BACKGROUND !== '1') {
    phase = 'agent self-caused failure';
    await prompt(
      chat,
      process.env.ASI_E2E_TEST_TOOL === '1'
        ? 'Use the bash tool once to run the foreground command `false`, and call env_state with section self once. Do not call other tools or retry. When done reply READY.'
        : 'Use the bash tool for exactly two separate calls: run the foreground command false; then run the foreground command printf test > agent-created.txt in the session working directory. Do not call other tools or retry. When done reply READY.',
    );
    await waitFor(
      async () => {
        const log = await events(sessionRoot);
        const empty = emptyResponse(log);
        if (empty !== undefined) throw new Error(`Gateway EMPTY_RESPONSE: ${empty}`);
        const commands = bashCommands(log);
        const fileExists = await access(fixtureFile).then(
          () => true,
          () => false,
        );
        return commands.some((command) => command.trim() === 'false') &&
          (process.env.ASI_E2E_TEST_TOOL === '1'
            ? log.some((event) => event.type === 'tool/call' && record(event.data).name === 'env_state')
            : commands.some((command) => command.includes('agent-created.txt')) && fileExists) &&
          log.some((event) => event.type === 'turn/end')
          ? log
          : undefined;
      },
      120_000,
      'agent failing shell operation',
    );
    await delay(3000);
    const first = await events(sessionRoot);
    expect(envFollowups(first)).toHaveLength(0);
    expect(envInjections(first)).toHaveLength(0);
    expect(envMessages(first)).toHaveLength(0);
    const failedShell = panel
      .locator('li[data-level]')
      .filter({ hasText: 'false' })
      .filter({ hasText: 'self-caused' })
      .filter({ hasText: 'Agent 自己引起' });
    if (process.env.ASI_E2E_TEST_TOOL === '1') {
      phase = 'agent env_state tool';
      const log = await waitFor(
        async () => {
          const current = await events(sessionRoot);
          const call = current.find((event) => event.type === 'tool/call' && record(event.data).name === 'env_state');
          if (!call) return undefined;
          const callId = record(call.data).callId;
          const result = current.find(
            (event) =>
              event.type === 'tool/result' && record(record(record(event.data).message).source).callId === callId,
          );
          return result ? { call, result } : undefined;
        },
        120_000,
        'agent env_state result',
      );
      const message = record(record(log.result.data).message);
      expect(message.isError).not.toBe(true);
      expect(record(log.result.data).error).toBeUndefined();
      const content = Array.isArray(message.content) ? message.content : [];
      const text = content.map(record).find((part) => part.type === 'text')?.text;
      expect(typeof text).toBe('string');
      const state = record(JSON.parse(String(text)));
      const body = record(state.body);
      for (const metric of ['cpu', 'memory', 'disks', 'network', 'harnessProcess']) {
        const fact = record(body[metric]);
        expect(typeof fact.status).toBe('string');
        expect(fact).toHaveProperty('value');
        expect(fact).toHaveProperty('source');
      }
      console.log('env_state: real agent tool call and structured self.body result passed');
    }
    phase = 'self-caused DOM status';
    await expect(failedShell.first()).toHaveCount(1, { timeout: 10_000 });
    console.log(
      `b1: zero followups and injections; self-caused DOM level=${await failedShell.first().getAttribute('data-level')}`,
    );
    if (process.env.ASI_E2E_TEST_TOOL !== '1')
      await expect(
        panel
          .locator('li[data-level]')
          .filter({ hasText: 'agent-created.txt' })
          .filter({ hasText: 'self-caused' })
          .filter({ hasText: 'Agent 自己引起' })
          .first(),
      ).toHaveCount(1, { timeout: 10_000 });
    await expect(failedShell.first()).toHaveAttribute('data-level', 'suppressed');
    await expect(failedShell.first()).toContainText('已抑制');
    console.log('b1: self-caused event is shown as suppressed');
  }
  if (process.env.ASI_E2E_NO_MODEL !== '1' && process.env.ASI_E2E_ONLY_SELF !== '1') {
    const baseline = envMessages(await events(sessionRoot)).length;
    phase = 'b2 initial background command';
    await prompt(
      chat,
      'Use the bash tool once with command `sleep 20; exit 1` and run_in_background set to true. Do not wait for it or call other tools. Reply READY immediately. When an environment update arrives, reply ACK without calling any tools.',
    );
    const initial = await waitFor(
      async () => {
        const current = await events(sessionRoot);
        const end = current.find((event) => event.type === 'turn/end');
        return end ? { log: current, end } : undefined;
      },
      120_000,
      'initial background turn completion',
    );
    const turn = record(initial.end.data).turn;
    if (typeof turn !== 'number') throw new Error('Initial background turn has no turn number');
    backgroundTurn = turn;
    expect(record(record(initial.end.data).reason).kind).toBe('completed');
    const bash = initial.log.find((event) => {
      const data = record(event.data);
      if (event.type !== 'tool/call' || data.name !== 'bash' || typeof data.arguments !== 'string') return false;
      const args = record(JSON.parse(data.arguments));
      return (
        typeof args.command === 'string' &&
        args.command.includes('sleep 20') &&
        args.command.includes('exit 1') &&
        args.run_in_background === true
      );
    });
    expect(bash).toBeDefined();
    expect(envMessages(initial.log)).toHaveLength(baseline);
    const jobNotice = initial.log.some(
      (event) =>
        event.type === 'agent/inbox/spliced' &&
        Array.isArray(record(event.data).inserted) &&
        (record(event.data).inserted as unknown[]).some((item) => record(record(item).source).kind === 'tool-jobs'),
    );
    expect(jobNotice).toBe(false);
    const failedJob = panel.locator('li[data-level]').filter({ hasText: 'sleep 20' }).filter({ hasText: 'job-failed' });
    expect(await failedJob.count()).toBe(0);
    phase = 'b2 background failure';
    await expect(failedJob.first()).toHaveCount(1, { timeout: 120_000 });
    phase = 'b2 woken turn completion';
    await waitFor(
      async () => {
        const current = await events(sessionRoot);
        const diagnostics = wakeDiagnostics(current, backgroundTurn);
        return diagnostics.status !== '等待后台失败' &&
          diagnostics.status !== '等待唤醒超时' &&
          diagnostics.status !== '唤醒已发生但回复未完成'
          ? diagnostics
          : undefined;
      },
      120_000,
      'woken model turn completion',
    );
    let current = await events(sessionRoot);
    let diagnostics = wakeDiagnostics(current, backgroundTurn);
    console.log('b2 diagnostics:', JSON.stringify(diagnostics));
    expect(diagnostics.status).toBe('完成');
    expect(envMessages(current)).toHaveLength(baseline + 1);
    await delay(4000);
    current = await events(sessionRoot);
    diagnostics = wakeDiagnostics(current, backgroundTurn);
    console.log('b2 diagnostics after 4s:', JSON.stringify(diagnostics));
    expect(diagnostics.status).toBe('完成');
    expect(envMessages(current)).toHaveLength(baseline + 1);
    await expect(panel.locator('[data-tile="tokens"]')).toContainText(/\d/, { timeout: 20_000 });
    console.log('b2: exactly one new turn and environment message; turn completed with nonempty reply');
  }
  let shots: string | undefined;
  if (synthetic) {
    if (helperPids().length) throw new Error('Synthetic mode unexpectedly started a helper');
    await mkdir('/tmp/asi-sense-e2e-shots', { recursive: true, mode: 0o700 });
    shots = await mkdtemp('/tmp/asi-sense-e2e-shots/run-');
    await screenshotDesktop(panelPage, panel, join(shots, 'asi-sense.png'));
  }
  await checkResponsive(panelPage, panel, shots ? join(shots, 'asi-sense-mobile.png') : undefined);
  expect(browserErrors).toBe(0);
  expect(await count()).toBeLessThanOrEqual(limit);
  console.log(`Model request upper bound: ${await count()}/${limit}`);
  if (shots)
    console.log(`Synthetic screenshots: ${join(shots, 'asi-sense.png')} ${join(shots, 'asi-sense-mobile.png')}`);
} catch (error) {
  console.error(
    `DSH e2e failed during ${phase} (${error instanceof Error ? error.name : 'unknown error'}); model request upper bound ${await count()}/${limit}`,
  );
  if (error instanceof Error && error.message.startsWith('Timed out waiting for ')) console.error(error.message);
  if (phase.startsWith('b2 ')) {
    const log = await events(sessionRoot);
    console.error('b2 diagnostics:', JSON.stringify(wakeDiagnostics(log, backgroundTurn)));
  }
  const serviceStatus = await readFile(services, 'utf8').catch(() => '');
  if (serviceStatus) console.error(`DSH services: ${serviceStatus}`);
  process.exitCode = 1;
} finally {
  const cleanup = await Promise.allSettled([
    browser?.close() ?? Promise.resolve(),
    server ? stop(server) : Promise.resolve(),
  ]);
  if (cleanup.some((result) => result.status === 'rejected')) {
    console.error(`Browser cleanup: ${cleanup[0].status}; DSH cleanup: ${cleanup[1].status}`);
    process.exitCode = 1;
  }
  const remaining = helperPids();
  console.log(`pgrep owned helper after stop: ${remaining.length ? remaining.join(' ') : '(none)'}`);
  if (remaining.length) {
    console.error('Owned helper process remained after DSH shutdown');
    process.exitCode = 1;
  }
}
