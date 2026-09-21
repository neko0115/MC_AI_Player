import assert from 'node:assert/strict'
import {
  execFileSync,
  spawnSync
} from 'node:child_process'
import {
  mkdtempSync,
  rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  deriveWorkspaceSemanticKeys,
  decryptWorkspaceIntentSnapshot
} from '../../src/workspace/learned-intent-export.js'
import {
  SqliteLearnedWorkspaceIntentCache
} from '../../src/workspace/learned-intent-cache.js'
import type {
  WorkspaceSemanticContext
} from '../../src/workspace/chat-intent.js'
import {
  GitCliWorkspaceSemanticTransport,
  WorkspaceSemanticGitSync,
  WorkspaceSemanticGitSyncError,
  type WorkspaceSemanticGitTransport,
  type WorkspaceSemanticPublishInput,
  type WorkspaceSemanticPublishResult,
  type WorkspaceSemanticRemoteArtifact
} from '../../src/workspace/learned-intent-git-sync.js'

const MASTER_SECRET =
  'workspace-semantic-git-sync-test-secret-0123456789'

function context(
  utterance: string,
  selectionAvailable = true
): WorkspaceSemanticContext {
  return {
    utterance,
    actorPrincipal: 'player-1',
    dimension: 'overworld',
    selection: {
      available:
        selectionAvailable,
      id:
        selectionAvailable
          ? 'selection-1'
          : null,
      dimension:
        selectionAvailable
          ? 'overworld'
          : null
    },
    conversationWorkspaceId:
      null,
    recentWorkspaceId:
      null,
    workspaces: []
  }
}

class MemoryTransport
implements WorkspaceSemanticGitTransport {
  commit = 0
  remote:
    WorkspaceSemanticRemoteArtifact |
    null = null
  publishCount = 0
  conflictOnce = false
  conflictArtifact:
    WorkspaceSemanticRemoteArtifact |
    null = null

  fetch():
    WorkspaceSemanticRemoteArtifact |
    null {
    return this.remote
      ? structuredClone(
          this.remote
        )
      : null
  }

  publish(
    input: WorkspaceSemanticPublishInput
  ): WorkspaceSemanticPublishResult {
    if (
      this.conflictOnce &&
      this.conflictArtifact
    ) {
      this.conflictOnce = false
      this.remote =
        structuredClone(
          this.conflictArtifact
        )
      return {
        kind: 'conflict'
      }
    }

    const currentParent =
      this.remote?.commitSha ??
      null
    if (
      currentParent !==
      input.parentCommitSha
    ) {
      return {
        kind: 'conflict'
      }
    }

    this.publishCount += 1
    this.commit += 1
    this.remote = {
      commitSha:
        String(this.commit)
          .padStart(40, 'a'),
      envelope:
        input.envelope
    }

    return {
      kind: 'pushed',
      commitSha:
        this.remote.commitSha
    }
  }
}

function createCache() {
  const keys =
    deriveWorkspaceSemanticKeys(
      MASTER_SECRET
    )
  const cache =
    new SqliteLearnedWorkspaceIntentCache(
      ':memory:',
      {
        hmacKey:
          keys.hmacKey
      }
    )
  return {
    cache,
    keys
  }
}

test('explicit semantic sync push publishes encrypted records and identical second push is a no-op', () => {
  const current =
    createCache()
  const transport =
    new MemoryTransport()

  try {
    current.cache
      .rememberSuccessful(
        context(
          '幫我看一下東側農田'
        ),
        {
          kind: 'show',
          target: {
            kind: 'explicit',
            value: '東側農田'
          }
        }
      )

    const sync =
      new WorkspaceSemanticGitSync({
        cache: current.cache,
        exportKey:
          current.keys.exportKey,
        transport
      })

    const first =
      sync.push()
    assert.equal(
      first.kind,
      'pushed'
    )
    assert.equal(
      transport.publishCount,
      1
    )
    assert.ok(
      transport.remote
    )
    assert.equal(
      transport.remote
        .envelope
        .includes(
          '幫我看一下東側農田'
        ),
      false
    )

    const decrypted =
      decryptWorkspaceIntentSnapshot(
        transport.remote.envelope,
        current.keys.exportKey
      )
    assert.equal(
      decrypted.records.length,
      1
    )

    const second =
      sync.push()
    assert.equal(
      second.kind,
      'no_change'
    )
    assert.equal(
      transport.publishCount,
      1
    )
  } finally {
    current.cache.close()
    current.keys.hmacKey.fill(0)
    current.keys.exportKey.fill(0)
  }
})

