import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ReplayReader, ReplayValidationError } from '../../src/telemetry/replay.js'

async function writeReplay(lines: string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mc-ai-player-replay-'))
  const path = join(directory, 'events.jsonl')
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8')
  return path
}

test('replay returns validated events in source order', async () => {
  const path = await writeReplay([
    '{"type":"connected","at":1}',
    '{"type":"disconnected","at":2,"reason":"test"}'
  ])

  const events = await ReplayReader.readAll(path)

  assert.deepEqual(
    events.map(event => event.type),
    ['connected', 'disconnected']
  )
})

test('replay rejects an invalid line with its source line number', async () => {
  const path = await writeReplay([
    '{"type":"connected","at":1}',
    '{"type":"connected","at":2,"reasoning":"must not replay"}',
    '{"type":"disconnected","at":3}'
  ])

  await assert.rejects(
    ReplayReader.readAll(path),
    (error: unknown) => error instanceof ReplayValidationError && error.lineNumber === 2
  )
})
