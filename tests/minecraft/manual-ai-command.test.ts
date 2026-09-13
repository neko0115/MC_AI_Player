import assert from 'node:assert/strict'
import test from 'node:test'
import { parseManualAiCommand } from '../../src/minecraft/manual-ai-command.js'

test('explicit deep command creates one bounded new-task request', () => {
  assert.deepEqual(parseManualAiCommand('!moxue deep 重新規劃採木頭'), {
    kind: 'deep_new',
    instruction: '重新規劃採木頭'
  })
  assert.deepEqual(parseManualAiCommand('  !MOXUE   DEEP   find a way home  '), {
    kind: 'deep_new',
    instruction: 'find a way home'
  })
})

test('deep current targets only the active-task decision and may carry one directive', () => {
  assert.deepEqual(parseManualAiCommand('!moxue deep current 再確認背包和箱子'), {
    kind: 'deep_current',
    directive: '再確認背包和箱子'
  })
  assert.deepEqual(parseManualAiCommand('!moxue deep current'), {
    kind: 'deep_current'
  })
})

test('empty deep-new and ordinary natural language are not privileged commands', () => {
  assert.equal(parseManualAiCommand('!moxue deep'), null)
  assert.equal(parseManualAiCommand('墨雪仔細想一下'), null)
  assert.equal(parseManualAiCommand('用大模型看看'), null)
})

test('manual command rejects oversized instruction instead of truncating authorization intent', () => {
  assert.equal(parseManualAiCommand(`!moxue deep ${'x'.repeat(1001)}`), null)
  assert.equal(parseManualAiCommand(`!moxue deep current ${'y'.repeat(1001)}`), null)
})