test('two machines merge remote encrypted semantics before publishing instead of last-write-wins', () => {
  const transport =
    new MemoryTransport()
  const first =
    createCache()
  const second =
    createCache()

  try {
    first.cache.rememberSuccessful(
      context(
        '查看東側農田'
      ),
      {
        kind: 'show',
        target: {
          kind: 'explicit',
          value: '東側農田'
        }
      }
    )
    second.cache.rememberSuccessful(
      context(
        '查看西側倉庫'
      ),
      {
        kind: 'show',
        target: {
          kind: 'explicit',
          value: '西側倉庫'
        }
      }
    )

    const firstSync =
      new WorkspaceSemanticGitSync({
        cache: first.cache,
        exportKey:
          first.keys.exportKey,
        transport
      })
    const secondSync =
      new WorkspaceSemanticGitSync({
        cache: second.cache,
        exportKey:
          second.keys.exportKey,
        transport
      })

    assert.equal(
      firstSync.push().kind,
      'pushed'
    )
    assert.equal(
      secondSync.push().kind,
      'pushed'
    )

    const remote =
      transport.remote
    assert.ok(remote)
    const snapshot =
      decryptWorkspaceIntentSnapshot(
        remote.envelope,
        first.keys.exportKey
      )
    assert.equal(
      snapshot.records.length,
      2
    )

    const pulled =
      firstSync.pull()
    assert.equal(
      pulled.kind,
      'pulled'
    )
    assert.deepEqual(
      first.cache.lookup(
        context(
          '查看西側倉庫'
        )
      ),
      {
        kind: 'show',
        target: {
          kind: 'explicit',
          value: '西側倉庫'
        }
      }
    )
  } finally {
    first.cache.close()
    second.cache.close()
    first.keys.hmacKey.fill(0)
    first.keys.exportKey.fill(0)
    second.keys.hmacKey.fill(0)
    second.keys.exportKey.fill(0)
  }
})

test('concurrent remote update is refetched merged and retried', () => {
  const local =
    createCache()
  const other =
    createCache()
  const transport =
    new MemoryTransport()

  try {
    local.cache.rememberSuccessful(
      context('查看本機農田'),
      {
        kind: 'show',
        target: {
          kind: 'explicit',
          value: '本機農田'
        }
      }
    )
    other.cache.rememberSuccessful(
      context('查看遠端農田'),
      {
        kind: 'show',
        target: {
          kind: 'explicit',
          value: '遠端農田'
        }
      }
    )

    const remoteEnvelope =
      (() => {
        const otherTransport =
          new MemoryTransport()
        const otherSync =
          new WorkspaceSemanticGitSync({
            cache: other.cache,
            exportKey:
              other.keys.exportKey,
            transport:
              otherTransport
          })
        otherSync.push()
        assert.ok(
          otherTransport.remote
        )
        return {
          commitSha:
            'b'.repeat(40),
          envelope:
            otherTransport.remote
              .envelope
        }
      })()

    transport.conflictOnce = true
    transport.conflictArtifact =
      remoteEnvelope

    const sync =
      new WorkspaceSemanticGitSync({
        cache: local.cache,
        exportKey:
          local.keys.exportKey,
        transport
      })

    const result =
      sync.push()
    assert.equal(
      result.kind,
      'pushed'
    )

    const remote =
      transport.remote
    assert.ok(remote)
    const snapshot =
      decryptWorkspaceIntentSnapshot(
        remote.envelope,
        local.keys.exportKey
      )
    assert.equal(
      snapshot.records.length,
      2
    )
  } finally {
    local.cache.close()
    other.cache.close()
    local.keys.hmacKey.fill(0)
    local.keys.exportKey.fill(0)
    other.keys.hmacKey.fill(0)
    other.keys.exportKey.fill(0)
  }
})

