import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { access, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, expect, type Page } from '@playwright/test';
import { setup } from '../../scripts/e2e-setup.ts';
import { run, stop, temporaryProfile, waitFor, webUrl } from '../../scripts/e2e-support.ts';
import { syntheticBundle } from '../../scripts/e2e-synthetic.ts';
import { createSenseRuntime } from '../../src/host/runtime/index.ts';
import type { SensePorts } from '../../src/host/runtime/ports.ts';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
await using profile = await temporaryProfile();
const dsh = resolve(process.env.DSH_ROOT ?? '');
if (!process.env.DSH_ROOT) throw new Error('Set DSH_ROOT to the read-only DeepSeek Harness checkout');
const cli = join(dsh, 'apps/cli/src/bin.ts');
const picker = join(dsh, 'apps/web/tests/pin-browse-picker.overlay.yml');
await Promise.all([access(cli), access(picker)]);
const args = ['--import', createRequire(join(dsh, 'package.json')).resolve('tsx/esm'), cli];
const root = await realpath(profile.root);
const home = join(root, 'home');
const workspace = join(root, 'deepseek-harness/default-workspace');
const counter = join(root, 'model-requests.txt');
const budgetReady = join(root, 'budget-ready.txt');
const services = join(root, 'service-status.json');
const bodyFile = join(home, 'data/asi-sense/body.json');
const helper = join(pkg, 'lib/asi-sense-helper');
const env = {
  ...process.env,
  DSH_HOME: home,
  DSH_TELEMETRY_DISABLED: '1',
  ASI_MAGPIE_PLACEHOLDER: 'magpie',
  TSX_TSCONFIG_PATH: join(dsh, 'tsconfig.json'),
};
let overlay = '';

function helperPids(): string[] {
  const result = spawnSync('pgrep', ['-f', helper], { encoding: 'utf8' });
  if (result.status !== 0 && result.status !== 1) throw new Error('pgrep failed');
  return result.stdout.trim().split('\n').filter(Boolean);
}

async function seedStorageFailure(): Promise<void> {
  const ports: SensePorts = {
    clock: { wall: Date.now, mono: () => performance.now() },
    dsh: {
      onAgentEvent: () => () => {},
      onTool: () => () => {},
      onJob: () => () => {},
      deliver: async () => {},
      tokenSnapshot: async () => undefined,
    },
    storage: {
      load: async () => undefined,
      save: async (key, value) => {
        if (key === 'body') await writeFile(bodyFile, value, { mode: 0o600 });
      },
    },
    helper: { spawn: () => undefined },
    probe: { create: () => ({ onSample: () => () => {}, start: () => {}, stop: async () => {} }) },
    files: { watch: () => ({ close: () => {} }) },
  };
  const runtime = createSenseRuntime(ports, { platform: 'linux', rules: [] });
  await runtime.start();
  try {
    runtime.body.tuner.disableStorage();
    await runtime.body.monitor.persist();
  } finally {
    await runtime.stop();
  }
}

let server: ChildProcess | undefined;
let browser: Browser | undefined;
let unblockRoute: (() => void) | undefined;
async function shutdown(): Promise<void> {
  unblockRoute?.();
  unblockRoute = undefined;
  const results = await Promise.allSettled([
    browser?.close() ?? Promise.resolve(),
    server ? stop(server) : Promise.resolve(),
  ]);
  browser = undefined;
  server = undefined;
  if (results.some((result) => result.status === 'rejected')) throw new Error('DSH or browser cleanup failed');
  if (helperPids().length) throw new Error('Owned helper remained after shutdown');
}
async function openPanel(): Promise<Page> {
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
    'zero-request budget',
  );
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(url);
  const notice = page.getByRole('button', { name: 'Continue', exact: true });
  if (
    await notice.waitFor({ state: 'visible', timeout: 3000 }).then(
      () => true,
      () => false,
    )
  )
    await notice.click();
  await page.getByRole('button', { name: 'Environment sense', exact: true }).first().click();
  const panel = page.getByTestId('asi-sense-panel');
  await expect(panel.getByRole('heading', { name: '环境感知' })).toBeVisible();
  await panel.locator('summary').filter({ hasText: '规则' }).click();
  return page;
}

try {
  overlay = await setup({
    root,
    home,
    workspace,
    sessionRoot: join(home, 'sessions'),
    counter,
    budgetReady,
    services,
    limit: 0,
  });
  if (helperPids().length) throw new Error('An ASI helper from this worktree is already running');
  await seedStorageFailure();
  const bundle = await syntheticBundle(root, pkg, join(home, 'data/asi-sense'));
  await run(
    process.execPath,
    [...args, '--profile', 'asi-dev', '--from-default-profile', 'web', '--dump-config'],
    workspace,
    env,
  );
  await run(process.execPath, [...args, 'plugin', '--profile', 'asi-dev', 'add', bundle], workspace, env);
  await run(
    process.execPath,
    [...args, 'plugin', '--profile', 'asi-dev', 'add', join(pkg, 'test/dsh/budget-plugin')],
    workspace,
    env,
  );
  let page = await openPanel();
  const resume = page.getByRole('button', { name: '恢复 AI 调参', exact: true });
  await expect(resume).toBeVisible();
  let arrived = false;
  const blocked = new Promise<void>((resolve) => (unblockRoute = resolve));
  await page.route('**/api/**', async (route) => {
    if (route.request().url().includes('resumeTuning')) {
      arrived = true;
      await blocked;
    }
    await route.continue();
  });
  await resume.click();
  await waitFor(async () => arrived || undefined, 10_000, 'resume RPC');
  const pending = page.getByRole('button', { name: '恢复 AI 调参 · 处理中', exact: true });
  await expect(pending).toBeDisabled();
  await pending.locator('..').screenshot({ path: join(root, 'resume-pending.png') });
  unblockRoute?.();
  unblockRoute = undefined;
  await expect(page.getByText('保存调参数据失败，AI 调参已停用')).toHaveCount(0, { timeout: 15_000 });
  const snapshot = JSON.parse(await readFile(bodyFile, 'utf8'));
  expect(snapshot.disabled).toBeUndefined();
  console.log('Resume RPC: pending, then persisted and reflected');
  await shutdown();

  await unlink(budgetReady);
  await writeFile(bodyFile, '{', { mode: 0o600 });
  page = await openPanel();
  await page.getByRole('button', { name: '重置调参', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: '重置调参' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await dialog.screenshot({ path: join(root, 'reset-confirmation.png') });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  console.log('Reset confirmation: Cancel focused');
  const count = (await readFile(counter, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
  expect(count).toBe(0);
  console.log('Screenshots: synthetic host only');
  console.log(`Model requests: ${count}/0`);
} finally {
  await shutdown();
  console.log(`Owned helper after stop: ${helperPids().length}`);
}
