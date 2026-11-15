// 60s real-machine smoke: samples body vitals at the default 2s cadence and
// prints a compact numeric summary every 10s. Prints no host/cwd/pid/network
// addresses or other personal data. /usr/bin/time includes the sampled Node
// process, its loader/startup, and all waited-for child commands in the 1% gate.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BodyProbe } from '../src/index.js';
import type { Body, Fact } from '../src/index.js';

const DURATION_MS = 60_000;
const PRINT_EVERY_MS = 10_000;

if (!process.argv.includes('--sample-worker')) {
  if (process.platform !== 'darwin') {
    console.error('[smoke] requires macOS /usr/bin/time -l');
    process.exit(1);
  }
  const child = spawn('/usr/bin/time', [
    '-l', process.execPath, '--import', 'tsx', fileURLToPath(import.meta.url), '--sample-worker',
  ], { stdio: ['ignore', 'inherit', 'pipe'], env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
  let timing = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { timing += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const match = /^\s*([\d.]+)\s+real\s+([\d.]+)\s+user\s+([\d.]+)\s+sys\s*$/m.exec(timing);
  const [wall, user, sys] = (match?.slice(1) ?? []).map(Number);
  if (code !== 0 || !wall || wall < DURATION_MS / 1000
    || user === undefined || sys === undefined || ![wall, user, sys].every(Number.isFinite)) {
    console.error('[smoke] failed: worker or all-process timing unavailable');
    process.exit(1);
  }
  const totalCpuPct = (user + sys) / wall * 100;
  console.log(`[smoke] timed elapsed=${wall.toFixed(2)}s user=${user.toFixed(2)}s sys=${sys.toFixed(2)}s totalCpuPct=${totalCpuPct.toFixed(3)} includesChildCpu=true`);
  process.exit(totalCpuPct >= 1 ? 1 : 0);
}

const show = <T>(f: Fact<T>, render: (v: NonNullable<T>) => string): string =>
  f.status === 'ok' && f.value !== null ? render(f.value as NonNullable<T>) : f.status;

const probe = new BodyProbe();
let latest: Body | null = null;
let samples = 0;
let wallBase = 0;
let printer: NodeJS.Timeout | undefined;
let finished = false;

const report = () => {
  if (!latest) return;
  const b = latest;
  const elapsed = (performance.now() - wallBase) / 1000;
  console.log(`[smoke] ${[
    `elapsed=${elapsed.toFixed(1)}s`,
    `samples=${samples}`,
    `cpu=${show(b.cpu, (v) => `${(v.usage * 100).toFixed(1)}%`)}`,
    `memUsed=${show(b.memory, (v) => `${(v.used / 2 ** 30).toFixed(2)}GiB`)}`,
    `memCached=${show(b.memory, (v) => v.cached === undefined ? 'unknown' : `${(v.cached / 2 ** 30).toFixed(2)}GiB`)}`,
    `pressure=${show(b.memory, (v) => v.pressure)}`,
    `diskFree=${show(b.disks, (v) => (v[0] ? `${(v[0].free / 2 ** 30).toFixed(1)}GB` : 'unavailable'))}`,
    `net=${show(b.network, (v) => `rx=${(v.rxBps / 1024).toFixed(1)}kB/s tx=${(v.txBps / 1024).toFixed(1)}kB/s`)}`,
    `procRSS=${show(b.harnessProcess, (v) => `${(v.rss / 2 ** 20).toFixed(0)}MB`)}`,
    `tokens=${b.tokens.status}`,
    `thermal=${b.thermal.status}`,
  ].join(' ')}`);
};

const shutdown = async (code: number) => {
  if (finished) return;
  finished = true;
  if (printer) clearInterval(printer);
  await probe.stop();
  const wallMs = performance.now() - wallBase;
  report();
  console.log(`[smoke] done samples=${samples} elapsed=${(wallMs / 1000).toFixed(1)}s`);
  process.exit(code);
};

process.on('SIGINT', () => { void shutdown(130); });

wallBase = performance.now();
probe.start();
probe.onSample((b) => { samples += 1; latest = b; });
printer = setInterval(report, PRINT_EVERY_MS);
try {
  await new Promise<void>((res) => setTimeout(res, DURATION_MS));
} finally {
  await shutdown(0);
}
