import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { RuntimeEvent } from '../../src/contracts/events.js'
import { JsonlEventRecorder } from '../../src/telemetry/recorder.js'

async function tempLogPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mc-ai-player-recorder-'))
  return join(directory, 'events.jsonl')
}

test('recorder writes one validated runtime event per line', async () => {
  const path = await tempLogPath()
  const recorder = new JsonlEventRecorder(path, { maxFileBytes: 4096 })

  const result = await recorder.record({ type: 'connected', at: 1 })
  const content = await readFile(path, 'utf8')

  assert.deepEqual(result, { ok: true })
  assert.equal(content, '{"type":"connected","at":1}\n')
})

test('recorder rejects hidden reasoning instead of serializing it', async () => {
  const path = await tempLogPath()
  const recorder = new JsonlEventRecorder(path, { maxFileBytes: 4096 })
  const unsafe = {
    type: 'connected',
    at: 1,
    reasoning: 'private chain of thought'
  } as unknown as RuntimeEvent

  const result = await recorder.record(unsafe)

  assert.deepEqual(result, { ok: false, code: 'invalid_event' })
  await assert.rejects(readFile(path, 'utf8'), { code: 'ENOENT' })
})

test('recorder rejects thought and analysis aliases too', async () => {
  for (const forbidden of ['thought', 'analysis'] as const) {
    const path = await tempLogPath()
    const recorder = new JsonlEventRecorder(path, { maxFileBytes: 4096 })
    const unsafe = { type: 'connected', at: 1, [forbidden]: 'do not persist' } as unknown as RuntimeEvent

    const result = await recorder.record(unsafe)

    assert.deepEqual(result, { ok: false, code: 'invalid_event' })
    await assert.rejects(readFile(path, 'utf8'), { code: 'ENOENT' })
  }
})
