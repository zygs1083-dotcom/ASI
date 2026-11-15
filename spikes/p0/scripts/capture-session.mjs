// Read only this spike's synthetic session; never export prompts or environment data.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const root = resolve(import.meta.dirname, '..')
const session = resolve(root, 'tmp/dsh-home/sessions/--Users-wangying-Documents-deepseek-harness-default-workspace--/session-ebe08918-cf4b-4137-8f1a-6ad9af4cec8d/session.v4.jsonl.zstd')
const rows = zstdDecompressSync(readFileSync(session)).toString().trim().split('\n').map(JSON.parse)
const summary = {
  capturedAt: new Date().toISOString(),
  sessionId: rows[0].id,
  modelRequests: rows.filter(row => row.type === 'request/header').length,
  turnStarts: rows.filter(row => row.type === 'turn/start').map(row => ({ seq: row.seq, time: row.time, turn: row.data.turn })),
  turnEnds: rows.filter(row => row.type === 'turn/end').map(row => ({ seq: row.seq, time: row.time, reason: row.data.reason })),
  contexts: rows.filter(row => row.type === 'request/context').map(row => ({ seq: row.seq, ...row.data })),
  environmentInbox: rows.filter(row => row.type === 'agent/inbox/spliced')
    .flatMap(row => (row.data.inserted ?? []).filter(message => message.source?.kind === 'environment')
      .map(message => ({ seq: row.seq, time: row.time, target: row.data.target, source: message.source,
        text: message.content.filter(block => block.type === 'text').map(block => block.text).join('') }))),
  environmentMessages: rows.filter(row => row.type === 'user/message' && row.data.source?.kind === 'environment')
    .map(row => ({ seq: row.seq, source: row.data.source,
      text: row.data.content.filter(block => block.type === 'text').map(block => block.text).join('') })),
  replies: rows.filter(row => row.type === 'assistant/message').map(row => ({
    seq: row.seq,
    text: row.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('').slice(0, 200),
    usage: row.data.usage,
    toolCalls: row.data.message.content.filter(block => block.type === 'tool-call').length,
  })),
}
const output = JSON.stringify(summary, null, 2) + '\n'
if (process.argv[2]) writeFileSync(resolve(process.argv[2]), output)
process.stdout.write(output)
