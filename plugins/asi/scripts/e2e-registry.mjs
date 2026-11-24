import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dsh = process.env.DSH_ROOT;
if (!dsh) throw new Error('Set DSH_ROOT to the read-only fixed-version DSH checkout');
const cli = ['--import', createRequire(join(dsh, 'package.json')).resolve('tsx/esm'), join(dsh, 'apps/cli/src/bin.ts')];
const root = await mkdtemp(join(tmpdir(), 'asi-registry-'));
const home = join(root, 'dsh-home');
const workspace = join(root, 'workspace');
const profile = join(home, 'profiles/asi-registry');
const stage = join(root, 'fixture');
const env = {
  HOME: root,
  PATH: process.env.PATH,
  TMPDIR: root,
  DSH_HOME: home,
  DSH_TELEMETRY_DISABLED: '1',
  ASI_LOCAL_FIXTURE: 'fixture',
  TSX_TSCONFIG_PATH: join(dsh, 'tsconfig.json'),
  npm_config_userconfig: join(root, 'user-npmrc'),
  npm_config_globalconfig: join(root, 'global-npmrc'),
};
let server;
let browser;
let registry;

async function command(executable, args) {
  const child = spawn(executable, args, { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => (output += chunk));
  const status = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (status !== 0) throw new Error(`${executable} exited ${status}: ${output.slice(-4000)}`);
  return output;
}

async function stop(child) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => child.once('close', resolve));
  }
}

async function startWeb() {
  server = spawn(
    process.execPath,
    [
      ...cli,
      '--profile',
      'asi-registry',
      '--patch',
      join(root, 'overlay.yml'),
      '--no-open',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
    ],
    { cwd: workspace, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const web = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('DSH did not start')), 60_000);
    const data = (chunk) => {
      output += chunk;
      const url = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0];
      if (url) {
        clearTimeout(timer);
        resolve(url);
      }
    };
    server.stdout.on('data', data);
    server.stderr.on('data', data);
    server.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`DSH exited before readiness: ${code}`));
    });
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
  await page.goto(web);
  const notice = page.getByRole('button', { name: 'Continue', exact: true });
  if (
    await notice.waitFor({ state: 'visible', timeout: 30_000 }).then(
      () => true,
      () => false,
    )
  ) {
    await notice.click();
    await page.getByRole('dialog', { name: 'Preview Notice' }).waitFor({ state: 'hidden', timeout: 30_000 });
  }
  await page.getByRole('button', { name: 'Plugins', exact: true }).first().click({ timeout: 30_000 });
  await page.locator('[data-plugin-package="asi"]').click({ timeout: 30_000 });
  return page;
}

