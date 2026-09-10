import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  MemorySearchQuerySchema,
  MinecraftMemoryInputSchema,
  MinecraftMemoryTypeSchema,
  type MemorySearchQuery,
  type MinecraftMemory,
  type MinecraftMemoryInput,
  type MinecraftMemoryRepository,
  type MinecraftMemoryType
} from './repository.js'

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

interface MemoryRow {
  id: string
  world_key: string
  type: string
  content: string
  dimension: string | null
  x: number | null
  y: number | null
  z: number | null
  importance: number
  observed_at: number
  created_at: number
  updated_at: number
  reinforcement_count: number
  fingerprint: string
}

interface TagRow {
  tag: string
}

interface SqliteRepositoryOptions {
  readonly now?: () => number
}

interface NormalizedMemoryInput {
  readonly worldKey: string
  readonly type: MinecraftMemoryType
  readonly content: string
  readonly dimension: string | null
  readonly position: { x: number; y: number; z: number } | null
  readonly tags: readonly string[]
  readonly importance: number
  readonly observedAt: number
}

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as DatabaseConstructor
const DEFAULT_SEARCH_LIMIT = 8
const MEMORY_SCHEMA_VERSION = '2'

export class SqliteMemoryRepository implements MinecraftMemoryRepository {
  private readonly db: DatabaseLike
  private readonly now: () => number
  private closed = false

