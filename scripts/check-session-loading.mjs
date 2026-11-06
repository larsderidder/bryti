/** Exercise an oversized archive under a small V8 heap, with no provider calls. */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { openBoundedSession } from '../dist/compaction/session-loading.js'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bryti-bounded-session-'))
async function hash(file) {
  const digest = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) {
    digest.update(chunk)
  }
  return digest.digest('hex')
}
try {
  const original = SessionManager.create(directory, directory)
  original.appendMessage({ role: 'user', content: 'Inspection only. Never repeat uncertain actions.', timestamp: 1 })
  let parentId = original.appendCompaction('Approvals and unknown outcomes remain binding.', null, 200000)
  const file = original.getSessionFile()
  const content = 'Historical bounded fixture data. '.repeat(1024)
  const fd = fs.openSync(file, 'a')
  try {
    for (let index = 0; index < 7200; index++) {
      const id = `fixture-${index}`
      fs.writeSync(fd, JSON.stringify({ type: 'message', id, parentId, timestamp: '2026-01-01T00:00:00Z',
        message: { role: 'user', content, timestamp: index + 2 } }) + '\n')
      parentId = id
    }
  } finally {
    fs.closeSync(fd)
  }
  const before = await hash(file)
  const loaded = openBoundedSession(directory, directory)
  const successorBytes = fs.statSync(loaded.getSessionFile()).size
  assert.equal(await hash(file), before)
  assert.notEqual(loaded.getSessionId(), original.getSessionId())
  assert.ok(successorBytes < 100000)
  assert.ok(JSON.stringify(loaded.buildSessionContext().messages).includes('Approvals and unknown outcomes'))
  console.log(JSON.stringify({ sourceBytes: fs.statSync(file).size, successorBytes,
    heapUsedBytes: process.memoryUsage().heapUsed, archiveUnchanged: true }))
} finally {
  fs.rmSync(directory, { recursive: true, force: true })
}
