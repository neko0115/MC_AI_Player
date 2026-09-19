import assert from 'node:assert/strict'
import test from 'node:test'
import { registeredDecisionSkills } from '../../src/agent/skill-catalog.js'
import { SkillRegistry } from '../../src/skills/registry.js'

test('registry exposes presence and registered names without advertising schema-only skills', () => {
  const registry = new SkillRegistry()
  registry.register({
    name: 'gather_resource',
    async execute() {
      return { status: 'succeeded', code: 'done' }
    }
  })
  registry.register({
    name: 'stay',
    async execute() {
      return { status: 'succeeded', code: 'held' }
    }
  })
  registry.register({
    name: 'acquire_resource',
    async execute() {
      return { status: 'succeeded', code: 'acquired' }
    }
  })

  assert.equal(registry.has('gather_resource'), true)
  assert.equal(registry.has('acquire_resource'), true)
  assert.equal(registry.has('deposit_item'), false)
  assert.deepEqual(
    registry.registeredNames(),
    ['gather_resource', 'stay', 'acquire_resource']
  )

  const skills = registeredDecisionSkills(registry)
  assert.deepEqual(
    skills.map(skill => skill.name),
    ['stay', 'acquire_resource']
  )
  assert.equal(skills.some(skill => skill.name === 'gather_resource'), false)
  assert.equal(skills.some(skill => skill.name === 'deposit_item'), false)
})