try {
  await Promise.all([
    mkdir(profile, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(stage, { recursive: true }),
    writeFile(join(root, 'user-npmrc'), ''),
    writeFile(join(root, 'global-npmrc'), ''),
  ]);
  const version = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8')).version;
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  assert.ok(parts, 'Fixture expects a stable version');
  const next = `${parts[1]}.${parts[2]}.${Number(parts[3]) + 1}`;
  const archive = join(pkg, 'dist', `asi-${version}.tgz`);
  await command('tar', ['-xzf', archive, '-C', stage]);
  const first = JSON.parse(await readFile(join(stage, 'package/package.json'), 'utf8'));
  const second = { ...first, version: next };
  await writeFile(join(stage, 'package/package.json'), JSON.stringify(second));
  await command('tar', ['-czf', join(root, 'second.tgz'), '-C', stage, 'package']);
  const blobs = { [version]: await readFile(archive), [next]: await readFile(join(root, 'second.tgz')) };
  const requests = [];
  let latest = version;
  registry = createServer((req, res) => {
    requests.push({ method: req.method, path: req.url });
    if (req.url === '/asi') {
      const versions = Object.fromEntries(
        [first, ...(latest === next ? [second] : [])].map((manifest) => {
          const body = blobs[manifest.version];
          return [
            manifest.version,
            {
              ...manifest,
              dist: {
                tarball: `http://127.0.0.1:${registry.address().port}/asi/-/asi-${manifest.version}.tgz`,
                shasum: createHash('sha1').update(body).digest('hex'),
                integrity: `sha512-${createHash('sha512').update(body).digest('base64')}`,
              },
            },
          ];
        }),
      );
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          name: 'asi',
          'dist-tags': { latest },
          versions,
          time: { [version]: '2026-01-01T00:00:00.000Z', [next]: '2026-01-02T00:00:00.000Z' },
        }),
      );
      return;
    }
    const requested = Object.keys(blobs).find((item) => req.url === `/asi/-/asi-${item}.tgz`);
    if (requested) return res.end(blobs[requested]);
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
  });
  await new Promise((resolve) => registry.listen(0, '127.0.0.1', resolve));
  const registryUrl = `http://127.0.0.1:${registry.address().port}/`;
  await mkdir(join(home, 'data/asi/sense'), { recursive: true });
  const settings = JSON.stringify({
    version: 1,
    paused: true,
    sendTitles: false,
  });
  const settingsPath = join(home, 'data/asi/sense/settings.json');
  await writeFile(settingsPath, settings);
  await command(process.execPath, [
    ...cli,
    '--profile',
    'asi-registry',
    '--from-default-profile',
    'web',
    '--dump-config',
  ]);
  const authLine = '//registry.invalid/:_authToken=fixture-token';
  await writeFile(join(profile, '.npmrc'), `registry=${registryUrl}old/\nstrict-ssl=false\n${authLine}\n`);
  await command(process.execPath, [...cli, 'plugin', '--profile', 'asi-registry', 'add', archive]);
  const manifestPath = join(profile, 'package.json');
  const readProfile = async () => JSON.parse(await readFile(manifestPath, 'utf8'));
  const saveProfile = async (manifest) => writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const initial = await readProfile();
  assert.match(initial.dependencies.asi, /^file:/);
  assert.ok(initial.dsh.profile.bundles.includes('asi'));
  const enabled = initial.dsh.profile.bundles.filter((name) => name !== 'asi');
  enabled.splice(Math.floor(enabled.length / 2), 0, 'asi');
  initial.dsh.profile.bundles = enabled;
  await saveProfile(initial);
  await command('npm', ['--prefix', profile, 'config', 'set', 'registry', registryUrl, '--location=project']);
  assert.equal((await command('pnpm', ['--dir', profile, 'config', 'get', 'registry'])).trim(), registryUrl);
  assert.match(await readFile(join(profile, '.npmrc'), 'utf8'), /strict-ssl=false/);
  assert.ok((await readFile(join(profile, '.npmrc'), 'utf8')).includes(authLine));
  await command(process.execPath, [...cli, 'plugin', '--profile', 'asi-registry', 'add', `asi@${version}`]);
  assert.deepEqual((await readProfile()).dsh.profile.bundles, enabled);
  await command(process.execPath, [...cli, 'plugin', '--profile', 'asi-registry', 'add', archive]);
  assert.deepEqual((await readProfile()).dsh.profile.bundles, enabled);
  assert.match((await readProfile()).dependencies.asi, /^file:/);
  const disabled = await readProfile();
  disabled.dsh.profile.bundles = enabled.filter((name) => name !== 'asi');
  await saveProfile(disabled);
  await command(process.execPath, [...cli, 'plugin', '--profile', 'asi-registry', 'add', `asi@${version}`]);
  const installed = JSON.parse(await readFile(join(profile, 'node_modules/asi/package.json'), 'utf8'));
  const profileManifest = await readProfile();
  assert.equal(installed.version, version);
  assert.equal(profileManifest.dependencies.asi.replace(/^[~^]/, ''), version);
  assert.deepEqual(profileManifest.dsh.profile.bundles, disabled.dsh.profile.bundles);
  assert.ok(!profileManifest.dsh.profile.bundles.includes('asi'));
  await assert.rejects(() =>
    command(process.execPath, [...cli, 'plugin', '--profile', 'asi-registry', 'add', 'asi@99.99.99']),
  );
  assert.deepEqual((await readProfile()).dsh.profile.bundles, disabled.dsh.profile.bundles);
  assert.equal((await readProfile()).dependencies.asi, profileManifest.dependencies.asi);
  assert.equal(JSON.parse(await readFile(join(profile, 'node_modules/asi/package.json'), 'utf8')).version, version);
  assert.equal(await readFile(settingsPath, 'utf8'), settings);
  await writeFile(
    join(root, 'overlay.yml'),
    `- id: llm-pi-ai
  config:
    providers:
      fixture:
        displayName: Local fixture
        apiKeyEnv: ASI_LOCAL_FIXTURE
        api: openai-completions
        baseURL: ${registryUrl}fixture/v1
        models:
          - id: fixture
            name: Fixture
- id: agent-default-model
  config:
    provider: fixture
    model: fixture
- id: session-telemetry-otel
  disabled: true
- id: desktop-product-telemetry
  disabled: true
- id: product-analytics
  disabled: true
`,
  );
  await startWeb();
  await browser.close();
  browser = undefined;
  await stop(server);
  server = undefined;
  latest = next;
  const page = await startWeb();
  const update = page.getByRole('button', { name: `Update to ${next}`, exact: true }).first();
  await update.waitFor({ timeout: 60_000 });
  await update.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Update', exact: true }).click();
  await page.locator('[data-plugin-update="done"]').waitFor({ timeout: 120_000 });
  const updated = JSON.parse(await readFile(join(profile, 'node_modules/asi/package.json'), 'utf8'));
  assert.equal(updated.version, next);
  assert.deepEqual((await readProfile()).dsh.profile.bundles, disabled.dsh.profile.bundles);
  assert.equal(await readFile(settingsPath, 'utf8'), settings);
  assert.ok(requests.filter(({ path }) => path === '/asi').length >= 2);
  assert.ok(requests.every(({ method, path }) => method === 'GET' && !path.startsWith('/fixture/')));
} finally {
  try {
    if (browser) await browser.close();
  } finally {
    try {
      await stop(server);
    } finally {
      try {
        if (registry) await new Promise((resolve) => registry.close(resolve));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
}
