import assert from 'node:assert/strict'
import {
  mkdtempSync,
  readFileSync,
  rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type {
  WorkspaceChatIntent,
  WorkspaceIntentInterpreter,
  WorkspaceSemanticContext
} from '../../src/workspace/chat-intent.js'
import {
  CacheFirstWorkspaceIntentInterpreter,
  SqliteLearnedWorkspaceIntentCache
} from '../../src/workspace/learned-intent-cache.js'

const HMAC_KEY =
  'workspace-semantic-cache-test-key-0123456789'

function context(
  utterance: string,
  overrides:
    Partial<WorkspaceSemanticContext> = {}
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
    workspaces: [],
    ...overrides
  }
}

class CountingFallback
implements WorkspaceIntentInterpreter {
  calls = 0
  intent:
    WorkspaceChatIntent = {
      kind: 'create',
      label: '農田',
      purpose: 'farm',
      moxueUsePolicy: 'shared'
    }

  async interpret(): Promise<WorkspaceChatIntent> {
    this.calls += 1
    return structuredClone(
      this.intent
    )
  }
}

test('cache-first interpreter avoids provider after a successful learned mapping', async () => {
  const cache =
    new SqliteLearnedWorkspaceIntentCache(
      ':memory:',
      { hmacKey: HMAC_KEY }
    )
  const fallback =
    new CountingFallback()
  const interpreter =
    new CacheFirstWorkspaceIntentInterpreter(
      cache,
      fallback
    )

  try {
    const current =
      context('這裡以後當農田')

    const first =
      await interpreter.interpret(
        current,
        new AbortController().signal
      )
    assert.equal(
      fallback.calls,
      1
    )

    await interpreter.learnSuccessful(
      current,
      first
    )

    fallback.intent = {
      kind: 'not_workspace'
    }

    const second =
      await interpreter.interpret(
        current,
        new AbortController().signal
      )

    assert.deepEqual(
      second,
      first
    )
    assert.equal(
      fallback.calls,
      1
    )
  } finally {
    cache.close()
  }
})

test('cache stores no raw utterance and a different HMAC key cannot reproduce the lookup', () => {
  const directory =
    mkdtempSync(
      join(
        tmpdir(),
        'workspace-cache-'
      )
    )
  const filename =
    join(
      directory,
      'learned.sqlite3'
    )
  const rawSentinel =
    'VERY_PRIVATE_PLAYER_UTTERANCE_912734'

  try {
    const first =
      new SqliteLearnedWorkspaceIntentCache(
        filename,
        { hmacKey: HMAC_KEY }
      )
    first.rememberSuccessful(
      context(rawSentinel),
      {
        kind: 'create',
        label: 'ordinary-label',
        purpose: 'farm',
        moxueUsePolicy: 'owner_only'
      }
    )
    first.close()

    const bytes =
      readFileSync(filename)
    assert.equal(
      bytes.includes(
        Buffer.from(rawSentinel)
      ),
      false
    )

    const second =
      new SqliteLearnedWorkspaceIntentCache(
        filename,
        {
          hmacKey:
            'different-semantic-cache-key-123456789012345'
        }
      )
    try {
      assert.equal(
        second.lookup(
          context(rawSentinel)
        ),
        null
      )
    } finally {
      second.close()
    }
  } finally {
    rmSync(directory, {
      recursive: true,
      force: true
    })
  }
})

test('normalization reuses harmless unicode and whitespace variants without phrase templates', () => {
  const cache =
    new SqliteLearnedWorkspaceIntentCache(
      ':memory:',
      { hmacKey: HMAC_KEY }
    )

  try {
    const learned =
      context('  倉庫　給你優先用  ')
    assert.equal(
      cache.rememberSuccessful(
        learned,
        {
          kind:
            'change_use_policy',
          target: {
            kind: 'explicit',
            value: '倉庫'
          },
          moxueUsePolicy:
            'moxue_preferred'
        }
      ),
      true
    )

    const hit =
      cache.lookup(
        context('倉庫 給你優先用')
      )
    assert.equal(
      hit?.kind,
      'change_use_policy'
    )
  } finally {
    cache.close()
  }
})

test('conflicting learned intents fail closed to cache miss instead of last-write-wins', () => {
  const cache =
    new SqliteLearnedWorkspaceIntentCache(
      ':memory:',
      { hmacKey: HMAC_KEY }
    )
  const current =
    context('這裡以後就是我的區域')

  try {
    assert.equal(
      cache.rememberSuccessful(
        current,
        {
          kind: 'create',
          label: '私人區',
          purpose: 'custom',
          moxueUsePolicy:
            'owner_only'
        }
      ),
      true
    )
    assert.equal(
      cache.rememberSuccessful(
        current,
        {
          kind: 'create',
          label: '共享區',
          purpose: 'custom',
          moxueUsePolicy:
            'shared'
        }
      ),
      true
    )

    assert.equal(
      cache.lookup(current),
      null
    )
  } finally {
    cache.close()
  }
})

test('clarify not_workspace and nearby-dependent intents are not learned automatically', () => {
  const cache =
    new SqliteLearnedWorkspaceIntentCache(
      ':memory:',
      { hmacKey: HMAC_KEY }
    )
  const current =
    context('某句話')

  try {
    for (const intent of [
      {
        kind: 'not_workspace'
      },
      {
        kind: 'clarify',
        reason:
          'ambiguous_intent'
      },
      {
        kind: 'archive',
        target: {
          kind: 'nearby'
        }
      }
    ] as WorkspaceChatIntent[]) {
      assert.equal(
        cache.rememberSuccessful(
          current,
          intent
        ),
        false
      )
    }
    assert.equal(
      cache.lookup(current),
      null
    )
  } finally {
    cache.close()
  }
})

test('context-sensitive learned mappings require their original reference class to remain available', () => {
  const cache =
    new SqliteLearnedWorkspaceIntentCache(
      ':memory:',
      { hmacKey: HMAC_KEY }
    )

  try {
    const conversation =
      context(
        '這個改叫主倉庫',
        {
          conversationWorkspaceId:
            'workspace-1'
        }
      )

    assert.equal(
      cache.rememberSuccessful(
        conversation,
        {
          kind: 'rename',
          target: {
            kind: 'conversation'
          },
          label: '主倉庫'
        }
      ),
      true
    )

    assert.equal(
      cache.lookup(
        context(
          '這個改叫主倉庫',
          {
            conversationWorkspaceId:
              null
          }
        )
      ),
      null
    )

    assert.equal(
      cache.lookup(
        conversation
      )?.kind,
      'rename'
    )
  } finally {
    cache.close()
  }
})

test('revocation removes all current learned variants for one utterance fingerprint', () => {
  const cache =
    new SqliteLearnedWorkspaceIntentCache(
      ':memory:',
      { hmacKey: HMAC_KEY }
    )
  const current =
    context('這區我自己用')

  try {
    cache.rememberSuccessful(
      current,
      {
        kind: 'create',
        label: '私人區',
        purpose: 'custom',
        moxueUsePolicy:
          'owner_only'
      }
    )

    assert.ok(
      cache.lookup(current)
    )
    assert.equal(
      cache.revokeUtterance(current),
      1
    )
    assert.equal(
      cache.lookup(current),
      null
    )
  } finally {
    cache.close()
  }
})
