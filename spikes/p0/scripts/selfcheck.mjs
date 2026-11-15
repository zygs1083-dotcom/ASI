/**
 * Spike self-check: run the compiled helper briefly and validate that every
 * stdout line is NDJSON with a string `type`, that the first two events are
 * `permission` and `thermal`, and that no real title text ever leaves the
 * helper (the only allowed title value is "[REDACTED]").
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const helper = `${root}/.build/asi-sense-helper`
if (!existsSync(helper)) {
  console.error(`selfcheck: helper missing at ${helper} (run pnpm run helper)`)
  process.exit(1)
}

const child = spawn(helper, [], { stdio: ['ignore', 'pipe', 'pipe'] })
const lines = []
let buffer = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', chunk => {
  buffer += chunk
  let newline = buffer.indexOf('\n')
  while (newline >= 0) {
    lines.push(buffer.slice(0, newline))
    buffer = buffer.slice(newline + 1)
    newline = buffer.indexOf('\n')
  }
})

await new Promise(done => setTimeout(done, 3000))
child.kill('SIGTERM')

const failures = []
if (lines.length < 2) failures.push(`expected >=2 NDJSON lines, got ${lines.length}`)

const events = []
for (const line of lines) {
  let value
  try { value = JSON.parse(line) } catch {
    failures.push(`non-JSON line: ${line.slice(0, 80)}`)
    continue
  }
  if (typeof value !== 'object' || value === null || typeof value.type !== 'string') {
    failures.push(`line lacks string type: ${line.slice(0, 80)}`)
    continue
  }
  events.push(value)
}

if (events[0]?.type !== 'permission') failures.push(`first event is ${events[0]?.type}, expected permission`)
if (typeof events[0]?.axTrusted !== 'boolean') failures.push('permission event lacks boolean axTrusted')
if (events[1]?.type !== 'thermal') failures.push(`second event is ${events[1]?.type}, expected thermal`)

for (const event of events) {
  if (event.title !== undefined && event.title !== '[REDACTED]') {
    failures.push(`unredacted title escaped helper: ${String(event.title).slice(0, 40)}`)
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`selfcheck: FAIL ${failure}`)
  process.exit(1)
}
console.log(`selfcheck: ${events.length} helper events valid (permission axTrusted=${events[0].axTrusted}, thermal=${events[1].state})`)
