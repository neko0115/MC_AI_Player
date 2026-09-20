import {
  createHash,
  createHmac
} from 'node:crypto'
import { z } from 'zod'
import { createRequire } from 'node:module'
import {
  WORKSPACE_CHAT_INTENT_CONTRACT_VERSION,
  WorkspaceChatIntentSchema,
  normalizeWorkspaceSemanticContext,
  type WorkspaceChatIntent,
  type WorkspaceIntentInterpreter,
  type WorkspaceSemanticContext
} from './chat-intent.js'

type SqlValue =
  | string
  | number
  | bigint
  | Buffer
  | null

interface StatementLike {
  run(...params: SqlValue[]): {
    readonly changes: number
  }
  get(...params: SqlValue[]): unknown
  all(...params: SqlValue[]): unknown[]
}

interface DatabaseLike {
  exec(sql: string): void
  pragma(source: string): unknown
  prepare(sql: string): StatementLike
  transaction<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => TResult
  ): (...args: TArgs) => TResult
  close(): void
}

type DatabaseConstructor =
  new (filename: string) => DatabaseLike

interface LearnedRow {
  fingerprint: string
  applicability: string
  intent_hash: string
  intent_json: string
  contract_version: number
  created_at: number
  updated_at: number
  last_success_at: number
  success_count: number
  revoked: number
}

export interface LearnedWorkspaceIntentTransferRecord {
  readonly fingerprint: string
  readonly applicability: Applicability
  readonly intentHash: string
  readonly intent: WorkspaceChatIntent
  readonly contractVersion: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastSuccessAt: number
  readonly successCount: number
  readonly revoked: boolean
}

export interface LearnedWorkspaceIntentSnapshot {
  readonly format: 'mc-ai-player.workspace-intent-cache.snapshot'
  readonly version: 1
  readonly semanticContractVersion: number
  readonly exportedAt: number
  readonly records: readonly LearnedWorkspaceIntentTransferRecord[]
}

export interface LearnedWorkspaceIntentImportResult {
  readonly merged: number
  readonly skipped: number
}

export interface LearnedWorkspaceIntentCache {
  lookup(
    context: WorkspaceSemanticContext
  ): WorkspaceChatIntent | null
  rememberSuccessful(
    context: WorkspaceSemanticContext,
    intent: WorkspaceChatIntent
  ): boolean
  revokeUtterance(
    context: WorkspaceSemanticContext
  ): number
  exportSnapshot(): LearnedWorkspaceIntentSnapshot
  importSnapshot(
    snapshot: unknown
  ): LearnedWorkspaceIntentImportResult
  close(): void
}

export interface SqliteLearnedWorkspaceIntentCacheOptions {
  readonly hmacKey: string | Buffer
  readonly now?: () => number
}

const require = createRequire(import.meta.url)
const Database =
  require('better-sqlite3') as DatabaseConstructor

const CACHE_SCHEMA_VERSION = '1'

type Applicability =
  | 'context_free'
  | 'selection'
  | 'explicit'
  | 'conversation'
  | 'recent'

const ApplicabilitySchema = z.enum([
  'context_free',
  'selection',
  'explicit',
  'conversation',
  'recent'
])

const TransferRecordSchema = z
  .object({
    fingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/),
    applicability: ApplicabilitySchema,
    intentHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/),
    intent: WorkspaceChatIntentSchema,
    contractVersion:
      z.number().int().positive(),
    createdAt:
      z.number().int().nonnegative(),
    updatedAt:
      z.number().int().nonnegative(),
    lastSuccessAt:
      z.number().int().nonnegative(),
    successCount:
      z.number().int().positive(),
    revoked: z.boolean()
  })
  .strict()

const SnapshotSchema = z
  .object({
    format: z.literal(
      'mc-ai-player.workspace-intent-cache.snapshot'
    ),
    version: z.literal(1),
    semanticContractVersion:
      z.number().int().positive(),
    exportedAt:
      z.number().int().nonnegative(),
    records: z
      .array(TransferRecordSchema)
      .max(100_000)
  })
  .strict()

