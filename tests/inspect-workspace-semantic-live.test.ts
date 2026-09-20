import assert from 'node:assert/strict'
import {
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  SqliteLearnedWorkspaceIntentCache
} from '../src/workspace/learned-intent-cache.js'
import type {
  WorkspaceSemanticContext
} from '../src/workspace/chat-intent.js'
import {
  inspectWorkspaceSemanticLiveEvidence
} from '../scripts/inspect-workspace-semantic-live.js'

const HMAC_KEY =
  'workspace-live-inspector-test-key-0123456789'

function context():
  WorkspaceSemanticContext {
  return {
    utterance:
      '東側農田現在是什麼設定',
    actorPrincipal:
      'player-1',
    dimension: 'overworld',
    selection: {
      available: true,
      id: 'selection-1',
      dimension: 'overworld'
    },
    conversationWorkspaceId:
      null,
    recentWorkspaceId:
      null,
    workspaces: []
  }
}

test('workspace semantic live inspector correlates semantic routes attempts and learned cache evidence', () => {
  const directory =
    mkdtempSync(
      join(
        tmpdir(),
        'workspace-live-inspector-'
      )
    )
  const log =
    join(
      directory,
      'runtime-events.jsonl'
    )
  const cacheFile =
    join(
      directory,
      'semantic.sqlite3'
    )

  try {
    const events = [
      {
        type: 'model_route',
        at: 90,
        decisionId: 'old',
        model: 'routine',
        thinking: 'low',
        project: 'primary',
        reasons: [
          'workspace_semantic_interpretation'
        ],
        reserveAuthorized: false,
        reserveUsed: false
      },
      {
        type: 'model_route',
        at: 110,
        decisionId: 'semantic-1',
        model: 'routine',
        thinking: 'low',
        project: 'primary',
        reasons: [
          'workspace_semantic_interpretation'
        ],
        reserveAuthorized: false,
        reserveUsed: false
      },
      {
        type: 'attempt_result',
        at: 111,
        decisionId: 'semantic-1',
        model: 'routine',
        project: 'primary',
        result: 'success'
      },
      {
        type: 'model_route',
        at: 120,
        decisionId: 'gameplay-1',
        model: 'complex',
        thinking: 'medium',
        project: 'primary',
        reasons: [
          'open_ended_method'
        ],
        reserveAuthorized: false,
        reserveUsed: false
      }
    ]

    writeFileSync(
      log,
      events
        .map(event =>
          JSON.stringify(event)
        )
        .join('\n') + '\n',
      'utf8'
    )

    const cache =
      new SqliteLearnedWorkspaceIntentCache(
        cacheFile,
        { hmacKey: HMAC_KEY }
      )
    cache.rememberSuccessful(
      context(),
      {
        kind: 'show',
        target: {
          kind: 'explicit',
          value: '東側農田'
        }
      }
    )
    cache.close()

    const report =
      inspectWorkspaceSemanticLiveEvidence({
        sinceMs: 100,
        logFilename: log,
        cacheFilename: cacheFile,
        expectedRoutes: 1,
        expectedAttempts: 1,
        expectedActiveLearnedAtLeast: 1
      })

    assert.equal(
      report.kind,
      'passed'
    )
    assert.equal(
      report.semanticRouteCount,
      1
    )
    assert.equal(
      report.semanticAttemptCount,
      1
    )
    assert.deepEqual(
      report.semanticDecisionIds,
      ['semantic-1']
    )
    assert.equal(
      report.activeLearnedRecords,
      1
    )
    assert.equal(
      report.conflictingFingerprints,
      0
    )
  } finally {
    rmSync(
      directory,
      {
        recursive: true,
        force: true
      }
    )
  }
})

test('workspace semantic live inspector fails exact provider-call expectation when cache repeat calls provider again', () => {
  const directory =
    mkdtempSync(
      join(
        tmpdir(),
        'workspace-live-inspector-fail-'
      )
    )
  const log =
    join(
      directory,
      'runtime-events.jsonl'
    )

  try {
    const events = [
      {
        type: 'model_route',
        at: 110,
        decisionId: 'semantic-1',
        model: 'routine',
        thinking: 'low',
        project: 'primary',
        reasons: [
          'workspace_semantic_interpretation'
        ],
        reserveAuthorized: false,
        reserveUsed: false
      },
      {
        type: 'model_route',
        at: 120,
        decisionId: 'semantic-2',
        model: 'routine',
        thinking: 'low',
        project: 'primary',
        reasons: [
          'workspace_semantic_interpretation'
        ],
        reserveAuthorized: false,
        reserveUsed: false
      }
    ]

    writeFileSync(
      log,
      events
        .map(event =>
          JSON.stringify(event)
        )
        .join('\n') + '\n',
      'utf8'
    )

    const report =
      inspectWorkspaceSemanticLiveEvidence({
        sinceMs: 100,
        logFilename: log,
        cacheFilename:
          join(directory, 'missing.sqlite3'),
        expectedRoutes: 1
      })

    assert.equal(
      report.kind,
      'failed'
    )
    assert.equal(
      report.semanticRouteCount,
      2
    )
    assert.match(
      report.failures[0] ?? '',
      /expected 1 semantic route/
    )
  } finally {
    rmSync(
      directory,
      {
        recursive: true,
        force: true
      }
    )
  }
})
