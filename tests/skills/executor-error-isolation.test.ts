import assert from 'node:assert/strict'
import test from 'node:test'
import { SkillExecutor } from '../../src/skills/executor.js'
import { SkillRegistry } from '../../src/skills/registry.js'
import { RuntimeEventBus } from '../../src/telemetry/event-bus.js'

test('skill exceptions become a fixed public code and never leak exception text to telemetry', async () => {
  const registry = new SkillRegistry()
  registry.register({
    name: 'stay',
    async execute() {
      throw new Error('PRIVATE_SKILL_EXCEPTION_SENTINEL')
    }
  })
  const events = new RuntimeEventBus()
  const emitted: unknown[] = []
  events.subscribe(event => {
    emitted.push(structuredClone(event))
  })
  const executor = new SkillExecutor(registry, { events })

  const result = await executor.execute('stay', {})

  assert.deepEqual(result, {
    status: 'failed',
    code: 'skill_exception'
  })
  assert.equal(JSON.stringify(result).includes('PRIVATE_SKILL_EXCEPTION_SENTINEL'), false)
  assert.equal(JSON.stringify(emitted).includes('PRIVATE_SKILL_EXCEPTION_SENTINEL'), false)
  assert.equal(
    emitted.some(event =>
      typeof event === 'object' &&
      event !== null &&
      'type' in event &&
      event.type === 'skill_failed' &&
      'code' in event &&
      event.code === 'skill_exception'
    ),
    true
  )
})
