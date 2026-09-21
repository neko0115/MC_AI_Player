import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { GameKnowledgeLoader } from '../../src/knowledge/loader.js'

test('loads one exact Java version from committed reviewable files', () => {
  const loader = new GameKnowledgeLoader('fixtures/game-data')
  const pack = loader.loadJavaVersion('test-1.0')

  assert.equal(pack.minecraftVersion, 'test-1.0')
  assert.equal(
    pack.items.find(item => item.id === 'minecraft:stone')?.stackSize,
    64
  )
  assert.equal(
    pack.processing.find(
      fact => fact.output.item === 'minecraft:stone'
    )?.input.item,
    'minecraft:cobblestone'
  )
})

test('does not silently fall back to another Minecraft version', () => {
  const loader = new GameKnowledgeLoader('fixtures/game-data')

  assert.throws(
    () => loader.loadJavaVersion('test-2.0'),
    /knowledge_pack_missing:test-2.0/
  )
})

test('rejects metadata that does not exactly match requested version', () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-ai-knowledge-'))
  const directory = join(root, 'java', 'test-1.0')
  mkdirSync(directory, { recursive: true })

  writeFileSync(
    join(directory, 'metadata.json'),
    JSON.stringify({
      schemaVersion: 1,
      edition: 'java',
      minecraftVersion: 'test-9.9'
    })
  )

  const loader = new GameKnowledgeLoader(root)
  assert.throws(
    () => loader.loadJavaVersion('test-1.0'),
    /knowledge_pack_version_mismatch/
  )
})

test('rejects traversal-like version strings before filesystem access', () => {
  const loader = new GameKnowledgeLoader('fixtures/game-data')

  assert.throws(
    () => loader.loadJavaVersion('../test-1.0'),
    /knowledge_pack_invalid_version/
  )
})
