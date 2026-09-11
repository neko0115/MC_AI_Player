import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { createBot, type Bot } from 'mineflayer'
import type { Position } from '../../src/contracts/events.js'
import type { SkillResult } from '../../src/contracts/skills.js'
import type { ResourceNavigationAdapter } from '../../src/minecraft/gathering.js'
import { MineflayerGatheringRuntime } from '../../src/minecraft/mineflayer-gathering.js'
import { SafetyPolicy } from '../../src/safety/policy.js'
import {
  GatherResourceSkill,
  RegionProtectionPolicy
} from '../../src/skills/gathering.js'
import { ReturnHomeSkill } from '../../src/skills/navigation.js'
import type { WorldStateSnapshot } from '../../src/state/world-state.js'

const liveEnabled = process.env.MC_GATHER_LIVE_E2E === '1'
const version = process.env.MC_TEST_VERSION || '1.21.1'
const port = Number(process.env.MC_GATHER_TEST_PORT || '25574')

class NearbyNoDigNavigation implements ResourceNavigationAdapter {
  readonly targets: Position[] = []

  constructor(private readonly bot: () => Bot | null) {}

  async goTo(
    position: Position,
    options: { readonly range: number; readonly canDig: false },
    signal: AbortSignal
  ): Promise<SkillResult> {
    if (signal.aborted) return cancelled(signal)
    assert.equal(options.canDig, false)
    const bot = this.bot()
    if (!bot) return { status: 'failed', code: 'minecraft_not_ready' }
    this.targets.push({ ...position })
    const current = bot.entity.position
    const distance = Math.hypot(
      position.x - current.x,
      position.y - current.y,
      position.z - current.z
    )
    return distance <= 2.5
      ? { status: 'succeeded', code: 'reached' }
      : { status: 'failed', code: 'no_path' }
  }
}

test(
  'scoped gathering collects only allowed oak logs and returns home on a live vanilla server',
  { skip: !liveEnabled, timeout: 180_000 },
  async t => {
    const serverDirectory = await mkdtemp(join(tmpdir(), 'mc-ai-player-gather-live-'))
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
        'difficulty=normal',
        'view-distance=4',
        'simulation-distance=4',
        'max-players=2',
        'motd=MC_AI_Player Task 10 isolated CI test',
        ''
      ].join('\n'),
      'utf8'
    )

    const server = spawn(
      'java',
      ['-Xms256M', '-Xmx768M', '-jar', serverJar, 'nogui'],
      { cwd: serverDirectory, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    let serverTail = ''
    const capture = (chunk: Buffer) => {
      serverTail = `${serverTail}${chunk.toString('utf8')}`.slice(-20_000)
    }
    server.stdout.on('data', capture)
    server.stderr.on('data', capture)

    let bot: Bot | null = null
    t.after(async () => {
      try {
        bot?.quit('test-cleanup')
      } catch {}
      if (server.exitCode === null) {
        server.stdin.write('stop\n')
        await Promise.race([waitForExit(server), delay(10_000)])
      }
      if (server.exitCode === null) server.kill('SIGKILL')
    })

    await waitForServerReady(server, 90_000)

    bot = createBot({
      host: '127.0.0.1',
      port,
      username: 'Moxue_Test',
      auth: 'offline',
      version
    })
    await waitForBotSpawn(bot, 15_000)

    server.stdin.write('clear Moxue_Test\n')
    await waitUntil(() => countInventory(bot, 'oak_log') === 0, 5_000, 'cleared inventory')

    const home: Position = {
      x: bot.entity.position.x,
      y: bot.entity.position.y,
      z: bot.entity.position.z
    }
    const base = {
      x: Math.floor(home.x),
      y: Math.floor(home.y),
      z: Math.floor(home.z)
    }
    const left: Position = { x: base.x - 1, y: base.y, z: base.z }
    const right: Position = { x: base.x + 1, y: base.y, z: base.z }
    const protectedLog: Position = { x: base.x + 2, y: base.y, z: base.z }

    for (const position of [left, right, protectedLog]) {
      server.stdin.write(
        `setblock ${position.x} ${position.y} ${position.z} minecraft:oak_log replace\n`
      )
    }
    await waitUntil(
      () =>
        blockNameAt(bot, left) === 'oak_log' &&
        blockNameAt(bot, right) === 'oak_log' &&
        blockNameAt(bot, protectedLog) === 'oak_log',
      15_000,
      'controlled oak log fixture'
    )

    const resources = new MineflayerGatheringRuntime(() => bot, {
      collectionTimeoutMs: 5_000,
      collectionPollMs: 50
    })
    const navigation = new NearbyNoDigNavigation(() => bot)
    const protection = new RegionProtectionPolicy([
      { min: protectedLog, max: protectedLog }
    ])
    const gather = new GatherResourceSkill({
      resources,
      navigation,
      safety: new SafetyPolicy(),
      state: () => readyState(resources.currentPosition()),
      protection,
      options: {
        initialSearchRadius: 4,
        maxSearchRadius: 4,
        searchStep: 1,
        maxRetries: 2,
        maxCandidatesPerSearch: 8
      }
    })
    const returnHome = new ReturnHomeSkill(navigation, {
      resolveHome: () => home
    })
    const context = { signal: new AbortController().signal }

    const gatherResult = await gather.execute(context, {
      resource: 'oak_log',
      quantity: 2
    })
    assert.deepEqual(gatherResult, { status: 'succeeded', code: 'gathered' })
    assert.equal(countInventory(bot, 'oak_log'), 2)
    assert.equal(blockNameAt(bot, protectedLog), 'oak_log')
    assert.equal(blockNameAt(bot, left) === 'air' || blockNameAt(bot, right) === 'air', true)

    const returnResult = await returnHome.execute(context, {})
    assert.deepEqual(returnResult, { status: 'succeeded', code: 'reached' })
    assert.deepEqual(navigation.targets.at(-1), home)
    assert.equal(serverTail.includes('Moxue_Test joined the game'), true)
  }
)

