import assert from 'node:assert/strict'
import test from 'node:test'
import type { SkillName, SkillResult } from '../../src/contracts/skills.js'
import { GoalManager } from '../../src/goals/goal-manager.js'
import { wireGoalExecution } from '../../src/runtime/goal-execution-loop.js'
import { RuntimeEventBus } from '../../src/telemetry/event-bus.js'

class DeferredExecutor {
  readonly executeCalls: Array<{ name: SkillName; args: unknown }> = []
  readonly cancelReasons: string[] = []
  private pending: ((result: SkillResult) => void) | null = null
  throwNext = false

  async execute(name: SkillName, args: unknown): Promise<SkillResult> {
    this.executeCalls.push({ name, args: structuredClone(args) })
    if (this.throwNext) {
      this.throwNext = false
      throw new Error('PRIVATE_EXECUTOR_FAILURE_DETAIL')
    }
    return new Promise<SkillResult>(resolve => {
      this.pending = resolve
    })
  }

  async cancelActive(reason: string): Promise<void> {
    this.cancelReasons.push(reason)
    this.pending?.({ status: 'cancelled', code: reason })
    this.pending = null
  }

  finish(result: SkillResult): void {
    const pending = this.pending
    this.pending = null
    if (!pending) throw new Error('no pending skill execution')
    pending(result)
  }
}

function runtime() {
  let nextId = 0
  const events = new RuntimeEventBus()
  const executor = new DeferredExecutor()
  const goals = new GoalManager({
    skillController: executor,
    events,
    nextGoalId: () => `goal-${++nextId}`,
    now: () => 100
  })
  return { events, executor, goals }
}

test('goal_started launches deterministic skill execution without blocking GoalManager.submit', async () => {
  const current = runtime()
  const binding = wireGoalExecution({
    events: current.events,
    goals: current.goals,
    executor: current.executor
  })
  try {
    const submitted = await Promise.race([
      current.goals.submit({ kind: 'stay', args: {} }, 'player'),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('GoalManager.submit waited for gameplay completion')), 250)
      )
    ])

    assert.equal(submitted.goalId, 'goal-1')
    assert.equal(submitted.status, 'running')
    await waitFor(() => current.executor.executeCalls.length === 1)
    assert.deepEqual(current.executor.executeCalls, [{ name: 'stay', args: {} }])
    assert.equal(current.goals.getGoal('goal-1')?.status, 'running')

    current.executor.finish({ status: 'succeeded', code: 'held_position' })
    await waitFor(() => current.goals.getGoal('goal-1')?.status === 'succeeded')
  } finally {
    binding.dispose()
  }
})

test('duplicate goal_started events cannot execute the same running goal twice', async () => {
  const current = runtime()
  const binding = wireGoalExecution({
    events: current.events,
    goals: current.goals,
    executor: current.executor
  })
  try {
    await current.goals.submit({ kind: 'stay', args: {} }, 'player')
    await waitFor(() => current.executor.executeCalls.length === 1)

    await current.events.publish({ type: 'goal_started', at: 101, goalId: 'goal-1' })
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(current.executor.executeCalls.length, 1)

    current.executor.finish({ status: 'succeeded', code: 'held_position' })
    await waitFor(() => current.goals.getGoal('goal-1')?.status === 'succeeded')
  } finally {
    binding.dispose()
  }
})

test('executor exceptions become generic failed goals without leaking exception text', async () => {
  const current = runtime()
  current.executor.throwNext = true
  const emitted: unknown[] = []
  current.events.subscribe(event => {
    emitted.push(structuredClone(event))
  })
  const binding = wireGoalExecution({
    events: current.events,
    goals: current.goals,
    executor: current.executor
  })
  try {
    await current.goals.submit({ kind: 'stay', args: {} }, 'player')
    await waitFor(() => current.goals.getGoal('goal-1')?.status === 'failed')

    assert.equal(JSON.stringify(emitted).includes('PRIVATE_EXECUTOR_FAILURE_DETAIL'), false)
    assert.equal(
      emitted.some(event =>
        typeof event === 'object' &&
        event !== null &&
        'type' in event &&
        event.type === 'goal_failed' &&
        'code' in event &&
        event.code === 'skill_execution_failed'
      ),
      true
    )
  } finally {
    binding.dispose()
  }
})

test('disposing the execution binding stops future goal_started handling', async () => {
  const current = runtime()
  const binding = wireGoalExecution({
    events: current.events,
    goals: current.goals,
    executor: current.executor
  })
  binding.dispose()

  await current.events.publish({ type: 'goal_started', at: 1, goalId: 'missing-goal' })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(current.executor.executeCalls.length, 0)
})

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('condition did not become true')
}
