import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatWorkspaceChatReply
} from '../../src/workspace/chat-reply.js'
import type {
  WorkspaceRegion
} from '../../src/workspace/contracts.js'

function workspace(
  overrides:
    Partial<WorkspaceRegion> = {}
): WorkspaceRegion {
  return {
    id: 'workspace-1',
    worldKey: 'server:survival',
    dimension: 'overworld',
    bounds: {
      min: { x: 0, y: 64, z: 0 },
      max: { x: 8, y: 64, z: 8 }
    },
    label: '農田',
    purpose: 'farm',
    moxueUsePolicy: 'shared',
    status: 'active',
    tags: [],
    constraints: {},
    ownerPrincipal: 'player-1',
    sourceSelectionId: 'selection-1',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

test('workspace reply makes success and use policy visible without exposing internal codes', () => {
  assert.equal(
    formatWorkspaceChatReply({
      kind: 'handled',
      operation: 'create',
      workspace: workspace({
        label: '我的私人農田',
        moxueUsePolicy: 'owner_only'
      })
    }),
    '好，我記住「我的私人農田」了。這是你的私人區域，我不會使用裡面的資源。'
  )

  assert.equal(
    formatWorkspaceChatReply({
      kind: 'handled',
      operation: 'change_use_policy',
      workspace: workspace({
        label: '墨雪田',
        moxueUsePolicy:
          'moxue_preferred'
      })
    }),
    '好，「墨雪田」的使用規則已更新。這是你優先給我使用的區域。'
  )

  assert.equal(
    formatWorkspaceChatReply({
      kind: 'rejected',
      code: 'workspace_not_owner'
    }),
    '這個區域操作目前無法安全完成。'
  )
})

test('workspace reply explains missing selection and bounded ambiguity', () => {
  assert.equal(
    formatWorkspaceChatReply({
      kind: 'clarify',
      reason: 'missing_selection'
    }),
    '請先用墨雪設定棍框選區域，再告訴我這裡要設定成什麼。'
  )

  const message =
    formatWorkspaceChatReply({
      kind: 'clarify',
      reason: 'ambiguous_reference',
      candidates: [
        workspace({
          id: 'workspace-1',
          label: '東側農田'
        }),
        workspace({
          id: 'workspace-2',
          label: '西側農田'
        })
      ]
    })

  assert.equal(
    message,
    '我找到不只一個可能的區域：東側農田、西側農田。請告訴我是其中哪一個。'
  )
})

test('duplicate-label ambiguity tells the player how to disambiguate with the setting wand', () => {
  const message =
    formatWorkspaceChatReply({
      kind: 'clarify',
      reason:
        'ambiguous_reference',
      candidates: [
        workspace({
          id: 'workspace-1',
          label: 'W5C-AmbigFarm',
          sourceSelectionId:
            'selection-1'
        }),
        workspace({
          id: 'workspace-2',
          label: 'W5C-AmbigFarm',
          sourceSelectionId:
            'selection-2'
        })
      ]
    })

  assert.equal(
    message,
    '我找到 2 個都叫「W5C-AmbigFarm」的區域。請用墨雪設定棍選其中一塊，再告訴我你指的是選到的那個。'
  )
})

test('workspace reply sanitizes user labels and remains non-command bounded chat', () => {
  const message =
    formatWorkspaceChatReply({
      kind: 'handled',
      operation: 'create',
      workspace: workspace({
        label:
          '/workspace-test\n這是很長很長很長很長很長很長很長很長很長很長很長的區域'
      })
    })

  assert.ok(message)
  assert.equal(message.startsWith('/'), false)
  assert.equal(/[\r\n]/u.test(message), false)
  assert.ok(message.length <= 256)
})

test('fallback creates no workspace reply', () => {
  assert.equal(
    formatWorkspaceChatReply({
      kind: 'fallback'
    }),
    null
  )
})
