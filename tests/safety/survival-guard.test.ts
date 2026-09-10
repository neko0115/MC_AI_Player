import assert from 'node:assert/strict'
import test from 'node:test'
import type { SkillDefinition, SkillResult } from '../../src/contracts/skills.js'
import { GoalManager } from '../../src/goals/goal-manager.js'
import { SafetyPolicy } from '../../src/safety/policy.js'
import { SurvivalGuard } from '../../src/safety/survival-guard.js'
import { SkillExecutor } from '../../src/skills/executor.js'
import { SkillRegistry } from '../../src/skills/registry.js'
import type { WorldStateSnapshot } from '../../src/state/world-state.js'

const healthy: WorldStateSnapshot = {
  connected: true,
  spawned: true,
  health: 20,
  food: 20,
  dimension: 'overworld',
  position: { x: 0, y: 64, z: 0 },
  nearbyPlayers: [],
  inventory: [],
  recentEvents: []
}

class BlockingFollowSkill implements SkillDefinition<{ player: string; range: number }> {
  readonly name = 'follow_player' as const

  async execute(
    context: { signal: AbortSignal },
    _args: { player: string; range: number }
  ): Promise<SkillResult> {
    if (context.signal.aborted) return { status: 'cancelled', code: 'cancelled' }
    await new Promise<void>(resolve => {
      context.signal.addEventListener('abort', () => resolve(), { once: true })
    })
    return { status: 'cancelled', code: String(context.signal.reason || 'cancelled') }
  }
}

class CountingEatSkill implements SkillDefinition<Record<string, never>> {
  readonly name = 'eat' as const
  calls = 0

  async execute(): Promise<SkillResult> {
    this.calls += 1
    return { status: 'succeeded', code: 'consumed' }
  }
}

test('low food preempts ordinary active work and executes eat as a system safety goal', async () => {
  const registry = new SkillRegistry()
  const follow = new BlockingFollowSkill()
  const eat = new CountingEatSkill()
  registry.register(follow)
  registry.register(eat)
  const executor = new SkillExecutor(registry)
  const goals = new GoalManager({
    skillController: executor,
    nextGoalId: (() => {
      let next = 0
      return () => `goal-${++next}`
    })(),
    now: () => 100
  })
  const guard = new SurvivalGuard(new SafetyPolicy(), goals, executor)

  const ordinary = await goals.submit(
    { kind: 'follow_player', args: { player: 'Boss', range: 2 } },
    'ai'
  )
  const ordinaryRun = executor.execute('follow_player', ordinary.request.args)

  const result = await guard.enforce({ ...healthy, food: 2 })

  assert.deepEqual(result, { kind: 'handled', code: 'low_food', result: 'consumed' })
  assert.equal((await ordinaryRun).status, 'cancelled')
  assert.equal(goals.getGoal(ordinary.goalId)?.status, 'cancelled')
  assert.equal(eat.calls, 1)
  assert.equal(goals.activeGoal(), null)
})

test('healthy state does not interrupt an ordinary active goal', async () => {
  const registry = new SkillRegistry()
  registry.register(new BlockingFollowSkill())
  registry.register(new CountingEatSkill())
  const executor = new SkillExecutor(registry)
  const goals = new GoalManager({ skillController: executor })
  const guard = new SurvivalGuard(new SafetyPolicy(), goals, executor)

  const ordinary = await goals.submit(
    { kind: 'follow_player', args: { player: 'Boss', range: 2 } },
    'ai'
  )

  assert.deepEqual(await guard.enforce(healthy), { kind: 'noop', code: 'allowed' })
  assert.equal(goals.getGoal(ordinary.goalId)?.status, 'running')
  await goals.emergencyStop('test_cleanup')
})