function readyState(position: Position | null): WorldStateSnapshot {
  return {
    connected: true,
    spawned: true,
    health: 20,
    food: 20,
    dimension: 'overworld',
    position,
    nearbyPlayers: [],
    inventory: [],
    recentEvents: []
  }
}

function blockNameAt(bot: Bot | null, position: Position): string | null {
  if (!bot) return null
  const point = bot.entity.position.clone()
  point.set(position.x, position.y, position.z)
  return bot.blockAt(point)?.name ?? null
}

function countInventory(bot: Bot | null, name: string): number {
  if (!bot?.inventory) return 0
  return bot.inventory
    .items()
    .filter(item => item.name === name)
    .reduce((sum, item) => sum + item.count, 0)
}

async function waitForServerReady(server: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  let output = ''
  await new Promise<void>((resolveReady, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Minecraft server startup timed out. Last output:\n${output.slice(-5000)}`))
    }, timeoutMs)
    const onData = (chunk: Buffer) => {
      output = `${output}${chunk.toString('utf8')}`.slice(-20_000)
      if (output.includes('Done (')) {
        cleanup()
        resolveReady()
      }
    }
    const onExit = (code: number | null) => {
      cleanup()
      reject(new Error(`Minecraft server exited before ready with code ${code}. Output:\n${output}`))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      server.stdout.off('data', onData)
      server.stderr.off('data', onData)
      server.off('exit', onExit)
    }
    server.stdout.on('data', onData)
    server.stderr.on('data', onData)
    server.once('exit', onExit)
  })
}

async function waitForBotSpawn(bot: Bot, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolveSpawn, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Moxue_Test spawn timed out'))
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

async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(50)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function waitForExit(server: ChildProcessWithoutNullStreams): Promise<void> {
  if (server.exitCode !== null) return Promise.resolve()
  return new Promise(resolveExit => server.once('exit', () => resolveExit()))
}

function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms))
}

function cancelled(signal: AbortSignal): SkillResult {
  const reason = typeof signal.reason === 'string' ? signal.reason.trim() : ''
  return {
    status: 'cancelled',
    code: reason ? reason.replace(/\s+/g, '_').slice(0, 128) : 'cancelled'
  }
}
