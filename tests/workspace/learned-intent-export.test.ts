import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  WorkspaceSemanticContext
} from '../../src/workspace/chat-intent.js'
import {
  SqliteLearnedWorkspaceIntentCache
} from '../../src/workspace/learned-intent-cache.js'
import {
  decryptWorkspaceIntentSnapshot,
  deriveWorkspaceSemanticKeys,
  encryptWorkspaceIntentSnapshot,
  exportEncryptedWorkspaceIntentCache,
  importEncryptedWorkspaceIntentCache
} from '../../src/workspace/learned-intent-export.js'

const MASTER_SECRET =
  'workspace-semantic-master-secret-for-tests-0123456789'

function context(
  utterance: string
): WorkspaceSemanticContext {
  return {
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
    workspaces: []
  }
}

test('workspace semantic key derivation is stable and separates HMAC from export encryption keys', () => {
  const first =
    deriveWorkspaceSemanticKeys(
      MASTER_SECRET
    )
  const second =
    deriveWorkspaceSemanticKeys(
      MASTER_SECRET
    )

  assert.equal(
    first.hmacKey.byteLength,
    32
  )
  assert.equal(
    first.exportKey.byteLength,
    32
  )
  assert.deepEqual(
    first.hmacKey,
    second.hmacKey
  )
  assert.deepEqual(
    first.exportKey,
    second.exportKey
  )
  assert.notDeepEqual(
    first.hmacKey,
    first.exportKey
  )
})

test('encrypted export round-trips learned mappings into another cache without plaintext utterances', () => {
  const keys =
    deriveWorkspaceSemanticKeys(
      MASTER_SECRET
    )
  const source =
    new SqliteLearnedWorkspaceIntentCache(
      ':memory:',
      { hmacKey: keys.hmacKey }
    )
  const target =
    new SqliteLearnedWorkspaceIntentCache(
      ':memory:',
      { hmacKey: keys.hmacKey }
    )
  const current =
    context(
      'PRIVATE_UTTERANCE_773991 這裡當農田'
    )

  try {
    source.rememberSuccessful(
      current,
      {
        kind: 'create',
        label: '農田',
        purpose: 'farm',
        moxueUsePolicy:
          'owner_only'
      }
    )

    const envelope =
      exportEncryptedWorkspaceIntentCache(
        source,
        keys.exportKey,
        {
          randomBytesFn:
            size => Buffer.alloc(
              size,
              7
            )
        }
      )

    assert.equal(
      envelope.includes(
        'PRIVATE_UTTERANCE_773991'
      ),
      false
    )
    assert.equal(
      envelope.includes(
        '"label":"農田"'
      ),
      false
    )

    const imported =
      importEncryptedWorkspaceIntentCache(
        target,
        envelope,
        keys.exportKey
      )
    assert.deepEqual(
      imported,
      {
        merged: 1,
        skipped: 0
      }
    )
    assert.deepEqual(
      target.lookup(current),
      {
        kind: 'create',
        label: '農田',
        purpose: 'farm',
        moxueUsePolicy:
          'owner_only'
      }
    )
  } finally {
    source.close()
    target.close()
  }
})

test('wrong export secret and ciphertext tampering fail authentication', () => {
  const firstKeys =
    deriveWorkspaceSemanticKeys(
      MASTER_SECRET
    )
  const secondKeys =
    deriveWorkspaceSemanticKeys(
      'another-workspace-semantic-master-secret-987654321'
    )

  const snapshot = {
    format:
      'mc-ai-player.workspace-intent-cache.snapshot' as const,
    version: 1 as const,
    semanticContractVersion: 1,
    exportedAt: 10,
    records: []
  }

  const envelope =
    encryptWorkspaceIntentSnapshot(
      snapshot,
      firstKeys.exportKey,
      {
        randomBytesFn:
          size => Buffer.alloc(
            size,
            3
          )
      }
    )

  assert.throws(
    () =>
      decryptWorkspaceIntentSnapshot(
        envelope,
        secondKeys.exportKey
      ),
    /authentication failed/i
  )

  const parsed =
    JSON.parse(envelope) as {
      ciphertext: string
      [key: string]: unknown
    }
  const ciphertext =
    Buffer.from(
      parsed.ciphertext,
      'base64'
    )
  ciphertext[0] =
    (ciphertext[0] ?? 0) ^ 1
  parsed.ciphertext =
    ciphertext.toString('base64')

  assert.throws(
    () =>
      decryptWorkspaceIntentSnapshot(
        JSON.stringify(parsed),
        firstKeys.exportKey
      ),
    /authentication failed/i
  )
})

