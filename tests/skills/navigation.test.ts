import assert from 'node:assert/strict'
import test from 'node:test'
import type { SkillResult } from '../../src/contracts/skills.js'
import type {
  MinecraftAdapter,
  MinecraftEventListener,
  NavigationOptions
} from '../../src/minecraft/adapter.js'
import { createNavigationSkills } from '../../src/skills/navigation.js'

class FakeMovementAdapter implements MinecraftAdapter {
  readonly goToCalls: Array<{
    position: { x: number; y: number; z: number }
    options: NavigationOptions
    signal: AbortSignal
  }> = []
  readonly followCalls: Array<{ player: string; range: number; signal: AbortSignal }> = []
  holdCalls = 0
  stopMotionCount = 0

  onEvent(_listener: MinecraftEventListener): () => void {
    return () => undefined
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  async goTo(
    position: { x: number; y: number; z: number },
    options: NavigationOptions,
    signal: AbortSignal
  ): Promise<SkillResult> {
    this.goToCalls.push({ position, options, signal })
    return { status: 'succeeded', code: 'reached' }
  }

  async followPlayer(player: string, range: number, signal: AbortSignal): Promise<SkillResult> {
    this.followCalls.push({ player, range, signal })
    return { status: 'cancelled', code: 'preempted' }
  }

  async holdPosition(signal: AbortSignal): Promise<SkillResult> {
    this.holdCalls += 1
    return signal.aborted
      ? { status: 'cancelled', code: 'cancelled' }
      : { status: 'succeeded', code: 'holding' }
  }

  async stopMotion(): Promise<void> {
    this.stopMotionCount += 1
  }
}

test('go_to delegates a semantic target with digging disabled', async () => {
  const adapter = new FakeMovementAdapter()
  const skills = createNavigationSkills(adapter)
  const controller = new AbortController()

  const result = await skills.goTo.execute(
    { signal: controller.signal },
    { x: 10, y: 64, z: -5, radius: 2 }
  )

  assert.deepEqual(result, { status: 'succeeded', code: 'reached' })
  assert.equal(adapter.goToCalls.length, 1)
  assert.deepEqual(adapter.goToCalls[0]?.position, { x: 10, y: 64, z: -5 })
  assert.deepEqual(adapter.goToCalls[0]?.options, { range: 2, canDig: false })
  assert.equal(adapter.goToCalls[0]?.signal, controller.signal)
})

test('go_to uses a conservative one-block default radius', async () => {
  const adapter = new FakeMovementAdapter()
  const skills = createNavigationSkills(adapter)

  await skills.goTo.execute(
    { signal: new AbortController().signal },
    { x: 1, y: 65, z: 2 }
  )

  assert.deepEqual(adapter.goToCalls[0]?.options, { range: 1, canDig: false })
})

test('follow_player delegates the named dynamic target and configured range', async () => {
  const adapter = new FakeMovementAdapter()
  const skills = createNavigationSkills(adapter)
  const controller = new AbortController()

  const result = await skills.followPlayer.execute(
    { signal: controller.signal },
    { player: 'Boss', range: 4 }
  )

  assert.deepEqual(result, { status: 'cancelled', code: 'preempted' })
  assert.deepEqual(adapter.followCalls, [
    { player: 'Boss', range: 4, signal: controller.signal }
  ])
})

test('stay delegates to holdPosition and stop is an immediate semantic stop', async () => {
  const adapter = new FakeMovementAdapter()
  const skills = createNavigationSkills(adapter)
  const signal = new AbortController().signal

  assert.deepEqual(await skills.stay.execute({ signal }, {}), {
    status: 'succeeded',
    code: 'holding'
  })
  assert.equal(adapter.holdCalls, 1)

  assert.deepEqual(await skills.stop.execute({ signal }, {}), {
    status: 'succeeded',
    code: 'stopped'
  })
  assert.equal(adapter.stopMotionCount, 1)
})