test('wrong semantic master secret fails closed while pulling encrypted remote state', () => {
  const source =
    createCache()
  const wrongKeys =
    deriveWorkspaceSemanticKeys(
      'different-semantic-sync-secret-9876543210'
    )
  const target =
    new SqliteLearnedWorkspaceIntentCache(
      ':memory:',
      {
        hmacKey:
          wrongKeys.hmacKey
      }
    )
  const transport =
    new MemoryTransport()

  try {
    source.cache.rememberSuccessful(
      context('查看安全農田'),
      {
        kind: 'show',
        target: {
          kind: 'explicit',
          value: '安全農田'
        }
      }
    )

    new WorkspaceSemanticGitSync({
      cache: source.cache,
      exportKey:
        source.keys.exportKey,
      transport
    }).push()

    assert.throws(
      () =>
        new WorkspaceSemanticGitSync({
          cache: target,
          exportKey:
            wrongKeys.exportKey,
          transport
        }).pull(),
      error =>
        error instanceof
          WorkspaceSemanticGitSyncError &&
        error.code ===
          'remote_decrypt_failed'
    )
  } finally {
    source.cache.close()
    target.close()
    source.keys.hmacKey.fill(0)
    source.keys.exportKey.fill(0)
    wrongKeys.hmacKey.fill(0)
    wrongKeys.exportKey.fill(0)
  }
})

test('git cli transport publishes to a dedicated branch without changing current HEAD worktree or index', t => {
  const directory =
    mkdtempSync(
      join(
        tmpdir(),
        'workspace-semantic-git-'
      )
    )
  t.after(() =>
    rmSync(
      directory,
      {
        recursive: true,
        force: true
      }
    )
  )

  const remote =
    join(
      directory,
      'remote.git'
    )
  const work =
    join(
      directory,
      'work'
    )

  git(
    directory,
    ['init', '--bare', remote]
  )
  git(
    directory,
    ['init', work]
  )
  git(
    work,
    ['config', 'user.name', 'Semantic Sync Test']
  )
  git(
    work,
    ['config', 'user.email', 'semantic-sync@example.invalid']
  )
  git(
    work,
    ['remote', 'add', 'origin', remote]
  )

  const transport =
    new GitCliWorkspaceSemanticTransport({
      cwd: work
    })

  const beforeHead =
    gitMaybe(
      work,
      ['rev-parse', '--verify', 'HEAD']
    )
  const beforeStatus =
    git(
      work,
      ['status', '--porcelain=v1']
    )

  const first =
    transport.publish({
      parentCommitSha: null,
      envelope:
        '{"encrypted":"one"}'
    })
  assert.equal(
    first.kind,
    'pushed'
  )

  const fetched =
    transport.fetch()
  assert.ok(fetched)
  assert.equal(
    fetched.envelope,
    '{"encrypted":"one"}'
  )

  const second =
    transport.publish({
      parentCommitSha:
        fetched.commitSha,
      envelope:
        '{"encrypted":"two"}'
    })
  assert.equal(
    second.kind,
    'pushed'
  )
  assert.equal(
    transport.fetch()
      ?.envelope,
    '{"encrypted":"two"}'
  )

  assert.equal(
    gitMaybe(
      work,
      [
        'rev-parse',
        '--verify',
        'HEAD'
      ]
    ),
    beforeHead
  )
  assert.equal(
    git(
      work,
      ['status', '--porcelain=v1']
    ),
    beforeStatus
  )
})

function git(
  cwd: string,
  args: readonly string[]
): string {
  return execFileSync(
    'git',
    [...args],
    {
      cwd,
      encoding: 'utf8',
      windowsHide: true
    }
  )
}

function gitMaybe(
  cwd: string,
  args: readonly string[]
): string | null {
  const result =
    spawnSync(
      'git',
      [...args],
      {
        cwd,
        encoding: 'utf8',
        windowsHide: true
      }
    )
  return result.status === 0
    ? (
        typeof result.stdout ===
          'string'
          ? result.stdout.trim()
          : ''
      )
    : null
}
