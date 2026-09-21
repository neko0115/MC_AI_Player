import assert from 'node:assert/strict'
import test from 'node:test'
import { SkillExecutor } from '../../src/skills/executor.js'
import { SkillRegistry } from '../../src/skills/registry.js'
import { RuntimeEventBus } from '../../src/telemetry/event-bus.js'

test('skill registry rejects duplicate names and returns only registered definitions', () => {
  const registry = new SkillRegistry()
  const skill = {
    name: 'stay' as const,
    async execute() {
      return { status: 'succeeded' as const, code: 'held' }
    }
  }

  registry.register(skill)

  assert.equal(registry.get('stay'), skill)
  assert.equal(registry.get('go_to'), undefined)
  assert.throws(() => registry.register(skill), /already registered/i)
})

test('executor returns a structured failure for an unregistered skill', async () => {
  const executor = new SkillExecutor(new SkillRegistry())

  assert.deepEqual(await executor.execute('go_to', { x: 1, y: 64, z: 1 }), {
    status: 'failed',
    code: 'skill_not_registered'
  })
})

test('cancelActive aborts exactly once, waits for cleanup, and suppresses late success', async () => {
  const registry = new SkillRegistry()
  let abortCount = 0
  let cleanupFinished = false
  let releaseCleanup: (() => void) | undefined
  const cleanupGate = new Promise<void>(resolve => {
    releaseCleanup = resolve
  })

  registry.register({
    name: 'gather_resource',
    async execute({ signal }) {
      await new Promise<void>(resolve => {
        if (signal.aborted) {
          abortCount += 1
          resolve()
          return
        }
        signal.addEventListener(
          'abort',
          () => {
            abortCount += 1
            resolve()
          },
          { once: true }
        )
      })
      await cleanupGate
      cleanupFinished = true
      return { status: 'succeeded', code: 'late_success' }
    }
  })

  const executor = new SkillExecutor(registry)
  const running = executor.execute('gather_resource', { resource: 'oak_log', quantity: 1 })
  const firstCancel = executor.cancelActive('emergency_stop')
  const secondCancel = executor.cancelActive('ignored_second_cancel')

  assert.equal(abortCount, 1)
  assert.equal(cleanupFinished, false)

  releaseCleanup?.()
  await Promise.all([firstCancel, secondCancel])

  assert.equal(cleanupFinished, true)
  assert.deepEqual(await running, {
    status: 'cancelled',
    code: 'emergency_stop'
  })
})

test('cancelled execution emits skill_cancelled and never skill_failed', async () => {
  const registry = new SkillRegistry()
  const events = new RuntimeEventBus()
  const seen: string[] = []
  events.subscribe(event => {
    seen.push(event.type)
  })

  registry.register({
    name: 'stay',
    async execute({ signal }) {
      await new Promise<void>(resolve => {
        if (signal.aborted) {
          resolve()
          return
        }
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
      return { status: 'succeeded', code: 'late_success' }
    }
  })

  const executor = new SkillExecutor(registry, { events, now: () => 10 })
  const running = executor.execute('stay', {})
  await executor.cancelActive('operator_stop')

  assert.deepEqual(await running, { status: 'cancelled', code: 'operator_stop' })
  assert.deepEqual(seen, ['skill_started', 'skill_cancelled'])
})

test('executor refuses a concurrent second skill instead of racing it', async () => {
  const registry = new SkillRegistry()
  let release: (() => void) | undefined
  const gate = new Promise<void>(resolve => {
    release = resolve
  })

  registry.register({
    name: 'stay',
    async execute() {
      await gate
      return { status: 'succeeded', code: 'held' }
    }
  })
  registry.register({
    name: 'eat',
    async execute() {
      return { status: 'succeeded', code: 'ate' }
    }
  })

  const executor = new SkillExecutor(registry)
  const first = executor.execute('stay', {})

  assert.deepEqual(await executor.execute('eat', {}), {
    status: 'failed',
    code: 'executor_busy'
  })

  release?.()
  assert.deepEqual(await first, { status: 'succeeded', code: 'held' })
})


test('cancelActive is bounded when a skill ignores abort cleanup and keeps single-active safety', async () => {
  const registry = new SkillRegistry()
  const events = new RuntimeEventBus()
  const seen: string[] = []
  let release:
    (() => void) | undefined
  const gate = new Promise<void>(
    resolve => {
      release = resolve
    }
  )

  events.subscribe(event => {
    if (
      event.type ===
      'runtime_watchdog'
    ) {
      seen.push(
        `${event.scope}:${event.code}`
      )
    }
  })

  registry.register({
    name: 'gather_resource',
    async execute() {
      await gate
      return {
        status: 'succeeded',
        code: 'late_success'
      }
    }
  })
  registry.register({
    name: 'eat',
    async execute() {
      return {
        status: 'succeeded',
        code: 'ate'
      }
    }
  })

  const executor = new SkillExecutor(
    registry,
    {
      events,
      cancelWaitTimeoutMs: 10
    }
  )
  const running = executor.execute(
    'gather_resource',
    {
      resource: 'stone',
      quantity: 64
    }
  )

  await Promise.race([
    executor.cancelActive(
      'runtime_watchdog_timeout'
    ),
    new Promise<never>(
      (_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                'cancelActive remained hung'
              )
            ),
          100
        )
    )
  ])

  assert.deepEqual(
    seen,
    [
      'skill_cancel:cancel_cleanup_timeout'
    ]
  )
  assert.deepEqual(
    await executor.execute(
      'eat',
      {}
    ),
    {
      status: 'failed',
      code: 'executor_busy'
    }
  )

  release?.()
  assert.deepEqual(
    await running,
    {
      status: 'cancelled',
      code: 'runtime_watchdog_timeout'
    }
  )

  assert.deepEqual(
    await executor.execute(
      'eat',
      {}
    ),
    {
      status: 'succeeded',
      code: 'ate'
    }
  )
})
