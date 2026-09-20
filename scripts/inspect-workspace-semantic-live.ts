import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  RuntimeEventSchema,
  type RuntimeEvent
} from '../src/contracts/events.js'
import {
  WORKSPACE_CHAT_INTENT_CONTRACT_VERSION
} from '../src/workspace/chat-intent.js'

const DEFAULT_LOG =
  'data/runtime-events.jsonl'
const DEFAULT_CACHE =
  'data/workspace-semantic-cache.sqlite3'

const require = createRequire(import.meta.url)

interface ReadonlyStatementLike {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
}

interface ReadonlyDatabaseLike {
  prepare(sql: string):
    ReadonlyStatementLike
  close(): void
}

type ReadonlyDatabaseConstructor =
  new (
    filename: string,
    options?: {
      readonly readonly?: boolean
      readonly fileMustExist?: boolean
    }
  ) => ReadonlyDatabaseLike

const Database =
  require('better-sqlite3') as
    ReadonlyDatabaseConstructor

export interface WorkspaceSemanticLiveInspectorOptions {
  readonly sinceMs: number
  readonly logFilename?: string
  readonly cacheFilename?: string
  readonly expectedRoutes?: number
  readonly expectedAttempts?: number
  readonly expectedActiveLearnedAtLeast?: number
}

export interface WorkspaceSemanticRouteEvidence {
  readonly at: number
  readonly decisionId: string
  readonly model: string
  readonly project: string
  readonly thinking: string
}

export interface WorkspaceSemanticLiveReport {
  readonly kind: 'passed' | 'failed'
  readonly sinceMs: number
  readonly semanticRouteCount: number
  readonly semanticAttemptCount: number
  readonly semanticDecisionIds:
    readonly string[]
  readonly routes:
    readonly WorkspaceSemanticRouteEvidence[]
  readonly learnedCachePresent: boolean
  readonly activeLearnedRecords: number
  readonly revokedLearnedRecords: number
  readonly conflictingFingerprints: number
  readonly failures: readonly string[]
}

export function inspectWorkspaceSemanticLiveEvidence(
  options: WorkspaceSemanticLiveInspectorOptions
): WorkspaceSemanticLiveReport {
  validateSinceMs(options.sinceMs)
  const logFilename =
    options.logFilename ??
    DEFAULT_LOG
  const cacheFilename =
    options.cacheFilename ??
    DEFAULT_CACHE

  const events =
    readEvents(logFilename)
      .filter(event =>
        event.at >= options.sinceMs
      )

  const routes =
    events
      .filter(
        (
          event
        ): event is Extract<
          RuntimeEvent,
          { type: 'model_route' }
        > =>
          event.type ===
            'model_route' &&
          event.reasons.includes(
            'workspace_semantic_interpretation'
          )
      )
      .map(event => ({
        at: event.at,
        decisionId:
          event.decisionId,
        model: event.model,
        project: event.project,
        thinking:
          event.thinking
      }))

  const decisionIds =
    new Set(
      routes.map(
        route => route.decisionId
      )
    )

  const attempts =
    events.filter(
      event =>
        event.type ===
          'attempt_result' &&
        decisionIds.has(
          event.decisionId
        )
    )

  const cache =
    readCacheStats(
      cacheFilename
    )

  const failures: string[] = []

  if (
    options.expectedRoutes !==
      undefined &&
    routes.length !==
      options.expectedRoutes
  ) {
    failures.push(
      `expected ${options.expectedRoutes} semantic route(s), observed ${routes.length}`
    )
  }

  if (
    options.expectedAttempts !==
      undefined &&
    attempts.length !==
      options.expectedAttempts
  ) {
    failures.push(
      `expected ${options.expectedAttempts} semantic attempt result(s), observed ${attempts.length}`
    )
  }

  if (
    options.expectedActiveLearnedAtLeast !==
      undefined &&
    cache.active <
      options.expectedActiveLearnedAtLeast
  ) {
    failures.push(
      `expected at least ${options.expectedActiveLearnedAtLeast} active learned record(s), observed ${cache.active}`
    )
  }

  return {
    kind:
      failures.length === 0
        ? 'passed'
        : 'failed',
    sinceMs: options.sinceMs,
    semanticRouteCount:
      routes.length,
    semanticAttemptCount:
      attempts.length,
    semanticDecisionIds:
      [...decisionIds],
    routes,
    learnedCachePresent:
      cache.present,
    activeLearnedRecords:
      cache.active,
    revokedLearnedRecords:
      cache.revoked,
    conflictingFingerprints:
      cache.conflicts,
    failures
  }
}

function readEvents(
  filename: string
): RuntimeEvent[] {
  if (!existsSync(filename)) {
    throw new Error(
      `runtime event log not found: ${filename}`
    )
  }

  const text =
    readFileSync(
      filename,
      'utf8'
    )
  const events: RuntimeEvent[] = []

  for (
    const [index, line] of
    text.split(/\r?\n/u).entries()
  ) {
    const trimmed =
      line.trim()
    if (!trimmed) continue

    let raw: unknown
    try {
      raw = JSON.parse(trimmed)
    } catch {
      throw new Error(
        `invalid runtime event JSON at line ${index + 1}`
      )
    }

    const parsed =
      RuntimeEventSchema.safeParse(raw)
    if (!parsed.success) {
      throw new Error(
        `invalid runtime event at line ${index + 1}`
      )
    }
    events.push(parsed.data)
  }

  return events
}

