import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  WorkspaceAuditActionSchema,
  WorkspaceAuditInputSchema,
  WorkspaceAuditRecordSchema,
  WorkspacePurposeSchema,
  WorkspaceRegionInputSchema,
  WorkspaceRegionSchema,
  WorkspaceSearchQuerySchema,
  WorkspaceStatusSchema,
  WorkspaceUsePolicySchema,
  type WorkspaceAuditInput,
  type WorkspaceAuditRecord,
  type WorkspaceBounds,
  type WorkspaceConstraints,
  type WorkspacePurpose,
  type WorkspaceRegion,
  type WorkspaceRegionInput,
  type WorkspaceSearchQuery,
  type WorkspaceStatus,
  type WorkspaceUsePolicy
} from './contracts.js'
import type { WorkspaceRepository } from './repository.js'

type SqlValue = string | number | bigint | Buffer | null

interface RunResultLike {
  readonly changes: number
  readonly lastInsertRowid: number | bigint
}

interface StatementLike {
  run(...params: SqlValue[]): RunResultLike
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

type DatabaseConstructor = new (filename: string) => DatabaseLike

interface WorkspaceRow {
  id: string
  world_key: string
  dimension: string
  min_x: number
  min_y: number
  min_z: number
  max_x: number
  max_y: number
  max_z: number
  label: string
  purpose: string
  moxue_use_policy: string
  status: string
  constraints_json: string
  owner_principal: string
  source_selection_id: string | null
  created_at: number
  updated_at: number
}

interface AuditRow {
  event_id: string
  workspace_id: string
  actor_principal: string
  action: string
  safe_summary: string
  source_selection_id: string | null
  created_at: number
}

interface TagRow {
  tag: string
}

export interface SqliteWorkspaceRepositoryOptions {
  readonly now?: () => number
  readonly nextId?: () => string
  readonly nextAuditId?: () => string
}

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as DatabaseConstructor
const WORKSPACE_SCHEMA_VERSION = '3'
const DEFAULT_SEARCH_LIMIT = 20
const DEFAULT_AUDIT_LIMIT = 50

export class SqliteWorkspaceRepository
implements WorkspaceRepository {
  private readonly db: DatabaseLike
  private readonly now: () => number
  private readonly nextId: () => string
  private readonly nextAuditId: () => string
  private readonly listeners =
    new Set<() => void>()
  private closed = false

  constructor(
    filename: string,
    options: SqliteWorkspaceRepositoryOptions = {}
  ) {
    if (
      typeof filename !== 'string' ||
      filename.trim().length === 0
    ) {
      throw new TypeError('filename must be a non-empty string')
    }

    this.now = options.now ?? Date.now
    this.nextId = options.nextId ?? randomUUID
    this.nextAuditId = options.nextAuditId ?? randomUUID
    this.db = new Database(filename)

    try {
      this.configureDatabase(filename)
      this.createSchema()
    } catch (error) {
      this.closed = true
      this.db.close()
      throw error
    }
  }

  create(
    input: WorkspaceRegionInput,
    audit?: WorkspaceAuditInput
  ): WorkspaceRegion {
    this.assertOpen()
    const normalized = normalizeInput(input)
    const id = normalizeId(this.nextId())
    const timestamp = this.now()
    const normalizedAudit = normalizeAudit(
      audit ?? {
        actorPrincipal: normalized.ownerPrincipal,
        action: 'created',
        safeSummary: 'Workspace created',
        sourceSelectionId: normalized.sourceSelectionId
      }
    )

    const write = this.db.transaction(() => {
      this.insertRegion(
        id,
        normalized,
        'active',
        timestamp,
        timestamp
      )
      this.replaceTags(id, normalized.tags)
      this.insertAudit(
        id,
        normalizedAudit,
        timestamp
      )
    })
    write()
    this.notifyChanged()

    return this.requireById(id)
  }

  update(
    id: string,
    input: WorkspaceRegionInput,
    audit?: WorkspaceAuditInput
  ): WorkspaceRegion | null {
    this.assertOpen()
    const normalizedId = normalizeOptionalId(id)
    if (normalizedId === null) return null
    const normalized = normalizeInput(input)
    const existing = this.rowById(normalizedId)
    if (!existing) return null

    const timestamp = this.now()
    const normalizedAudit = normalizeAudit(
      audit ?? {
        actorPrincipal: existing.owner_principal,
        action: 'updated',
        safeSummary: 'Workspace updated',
        sourceSelectionId: normalized.sourceSelectionId
      }
    )

    const write = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE workspace_regions
        SET world_key = ?,
            dimension = ?,
            min_x = ?,
            min_y = ?,
            min_z = ?,
            max_x = ?,
            max_y = ?,
            max_z = ?,
            label = ?,
            purpose = ?,
            moxue_use_policy = ?,
            constraints_json = ?,
            owner_principal = ?,
            source_selection_id = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        normalized.worldKey,
        normalized.dimension,
        normalized.bounds.min.x,
        normalized.bounds.min.y,
        normalized.bounds.min.z,
        normalized.bounds.max.x,
        normalized.bounds.max.y,
        normalized.bounds.max.z,
        normalized.label,
        normalized.purpose,
        normalized.moxueUsePolicy,
        serializeConstraints(normalized.constraints),
        normalized.ownerPrincipal,
        normalized.sourceSelectionId,
        timestamp,
        normalizedId
      )

      this.replaceTags(normalizedId, normalized.tags)
      this.insertAudit(
        normalizedId,
        normalizedAudit,
        timestamp
      )
    })
    write()
    this.notifyChanged()

    return this.requireById(normalizedId)
  }

  setStatus(
    id: string,
    status: WorkspaceStatus,
    audit: WorkspaceAuditInput
  ): WorkspaceRegion | null {
    this.assertOpen()
    const normalizedId = normalizeOptionalId(id)
    if (normalizedId === null) return null
    const parsedStatus = WorkspaceStatusSchema.parse(status)
    const normalizedAudit = normalizeAudit(audit)
    if (!this.rowById(normalizedId)) return null

    const timestamp = this.now()
    const write = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE workspace_regions
        SET status = ?, updated_at = ?
        WHERE id = ?
      `).run(
        parsedStatus,
        timestamp,
        normalizedId
      )
      this.insertAudit(
        normalizedId,
        normalizedAudit,
        timestamp
      )
    })
    write()
    this.notifyChanged()

    return this.requireById(normalizedId)
  }

  get(id: string): WorkspaceRegion | null {
    this.assertOpen()
    const normalizedId = normalizeOptionalId(id)
    if (normalizedId === null) return null
    const row = this.rowById(normalizedId)
    return row ? this.hydrate(row) : null
  }

  search(
    query: WorkspaceSearchQuery
  ): WorkspaceRegion[] {
    this.assertOpen()
    const parsed = WorkspaceSearchQuerySchema.parse(query)
    const where: string[] = ['w.world_key = ?']
    const params: SqlValue[] = [parsed.worldKey.trim()]

    if (!parsed.includeArchived) {
      where.push('w.status = ?')
      params.push('active')
    }

    if (parsed.dimension !== undefined) {
      where.push('w.dimension = ?')
      params.push(normalizeDimension(parsed.dimension))
    }

    if (parsed.purposes !== undefined) {
      const purposes = [...new Set(parsed.purposes)]
      where.push(
        `w.purpose IN (${purposes.map(() => '?').join(', ')})`
      )
      params.push(...purposes)
    }

    if (parsed.usePolicies !== undefined) {
      const policies = [...new Set(parsed.usePolicies)]
      where.push(
        `w.moxue_use_policy IN (${policies.map(() => '?').join(', ')})`
      )
      params.push(...policies)
    }

    if (parsed.ownerPrincipal !== undefined) {
      where.push('w.owner_principal = ?')
      params.push(parsed.ownerPrincipal.trim())
    }

    if (parsed.tags !== undefined) {
      for (const tag of normalizeTags(parsed.tags)) {
        where.push(`
          EXISTS (
            SELECT 1
            FROM workspace_tags wt
            WHERE wt.workspace_id = w.id AND wt.tag = ?
          )
        `)
        params.push(tag)
      }
    }

    if (parsed.intersects !== undefined) {
      const bounds = parsed.intersects
      where.push(`
        NOT (
          w.max_x < ? OR w.min_x > ? OR
          w.max_y < ? OR w.min_y > ? OR
          w.max_z < ? OR w.min_z > ?
        )
      `)
      params.push(
        bounds.min.x,
        bounds.max.x,
        bounds.min.y,
        bounds.max.y,
        bounds.min.z,
        bounds.max.z
      )
    }

    params.push(parsed.limit ?? DEFAULT_SEARCH_LIMIT)

    return this.db.prepare(`
      SELECT w.*
      FROM workspace_regions w
      WHERE ${where.join(' AND ')}
      ORDER BY w.updated_at DESC, w.created_at DESC, w.id ASC
      LIMIT ?
    `)
      .all(...params)
      .map(requireWorkspaceRow)
      .map(row => this.hydrate(row))
  }

  listAudit(
    workspaceId: string,
    limit = DEFAULT_AUDIT_LIMIT
  ): WorkspaceAuditRecord[] {
    this.assertOpen()
    const normalizedId =
      normalizeOptionalId(workspaceId)
    if (normalizedId === null) return []
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw new RangeError(
        'audit limit must be an integer between 1 and 100'
      )
    }

    return this.db.prepare(`
      SELECT *
      FROM workspace_audit
      WHERE workspace_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `)
      .all(normalizedId, limit)
      .map(requireAuditRow)
      .map(hydrateAudit)
  }

  subscribe(
    listener: () => void
  ): () => void {
    this.assertOpen()
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  delete(id: string): boolean {
    this.assertOpen()
    const normalizedId = normalizeOptionalId(id)
    if (normalizedId === null) return false

    const deleted = this.db
      .prepare('DELETE FROM workspace_regions WHERE id = ?')
      .run(normalizedId)
      .changes === 1

    if (deleted) {
      this.notifyChanged()
    }
    return deleted
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.listeners.clear()
    this.db.close()
  }

  private notifyChanged(): void {
    for (const listener of [
      ...this.listeners
    ]) {
      try {
        listener()
      } catch {
        // Workspace persistence is already committed;
        // observer failures are isolated.
      }
    }
  }

  private configureDatabase(filename: string): void {
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('busy_timeout = 5000')
    this.db.pragma('synchronous = NORMAL')
    if (filename !== ':memory:') {
      this.db.pragma('journal_mode = WAL')
    }
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)

    const existing = this.db
      .prepare(
        'SELECT value FROM workspace_schema_meta WHERE key = ?'
      )
      .get('schema_version') as
        | { value?: unknown }
        | undefined

    if (existing === undefined) {
      this.createV2Schema()
      this.db.prepare(`
        INSERT INTO workspace_schema_meta (key, value)
        VALUES (?, ?)
      `).run(
        'schema_version',
        WORKSPACE_SCHEMA_VERSION
      )
      return
    }

    if (existing.value === '1') {
      this.migrateV1ToV2()
      this.migrateV2ToV3()
      return
    }

    if (existing.value === '2') {
      this.migrateV2ToV3()
      return
    }

    if (existing.value !== WORKSPACE_SCHEMA_VERSION) {
      throw new Error(
        'unsupported workspace schema version: ' +
        String(existing.value)
      )
    }

    this.createV2Schema()
  }

  private createV2Schema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_regions (
        id TEXT PRIMARY KEY,
        world_key TEXT NOT NULL,
        dimension TEXT NOT NULL,
        min_x INTEGER NOT NULL,
        min_y INTEGER NOT NULL,
        min_z INTEGER NOT NULL,
        max_x INTEGER NOT NULL,
        max_y INTEGER NOT NULL,
        max_z INTEGER NOT NULL,
        label TEXT NOT NULL,
        purpose TEXT NOT NULL,
        moxue_use_policy TEXT NOT NULL DEFAULT 'shared'
          CHECK (moxue_use_policy IN (
            'owner_only', 'shared', 'moxue_preferred'
          )),
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'archived')),
        constraints_json TEXT NOT NULL,
        owner_principal TEXT NOT NULL,
        source_selection_id TEXT,
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
        CHECK (min_x <= max_x),
        CHECK (min_y <= max_y),
        CHECK (min_z <= max_z)
      );

      CREATE TABLE IF NOT EXISTS workspace_tags (
        workspace_id TEXT NOT NULL
          REFERENCES workspace_regions(id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY (workspace_id, tag)
      );

      CREATE TABLE IF NOT EXISTS workspace_audit (
        event_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL
          REFERENCES workspace_regions(id) ON DELETE CASCADE,
        actor_principal TEXT NOT NULL,
        action TEXT NOT NULL,
        safe_summary TEXT NOT NULL,
        source_selection_id TEXT,
        created_at INTEGER NOT NULL CHECK (created_at >= 0)
      );

      CREATE INDEX IF NOT EXISTS idx_workspace_world
        ON workspace_regions(world_key);
      CREATE INDEX IF NOT EXISTS idx_workspace_world_dimension
        ON workspace_regions(world_key, dimension);
      CREATE INDEX IF NOT EXISTS idx_workspace_world_purpose
        ON workspace_regions(world_key, purpose);
      CREATE INDEX IF NOT EXISTS idx_workspace_world_status
        ON workspace_regions(world_key, status);
      CREATE INDEX IF NOT EXISTS idx_workspace_world_use_policy
        ON workspace_regions(world_key, moxue_use_policy);
      CREATE INDEX IF NOT EXISTS idx_workspace_owner
        ON workspace_regions(world_key, owner_principal);
      CREATE INDEX IF NOT EXISTS idx_workspace_bounds
        ON workspace_regions(
          world_key, dimension,
          min_x, max_x, min_y, max_y, min_z, max_z
        );
      CREATE INDEX IF NOT EXISTS idx_workspace_tags_tag
        ON workspace_tags(tag, workspace_id);
      CREATE INDEX IF NOT EXISTS idx_workspace_audit_workspace
        ON workspace_audit(
          workspace_id,
          created_at DESC
        );
    `)
  }

  private migrateV1ToV2(): void {
    const migrate = this.db.transaction(() => {
      this.db.exec(`
        ALTER TABLE workspace_regions
        ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'archived'));

        CREATE TABLE IF NOT EXISTS workspace_audit (
          event_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL
            REFERENCES workspace_regions(id) ON DELETE CASCADE,
          actor_principal TEXT NOT NULL,
          action TEXT NOT NULL,
          safe_summary TEXT NOT NULL,
          source_selection_id TEXT,
          created_at INTEGER NOT NULL CHECK (created_at >= 0)
        );

        CREATE INDEX IF NOT EXISTS idx_workspace_world_status
          ON workspace_regions(world_key, status);

        CREATE INDEX IF NOT EXISTS idx_workspace_audit_workspace
          ON workspace_audit(
            workspace_id,
            created_at DESC
          );
      `)

      this.db.prepare(`
        UPDATE workspace_schema_meta
        SET value = ?
        WHERE key = ?
      `).run(
        '2',
        'schema_version'
      )
    })
    migrate()
  }

  private migrateV2ToV3(): void {
    const migrate = this.db.transaction(() => {
      this.db.exec(`
        ALTER TABLE workspace_regions
        ADD COLUMN moxue_use_policy TEXT NOT NULL DEFAULT 'shared'
          CHECK (moxue_use_policy IN (
            'owner_only', 'shared', 'moxue_preferred'
          ));

        CREATE INDEX IF NOT EXISTS idx_workspace_world_use_policy
          ON workspace_regions(world_key, moxue_use_policy);
      `)

      this.db.prepare(`
        UPDATE workspace_schema_meta
        SET value = ?
        WHERE key = ?
      `).run(
        WORKSPACE_SCHEMA_VERSION,
        'schema_version'
      )
    })
    migrate()
    this.createV2Schema()
  }

  private insertRegion(
    id: string,
    input: NormalizedWorkspaceInput,
    status: WorkspaceStatus,
    createdAt: number,
    updatedAt: number
  ): void {
    this.db.prepare(`
      INSERT INTO workspace_regions (
        id, world_key, dimension,
        min_x, min_y, min_z,
        max_x, max_y, max_z,
        label, purpose, moxue_use_policy, status,
        constraints_json,
        owner_principal, source_selection_id,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?,
        ?, ?,
        ?, ?
      )
    `).run(
      id,
      input.worldKey,
      input.dimension,
      input.bounds.min.x,
      input.bounds.min.y,
      input.bounds.min.z,
      input.bounds.max.x,
      input.bounds.max.y,
      input.bounds.max.z,
      input.label,
      input.purpose,
      input.moxueUsePolicy,
      status,
      serializeConstraints(input.constraints),
      input.ownerPrincipal,
      input.sourceSelectionId,
      createdAt,
      updatedAt
    )
  }

  private replaceTags(
    id: string,
    tags: readonly string[]
  ): void {
    this.db
      .prepare('DELETE FROM workspace_tags WHERE workspace_id = ?')
      .run(id)

    const insert = this.db.prepare(`
      INSERT INTO workspace_tags (workspace_id, tag)
      VALUES (?, ?)
    `)
    for (const tag of tags) {
      insert.run(id, tag)
    }
  }

  private insertAudit(
    workspaceId: string,
    audit: NormalizedAuditInput,
    createdAt: number
  ): void {
    this.db.prepare(`
      INSERT INTO workspace_audit (
        event_id,
        workspace_id,
        actor_principal,
        action,
        safe_summary,
        source_selection_id,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalizeId(this.nextAuditId()),
      workspaceId,
      audit.actorPrincipal,
      audit.action,
      audit.safeSummary,
      audit.sourceSelectionId,
      createdAt
    )
  }

  private rowById(id: string): WorkspaceRow | null {
    const row = this.db
      .prepare(
        'SELECT * FROM workspace_regions WHERE id = ?'
      )
      .get(id)

    return row === undefined
      ? null
      : requireWorkspaceRow(row)
  }

  private requireById(id: string): WorkspaceRegion {
    const row = this.rowById(id)
    if (!row) {
      throw new Error('workspace disappeared after write')
    }
    return this.hydrate(row)
  }

  private hydrate(row: WorkspaceRow): WorkspaceRegion {
    const tags = this.db.prepare(`
      SELECT tag
      FROM workspace_tags
      WHERE workspace_id = ?
      ORDER BY tag ASC
    `)
      .all(row.id)
      .map(requireTagRow)
      .map(result => result.tag)

    return WorkspaceRegionSchema.parse({
      id: row.id,
      worldKey: row.world_key,
      dimension: row.dimension,
      bounds: {
        min: {
          x: row.min_x,
          y: row.min_y,
          z: row.min_z
        },
        max: {
          x: row.max_x,
          y: row.max_y,
          z: row.max_z
        }
      },
      label: row.label,
      purpose: WorkspacePurposeSchema.parse(row.purpose),
      moxueUsePolicy:
        WorkspaceUsePolicySchema.parse(
          row.moxue_use_policy
        ),
      status: WorkspaceStatusSchema.parse(row.status),
      tags,
      constraints: parseConstraints(row.constraints_json),
      ownerPrincipal: row.owner_principal,
      sourceSelectionId: row.source_selection_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    })
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('workspace repository is closed')
    }
  }
}

interface NormalizedWorkspaceInput {
  readonly worldKey: string
  readonly dimension: string
  readonly bounds: WorkspaceBounds
  readonly label: string
  readonly purpose: WorkspacePurpose
  readonly moxueUsePolicy: WorkspaceUsePolicy
  readonly tags: readonly string[]
  readonly constraints: WorkspaceConstraints
  readonly ownerPrincipal: string
  readonly sourceSelectionId: string | null
}

interface NormalizedAuditInput {
  readonly actorPrincipal: string
  readonly action:
    ReturnType<typeof WorkspaceAuditActionSchema.parse>
  readonly safeSummary: string
  readonly sourceSelectionId: string | null
}

function normalizeInput(
  input: WorkspaceRegionInput
): NormalizedWorkspaceInput {
  const parsed = WorkspaceRegionInputSchema.parse(input)

  return {
    worldKey: parsed.worldKey.trim(),
    dimension: normalizeDimension(parsed.dimension),
    bounds: {
      min: { ...parsed.bounds.min },
      max: { ...parsed.bounds.max }
    },
    label: parsed.label.trim(),
    purpose: parsed.purpose,
    moxueUsePolicy: parsed.moxueUsePolicy,
    tags: normalizeTags(parsed.tags),
    constraints: structuredClone(parsed.constraints),
    ownerPrincipal: parsed.ownerPrincipal.trim(),
    sourceSelectionId:
      parsed.sourceSelectionId === null
        ? null
        : parsed.sourceSelectionId.trim()
  }
}

function normalizeAudit(
  input: WorkspaceAuditInput
): NormalizedAuditInput {
  const parsed = WorkspaceAuditInputSchema.parse(input)
  return {
    actorPrincipal: parsed.actorPrincipal.trim(),
    action: parsed.action,
    safeSummary: parsed.safeSummary.trim(),
    sourceSelectionId:
      parsed.sourceSelectionId ?? null
  }
}

function normalizeTags(
  tags: readonly string[]
): string[] {
  return [
    ...new Set(
      tags.map(tag => tag.trim().toLowerCase())
    )
  ].sort()
}

function normalizeDimension(value: string): string {
  return value.trim().toLowerCase()
}

function serializeConstraints(
  constraints: WorkspaceConstraints
): string {
  return JSON.stringify(constraints)
}

function parseConstraints(
  value: string
): WorkspaceConstraints {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error(
      'invalid workspace constraints JSON in sqlite'
    )
  }

  return WorkspaceRegionInputSchema.shape.constraints.parse(
    parsed
  )
}

function normalizeOptionalId(
  value: string
): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (
    normalized.length < 1 ||
    normalized.length > 128 ||
    !/^[a-z0-9_.:-]+$/.test(normalized)
  ) {
    return null
  }
  return normalized
}

function normalizeId(value: string): string {
  const normalized = normalizeOptionalId(value)
  if (normalized === null) {
    throw new Error(
      'workspace id generator returned invalid id'
    )
  }
  return normalized
}

function requireWorkspaceRow(
  value: unknown
): WorkspaceRow {
  if (!isObject(value)) {
    throw new Error(
      'invalid workspace row returned by sqlite'
    )
  }

  return {
    id: requireString(value.id, 'id'),
    world_key: requireString(value.world_key, 'world_key'),
    dimension: requireString(value.dimension, 'dimension'),
    min_x: requireInteger(value.min_x, 'min_x'),
    min_y: requireInteger(value.min_y, 'min_y'),
    min_z: requireInteger(value.min_z, 'min_z'),
    max_x: requireInteger(value.max_x, 'max_x'),
    max_y: requireInteger(value.max_y, 'max_y'),
    max_z: requireInteger(value.max_z, 'max_z'),
    label: requireString(value.label, 'label'),
    purpose: requireString(value.purpose, 'purpose'),
    moxue_use_policy: requireString(
      value.moxue_use_policy,
      'moxue_use_policy'
    ),
    status: requireString(value.status, 'status'),
    constraints_json: requireString(
      value.constraints_json,
      'constraints_json'
    ),
    owner_principal: requireString(
      value.owner_principal,
      'owner_principal'
    ),
    source_selection_id: nullableString(
      value.source_selection_id,
      'source_selection_id'
    ),
    created_at: requireNonNegativeInteger(
      value.created_at,
      'created_at'
    ),
    updated_at: requireNonNegativeInteger(
      value.updated_at,
      'updated_at'
    )
  }
}

function requireAuditRow(
  value: unknown
): AuditRow {
  if (!isObject(value)) {
    throw new Error(
      'invalid workspace audit row returned by sqlite'
    )
  }

  return {
    event_id: requireString(
      value.event_id,
      'event_id'
    ),
    workspace_id: requireString(
      value.workspace_id,
      'workspace_id'
    ),
    actor_principal: requireString(
      value.actor_principal,
      'actor_principal'
    ),
    action: requireString(
      value.action,
      'action'
    ),
    safe_summary: requireString(
      value.safe_summary,
      'safe_summary'
    ),
    source_selection_id: nullableString(
      value.source_selection_id,
      'source_selection_id'
    ),
    created_at: requireNonNegativeInteger(
      value.created_at,
      'created_at'
    )
  }
}

function hydrateAudit(
  row: AuditRow
): WorkspaceAuditRecord {
  return WorkspaceAuditRecordSchema.parse({
    eventId: row.event_id,
    workspaceId: row.workspace_id,
    actorPrincipal: row.actor_principal,
    action: WorkspaceAuditActionSchema.parse(row.action),
    safeSummary: row.safe_summary,
    sourceSelectionId: row.source_selection_id,
    createdAt: row.created_at
  })
}

function requireTagRow(value: unknown): TagRow {
  if (!isObject(value)) {
    throw new Error('invalid workspace tag row')
  }
  return { tag: requireString(value.tag, 'tag') }
}

function isObject(
  value: unknown
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function requireString(
  value: unknown,
  field: string
): string {
  if (typeof value !== 'string') {
    throw new Error(`invalid sqlite ${field}`)
  }
  return value
}

function nullableString(
  value: unknown,
  field: string
): string | null {
  if (value === null) return null
  return requireString(value, field)
}

function requireInteger(
  value: unknown,
  field: string
): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value)
  ) {
    throw new Error(`invalid sqlite ${field}`)
  }
  return value
}

function requireNonNegativeInteger(
  value: unknown,
  field: string
): number {
  const number = requireInteger(value, field)
  if (number < 0) {
    throw new Error(`invalid sqlite ${field}`)
  }
  return number
}
