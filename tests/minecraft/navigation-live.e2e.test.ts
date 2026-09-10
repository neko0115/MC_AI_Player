import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { createBot, type Bot } from 'mineflayer'
import type { RuntimeEvent } from '../../src/contracts/events.js'
import type { SkillResult } from '../../src/contracts/skills.js'
import { MineflayerAdapter } from '../../src/minecraft/mineflayer-adapter.js'

const liveEnabled = process.env.MC_NAV_LIVE_E2E === '1'
const version = process.env.MC_TEST_VERSION || '1.21.1'
const port = Number(process.env.MC_NAV_TEST_PORT || '25571')
const durationScale = positiveNumber(process.env.MC_NAV_DURATION_SCALE, 1)
const minSequenceMs = positiveNumber(process.env.MC_NAV_MIN_SEQUENCE_MS, 600_000)

test(
  'safe navigation completes a ten-minute live vanilla-server sequence without digging',
  { skip: !liveEnabled, timeout: 900_000 },
  async t => {
    const serverDirectory = await mkdtemp(join(tmpdir(), 'mc-ai-player-nav-live-'))
    const serverJar = resolve('artifacts', 'test-server', `minecraft-server-${version}.jar`)

    await writeFile(join(serverDirectory, 'eula.txt'), 'eula=true\n', 'utf8')
    await writeFile(
      join(serverDirectory, 'server.properties'),
      [
        `server-port=${port}`,
        'server-ip=127.0.0.1',
        'online-mode=false',
        'enforce-secure-profile=false',
        'spawn-protection=0',
        'difficulty=peaceful',
        'spawn-monsters=false',
        'spawn-animals=false',
        'generate-structures=false',
        'level-type=minecraft:flat',
        'view-distance=5',
        'simulation-distance=5',
        'max-players=4',
        'motd=MC_AI_Player navigation CI test',
        ''
      ].join('\n'),
      'utf8'
    )

    const server = spawn(
      'java',
      ['-Xms256M', '-Xmx768M', '-jar', serverJar, 'nogui'],
      { cwd: serverDirectory, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    let serverOutput = ''
    const captureServerOutput = (chunk: Buffer) => {
      serverOutput = `${serverOutput}${chunk.toString('utf8')}`.slice(-40_000)
    }
    server.stdout.on('data', captureServerOutput)
    server.stderr.on('data', captureServerOutput)

    let boss: Bot | null = null
    const events: RuntimeEvent[] = []
    const adapter = new MineflayerAdapter({
      host: '127.0.0.1',
      port,
      username: 'Moxue_Test',
      auth: 'offline',
      version,
      logLevel: 'info'
    })
    adapter.onEvent(event => events.push(event))

    t.after(async () => {
      try {
        boss?.clearControlStates()
      } catch {}
      try {
        await withTimeout(adapter.disconnect(), 10_000, 'cleanup adapter disconnect')
      } catch {}
      try {
        boss?.quit('test-cleanup')
      } catch {}
      if (server.exitCode === null) {
        server.stdin.write('stop\n')
        await Promise.race([waitForExit(server), delay(10_000)])
      }
      if (server.exitCode === null) {
        server.kill('SIGKILL')
      }
    })

    mark('setup: waiting for Minecraft server')
    await waitForServerReady(server, () => serverOutput, 90_000)

    await adapter.connect()
    await waitUntil(
      () => events.some(event => event.type === 'connected'),
      15_000,
      'Moxue login'
    )
    await waitUntil(
      () => events.some(event => event.type === 'spawned'),
      15_000,
      'Moxue spawn'
    )

    boss = createBot({
      host: '127.0.0.1',
      port,
      username: 'Boss_Test',
      auth: 'offline',
      version
    })
    await waitForBotSpawn(boss, 15_000)

    command(server, 'fill -60 79 -60 60 79 60 minecraft:stone')
    command(server, 'fill -60 80 -60 60 90 60 minecraft:air')
    command(server, 'fill 0 80 -15 0 82 15 minecraft:stone')
    command(server, 'fill 0 80 -1 0 82 1 minecraft:air')
    command(server, 'tp Moxue_Test -35 80 -20')
    command(server, 'tp Boss_Test -30 80 -20')

    await waitUntil(
      () => Boolean(boss?.players.Moxue_Test?.entity?.position),
      15_000,
      'Boss sees Moxue entity'
    )
    await waitUntil(
      () => events.some(event => event.type === 'player_seen' && event.player.name === 'Boss_Test'),
      15_000,
      'Moxue sees Boss entity'
    )
    await waitUntil(
      () => distanceToObservedPlayer(boss, 'Moxue_Test', { x: -35, z: -20 }) < 3,
      15_000,
      'controlled Moxue start position'
    )
    await waitUntil(
      () => distanceToSelf(boss, { x: -30, z: -20 }) < 3,
      15_000,
      'controlled Boss start position'
    )
    await waitForWall(boss, 15_000)

    const sequenceStartedAt = Date.now()
    const wallBefore = wallSnapshot(boss)

    mark('phase A: follow moving Boss')
    const firstFollowController = new AbortController()
    const firstFollow = adapter.followPlayer('Boss_Test', 3, firstFollowController.signal)
    await moveBossRoute(boss, scaledDuration(180_000, 3_000))
    boss.clearControlStates()
    await waitUntil(
      () => playerDistance(boss, 'Moxue_Test') <= 5,
      20_000,
      'Moxue catches Boss after phase A follow'
    )
    firstFollowController.abort('follow_three_min_complete')
    assertCancelled(
      await withTimeout(firstFollow, 10_000, 'phase A follow cancellation'),
      'follow_three_min_complete'
    )
    mark('phase A: complete')

    mark('phase B: stay while Boss moves')
    command(server, 'tp Boss_Test -48 80 25')
    await waitUntil(() => distanceToSelf(boss, { x: -48, z: 25 }) < 3, 10_000, 'Boss stay-test position')
    const stayController = new AbortController()
    const stay = adapter.holdPosition(stayController.signal)
    await waitForObservedPlayerStable(
      boss,
      'Moxue_Test',
      scaledDuration(750, 300),
      0.1,
      5_000
    )
    const stayStart = observedPlayerPosition(boss, 'Moxue_Test')
    await moveBossRoute(boss, scaledDuration(60_000, 1_000), [
      { x: -48, z: 25 },
      { x: -40, z: 25 },
      { x: -40, z: 33 },
      { x: -48, z: 33 }
    ])
    const stayEnd = observedPlayerPosition(boss, 'Moxue_Test')
    const stayDrift = Math.hypot(stayEnd.x - stayStart.x, stayEnd.z - stayStart.z)
    assert.ok(stayDrift < 0.75, `stay drifted horizontally by ${stayDrift}`)
    stayController.abort('stay_one_min_complete')
    assertCancelled(
      await withTimeout(stay, 10_000, 'phase B stay cancellation'),
      'stay_one_min_complete'
    )
    mark('phase B: complete')

    mark('phase C: go_to three points with protected wall')
    command(server, 'tp Moxue_Test -20 80 -10')
    await waitUntil(
      () => distanceToObservedPlayer(boss, 'Moxue_Test', { x: -20, z: -10 }) < 3,
      10_000,
      'Moxue go_to start position'
    )

    const points = [
      { x: -20, y: 80, z: 10 },
      { x: 20, y: 80, z: 10 },
      { x: -20, y: 80, z: -10 }
    ]
    for (const point of points) {
      mark(`phase C: go_to ${point.x},${point.z}`)
      const result = await withTimeout(
        adapter.goTo(
          point,
          { range: 1, canDig: false },
          new AbortController().signal
        ),
        60_000,
        `phase C go_to ${point.x},${point.z}`
      )
      assert.deepEqual(result, { status: 'succeeded', code: 'reached' })
      await waitUntil(
        () => distanceToObservedPlayer(boss, 'Moxue_Test', point) <= 3,
        15_000,
        `Moxue reached ${point.x},${point.z}`
      )
    }
    assert.deepEqual(wallSnapshot(boss), wallBefore)
    mark('phase C: complete')

    mark('phase D: interrupt go_to with stop')
    const interruptedGoTo = adapter.goTo(
      { x: 45, y: 80, z: -10 },
      { range: 1, canDig: false },
      new AbortController().signal
    )
    await delay(scaledDuration(1_000, 500))
    await withTimeout(adapter.stopMotion(), 10_000, 'phase D stopMotion')
    assert.deepEqual(
      await withTimeout(interruptedGoTo, 10_000, 'phase D interrupted go_to'),
      { status: 'failed', code: 'path_stopped' }
    )
    mark('phase D: complete')

    mark('phase E: follow continuously moving Boss')
    command(server, 'tp Moxue_Test -35 80 20')
    command(server, 'tp Boss_Test -30 80 20')
    await waitUntil(
      () => distanceToObservedPlayer(boss, 'Moxue_Test', { x: -35, z: 20 }) < 3,
      10_000,
      'Moxue moving-follow start position'
    )
    await waitUntil(() => distanceToSelf(boss, { x: -30, z: 20 }) < 3, 10_000, 'Boss moving-follow start position')

    const movingFollowController = new AbortController()
    const movingFollow = adapter.followPlayer('Boss_Test', 3, movingFollowController.signal)
    const remainingToMinimum = Math.max(
      scaledDuration(60_000, 5_000),
      minSequenceMs - (Date.now() - sequenceStartedAt)
    )
    await moveBossRoute(boss, remainingToMinimum)
    boss.clearControlStates()
    await waitUntil(
      () => playerDistance(boss, 'Moxue_Test') <= 5,
      20_000,
      'Moxue catches moving Boss before final stop'
    )
    movingFollowController.abort('moving_follow_complete')
    assertCancelled(
      await withTimeout(movingFollow, 10_000, 'phase E moving follow cancellation'),
      'moving_follow_complete'
    )

    assert.ok(
      Date.now() - sequenceStartedAt >= minSequenceMs,
      `navigation sequence must run for at least ${minSequenceMs} ms`
    )
    assert.deepEqual(wallSnapshot(boss), wallBefore)
    mark('phase E: complete')

    mark('phase F: disconnect during movement')
    command(server, 'tp Moxue_Test -35 80 -30')
    await waitUntil(
      () => distanceToObservedPlayer(boss, 'Moxue_Test', { x: -35, z: -30 }) < 3,
      10_000,
      'disconnect-test start position'
    )
    const disconnectCount = events.filter(event => event.type === 'disconnected').length
    const movementDuringDisconnect = adapter.goTo(
      { x: 45, y: 80, z: -30 },
      { range: 1, canDig: false },
      new AbortController().signal
    )
    await delay(scaledDuration(1_000, 500))
    await withTimeout(adapter.disconnect(), 10_000, 'phase F adapter disconnect')
    assert.deepEqual(
      await withTimeout(movementDuringDisconnect, 10_000, 'phase F movement cleanup'),
      { status: 'failed', code: 'path_stopped' }
    )
    await waitUntil(
      () => events.filter(event => event.type === 'disconnected').length > disconnectCount,
      15_000,
      'disconnect event during movement'
    )

    assert.equal(events.some(event => event.type === 'adapter_error'), false)
    assert.deepEqual(wallSnapshot(boss), wallBefore)
    mark('phase F: complete')
  }
)

function assertCancelled(result: SkillResult, code: string): void {
  assert.deepEqual(result, { status: 'cancelled', code })
}

function command(server: ChildProcessWithoutNullStreams, value: string): void {
  server.stdin.write(`${value}\n`)
}

async function moveBossRoute(
  bot: Bot,
  durationMs: number,
  waypoints: ReadonlyArray<{ x: number; z: number }> = [
    { x: -30, z: -20 },
    { x: -22, z: -20 },
    { x: -22, z: -12 },
    { x: -30, z: -12 }
  ]
): Promise<void> {
  const deadline = Date.now() + durationMs
  let waypointIndex = 0
  try {
    while (Date.now() < deadline) {
      const waypoint = waypoints[waypointIndex % waypoints.length]
      if (!waypoint) break
      const current = bot.entity.position
      if (Math.hypot(current.x - waypoint.x, current.z - waypoint.z) < 1.25) {
        waypointIndex += 1
        continue
      }
      const lookTarget = current.clone()
      lookTarget.x = waypoint.x
      lookTarget.y = current.y
      lookTarget.z = waypoint.z
      await withTimeout(bot.lookAt(lookTarget, true), 5_000, 'Boss lookAt route waypoint')
      bot.setControlState('forward', true)
      await delay(Math.min(200, Math.max(1, deadline - Date.now())))
      bot.setControlState('forward', false)
      await delay(Math.min(50, Math.max(1, deadline - Date.now())))
    }
  } finally {
    bot.setControlState('forward', false)
  }
}

function wallSnapshot(bot: Bot): Record<string, string> {
  const result: Record<string, string> = {}
  for (let y = 80; y <= 82; y += 1) {
    for (let z = -15; z <= 15; z += 1) {
      if (z >= -1 && z <= 1) continue
      const position = bot.entity.position.clone()
      position.x = 0
      position.y = y
      position.z = z
      const block = bot.blockAt(position)
      assert.ok(block, `wall block ${y},${z} is not loaded`)
      result[`${y}:${z}`] = block.name
    }
  }
  return result
}

async function waitForWall(bot: Bot, timeoutMs: number): Promise<void> {
  await waitUntil(() => {
    const position = bot.entity.position.clone()
    position.x = 0
    position.y = 80
    position.z = 5
    return bot.blockAt(position)?.name === 'stone'
  }, timeoutMs, 'protected wall')
}

async function waitForObservedPlayerStable(
  bot: Bot,
  player: string,
  stableMs: number,
  tolerance: number,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let anchor = observedPlayerPosition(bot, player)
  let stableSince = Date.now()

  while (Date.now() < deadline) {
    const current = observedPlayerPosition(bot, player)
    const drift = Math.hypot(current.x - anchor.x, current.z - anchor.z)
    if (drift > tolerance) {
      anchor = current
      stableSince = Date.now()
    } else if (Date.now() - stableSince >= stableMs) {
      return
    }
    await delay(50)
  }

  throw new Error(`Timed out waiting for ${player} to remain stable for ${stableMs}ms`)
}

function observedPlayerPosition(bot: Bot, player: string): { x: number; y: number; z: number } {
  const position = bot.players[player]?.entity?.position
  assert.ok(position, `${player} position is unavailable`)
  return { x: position.x, y: position.y, z: position.z }
}

function distanceToObservedPlayer(
  bot: Bot | null,
  player: string,
  target: { x: number; z: number }
): number {
  const position = bot?.players[player]?.entity?.position
  if (!position) return Number.POSITIVE_INFINITY
  return Math.hypot(position.x - target.x, position.z - target.z)
}

function distanceToSelf(bot: Bot | null, target: { x: number; z: number }): number {
  const position = bot?.entity.position
  if (!position) return Number.POSITIVE_INFINITY
  return Math.hypot(position.x - target.x, position.z - target.z)
}

function playerDistance(bot: Bot, player: string): number {
  const target = bot.players[player]?.entity?.position
  if (!target) return Number.POSITIVE_INFINITY
  return Math.hypot(
    bot.entity.position.x - target.x,
    bot.entity.position.z - target.z
  )
}

async function waitForServerReady(
  server: ChildProcessWithoutNullStreams,
  output: () => string,
  timeoutMs: number
): Promise<void> {
  await waitUntil(
    () => {
      if (server.exitCode !== null) {
        throw new Error(`Minecraft server exited before ready with code ${server.exitCode}.\n${output()}`)
      }
      return output().includes('Done (')
    },
    timeoutMs,
    'Minecraft server ready'
  )
}

async function waitForBotSpawn(bot: Bot, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolveSpawn, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Boss_Test spawn timed out'))
    }, timeoutMs)
    const onSpawn = () => {
      cleanup()
      resolveSpawn()
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      clearTimeout(timeout)
      bot.off('spawn', onSpawn)
      bot.off('error', onError)
    }
    bot.once('spawn', onSpawn)
    bot.once('error', onError)
  })
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  label: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(50)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`))
    }, timeoutMs)
    promise.then(
      value => {
        clearTimeout(timer)
        resolvePromise(value)
      },
      error => {
        clearTimeout(timer)
        rejectPromise(error)
      }
    )
  })
}

function waitForExit(server: ChildProcessWithoutNullStreams): Promise<void> {
  if (server.exitCode !== null) return Promise.resolve()
  return new Promise(resolveExit => server.once('exit', () => resolveExit()))
}

function scaledDuration(fullDurationMs: number, minimumMs: number): number {
  return Math.max(minimumMs, Math.round(fullDurationMs * durationScale))
}

function positiveNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new RangeError(`expected positive finite number, got ${value}`)
  }
  return parsed
}

function mark(label: string): void {
  console.log(`[navigation-live] ${label}`)
}

function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms))
}