test('authenticated but malformed decrypted snapshot is rejected by schema validation', () => {
  const keys =
    deriveWorkspaceSemanticKeys(
      MASTER_SECRET
    )

  const malformed = {
    format:
      'mc-ai-player.workspace-intent-cache.snapshot',
    version: 1,
    semanticContractVersion: 1,
    exportedAt: 10,
    records: [{
      fingerprint: 'not-a-fingerprint'
    }]
  } as any

  const envelope =
    encryptWorkspaceIntentSnapshot(
      malformed,
      keys.exportKey,
      {
        randomBytesFn:
          size => Buffer.alloc(
            size,
            5
          )
      }
    )

  assert.throws(
    () =>
      decryptWorkspaceIntentSnapshot(
        envelope,
        keys.exportKey
      )
  )
})

test('incompatible semantic contract records are skipped rather than coerced', () => {
  const keys =
    deriveWorkspaceSemanticKeys(
      MASTER_SECRET
    )
  const target =
    new SqliteLearnedWorkspaceIntentCache(
      ':memory:',
      { hmacKey: keys.hmacKey }
    )

  try {
    const snapshot = {
      format:
        'mc-ai-player.workspace-intent-cache.snapshot' as const,
      version: 1 as const,
      semanticContractVersion: 999,
      exportedAt: 10,
      records: []
    }

    const envelope =
      encryptWorkspaceIntentSnapshot(
        snapshot,
        keys.exportKey,
        {
          randomBytesFn:
            size => Buffer.alloc(
              size,
              6
            )
        }
      )

    const result =
      importEncryptedWorkspaceIntentCache(
        target,
        envelope,
        keys.exportKey
      )

    assert.deepEqual(
      result,
      {
        merged: 0,
        skipped: 0
      }
    )
  } finally {
    target.close()
  }
})

test('encrypted import preserves conflict semantics instead of choosing a winner', () => {
  const keys =
    deriveWorkspaceSemanticKeys(
      MASTER_SECRET
    )
  const source =
    new SqliteLearnedWorkspaceIntentCache(
      ':memory:',
      { hmacKey: keys.hmacKey }
    )
  const target =
    new SqliteLearnedWorkspaceIntentCache(
      ':memory:',
      { hmacKey: keys.hmacKey }
    )
  const current =
    context(
      '這區之後就是我的地方'
    )

  try {
    source.rememberSuccessful(
      current,
      {
        kind: 'create',
        label: '私人區',
        purpose: 'custom',
        moxueUsePolicy:
          'owner_only'
      }
    )
    source.rememberSuccessful(
      current,
      {
        kind: 'create',
        label: '共享區',
        purpose: 'custom',
        moxueUsePolicy:
          'shared'
      }
    )

    const envelope =
      exportEncryptedWorkspaceIntentCache(
        source,
        keys.exportKey
      )
    importEncryptedWorkspaceIntentCache(
      target,
      envelope,
      keys.exportKey
    )

    assert.equal(
      target.lookup(current),
      null
    )
  } finally {
    source.close()
    target.close()
  }
})

test('revoked learned mappings remain revoked after encrypted export and import', () => {
  const keys =
    deriveWorkspaceSemanticKeys(
      MASTER_SECRET
    )
  const source =
    new SqliteLearnedWorkspaceIntentCache(
      ':memory:',
      { hmacKey: keys.hmacKey }
    )
  const target =
    new SqliteLearnedWorkspaceIntentCache(
      ':memory:',
      { hmacKey: keys.hmacKey }
    )
  const current =
    context('這區我自己用')

  try {
    source.rememberSuccessful(
      current,
      {
        kind: 'create',
        label: '私人區',
        purpose: 'custom',
        moxueUsePolicy:
          'owner_only'
      }
    )
    source.revokeUtterance(
      current
    )

    const envelope =
      exportEncryptedWorkspaceIntentCache(
        source,
        keys.exportKey
      )
    importEncryptedWorkspaceIntentCache(
      target,
      envelope,
      keys.exportKey
    )

    assert.equal(
      target.lookup(current),
      null
    )
  } finally {
    source.close()
    target.close()
  }
})
