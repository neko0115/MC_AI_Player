import assert from 'node:assert/strict'
import test from 'node:test'
import type { SkillModule } from '../../src/modules/skill-module.js'
import { installSkillModules } from '../../src/modules/skill-module.js'
import { SkillRegistry } from '../../src/skills/registry.js'

test('skill modules install into the shared registry in declared order', () => {
  const registry = new SkillRegistry()
  const installed: string[] = []

  const modules: SkillModule[] = [
    {
      id: 'first',
      install(target) {
        installed.push('first')
        target.register({
          name: 'stay',
          async execute() {
            return { status: 'succeeded', code: 'held' }
          }
        })
      }
    },
    {
      id: 'second',
      install(target) {
        installed.push('second')
        target.register({
          name: 'eat',
          async execute() {
            return { status: 'succeeded', code: 'ate' }
          }
        })
      }
    }
  ]

  installSkillModules(registry, modules)

  assert.deepEqual(installed, ['first', 'second'])
  assert.deepEqual(registry.registeredNames(), ['stay', 'eat'])
})

test('duplicate module ids fail before any module installs', () => {
  const registry = new SkillRegistry()
  let installs = 0

  const duplicate: SkillModule[] = [
    { id: 'resources', install() { installs += 1 } },
    { id: 'resources', install() { installs += 1 } }
  ]

  assert.throws(
    () => installSkillModules(registry, duplicate),
    /duplicate skill module id: resources/
  )
  assert.equal(installs, 0)
  assert.deepEqual(registry.registeredNames(), [])
})

test('invalid module ids fail before installation', () => {
  const registry = new SkillRegistry()
  let installed = false

  assert.throws(
    () => installSkillModules(registry, [{
      id: 'Bad Module',
      install() {
        installed = true
      }
    }]),
    /invalid skill module id/
  )
  assert.equal(installed, false)
})