export class SqliteLearnedWorkspaceIntentCache
implements LearnedWorkspaceIntentCache {
  private readonly db: DatabaseLike
  private readonly hmacKey: Buffer
  private readonly now: () => number
  private closed = false

  constructor(
    filename: string,
    options:
      SqliteLearnedWorkspaceIntentCacheOptions
  ) {
    if (
      typeof filename !== 'string' ||
      filename.trim().length === 0
    ) {
      throw new TypeError(
        'filename must be a non-empty string'
      )
    }

    this.hmacKey =
      normalizeHmacKey(
        options.hmacKey
      )
    this.now = options.now ?? Date.now
    this.db = new Database(filename)

    try {
      this.configure(filename)
      this.createSchema()
    } catch (error) {
      this.closed = true
      this.db.close()
      throw error
    }
  }

  lookup(
    context: WorkspaceSemanticContext
  ): WorkspaceChatIntent | null {
    this.assertOpen()
    const normalized =
      normalizeWorkspaceSemanticContext(
        context
      )
    const fingerprint =
      this.fingerprint(
        normalized.utterance
      )

    const rows = this.db.prepare(`
      SELECT
        fingerprint,
        applicability,
        intent_hash,
        intent_json,
        contract_version,
        success_count,
        revoked
      FROM learned_workspace_intents
      WHERE fingerprint = ?
        AND contract_version = ?
        AND revoked = 0
      ORDER BY success_count DESC,
               intent_hash ASC
      LIMIT 32
    `)
      .all(
        fingerprint,
        WORKSPACE_CHAT_INTENT_CONTRACT_VERSION
      )
      .map(requireLearnedRow)
      .filter(row =>
        applicabilityMatches(
          row.applicability,
          normalized
        )
      )

    const unique =
      new Map<string, WorkspaceChatIntent>()

    for (const row of rows) {
      let parsedJson: unknown
      try {
        parsedJson =
          JSON.parse(row.intent_json)
      } catch {
        continue
      }

      const parsed =
        WorkspaceChatIntentSchema
          .safeParse(parsedJson)
      if (!parsed.success) continue

      const canonical =
        canonicalIntent(parsed.data)
      if (
        intentHash(canonical) !==
        row.intent_hash
      ) {
        continue
      }

      unique.set(
        row.intent_hash,
        parsed.data
      )
    }

    if (unique.size !== 1) {
      return null
    }

    return structuredClone(
      [...unique.values()][0]!
    )
  }

  rememberSuccessful(
    context: WorkspaceSemanticContext,
    intent: WorkspaceChatIntent
  ): boolean {
    this.assertOpen()
    const normalized =
      normalizeWorkspaceSemanticContext(
        context
      )
    const parsed =
      WorkspaceChatIntentSchema.parse(
        intent
      )
    const applicability =
      cacheApplicability(parsed)
    if (
      applicability === null ||
      !applicabilityMatches(
        applicability,
        normalized
      ) ||
      (
        applicability === 'explicit' &&
        !explicitReferenceIsStable(
          parsed,
          normalized.utterance
        )
      )
    ) {
      return false
    }

    const fingerprint =
      this.fingerprint(
        normalized.utterance
      )
    const canonical =
      canonicalIntent(parsed)
    const hash =
      intentHash(canonical)
    const timestamp = this.now()

    this.db.prepare(`
      INSERT INTO learned_workspace_intents (
        fingerprint,
        applicability,
        intent_hash,
        intent_json,
        contract_version,
        created_at,
        updated_at,
        last_success_at,
        success_count,
        revoked
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, 1, 0
      )
      ON CONFLICT(
        fingerprint,
        applicability,
        intent_hash,
        contract_version
      ) DO UPDATE SET
        intent_json = excluded.intent_json,
        updated_at = excluded.updated_at,
        last_success_at = excluded.last_success_at,
        success_count =
          learned_workspace_intents.success_count + 1,
        revoked = 0
    `).run(
      fingerprint,
      applicability,
      hash,
      canonical,
      WORKSPACE_CHAT_INTENT_CONTRACT_VERSION,
      timestamp,
      timestamp,
      timestamp
    )

    return true
  }

  revokeUtterance(
    context: WorkspaceSemanticContext
  ): number {
    this.assertOpen()
    const normalized =
      normalizeWorkspaceSemanticContext(
        context
      )
    const fingerprint =
      this.fingerprint(
        normalized.utterance
      )

    return this.db.prepare(`
      UPDATE learned_workspace_intents
      SET revoked = 1,
          updated_at = ?
      WHERE fingerprint = ?
        AND contract_version = ?
        AND revoked = 0
    `).run(
      this.now(),
      fingerprint,
      WORKSPACE_CHAT_INTENT_CONTRACT_VERSION
    ).changes
  }

  exportSnapshot(): LearnedWorkspaceIntentSnapshot {
    this.assertOpen()

    const rows = this.db.prepare(`
      SELECT
        fingerprint,
        applicability,
        intent_hash,
        intent_json,
        contract_version,
        created_at,
        updated_at,
        last_success_at,
        success_count,
        revoked
      FROM learned_workspace_intents
      WHERE contract_version = ?
      ORDER BY fingerprint ASC,
               applicability ASC,
               intent_hash ASC
      LIMIT 100000
    `)
      .all(
        WORKSPACE_CHAT_INTENT_CONTRACT_VERSION
      )
      .map(requireLearnedRow)

    const records =
      rows.map(row =>
        transferRecordFromRow(row)
      )

    return {
      format:
        'mc-ai-player.workspace-intent-cache.snapshot',
      version: 1,
      semanticContractVersion:
        WORKSPACE_CHAT_INTENT_CONTRACT_VERSION,
      exportedAt: this.now(),
      records
    }
  }

  importSnapshot(
    snapshot: unknown
  ): LearnedWorkspaceIntentImportResult {
    this.assertOpen()
    const parsed =
      SnapshotSchema.parse(snapshot)

    let merged = 0
    let skipped = 0

    const merge =
      this.db.transaction(() => {
        for (
          const candidate of
          parsed.records
        ) {
          if (
            candidate.contractVersion !==
              WORKSPACE_CHAT_INTENT_CONTRACT_VERSION ||
            parsed.semanticContractVersion !==
              WORKSPACE_CHAT_INTENT_CONTRACT_VERSION
          ) {
            skipped += 1
            continue
          }

          const canonical =
            canonicalIntent(
              candidate.intent
            )
          if (
            intentHash(canonical) !==
              candidate.intentHash
          ) {
            skipped += 1
            continue
          }

          this.db.prepare(`
            INSERT INTO learned_workspace_intents (
              fingerprint,
              applicability,
              intent_hash,
              intent_json,
              contract_version,
              created_at,
              updated_at,
              last_success_at,
              success_count,
              revoked
            ) VALUES (
              ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?
            )
            ON CONFLICT (
              fingerprint,
              applicability,
              intent_hash,
              contract_version
            ) DO UPDATE SET
              intent_json = CASE
                WHEN excluded.updated_at >
                  learned_workspace_intents.updated_at
                THEN excluded.intent_json
                ELSE learned_workspace_intents.intent_json
              END,
              created_at = MIN(
                learned_workspace_intents.created_at,
                excluded.created_at
              ),
              updated_at = MAX(
                learned_workspace_intents.updated_at,
                excluded.updated_at
              ),
              last_success_at = MAX(
                learned_workspace_intents.last_success_at,
                excluded.last_success_at
              ),
              success_count = MAX(
                learned_workspace_intents.success_count,
                excluded.success_count
              ),
              revoked = CASE
                WHEN excluded.updated_at >
                  learned_workspace_intents.updated_at
                THEN excluded.revoked
                WHEN excluded.updated_at <
                  learned_workspace_intents.updated_at
                THEN learned_workspace_intents.revoked
                ELSE MAX(
                  learned_workspace_intents.revoked,
                  excluded.revoked
                )
              END
          `).run(
            candidate.fingerprint,
            candidate.applicability,
            candidate.intentHash,
            canonical,
            candidate.contractVersion,
            candidate.createdAt,
            candidate.updatedAt,
            candidate.lastSuccessAt,
            candidate.successCount,
            candidate.revoked ? 1 : 0
          )
          merged += 1
        }
      })

    merge()
    return { merged, skipped }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  private fingerprint(
    utterance: string
  ): string {
    const normalized =
      normalizeUtterance(utterance)
    return createHmac(
      'sha256',
      this.hmacKey
    )
      .update(
        `workspace-intent:v${WORKSPACE_CHAT_INTENT_CONTRACT_VERSION}:\0`
      )
      .update(normalized)
      .digest('hex')
  }

  private configure(
    filename: string
  ): void {
    this.db.pragma('foreign_keys = ON')
    this.db.pragma(
      'busy_timeout = 5000'
    )
    this.db.pragma(
      'synchronous = NORMAL'
    )
    if (filename !== ':memory:') {
      this.db.pragma(
        'journal_mode = WAL'
      )
    }
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS learned_workspace_intent_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS learned_workspace_intents (
        fingerprint TEXT NOT NULL,
        applicability TEXT NOT NULL
          CHECK (applicability IN (
            'context_free',
            'selection',
            'explicit',
            'conversation',
            'recent'
          )),
        intent_hash TEXT NOT NULL,
        intent_json TEXT NOT NULL,
        contract_version INTEGER NOT NULL
          CHECK (contract_version >= 1),
        created_at INTEGER NOT NULL
          CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL
          CHECK (updated_at >= 0),
        last_success_at INTEGER NOT NULL
          CHECK (last_success_at >= 0),
        success_count INTEGER NOT NULL
          CHECK (success_count >= 1),
        revoked INTEGER NOT NULL DEFAULT 0
          CHECK (revoked IN (0, 1)),
        PRIMARY KEY (
          fingerprint,
          applicability,
          intent_hash,
          contract_version
        )
      );

      CREATE INDEX IF NOT EXISTS idx_learned_workspace_lookup
        ON learned_workspace_intents(
          fingerprint,
          contract_version,
          revoked
        );
    `)

    const existing = this.db
      .prepare(`
        SELECT value
        FROM learned_workspace_intent_meta
        WHERE key = ?
      `)
      .get('schema_version') as
        | { value?: unknown }
        | undefined

    if (existing === undefined) {
      this.db.prepare(`
        INSERT INTO learned_workspace_intent_meta (
          key,
          value
        ) VALUES (?, ?)
      `).run(
        'schema_version',
        CACHE_SCHEMA_VERSION
      )
      return
    }

    if (
      existing.value !==
      CACHE_SCHEMA_VERSION
    ) {
      throw new Error(
        'unsupported learned workspace intent cache schema version: ' +
        String(existing.value)
      )
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error(
        'learned workspace intent cache is closed'
      )
    }
  }
}

export class CacheFirstWorkspaceIntentInterpreter
implements WorkspaceIntentInterpreter {
  constructor(
    private readonly cache:
      LearnedWorkspaceIntentCache,
    private readonly fallback:
      WorkspaceIntentInterpreter
  ) {}

  async interpret(
    context: WorkspaceSemanticContext,
    signal: AbortSignal
  ): Promise<WorkspaceChatIntent> {
    if (signal.aborted) {
      return {
        kind: 'clarify',
        reason: 'ambiguous_intent'
      }
    }

    const cached =
      this.cache.lookup(context)
    if (cached) {
      return cached
    }

    return this.fallback.interpret(
      context,
      signal
    )
  }

  async learnSuccessful(
    context: WorkspaceSemanticContext,
    intent: WorkspaceChatIntent
  ): Promise<void> {
    try {
      this.cache.rememberSuccessful(
        context,
        intent
      )
    } catch {
      // Learned cache is advisory and must never
      // change a successful Workspace operation.
    }
  }

  revoke(
    context: WorkspaceSemanticContext
  ): number {
    return this.cache.revokeUtterance(
      context
    )
  }
}

function cacheApplicability(
  intent: WorkspaceChatIntent
): Applicability | null {
  switch (intent.kind) {
    case 'not_workspace':
    case 'clarify':
      return null

    case 'create':
      return 'selection'

    case 'list':
      return 'context_free'

    case 'show':
    case 'rename':
    case 'resize':
    case 'change_purpose':
    case 'change_use_policy':
    case 'replace_tags':
    case 'change_constraints':
    case 'archive':
    case 'restore':
      switch (intent.target.kind) {
        case 'explicit':
          return 'explicit'
        case 'current_selection':
          return 'selection'
        case 'conversation':
          return 'conversation'
        case 'recent':
          return 'recent'
        case 'nearby':
          return null
      }
  }
}

function explicitReferenceIsStable(
  intent: WorkspaceChatIntent,
  utterance: string
): boolean {
  if (
    intent.kind === 'not_workspace' ||
    intent.kind === 'clarify' ||
    intent.kind === 'create' ||
    intent.kind === 'list'
  ) {
    return false
  }

  if (
    intent.target.kind !== 'explicit'
  ) {
    return false
  }

  return normalizeUtterance(
    utterance
  ).includes(
    normalizeUtterance(
      intent.target.value
    )
  )
}

function applicabilityMatches(
  applicability: string,
  context: WorkspaceSemanticContext
): boolean {
  switch (applicability) {
    case 'context_free':
    case 'explicit':
      return true

    case 'selection':
      return (
        context.selection.available ===
        true
      )

    case 'conversation':
      return (
        context.conversationWorkspaceId !==
        null
      )

    case 'recent':
      return (
        context.recentWorkspaceId !==
        null
      )

    default:
      return false
  }
}

function normalizeUtterance(
  value: string
): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase('und')
}

function canonicalIntent(
  intent: WorkspaceChatIntent
): string {
  return stableStringify(intent)
}

function intentHash(
  canonical: string
): string {
  return createHash('sha256')
    .update(canonical)
    .digest('hex')
}

function stableStringify(
  value: unknown
): string {
  if (
    value === null ||
    typeof value !== 'object'
  ) {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return (
      '[' +
      value
        .map(stableStringify)
        .join(',') +
      ']'
    )
  }

  const record =
    value as Record<string, unknown>
  return (
    '{' +
    Object.keys(record)
      .sort()
      .map(key =>
        JSON.stringify(key) +
        ':' +
        stableStringify(record[key])
      )
      .join(',') +
    '}'
  )
}

function normalizeHmacKey(
  value: string | Buffer
): Buffer {
  const buffer =
    Buffer.isBuffer(value)
      ? Buffer.from(value)
      : Buffer.from(value, 'utf8')

  if (buffer.byteLength < 32) {
    throw new RangeError(
      'workspace semantic cache HMAC key must be at least 32 bytes'
    )
  }

  return buffer
}

function transferRecordFromRow(
  row: LearnedRow
): LearnedWorkspaceIntentTransferRecord {
  let rawIntent: unknown
  try {
    rawIntent =
      JSON.parse(row.intent_json)
  } catch {
    throw new Error(
      'invalid learned workspace intent JSON'
    )
  }

  const intent =
    WorkspaceChatIntentSchema.parse(
      rawIntent
    )
  const canonical =
    canonicalIntent(intent)

  if (
    intentHash(canonical) !==
      row.intent_hash
  ) {
    throw new Error(
      'learned workspace intent hash mismatch'
    )
  }

  return TransferRecordSchema.parse({
    fingerprint:
      row.fingerprint,
    applicability:
      row.applicability,
    intentHash:
      row.intent_hash,
    intent,
    contractVersion:
      row.contract_version,
    createdAt:
      row.created_at,
    updatedAt:
      row.updated_at,
    lastSuccessAt:
      row.last_success_at,
    successCount:
      row.success_count,
    revoked:
      row.revoked === 1
  })
}

function requireLearnedRow(
  value: unknown
): LearnedRow {
  if (
    typeof value !== 'object' ||
    value === null
  ) {
    throw new Error(
      'invalid learned workspace intent row'
    )
  }

  const row =
    value as Record<string, unknown>

  return {
    fingerprint:
      requireString(
        row.fingerprint,
        'fingerprint'
      ),
    applicability:
      requireString(
        row.applicability,
        'applicability'
      ),
    intent_hash:
      requireString(
        row.intent_hash,
        'intent_hash'
      ),
    intent_json:
      requireString(
        row.intent_json,
        'intent_json'
      ),
    contract_version:
      requireInteger(
        row.contract_version,
        'contract_version'
      ),
    created_at:
      requireInteger(
        row.created_at,
        'created_at'
      ),
    updated_at:
      requireInteger(
        row.updated_at,
        'updated_at'
      ),
    last_success_at:
      requireInteger(
        row.last_success_at,
        'last_success_at'
      ),
    success_count:
      requireInteger(
        row.success_count,
        'success_count'
      ),
    revoked:
      requireInteger(
        row.revoked,
        'revoked'
      )
  }
}

function requireString(
  value: unknown,
  field: string
): string {
  if (typeof value !== 'string') {
    throw new Error(
      `invalid learned cache ${field}`
    )
  }
  return value
}

function requireInteger(
  value: unknown,
  field: string
): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new Error(
      `invalid learned cache ${field}`
    )
  }
  return value
}
