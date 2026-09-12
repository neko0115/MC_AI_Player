import assert from 'node:assert/strict'
import test from 'node:test'
import { ContextBuilder } from '../../src/agent/context-builder.js'
import { DecisionGate } from '../../src/agent/decision-gate.js'
import type {
  LogicalDecisionRequest,
  LogicalDecisionResult
} from '../../src/agent/routing/contracts.js'
import { GoalManager } from '../../src/goals/goal-manager.js'
import type { MinecraftMemoryRepository } from '../../src/memory/repository.js'
import { MinecraftIdentityRegistry } from '../../src/minecraft/identity-registry.js'
import { DecisionCoordinator } from '../../src/runtime/decision-coordinator.js'
import { SafetyPolicy } from '../../src/safety/policy.js'
import { SkillRegistry } from '../../src/skills/registry.js'
import { WorldStateCache } from '../../src/state/world-state-cache.js'
import { RuntimeEventBus } from '../../src/telemetry/event-bus.js'

class EmptyMemory implements MinecraftMemoryRepository {
  remember(): never { throw new Error('not used') }
  search() { return [] }
  forget() { return false }
  close(): void {}
}

class FakeLogicalExecutor {
  readonly requests: LogicalDecisionRequest[] = []
  readonly signals: AbortSignal[] = []
  private readonly pending: Array<(result: LogicalDecisionResult) => void> = []

  execute(request: LogicalDecisionRequest, signal: AbortSignal): Promise<LogicalDecisionResult> {
    this.requests.push(structuredClone(request))
    this.signals.push(signal)
    return new Promise(resolve => this.pending.push(resolve))
  }

  resolveNext(result: LogicalDecisionResult): void {
    const resolve = this.pending.shift()
    if (!resolve) throw new Error('no pending decision')
    resolve(result)
  }
}

function harness() {
  const events = new RuntimeEventBus()
  const state = new WorldStateCache({ maxRecentEvents: 32 })
  events.subscribe(event => state.apply(event))

  const registry = new SkillRegistry()
  registry.register({
    name: 'stay',
    async execute() { return { status: 'succeeded', code: 'held' } }
  })

  const goals = new GoalManager({
    skillController: { async cancelActive() {} },
    events,
    nextGoalId: (() => {
      let value = 0
      return () => `goal-${++value}`
    })(),
    now: () => 100
  })
  const identity = new MinecraftIdentityRegistry()
  identity.beginSession()
  const logicalExecutor = new FakeLogicalExecutor()

  const coordinator = new DecisionCoordinator({
    events,
    state,
    goals,
    memory: new EmptyMemory(),
    registry,
    identity,
    identityMode: 'offline',
    manualAccess: { ownerUuid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', operatorAllowlistUuids: [] },
    worldKey: 'test-world',
    botUsername: 'Moxue_Test',
    logicalExecutor,
    decisionGate: new DecisionGate({ safety: new SafetyPolicy(), events }),
    contextBuilder: new ContextBuilder(),
    safetyConstraints: ['PvP is disabled.'],
    nextTaskId: (() => { let value = 0; return () => `task-${++value}` })(),
    nextDecisionId: (() => { let value = 0; return () => `decision-${++value}` })(),
    now: () => 1_000
  })
  coordinator.start()
  return { coordinator, events, state, logicalExecutor }
}

async function ready(events: RuntimeEventBus): Promise<void> {
  await events.publish({ type: 'connected', at: 1 })
  await events.publish({
    type: 'spawned', at: 2, dimension: 'overworld',
    position: { x: 0, y: 64, z: 0 }, health: 20, food: 20
  })
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error('condition did not become true')
}

test('addressed chat enqueues AI work without blocking RuntimeEventBus on an unresolved provider call', async () => {
  const current = harness()
  await ready(current.events)

  await Promise.race([
    current.events.publish({
      type: 'player_chat', at: 3, player: 'Boss', message: '墨雪 跟我來'
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('event bus waited for AI decision')), 100)
    )
  ])

  await waitFor(() => current.logicalExecutor.requests.length === 1)
  assert.equal(current.coordinator.status().decisionInFlight, true)
  assert.equal(current.logicalExecutor.requests[0]?.context.task?.objective, '跟我來')

  current.coordinator.dispose()
})

test('state-only events update latest state during an in-flight decision without starting a second AI call', async () => {
  const current = harness()
  await ready(current.events)
  await current.events.publish({
    type: 'player_chat', at: 3, player: 'Boss', message: '墨雪 跟我來'
  })
  await waitFor(() => current.logicalExecutor.requests.length === 1)

  await current.events.publish({
    type: 'inventory_changed', at: 4, items: [{ name: 'bread', count: 2 }]
  })
  await current.events.publish({
    type: 'position_changed', at: 5, position: { x: 5, y: 64, z: 5 }
  })
  await new Promise(resolve => setTimeout(resolve, 5))

  assert.equal(current.logicalExecutor.requests.length, 1)
  assert.deepEqual(current.state.snapshot().inventory, [{ name: 'bread', count: 2 }])
  assert.deepEqual(current.state.snapshot().position, { x: 5, y: 64, z: 5 })

  current.coordinator.dispose()
})