  constructor(
    filename: string,
    options: SqliteRepositoryOptions = {}
  ) {
    if (typeof filename !== 'string' || filename.trim().length === 0) {
      throw new TypeError('filename must be a non-empty string')
    }
    this.now = options.now ?? Date.now
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

  remember(input: MinecraftMemoryInput): MinecraftMemory {
    this.assertOpen()
    const normalized = normalizeMemoryInput(input)
    const fingerprint = fingerprintOf(normalized)
    const write = this.db.transaction(() => {
      const existing = asMemoryRow(
        this.db.prepare('SELECT * FROM memories WHERE fingerprint = ?').get(fingerprint)
      )
      const timestamp = this.now()

      if (existing) {
        const importance = Math.max(existing.importance, normalized.importance)
        const observedAt = Math.max(existing.observed_at, normalized.observedAt)
        this.db.prepare(`
          UPDATE memories
          SET importance = ?,
              observed_at = ?,
              updated_at = ?,
              reinforcement_count = reinforcement_count + 1
          WHERE id = ?
        `).run(importance, observedAt, timestamp, existing.id)
        return existing.id
      }

      const id = randomUUID()
      this.db.prepare(`
        INSERT INTO memories (
          id, world_key, type, content, dimension, x, y, z,
          importance, observed_at, created_at, updated_at,
          reinforcement_count, fingerprint
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      `).run(
        id,
        normalized.worldKey,
        normalized.type,
        normalized.content,
        normalized.dimension,
        normalized.position?.x ?? null,
        normalized.position?.y ?? null,
        normalized.position?.z ?? null,
        normalized.importance,
        normalized.observedAt,
        timestamp,
        timestamp,
        fingerprint
      )

      const insertTag = this.db.prepare(
        'INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)'
      )
      for (const tag of normalized.tags) {
        insertTag.run(id, tag)
      }
      return id
    })

    return this.memoryById(write())
  }

  search(query: MemorySearchQuery): MinecraftMemory[] {
    this.assertOpen()
    const parsed = MemorySearchQuerySchema.parse(query)
    const where: string[] = ['m.world_key = ?']
    const params: SqlValue[] = [normalizeWorldKey(parsed.worldKey)]

    if (parsed.text !== undefined) {
      where.push('instr(lower(m.content), lower(?)) > 0')
      params.push(parsed.text.trim())
    }

    if (parsed.types !== undefined) {
      const types = [...new Set(parsed.types)]
      where.push(`m.type IN (${types.map(() => '?').join(', ')})`)
      params.push(...types)
    }

    if (parsed.dimension !== undefined) {
      where.push('m.dimension = ?')
      params.push(normalizeDimension(parsed.dimension))
    }

    if (parsed.near !== undefined) {
      const { x, y, z } = parsed.near.position
      const radiusSquared = parsed.near.radius * parsed.near.radius
      where.push(`
        m.x IS NOT NULL AND m.y IS NOT NULL AND m.z IS NOT NULL AND
        ((m.x - ?) * (m.x - ?) +
         (m.y - ?) * (m.y - ?) +
         (m.z - ?) * (m.z - ?)) <= ?
      `)
      params.push(x, x, y, y, z, z, radiusSquared)
    }

    if (parsed.tags !== undefined) {
      const tags = normalizeTags(parsed.tags)
      for (const tag of tags) {
        where.push(`
          EXISTS (
            SELECT 1
            FROM memory_tags mt
            WHERE mt.memory_id = m.id AND mt.tag = ?
          )
        `)
        params.push(tag)
      }
    }

    const limit = parsed.limit ?? DEFAULT_SEARCH_LIMIT
    const sql = `
      SELECT m.*
      FROM memories m
      WHERE ${where.join(' AND ')}
      ORDER BY m.importance DESC,
               m.observed_at DESC,
               m.updated_at DESC,
               m.id ASC
      LIMIT ?
    `
    params.push(limit)

    return this.db
      .prepare(sql)
      .all(...params)
      .map(row => this.hydrate(requireMemoryRow(row)))
  }

  forget(id: string): boolean {
    this.assertOpen()
    if (typeof id !== 'string' || id.trim().length === 0) {
      return false
    }
    return this.db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes === 1
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
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
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        world_key TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        dimension TEXT,
        x REAL,
        y REAL,
        z REAL,
        importance REAL NOT NULL CHECK (importance >= 0 AND importance <= 1),
        observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        reinforcement_count INTEGER NOT NULL DEFAULT 0 CHECK (reinforcement_count >= 0),
        fingerprint TEXT NOT NULL UNIQUE
      );

      CREATE TABLE IF NOT EXISTS memory_tags (
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY (memory_id, tag)
      );

      CREATE INDEX IF NOT EXISTS idx_memories_world_key ON memories(world_key);
      CREATE INDEX IF NOT EXISTS idx_memories_world_type ON memories(world_key, type);
      CREATE INDEX IF NOT EXISTS idx_memories_world_dimension ON memories(world_key, dimension);
      CREATE INDEX IF NOT EXISTS idx_memories_world_rank
        ON memories(world_key, importance DESC, observed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_tags_tag ON memory_tags(tag, memory_id);
    `)

    const existing = this.db
      .prepare('SELECT value FROM schema_meta WHERE key = ?')
      .get('schema_version') as { value?: unknown } | undefined
    if (existing === undefined) {
      this.db
        .prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)')
        .run('schema_version', MEMORY_SCHEMA_VERSION)
    } else if (existing.value !== MEMORY_SCHEMA_VERSION) {
      throw new Error(`unsupported minecraft memory schema version: ${String(existing.value)}`)
    }
  }

  private memoryById(id: string): MinecraftMemory {
    const row = requireMemoryRow(
      this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id)
    )
    return this.hydrate(row)
  }

  private hydrate(row: MemoryRow): MinecraftMemory {
    const type = MinecraftMemoryTypeSchema.parse(row.type)
    const tags = this.db
      .prepare('SELECT tag FROM memory_tags WHERE memory_id = ? ORDER BY tag ASC')
      .all(row.id)
      .map(requireTagRow)
      .map(tag => tag.tag)

    const hasPosition = row.x !== null && row.y !== null && row.z !== null
    if ((row.x === null || row.y === null || row.z === null) && hasAnyCoordinate(row)) {
      throw new Error(`memory ${row.id} has a partial position`)
    }

    return {
      id: row.id,
      worldKey: row.world_key,
      type,
      content: row.content,
      dimension: row.dimension,
      position: hasPosition
        ? { x: row.x as number, y: row.y as number, z: row.z as number }
        : null,
      tags,
      importance: row.importance,
      observedAt: row.observed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      reinforcementCount: row.reinforcement_count
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('minecraft memory repository is closed')
    }
  }
}

function normalizeMemoryInput(input: MinecraftMemoryInput): NormalizedMemoryInput {
  const parsed = MinecraftMemoryInputSchema.parse(input)
  return {
    worldKey: normalizeWorldKey(parsed.worldKey),
    type: parsed.type,
    content: parsed.content.trim(),
    dimension: parsed.dimension === undefined ? null : normalizeDimension(parsed.dimension),
    position: parsed.position === undefined ? null : { ...parsed.position },
    tags: normalizeTags(parsed.tags ?? []),
    importance: parsed.importance ?? 0.5,
    observedAt: parsed.observedAt
  }
}

function normalizeWorldKey(value: string): string {
  return value.trim()
}

function normalizeDimension(value: string): string {
  return value.trim().toLowerCase()
}

function normalizeTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map(tag => tag.trim().toLowerCase()))].sort()
}

function fingerprintOf(input: NormalizedMemoryInput): string {
  return createHash('sha256')
    .update(JSON.stringify({
      worldKey: input.worldKey,
      type: input.type,
      content: input.content,
      dimension: input.dimension,
      position: input.position,
      tags: input.tags
    }))
    .digest('hex')
}

function asMemoryRow(value: unknown): MemoryRow | null {
  return value === undefined ? null : requireMemoryRow(value)
}

function requireMemoryRow(value: unknown): MemoryRow {
  if (!isObject(value)) throw new Error('invalid memory row returned by sqlite')
  const row: MemoryRow = {
    id: requireString(value.id, 'id'),
    world_key: requireString(value.world_key, 'world_key'),
    type: requireString(value.type, 'type'),
    content: requireString(value.content, 'content'),
    dimension: nullableString(value.dimension, 'dimension'),
    x: nullableFiniteNumber(value.x, 'x'),
    y: nullableFiniteNumber(value.y, 'y'),
    z: nullableFiniteNumber(value.z, 'z'),
    importance: requireFiniteNumber(value.importance, 'importance'),
    observed_at: requireNonNegativeInteger(value.observed_at, 'observed_at'),
    created_at: requireFiniteNumber(value.created_at, 'created_at'),
    updated_at: requireFiniteNumber(value.updated_at, 'updated_at'),
    reinforcement_count: requireNonNegativeInteger(
      value.reinforcement_count,
      'reinforcement_count'
    ),
    fingerprint: requireString(value.fingerprint, 'fingerprint')
  }
  return row
}

function requireTagRow(value: unknown): TagRow {
  if (!isObject(value)) throw new Error('invalid tag row returned by sqlite')
  return { tag: requireString(value.tag, 'tag') }
}

function hasAnyCoordinate(row: MemoryRow): boolean {
  return row.x !== null || row.y !== null || row.z !== null
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`invalid sqlite ${field}`)
  return value
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null
  return requireString(value, field)
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`invalid sqlite ${field}`)
  }
  return value
}

function nullableFiniteNumber(value: unknown, field: string): number | null {
  if (value === null) return null
  return requireFiniteNumber(value, field)
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  const number = requireFiniteNumber(value, field)
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`invalid sqlite ${field}`)
  }
  return number
}
