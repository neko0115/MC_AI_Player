import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WorkspaceChatIntentSchema,
  normalizeWorkspaceSemanticContext
} from '../../src/workspace/chat-intent.js'

test('workspace semantic intent is operation based rather than phrase based', () => {
  const intent =
    WorkspaceChatIntentSchema.parse({
      kind: 'create',
      label: '東邊那塊我平常種東西的地方',
      purpose: 'farm',
      moxueUsePolicy: 'owner_only'
    })

  assert.deepEqual(intent, {
    kind: 'create',
    label: '東邊那塊我平常種東西的地方',
    purpose: 'farm',
    moxueUsePolicy: 'owner_only'
  })

  assert.deepEqual(
    WorkspaceChatIntentSchema.parse({
      kind: 'change_use_policy',
      target: {
        kind: 'explicit',
        value: '東側農田'
      },
      moxueUsePolicy:
        'moxue_preferred'
    }),
    {
      kind: 'change_use_policy',
      target: {
        kind: 'explicit',
        value: '東側農田'
      },
      moxueUsePolicy:
        'moxue_preferred'
    }
  )
})

test('workspace semantic intent rejects raw coordinates and invented mutation authority', () => {
  assert.equal(
    WorkspaceChatIntentSchema.safeParse({
      kind: 'create',
      label: '農田',
      purpose: 'farm',
      moxueUsePolicy: 'shared',
      bounds: {
        min: { x: 0, y: 64, z: 0 },
        max: { x: 8, y: 64, z: 8 }
      }
    }).success,
    false
  )

  assert.equal(
    WorkspaceChatIntentSchema.safeParse({
      kind: 'change_use_policy',
      target: {
        kind: 'explicit',
        value: '倉庫'
      },
      moxueUsePolicy: 'admin_override'
    }).success,
    false
  )

  assert.equal(
    WorkspaceChatIntentSchema.safeParse({
      kind: 'delete_forever',
      target: {
        kind: 'explicit',
        value: '農田'
      }
    }).success,
    false
  )
})

test('workspace semantic reference supports deictic context without encoding Chinese phrase lists', () => {
  for (const reference of [
    { kind: 'current_selection' },
    { kind: 'conversation' },
    { kind: 'nearby' },
    { kind: 'recent' },
    {
      kind: 'explicit',
      value: '我家旁邊那個小麥區'
    }
  ]) {
    assert.equal(
      WorkspaceChatIntentSchema.safeParse({
        kind: 'archive',
        target: reference
      }).success,
      true
    )
  }
})

test('workspace semantic context keeps the utterance opaque and bounded for an AI interpreter', () => {
  const utterance =
    '墨雪，這一整塊以後我自己留著種東西，你知道位置就好不要拿。'

  const normalized =
    normalizeWorkspaceSemanticContext({
      utterance,
      actorPrincipal: 'player-1',
      dimension: 'overworld',
      selection: {
        available: true,
        id: 'selection-1',
        dimension: 'overworld'
      },
      conversationWorkspaceId: null,
      recentWorkspaceId: null,
      workspaces: [{
        id: 'workspace-1',
        label: '舊農田',
        purpose: 'farm',
        moxueUsePolicy: 'shared',
        status: 'active',
        dimension: 'overworld'
      }]
    })

  assert.equal(
    normalized.utterance,
    utterance
  )
  assert.equal(
    normalized.selection.available,
    true
  )
  assert.equal(
    normalized.workspaces[0]
      ?.moxueUsePolicy,
    'shared'
  )
})

test('workspace semantic intent can explicitly decline or ask for clarification', () => {
  assert.deepEqual(
    WorkspaceChatIntentSchema.parse({
      kind: 'not_workspace'
    }),
    {
      kind: 'not_workspace'
    }
  )

  assert.deepEqual(
    WorkspaceChatIntentSchema.parse({
      kind: 'clarify',
      reason: 'ambiguous_reference'
    }),
    {
      kind: 'clarify',
      reason: 'ambiguous_reference'
    }
  )
})
