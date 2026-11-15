// 60s real-machine smoke: samples body vitals at the default 2s cadence and
// prints a compact numeric summary every 10s. Prints no host/cwd/pid/network
// addresses or other personal data. Exits nonzero if the sampler itself
// averages >= 1% of this Node process's CPU (child command CPU excluded).
import { BodyProbe } from '../src/index.js';
import type { Body, Fact } from '../src/index.js';

const DURATION_MS = 60_000;
const PRINT_EVERY_MS = 10_000;

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
    `memUsed=${show(b.memory, (v) => `${(v.used / 2 ** 30).toFixed(2)}GB`)}`,
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
  const cpuUsed = process.cpuUsage(cpuBase);
  const wallMs = performance.now() - wallBase;
  const avgProcessCpuPct = ((cpuUsed.user + cpuUsed.system) / 1000) / wallMs * 100;
  report();
  console.log(`[smoke] done samples=${samples} elapsed=${(wallMs / 1000).toFixed(1)}s avgProcessCpuPct=${avgProcessCpuPct.toFixed(3)}`);
  console.log('[smoke] avgProcessCpuPct covers this Node process only; child command CPU is excluded');
  process.exit(code !== 0 ? code : avgProcessCpuPct >= 1 ? 1 : 0);
};

process.on('SIGINT', () => { void shutdown(130); });

// Baselines start here: nothing before this line is counted.
const cpuBase = process.cpuUsage();
wallBase = performance.now();
probe.start();
probe.onSample((b) => { samples += 1; latest = b; });
printer = setInterval(report, PRINT_EVERY_MS);
try {
  await new Promise<void>((res) => setTimeout(res, DURATION_MS));
} finally {
  await shutdown(0);
}
