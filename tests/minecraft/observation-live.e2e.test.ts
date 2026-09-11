import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { createBot, type Bot } from 'mineflayer'
import type { RuntimeEvent } from '../../src/contracts/events.js'
import { MineflayerAdapter } from '../../src/minecraft/mineflayer-adapter.js'

const liveEnabled = process.env.MC_LIVE_E2E === '1'
const version = process.env.MC_TEST_VERSION || '1.21.1'
const port = Number(process.env.MC_TEST_PORT || '25570')

test(
  'observation-only adapter completes a live vanilla-server scenario without moving itself',
  { skip: !liveEnabled, timeout: 120_000 },
  async t => {
    const serverDirectory = await mkdtemp(join(tmpdir(), 'mc-ai-player-live-'))
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
        'max-players=4',
        'motd=MC_AI_Player isolated CI test',
        ''
      ].join('\n'),
      'utf8'
    )

    const server = spawn(
      'java',
      ['-Xms256M', '-Xmx768M', '-jar', serverJar, 'nogui'],
      { cwd: serverDirectory, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    const serverLog = attachProcessLog(server)
    let boss: Bot | null = null
    const adapter = new MineflayerAdapter({
      host: '127.0.0.1',
      port,
      username: 'Moxue_Test',
      auth: 'offline',
      version,
      logLevel: 'info'
    })

    t.after(async () => {
      try {
        await adapter.disconnect()
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

    await waitForServerReady(server, 90_000)

    const events: RuntimeEvent[] = []
    adapter.onEvent(event => events.push(event))

    await adapter.connect()
    await waitUntil(() => events.some(event => event.type === 'connected'), 15_000, 'Moxue login')
    await waitUntil(() => events.some(event => event.type === 'spawned'), 15_000, 'Moxue spawn')

    boss = createBot({
      host: '127.0.0.1',
      port,
      username: 'Boss_Test',
      auth: 'offline',
      version
    })
    await waitForBotSpawn(boss, 15_000)

    await waitUntil(
      () => events.some(event => event.type === 'player_seen' && event.player.name === 'Boss_Test'),
      15_000,
      'player_seen'
    )

    boss.chat('hello-from-boss')
    await waitUntil(
      () =>
        events.some(
          event =>
            event.type === 'player_chat' &&
            event.player === 'Boss_Test' &&
            event.message === 'hello-from-boss'
        ),
      15_000,
      'player_chat'
    )

    const inventoryCount = events.filter(event => event.type === 'inventory_changed').length
    server.stdin.write('give Moxue_Test minecraft:bread 1\n')
    await waitUntil(
      () =>
        events
          .slice(inventoryCount === 0 ? 0 : -10)
          .some(
            event =>
              event.type === 'inventory_changed' &&
              event.items.some(item => item.name === 'bread' && item.count >= 1)
          ),
      15_000,
      'inventory_changed after give'
    )

    // A newly spawned vanilla player has a short server-side invulnerability window.
    // Keep the damage type unchanged so this test isolates timing rather than changing two variables.
    await delay(4000)
    const healthCount = events.filter(event => event.type === 'health_changed').length
    server.stdin.write('damage Moxue_Test 1 minecraft:generic\n')
    try {
      await waitUntil(
        () => events.filter(event => event.type === 'health_changed').length > healthCount,
        15_000,
        'health_changed after damage'
      )
    } catch (error) {
      throw new Error(
        `${asError(error).message}\n\nMinecraft server tail:\n${serverLog.tail()}\n\nRecent runtime events:\n${JSON.stringify(events.slice(-20), null, 2)}`
      )
    }

    await waitUntil(
      () => Boolean(boss?.players.Moxue_Test?.entity?.position),
      15_000,
      'Boss sees Moxue entity'
    )
    const firstPosition = boss.players.Moxue_Test?.entity.position.clone()
    assert.ok(firstPosition)
    await delay(1000)
    const secondPosition = boss.players.Moxue_Test?.entity.position
    assert.ok(secondPosition)
    const horizontalMovement = Math.hypot(
      secondPosition.x - firstPosition.x,
      secondPosition.z - firstPosition.z
    )
    assert.ok(horizontalMovement < 0.01, `unexpected horizontal movement: ${horizontalMovement}`)

    const disconnectCount = events.filter(event => event.type === 'disconnected').length
    await adapter.disconnect()
    await waitUntil(
      () => events.filter(event => event.type === 'disconnected').length > disconnectCount,
      15_000,
      'manual disconnect'
    )

    const connectedCount = events.filter(event => event.type === 'connected').length
    const spawnedCount = events.filter(event => event.type === 'spawned').length
    await adapter.connect()
    await waitUntil(
      () => events.filter(event => event.type === 'connected').length > connectedCount,
      15_000,
      'manual reconnect login'
    )
    await waitUntil(
      () => events.filter(event => event.type === 'spawned').length > spawnedCount,
      15_000,
      'manual reconnect spawn'
    )

    assert.equal(events.some(event => event.type === 'adapter_error'), false)
  }
)

function attachProcessLog(server: ChildProcessWithoutNullStreams): { tail(): string } {
  let output = ''
  const capture = (chunk: Buffer) => {
    output = `${output}${chunk.toString('utf8')}`.slice(-20_000)
  }
  server.stdout.on('data', capture)
  server.stderr.on('data', capture)
  return {
    tail: () => output.slice(-5000)
  }
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

function waitForExit(server: ChildProcessWithoutNullStreams): Promise<void> {
  if (server.exitCode !== null) return Promise.resolve()
  return new Promise(resolveExit => server.once('exit', () => resolveExit()))
}

function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms))
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
