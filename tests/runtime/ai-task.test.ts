import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AiTaskQueue,
  createAiTask,
  createManualRouteGrant,
  noteActionSuccess,
  noteGoalFailure
} from '../../src/runtime/ai-task.js'

test('AiTask keeps bounded objective identity and base complexity evidence', () => {
  const task = createAiTask({
    taskId: 'task-1',
    objective: '採木頭然後回基地放箱子',
    source: 'minecraft',
    principalKind: 'minecraft_operator',
    taskGeneration: 3,
    minecraftSessionGeneration: 8,
    baseComplexityEvidence: { multiStep: true, multiSkill: true }
  })

  assert.equal(task.taskId, 'task-1')
  assert.equal(task.objective, '採木頭然後回基地放箱子')
  assert.equal(task.state, 'active')
  assert.equal(task.activeGoalId, null)
  assert.deepEqual(task.baseComplexityEvidence, { multiStep: true, multiSkill: true })
  assert.equal(task.consecutiveReplanCount, 0)
  assert.equal(task.totalReplanCount, 0)
})

test('AiTask rejects an oversized objective instead of silently changing task meaning', () => {
  assert.throws(() => createAiTask({
    taskId: 'task-1',
    objective: 'x'.repeat(1001),
    source: 'minecraft',
    principalKind: 'minecraft_untrusted',
    taskGeneration: 1,
    minecraftSessionGeneration: 1,
    baseComplexityEvidence: {}
  }), /objective/i)
})

test('pending task queue accepts eight tasks and rejects the ninth without dropping old work', () => {
  const queue = new AiTaskQueue(8)
  for (let index = 1; index <= 8; index += 1) {
    assert.equal(queue.enqueue(createAiTask({
      taskId: `task-${index}`,
      objective: `task ${index}`,
      source: 'minecraft',
      principalKind: 'minecraft_untrusted',
      taskGeneration: 1,
      minecraftSessionGeneration: 1,
      baseComplexityEvidence: {}
    })), true)
  }

  assert.equal(queue.enqueue(createAiTask({
    taskId: 'task-9', objective: 'task 9', source: 'minecraft',
    principalKind: 'minecraft_untrusted', taskGeneration: 1,
    minecraftSessionGeneration: 1, baseComplexityEvidence: {}
  })), false)
  assert.equal(queue.size(), 8)
  assert.equal(queue.dequeue()?.taskId, 'task-1')
  assert.equal(queue.size(), 7)
})

test('ManualRouteGrant is one-shot and bound to task plus Minecraft session generations', () => {
  const grant = createManualRouteGrant({
    requestId: 'request-1',
    taskId: 'task-1',
    taskGeneration: 4,
    minecraftSessionGeneration: 9,
    principalKind: 'minecraft_owner',
    directive: '再檢查一次背包'
  })

  assert.equal(grant.state, 'pending')
  assert.equal(grant.validFor('task-1', 4, 9), true)
  assert.equal(grant.validFor('task-1', 5, 9), false)
  assert.equal(grant.validFor('task-1', 4, 10), false)
  assert.equal(grant.consume('task-1', 4, 9), true)
  assert.equal(grant.state, 'consumed')
  assert.equal(grant.consume('task-1', 4, 9), false)
})

test('invalidated ManualRouteGrant can never be revived or consumed', () => {
  const grant = createManualRouteGrant({
    requestId: 'request-1', taskId: 'task-1', taskGeneration: 1,
    minecraftSessionGeneration: 2, principalKind: 'minecraft_operator'
  })
  grant.invalidate()
  assert.equal(grant.state, 'invalidated')
  assert.equal(grant.validFor('task-1', 1, 2), false)
  assert.equal(grant.consume('task-1', 1, 2), false)
})

test('true goal failure increments both counters while success resets only consecutive failures', () => {
  const task = createAiTask({
    taskId: 'task-1', objective: '採木頭', source: 'minecraft',
    principalKind: 'minecraft_untrusted', taskGeneration: 1,
    minecraftSessionGeneration: 1, baseComplexityEvidence: {}
  })

  noteGoalFailure(task)
  noteGoalFailure(task)
  assert.equal(task.consecutiveReplanCount, 2)
  assert.equal(task.totalReplanCount, 2)

  noteActionSuccess(task)
  assert.equal(task.consecutiveReplanCount, 0)
  assert.equal(task.totalReplanCount, 2)
})
