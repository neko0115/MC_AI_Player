import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveResourceProfile } from '../../src/minecraft/resource-profiles.js'

test('iron ore aliases resolve block targets to raw iron collection semantics', () => {
  for (const resource of ['iron_ore', 'deepslate_iron_ore', 'raw_iron']) {
    const profile = resolveResourceProfile(resource)
    assert.deepEqual(profile.blockNames, ['iron_ore', 'deepslate_iron_ore'])
    assert.deepEqual(profile.collectedItemNames, ['raw_iron'])
    assert.equal(profile.capabilityId, 'vein_mining')
    assert.equal(profile.minimumOnePerBlock, true)
    assert.equal(profile.toolKind, 'pickaxe')
    assert.deepEqual(profile.forbiddenToolEnchantments, ['silk_touch'])
    assert.deepEqual(
      profile.acceleratorForbiddenToolEnchantments,
      ['silk_touch']
    )
  }
})

test('vanilla namespace is normalized to Mineflayer runtime names', () => {
  const iron = resolveResourceProfile('minecraft:iron_ore')
  assert.deepEqual(iron.blockNames, ['iron_ore', 'deepslate_iron_ore'])
  assert.deepEqual(iron.collectedItemNames, ['raw_iron'])

  const log = resolveResourceProfile('minecraft:oak_log')
  assert.deepEqual(log.blockNames, ['oak_log'])
  assert.deepEqual(log.collectedItemNames, ['oak_log'])
  assert.equal(log.capabilityId, 'tree_felling')
})

test('variable-drop ores remain chain-safe under minimum fulfillment semantics', () => {
  const copper = resolveResourceProfile('copper_ore')
  assert.deepEqual(copper.collectedItemNames, ['raw_copper'])
  assert.equal(copper.capabilityId, 'vein_mining')
  assert.equal(copper.minimumOnePerBlock, true)

  const redstone = resolveResourceProfile('redstone_ore')
  assert.deepEqual(redstone.collectedItemNames, ['redstone'])
  assert.equal(redstone.minimumOnePerBlock, true)

  const lapis = resolveResourceProfile('lapis_ore')
  assert.deepEqual(lapis.collectedItemNames, ['lapis_lazuli'])
  assert.equal(lapis.minimumOnePerBlock, true)
})

test('unknown resources remain exact passthrough profiles without invented capabilities', () => {
  const profile = resolveResourceProfile('amethyst_block')
  assert.deepEqual(profile.blockNames, ['amethyst_block'])
  assert.deepEqual(profile.collectedItemNames, ['amethyst_block'])
  assert.equal(profile.capabilityId, null)
  assert.equal(profile.toolKind, null)
})


test('modded namespaces never inherit vanilla ore capability semantics by suffix', () => {
  const profile = resolveResourceProfile('examplemod:iron_ore')
  assert.deepEqual(profile.blockNames, ['examplemod:iron_ore'])
  assert.deepEqual(profile.collectedItemNames, ['examplemod:iron_ore'])
  assert.equal(profile.capabilityId, null)
  assert.equal(profile.toolKind, null)
})