function readCacheStats(
  filename: string
): {
  readonly present: boolean
  readonly active: number
  readonly revoked: number
  readonly conflicts: number
} {
  if (!existsSync(filename)) {
    return {
      present: false,
      active: 0,
      revoked: 0,
      conflicts: 0
    }
  }

  const db =
    new Database(
      filename,
      {
        readonly: true,
        fileMustExist: true
      }
    )

  try {
    const active =
      countValue(
        db.prepare(`
          SELECT COUNT(*) AS count
          FROM learned_workspace_intents
          WHERE contract_version = ?
            AND revoked = 0
        `).get(
          WORKSPACE_CHAT_INTENT_CONTRACT_VERSION
        )
      )

    const revoked =
      countValue(
        db.prepare(`
          SELECT COUNT(*) AS count
          FROM learned_workspace_intents
          WHERE contract_version = ?
            AND revoked = 1
        `).get(
          WORKSPACE_CHAT_INTENT_CONTRACT_VERSION
        )
      )

    const conflicts =
      countValue(
        db.prepare(`
          SELECT COUNT(*) AS count
          FROM (
            SELECT fingerprint
            FROM learned_workspace_intents
            WHERE contract_version = ?
              AND revoked = 0
            GROUP BY fingerprint
            HAVING COUNT(
              DISTINCT intent_hash
            ) > 1
          )
        `).get(
          WORKSPACE_CHAT_INTENT_CONTRACT_VERSION
        )
      )

    return {
      present: true,
      active,
      revoked,
      conflicts
    }
  } finally {
    db.close()
  }
}

function countValue(
  value: unknown
): number {
  if (
    typeof value !== 'object' ||
    value === null
  ) {
    throw new Error(
      'invalid inspector sqlite count row'
    )
  }
  const count =
    (value as {
      count?: unknown
    }).count
  if (
    typeof count !== 'number' ||
    !Number.isInteger(count) ||
    count < 0
  ) {
    throw new Error(
      'invalid inspector sqlite count'
    )
  }
  return count
}

function validateSinceMs(
  value: number
): void {
  if (
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new RangeError(
      'sinceMs must be a non-negative integer'
    )
  }
}

function parseArgs(
  argv: readonly string[]
): WorkspaceSemanticLiveInspectorOptions {
  let sinceMs: number | null = null
  let logFilename:
    string | undefined
  let cacheFilename:
    string | undefined
  let expectedRoutes:
    number | undefined
  let expectedAttempts:
    number | undefined
  let expectedActiveLearnedAtLeast:
    number | undefined

  for (
    let index = 0;
    index < argv.length;
    index += 1
  ) {
    const arg = argv[index]
    const next = argv[index + 1]

    switch (arg) {
      case '--since-ms':
        sinceMs =
          parseNonNegativeInteger(
            next,
            '--since-ms'
          )
        index += 1
        break

      case '--log':
        logFilename =
          requiredText(
            next,
            '--log'
          )
        index += 1
        break

      case '--cache':
        cacheFilename =
          requiredText(
            next,
            '--cache'
          )
        index += 1
        break

      case '--expect-routes':
        expectedRoutes =
          parseNonNegativeInteger(
            next,
            '--expect-routes'
          )
        index += 1
        break

      case '--expect-attempts':
        expectedAttempts =
          parseNonNegativeInteger(
            next,
            '--expect-attempts'
          )
        index += 1
        break

      case '--expect-active-learned-at-least':
        expectedActiveLearnedAtLeast =
          parseNonNegativeInteger(
            next,
            '--expect-active-learned-at-least'
          )
        index += 1
        break

      default:
        throw new Error(
          `unknown argument: ${String(arg)}`
        )
    }
  }

  if (sinceMs === null) {
    throw new Error(
      '--since-ms is required'
    )
  }

  return {
    sinceMs,
    ...(logFilename === undefined
      ? {}
      : { logFilename }),
    ...(cacheFilename === undefined
      ? {}
      : { cacheFilename }),
    ...(expectedRoutes === undefined
      ? {}
      : { expectedRoutes }),
    ...(expectedAttempts === undefined
      ? {}
      : { expectedAttempts }),
    ...(expectedActiveLearnedAtLeast === undefined
      ? {}
      : {
          expectedActiveLearnedAtLeast
        })
  }
}

function parseNonNegativeInteger(
  value: string | undefined,
  name: string
): number {
  if (value === undefined) {
    throw new Error(
      `${name} requires a value`
    )
  }
  const parsed = Number(value)
  if (
    !Number.isInteger(parsed) ||
    parsed < 0
  ) {
    throw new Error(
      `${name} must be a non-negative integer`
    )
  }
  return parsed
}

function requiredText(
  value: string | undefined,
  name: string
): string {
  const normalized =
    value?.trim()
  if (!normalized) {
    throw new Error(
      `${name} requires a non-empty value`
    )
  }
  return normalized
}

function isEntrypoint(): boolean {
  const script =
    process.argv[1]
  if (!script) return false

  return (
    import.meta.url ===
    pathToFileURL(
      resolve(script)
    ).href
  )
}

if (isEntrypoint()) {
  try {
    const report =
      inspectWorkspaceSemanticLiveEvidence(
        parseArgs(
          process.argv.slice(2)
        )
      )
    console.log(
      JSON.stringify(
        report,
        null,
        2
      )
    )
    if (
      report.kind ===
      'failed'
    ) {
      process.exitCode = 1
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        kind: 'failed',
        code: 'inspector_error',
        message:
          error instanceof Error
            ? error.message
            : String(error)
      })
    )
    process.exitCode = 1
  }
}
