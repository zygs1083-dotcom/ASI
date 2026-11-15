// macOS CPU time deltas / wall time; 100% denotes one fully occupied logical CPU.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout } from 'node:timers/promises'

const pids = process.argv.slice(2, 4).map(Number)
if (pids.length !== 2 || pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) {
  throw new Error('usage: node measure-processes.mjs <host-pid> <helper-pid> <output.json>')
}
const output = resolve(process.argv[4])
const cpuSeconds = value => {
  const parts = value.split(':').map(Number)
  return parts.reduce((seconds, part) => seconds * 60 + part, 0)
}
const start = performance.now()
const samples = []
for (let index = 0; index <= 30; index++) {
  const delay = start + index * 2000 - performance.now()
  if (delay > 0) await setTimeout(delay)
  const text = execFileSync('ps', ['-p', pids.join(','), '-o', 'pid=,time=,rss=,%cpu='], { encoding: 'utf8' })
  const processes = text.trim().split('\n').map(line => {
    const [pid, time, rss, psCpu] = line.trim().split(/\s+/)
    return { pid: Number(pid), cpuSeconds: cpuSeconds(time), rssKiB: Number(rss), psCpu: Number(psCpu) }
  })
  if (processes.length !== 2 || pids.some(pid => !processes.some(row => row.pid === pid))) {
    throw new Error('measured process exited; incomplete run')
  }
  samples.push({ elapsedSec: (performance.now() - start) / 1000, processes })
}
const first = samples[0]
const last = samples.at(-1)
const elapsedSec = last.elapsedSec - first.elapsedSec
const result = {
  capturedAt: new Date().toISOString(), elapsedSec,
  method: '31 ps samples at 2s; average CPU = 100 * delta cumulative CPU seconds / elapsed wall seconds; RSS in KiB',
  processes: pids.map(pid => {
    const initial = first.processes.find(row => row.pid === pid)
    const final = last.processes.find(row => row.pid === pid)
    return { pid, cpuPercent: 100 * (final.cpuSeconds - initial.cpuSeconds) / elapsedSec,
      rssMinKiB: Math.min(...samples.map(sample => sample.processes.find(row => row.pid === pid).rssKiB)),
      rssMaxKiB: Math.max(...samples.map(sample => sample.processes.find(row => row.pid === pid).rssKiB)) }
  }),
  samples,
}
writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ elapsedSec, processes: result.processes }, null, 2))
