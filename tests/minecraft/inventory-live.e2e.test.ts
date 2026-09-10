import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { createBot, type Bot } from 'mineflayer'
import { MineflayerInventoryRuntime } from '../../src/minecraft/mineflayer-inventory.js'
import { EatSkill, EquipSkill } from '../../src/skills/survival.js'
import type { ResolvedStorageTarget } from '../../src/minecraft/adapter.js'

const liveEnabled = process.env.MC_INV_LIVE_E2E === '1'
const version = process.env.MC_TEST_VERSION || '1.21.1'
const port = Number(process.env.MC_INV_TEST_PORT || '25573')

test(
  'survival and bounded chest primitives complete against a live vanilla server',
  { skip: !liveEnabled, timeout: 180_000 },
  async t => {
    const serverDirectory = await mkdtemp(join(tmpdir(), 'mc-ai-player-inventory-live-'))
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
        'motd=MC_AI_Player Task 9 isolated CI test',
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

    const runtime = new MineflayerInventoryRuntime(() => bot)
    const eat = new EatSkill(runtime, {
      preferredFood: ['bread'],
      excludedItems: ['golden_apple', 'enchanted_golden_apple']
    })
    const equip = new EquipSkill(runtime)
    const context = { signal: new AbortController().signal }

    server.stdin.write('give Moxue_Test minecraft:bread 8\n')
    server.stdin.write('give Moxue_Test minecraft:iron_helmet 1\n')
    await waitUntil(
      () => countInventory(bot, 'bread') >= 8 && countInventory(bot, 'iron_helmet') >= 1,
      15_000,
      'starter inventory'
    )

    server.stdin.write('effect give Moxue_Test minecraft:hunger 4 255 true\n')
    await waitUntil(() => (bot?.food ?? 20) < 20, 15_000, 'hunger effect')
    server.stdin.write('effect clear Moxue_Test minecraft:hunger\n')

    const breadBeforeEat = countInventory(bot, 'bread')
    const eatResult = await eat.execute(context, {})
    assert.deepEqual(eatResult, { status: 'succeeded', code: 'consumed' })
    await waitUntil(
      () => countInventory(bot, 'bread') === breadBeforeEat - 1,
      10_000,
      'bread consumption'
    )

    const equipResult = await equip.execute(context, {
      item: 'iron_helmet',
      destination: 'head'
    })
    assert.deepEqual(equipResult, { status: 'succeeded', code: 'equipped' })

    const position = bot.entity.position
    const chestPosition = {
      x: Math.floor(position.x) + 2,
      y: Math.floor(position.y),
      z: Math.floor(position.z)
    }
    server.stdin.write(
      `setblock ${chestPosition.x} ${chestPosition.y} ${chestPosition.z} minecraft:chest replace\n`
    )
    const chestVec = bot.entity.position.clone()
    chestVec.set(chestPosition.x, chestPosition.y, chestPosition.z)
    await waitUntil(
      () => bot?.blockAt(chestVec)?.name === 'chest',
      15_000,
      'chest block'
    )

    const target: ResolvedStorageTarget = {
      id: 'live-food-chest',
      position: chestPosition,
      expectedBlockNames: ['chest']
    }

    const breadBeforeDeposit = countInventory(bot, 'bread')
    const deposit = await runtime.transferContainerItem(
      target,
      'deposit',
      'bread',
      2,
      context.signal
    )
    assert.deepEqual(deposit, { status: 'succeeded', code: 'transferred' })
    await waitUntil(
      () => countInventory(bot, 'bread') === breadBeforeDeposit - 2,
      10_000,
      'deposit inventory delta'
    )
    assert.equal(bot.currentWindow, null)

    const breadBeforeWithdraw = countInventory(bot, 'bread')
    const withdraw = await runtime.transferContainerItem(
      target,
      'withdraw',
      'bread',
      1,
      context.signal
    )
    assert.deepEqual(withdraw, { status: 'succeeded', code: 'transferred' })
    await waitUntil(
      () => countInventory(bot, 'bread') === breadBeforeWithdraw + 1,
      10_000,
      'withdraw inventory delta'
    )
    assert.equal(bot.currentWindow, null)

    assert.equal(serverTail.includes('Moxue_Test joined the game'), true)
  }
)

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
