import assert from 'node:assert/strict'
import test from 'node:test'
import type { GoalRequest } from '../../src/contracts/goals.js'
import type { SkillResult } from '../../src/contracts/skills.js'
import { GoalManager } from '../../src/goals/goal-manager.js'
import { RuntimeEventBus } from '../../src/telemetry/event-bus.js'

const gatherGoal: GoalRequest = {
  kind: 'gather_resource',
  args: { resource: 'oak_log', quantity: 16 }
}

const followGoal: GoalRequest = {
  kind: 'follow_player',
  args: { player: 'Boss', range: 3 }
}

class FakeSkillController {
  readonly cancelReasons: string[] = []

  async cancelActive(reason: string): Promise<void> {
    this.cancelReasons.push(reason)
  }
}

function createManager() {
  let nextId = 1
  let now = 100
  const controller = new FakeSkillController()
  const events = new RuntimeEventBus()
  const seenEvents: string[] = []
  events.subscribe(event => {
    seenEvents.push(event.type)
  })

  const manager = new GoalManager({
    skillController: controller,
    events,
    nextGoalId: () => `goal-${nextId++}`,
    now: () => now++
  })

  return { manager, controller, seenEvents }
}

test('an AI goal becomes the single running goal when idle', async () => {
  const { manager } = createManager()

  const goal = await manager.submit(gatherGoal, 'ai')

  assert.equal(goal.status, 'running')
  assert.equal(manager.activeGoal()?.goalId, goal.goalId)
  assert.equal(manager.queuedGoals().length, 0)
})

test('a second AI goal queues instead of racing the active AI goal', async () => {
  const { manager, controller } = createManager()

  const first = await manager.submit(gatherGoal, 'ai')
  const second = await manager.submit(followGoal, 'ai')

  assert.equal(manager.activeGoal()?.goalId, first.goalId)
  assert.equal(manager.getGoal(second.goalId)?.status, 'queued')
  assert.deepEqual(manager.queuedGoals().map(goal => goal.goalId), [second.goalId])
  assert.deepEqual(controller.cancelReasons, [])
})

test('a direct player goal preempts an active AI goal with cancellation, not failure', async () => {
  const { manager, controller, seenEvents } = createManager()

  const aiGoal = await manager.submit(gatherGoal, 'ai')
  const playerGoal = await manager.submit(followGoal, 'player')

  assert.equal(manager.getGoal(aiGoal.goalId)?.status, 'cancelled')
  assert.equal(manager.activeGoal()?.goalId, playerGoal.goalId)
  assert.equal(manager.getGoal(playerGoal.goalId)?.status, 'running')
  assert.deepEqual(controller.cancelReasons, ['preempted_by_player'])
  assert.deepEqual(seenEvents, ['goal_started', 'goal_cancelled', 'goal_started'])
})

test('threat suspension keeps the same goal active and resumes it without terminal cancellation', async () => {
  const { manager, controller, seenEvents } = createManager()

  const goal = await manager.submit(gatherGoal, 'ai')

  assert.equal(await manager.suspendActive('threat_suspended'), true)
  assert.equal(manager.activeGoal()?.goalId, goal.goalId)
  assert.equal(manager.getGoal(goal.goalId)?.status, 'suspended')
  assert.deepEqual(controller.cancelReasons, ['threat_suspended'])

  assert.equal(await manager.resumeSuspended(), true)
  assert.equal(manager.activeGoal()?.goalId, goal.goalId)
  assert.equal(manager.getGoal(goal.goalId)?.status, 'running')
  assert.deepEqual(seenEvents, [
    'goal_started',
    'goal_suspended',
    'goal_resumed'
  ])
})

test('a suspended AI goal can still be preempted by a direct player goal', async () => {
  const { manager } = createManager()

  const aiGoal = await manager.submit(gatherGoal, 'ai')
  await manager.suspendActive('threat_suspended')
  const playerGoal = await manager.submit(followGoal, 'player')

  assert.equal(manager.getGoal(aiGoal.goalId)?.status, 'cancelled')
  assert.equal(manager.activeGoal()?.goalId, playerGoal.goalId)
  assert.equal(manager.getGoal(playerGoal.goalId)?.status, 'running')
})

test('emergency stop cancels the active goal and active skill without reporting a failure', async () => {
  const { manager, controller, seenEvents } = createManager()

  const active = await manager.submit(gatherGoal, 'ai')
  await manager.emergencyStop('operator_emergency_stop')

  assert.equal(manager.getGoal(active.goalId)?.status, 'cancelled')
  assert.equal(manager.activeGoal(), null)
  assert.deepEqual(controller.cancelReasons, ['operator_emergency_stop'])
  assert.deepEqual(seenEvents, ['goal_started', 'emergency_stop', 'goal_cancelled'])
})

test('late success from a cancelled goal cannot resurrect it or replace the current goal', async () => {
  const { manager } = createManager()

  const oldGoal = await manager.submit(gatherGoal, 'ai')
  const currentGoal = await manager.submit(followGoal, 'player')
  const lateSuccess: SkillResult = { status: 'succeeded', code: 'late_success' }

  await manager.completeGoal(oldGoal.goalId, lateSuccess)

  assert.equal(manager.getGoal(oldGoal.goalId)?.status, 'cancelled')
  assert.equal(manager.activeGoal()?.goalId, currentGoal.goalId)
  assert.equal(manager.getGoal(currentGoal.goalId)?.status, 'running')
})

test('terminal event publication cannot clear a replacement goal started while old completion is still publishing', async () => {
  let nextId = 1
  const controller =
    new FakeSkillController()
  const events =
    new RuntimeEventBus()

  const {
    promise: completionBlocked,
    resolve: releaseCompletion
  } = Promise.withResolvers<void>()
  let completionListenerEntered = false

  events.subscribe(async event => {
    if (event.type !== 'goal_completed') return
    completionListenerEntered = true
    await completionBlocked
  })

  const manager = new GoalManager({
    skillController: controller,
    events,
    nextGoalId: () =>
      `goal-${nextId++}`,
    now: (() => {
      let value = 100
      return () => value++
    })()
  })

  const oldGoal =
    await manager.submit(
      gatherGoal,
      'ai'
    )

  const completing =
    manager.completeGoal(
      oldGoal.goalId,
      {
        status: 'succeeded',
        code: 'done'
      }
    )

  while (!completionListenerEntered) {
    await new Promise(resolve =>
      setTimeout(resolve, 0)
    )
  }

  assert.equal(
    manager.getGoal(oldGoal.goalId)
      ?.status,
    'succeeded'
  )
  assert.equal(
    manager.activeGoal(),
    null
  )

  const replacement =
    await manager.submit(
      followGoal,
      'player'
    )

  assert.equal(
    manager.activeGoal()?.goalId,
    replacement.goalId
  )
  assert.equal(
    manager.getGoal(
      replacement.goalId
    )?.status,
    'running'
  )

  releaseCompletion()
  await completing

  assert.equal(
    manager.activeGoal()?.goalId,
    replacement.goalId
  )
  assert.equal(
    manager.getGoal(
      replacement.goalId
    )?.status,
    'running'
  )
})

test('only the active running goal can transition to succeeded and emit completion events', async () => {
  const { manager, seenEvents } = createManager()

  const goal = await manager.submit(gatherGoal, 'ai')
  await manager.completeGoal(goal.goalId, { status: 'succeeded', code: 'done' })

  assert.equal(manager.getGoal(goal.goalId)?.status, 'succeeded')
  assert.equal(manager.activeGoal(), null)
  assert.deepEqual(seenEvents, ['goal_started', 'goal_completed'])
})
