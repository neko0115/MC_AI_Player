import { createRequire } from 'node:module'
import type { BudgetClass, ThinkingLevel } from './contracts.js'
import { nextProviderDayStart, providerDayKey } from './provider-day.js'

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

export interface QuotaProviderLimits {
  readonly rpm: number
  readonly inputTpm: number
  readonly rpd: number
}

export interface FlashBudgetLimits {
  readonly requestLimit: number
  readonly totalTokenLimit: number
}

export interface QuotaAdmissionRequest {
  readonly attemptId: string
  readonly decisionId: string
  readonly configGeneration: number
  readonly projectKey: string
  readonly model: string
  readonly thinking: ThinkingLevel
  readonly budgetClass: BudgetClass
  readonly now: number
  readonly reservedInputTokens: number
  readonly reservedTotalTokens: number
  readonly providerLimits: QuotaProviderLimits
  readonly flashBudget?: FlashBudgetLimits
}

export type QuotaAdmissionResult =
  | { readonly kind: 'admitted'; readonly reservationId: string }
  | {
      readonly kind: 'rejected'
      readonly code:
        | 'domain_unavailable'
        | 'rpm'
        | 'input_tpm'
        | 'rpd'
        | 'flash_request_budget'
        | 'flash_token_budget'
      readonly retryAt: number | null
    }

export interface GeminiUsageAccounting {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly thoughtTokens: number
  readonly toolTokens: number
  readonly totalTokens: number
}

export interface AttemptSettlement {
  readonly now: number
  readonly resultClass: string
  readonly safeErrorCode?: string
  readonly usage?: GeminiUsageAccounting
  readonly missingUsagePolicy?: 'rejected' | 'unknown'
}

export interface AdminQuotaDomainSnapshot {
  readonly model: string
  readonly rollingRequests: number
  readonly rollingInputTokens: number
  readonly dayRequests: number
  readonly dayInputTokens: number
  readonly dayTotalTokens: number
  readonly normalRequests: number
  readonly normalTotalTokens: number
  readonly reserveRequests: number
  readonly reserveTotalTokens: number
  readonly budgetOverrunCount: number
  readonly transientFailureCount: number
  readonly cooldownUntil: number | null
  readonly quotaUnavailableUntil: number | null
  readonly lastSafeError: string | null
  readonly lastSafeErrorAt: number | null
}

export interface AdminQuotaProjectSnapshot {
  readonly projectKey: string
  readonly domains: readonly AdminQuotaDomainSnapshot[]
}

interface AttemptUsageRow {
  state: string
  budget_class: string
  reserved_at: number
  dispatched_at: number | null
  reserved_input_tokens: number
  reserved_total_tokens: number
  accounted_input_tokens: number
  accounted_total_tokens: number
  budget_overrun: number
}

interface AttemptRow extends AttemptUsageRow {
  attempt_id: string
  provider_day_key: string
  flash_request_limit: number | null
  flash_total_token_limit: number | null
}

interface DomainStateRow {
  transient_count: number
  cooldown_until: number | null
  quota_unavailable_until: number | null
  last_safe_error: string | null
  last_error_at: number | null
}

interface DomainKeyRow {
  project_key: string
  model: string
}

interface CountRow {
  count: number
}

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as DatabaseConstructor
const QUOTA_SCHEMA_VERSION = '1'
const ROLLING_WINDOW_MS = 60_000
const TRANSIENT_DELAYS = [5_000, 15_000, 30_000, 60_000] as const

export class SqliteQuotaLedger {
  private readonly db: DatabaseLike
  private closed = false

  constructor(filename: string) {
    if (typeof filename !== 'string' || filename.trim().length === 0) {
      throw new TypeError('filename must be a non-empty string')
    }
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

  allocateConfigGeneration(): number {
    this.assertOpen()
    const allocate = this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT value FROM quota_meta WHERE key = ?')
        .get('config_generation') as { value?: unknown } | undefined
      const current = row === undefined ? 0 : requireNonNegativeInteger(Number(row.value), 'config_generation')
      const next = current + 1
      this.db.prepare(`
        INSERT INTO quota_meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run('config_generation', String(next))
      return next
    })
    return allocate()
  }

  admitAttempt(request: QuotaAdmissionRequest): QuotaAdmissionResult {
    this.assertOpen()
    validateAdmissionRequest(request)
    const admit = this.db.transaction((): QuotaAdmissionResult => {
      const availability = this.domainAvailability(request.projectKey, request.model, request.now)
      if (!availability.available) {
        return { kind: 'rejected', code: 'domain_unavailable', retryAt: availability.retryAt }
      }

      const recent = this.recentUsageRows(request.projectKey, request.model, request.now)
      const recentRequests = recent.length
      const recentInput = recent.reduce((sum, row) => sum + accountedInput(row), 0)

      if (recentRequests + 1 > request.providerLimits.rpm) {
        return {
          kind: 'rejected',
          code: 'rpm',
          retryAt: rollingRetryAt(recent, request, 'rpm')
        }
      }
      if (request.reservedInputTokens > request.providerLimits.inputTpm) {
        return { kind: 'rejected', code: 'input_tpm', retryAt: null }
      }
      if (recentInput + request.reservedInputTokens > request.providerLimits.inputTpm) {
        return {
          kind: 'rejected',
          code: 'input_tpm',
          retryAt: rollingRetryAt(recent, request, 'input_tpm')
        }
      }

      const dayKey = providerDayKey(request.now)
      const day = this.dayUsage(request.projectKey, request.model, dayKey)
      if (day.dayRequests + 1 > request.providerLimits.rpd) {
        return {
          kind: 'rejected',
          code: 'rpd',
          retryAt: nextProviderDayStart(request.now)
        }
      }

      if (request.flashBudget) {
        const requestCeiling = request.budgetClass === 'normal'
          ? Math.floor(request.flashBudget.requestLimit * 0.70)
          : request.flashBudget.requestLimit
        const tokenCeiling = request.budgetClass === 'normal'
          ? Math.floor(request.flashBudget.totalTokenLimit * 0.70)
          : request.flashBudget.totalTokenLimit
        const usedRequests = request.budgetClass === 'normal'
          ? day.normalRequests
          : day.dayRequests
        const usedTokens = request.budgetClass === 'normal'
          ? day.normalTotalTokens
          : day.dayTotalTokens

        if (usedRequests + 1 > requestCeiling) {
          return {
            kind: 'rejected',
            code: 'flash_request_budget',
            retryAt: nextProviderDayStart(request.now)
          }
        }
        if (usedTokens + request.reservedTotalTokens > tokenCeiling) {
          return {
            kind: 'rejected',
            code: 'flash_token_budget',
            retryAt: nextProviderDayStart(request.now)
          }
        }
      }

      this.db.prepare(`
        INSERT INTO quota_attempts (
          attempt_id, decision_id, config_generation, project_key, model,
          thinking, budget_class, state, reserved_at, provider_day_key,
          reserved_input_tokens, reserved_total_tokens,
          accounted_input_tokens, accounted_total_tokens, usage_quality,
          flash_request_limit, flash_total_token_limit, budget_overrun
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, 0, 0, 'reserved', ?, ?, 0)
      `).run(
        bounded(request.attemptId, 'attemptId'),
        bounded(request.decisionId, 'decisionId'),
        request.configGeneration,
        bounded(request.projectKey, 'projectKey'),
        bounded(request.model, 'model', 256),
        request.thinking,
        request.budgetClass,
        request.now,
        dayKey,
        request.reservedInputTokens,
        request.reservedTotalTokens,
        request.flashBudget?.requestLimit ?? null,
        request.flashBudget?.totalTokenLimit ?? null
      )

      return { kind: 'admitted', reservationId: request.attemptId }
    })
    return admit()
  }

  markDispatched(reservationId: string, dispatchedAt: number): void {
    this.assertOpen()
    validateTimestamp(dispatchedAt, 'dispatchedAt')
    const result = this.db.prepare(`
      UPDATE quota_attempts
      SET state = 'dispatched', dispatched_at = ?, provider_day_key = ?
      WHERE attempt_id = ? AND state = 'reserved'
    `).run(dispatchedAt, providerDayKey(dispatchedAt), reservationId)
    if (result.changes !== 1) {
      throw new Error('reservation must be reserved before dispatch')
    }
  }

  releaseReservation(reservationId: string, now: number): void {
    this.assertOpen()
    validateTimestamp(now, 'now')
    const result = this.db.prepare(`
      UPDATE quota_attempts
      SET state = 'released', settled_at = ?, usage_quality = 'released',
          result_class = 'released', accounted_input_tokens = 0,
          accounted_total_tokens = 0
      WHERE attempt_id = ? AND state = 'reserved'
    `).run(now, reservationId)
    if (result.changes !== 1) {
      throw new Error('only reserved attempts may be released')
    }
  }

  settleAttempt(reservationId: string, settlement: AttemptSettlement): void {
    this.assertOpen()
    validateTimestamp(settlement.now, 'settlement.now')
    const settle = this.db.transaction(() => {
      const row = requireAttemptRow(
        this.db.prepare('SELECT * FROM quota_attempts WHERE attempt_id = ?').get(reservationId)
      )
      if (row.state !== 'dispatched') {
        throw new Error('attempt must be dispatched before settlement')
      }

      let accountedInput: number
      let accountedTotal: number
      let usageQuality: string
      let actual: GeminiUsageAccounting | undefined

      if (settlement.usage) {
        validateUsage(settlement.usage)
        actual = settlement.usage
        accountedInput = actual.inputTokens
        accountedTotal = actual.totalTokens
        usageQuality = 'actual'
      } else if (settlement.missingUsagePolicy === 'rejected') {
        accountedInput = row.reserved_input_tokens
        accountedTotal = row.reserved_input_tokens
        usageQuality = 'conservative_rejected'
      } else if (settlement.missingUsagePolicy === 'unknown') {
        accountedInput = row.reserved_input_tokens
        accountedTotal = row.reserved_total_tokens
        usageQuality = 'conservative_unknown'
      } else {
        throw new Error('missing usage requires an explicit conservative policy')
      }

      this.db.prepare(`
        UPDATE quota_attempts
        SET state = 'settled', settled_at = ?,
            actual_input_tokens = ?, actual_output_tokens = ?,
            actual_thought_tokens = ?, actual_tool_tokens = ?, actual_total_tokens = ?,
            accounted_input_tokens = ?, accounted_total_tokens = ?,
            usage_quality = ?, result_class = ?, safe_error_code = ?
        WHERE attempt_id = ?
      `).run(
        settlement.now,
        actual?.inputTokens ?? null,
        actual?.outputTokens ?? null,
        actual?.thoughtTokens ?? null,
        actual?.toolTokens ?? null,
        actual?.totalTokens ?? null,
        accountedInput,
        accountedTotal,
        usageQuality,
        bounded(settlement.resultClass, 'resultClass'),
        settlement.safeErrorCode ? bounded(settlement.safeErrorCode, 'safeErrorCode') : null,
        reservationId
      )

      if (
        row.budget_class === 'normal' &&
        row.flash_total_token_limit !== null &&
        accountedTotal > row.reserved_total_tokens
      ) {
        const day = this.dayUsage(
          this.projectKeyFor(reservationId),
          this.modelFor(reservationId),
          row.provider_day_key
        )
        const normalCeiling = Math.floor(row.flash_total_token_limit * 0.70)
        if (day.normalTotalTokens > normalCeiling) {
          this.db.prepare(
            'UPDATE quota_attempts SET budget_overrun = 1 WHERE attempt_id = ?'
          ).run(reservationId)
        }
      }
    })
    settle()
  }

  recoverIncompleteAttempts(now: number): { released: number; uncertain: number } {
    this.assertOpen()
    validateTimestamp(now, 'now')
    const recover = this.db.transaction(() => {
      const released = this.db.prepare(`
        UPDATE quota_attempts
        SET state = 'released', settled_at = ?, usage_quality = 'released',
            result_class = 'process_restart_before_dispatch',
            accounted_input_tokens = 0, accounted_total_tokens = 0
        WHERE state = 'reserved'
      `).run(now).changes

      const uncertain = this.db.prepare(`
        UPDATE quota_attempts
        SET state = 'uncertain', settled_at = ?, usage_quality = 'conservative_unknown',
            result_class = 'process_crash',
            accounted_input_tokens = reserved_input_tokens,
            accounted_total_tokens = reserved_total_tokens
        WHERE state = 'dispatched'
      `).run(now).changes

      return { released, uncertain }
    })
    return recover()
  }

  recordTransientFailure(
    projectKey: string,
    model: string,
    now: number,
    retryAfterMs?: number
  ): number {
    this.assertOpen()
    validateTimestamp(now, 'now')
    if (retryAfterMs !== undefined && (!Number.isFinite(retryAfterMs) || retryAfterMs < 0)) {
      throw new RangeError('retryAfterMs must be non-negative when provided')
    }
    const update = this.db.transaction(() => {
      this.ensureDomainState(projectKey, model)
      const current = requireDomainStateRow(this.db.prepare(`
        SELECT transient_count, cooldown_until, quota_unavailable_until,
               last_safe_error, last_error_at
        FROM quota_domain_state WHERE project_key = ? AND model = ?
      `).get(projectKey, model))
      const policyDelay = TRANSIENT_DELAYS[Math.min(current.transient_count, TRANSIENT_DELAYS.length - 1)] ?? 60_000
      const delay = Math.max(policyDelay, Math.floor(retryAfterMs ?? 0))
      this.db.prepare(`
        UPDATE quota_domain_state
        SET transient_count = ?, cooldown_until = ?,
            last_safe_error = 'transient', last_error_at = ?
        WHERE project_key = ? AND model = ?
      `).run(current.transient_count + 1, now + delay, now, projectKey, model)
      return delay
    })
    return update()
  }

  recordDomainSuccess(projectKey: string, model: string): void {
    this.assertOpen()
    this.ensureDomainState(projectKey, model)
    this.db.prepare(`
      UPDATE quota_domain_state
      SET transient_count = 0, cooldown_until = NULL
      WHERE project_key = ? AND model = ?
    `).run(projectKey, model)
  }

  markQuotaUnavailable(
    projectKey: string,
    model: string,
    until: number,
    safeCode: string
  ): void {
    this.assertOpen()
    validateTimestamp(until, 'until')
    this.ensureDomainState(projectKey, model)
    const current = requireDomainStateRow(this.db.prepare(`
      SELECT transient_count, cooldown_until, quota_unavailable_until,
             last_safe_error, last_error_at
      FROM quota_domain_state WHERE project_key = ? AND model = ?
    `).get(projectKey, model))
    const nextUntil = Math.max(current.quota_unavailable_until ?? 0, until)
    this.db.prepare(`
      UPDATE quota_domain_state
      SET quota_unavailable_until = ?, last_safe_error = ?, last_error_at = ?
      WHERE project_key = ? AND model = ?
    `).run(nextUntil, bounded(safeCode, 'safeCode'), Date.now(), projectKey, model)
  }

  domainAvailability(
    projectKey: string,
    model: string,
    now: number
  ): { available: boolean; retryAt: number | null } {
    this.assertOpen()
    validateTimestamp(now, 'now')
    const value = this.db.prepare(`
      SELECT transient_count, cooldown_until, quota_unavailable_until,
             last_safe_error, last_error_at
      FROM quota_domain_state WHERE project_key = ? AND model = ?
    `).get(projectKey, model)
    if (value === undefined) return { available: true, retryAt: null }
    const state = requireDomainStateRow(value)
    const blockers = [state.cooldown_until, state.quota_unavailable_until]
      .filter((candidate): candidate is number => candidate !== null && candidate > now)
    if (blockers.length === 0) return { available: true, retryAt: null }
    return { available: false, retryAt: Math.max(...blockers) }
  }

  disableCredentialForProcess(
    projectKey: string,
    processInstanceId: string,
    safeCode: string,
    now: number
  ): void {
    this.assertOpen()
    validateTimestamp(now, 'now')
    this.db.prepare(`
      INSERT INTO credential_health (
        project_key, process_instance_id, disabled, safe_error_code, disabled_at
      ) VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(project_key, process_instance_id) DO UPDATE SET
        disabled = 1,
        safe_error_code = excluded.safe_error_code,
        disabled_at = excluded.disabled_at
    `).run(
      bounded(projectKey, 'projectKey'),
      bounded(processInstanceId, 'processInstanceId'),
      bounded(safeCode, 'safeCode'),
      now
    )
  }

  credentialDisabled(projectKey: string, processInstanceId: string): boolean {
    this.assertOpen()
    const row = this.db.prepare(`
      SELECT disabled FROM credential_health
      WHERE project_key = ? AND process_instance_id = ?
    `).get(projectKey, processInstanceId) as { disabled?: unknown } | undefined
    return row?.disabled === 1
  }

  adminSnapshot(now: number): readonly AdminQuotaProjectSnapshot[] {
    this.assertOpen()
    validateTimestamp(now, 'now')
    const keys = this.db.prepare(`
      SELECT project_key, model FROM quota_attempts
      UNION
      SELECT project_key, model FROM quota_domain_state
      ORDER BY project_key ASC, model ASC
    `).all().map(requireDomainKeyRow)

    const projects = new Map<string, AdminQuotaDomainSnapshot[]>()
    const dayKey = providerDayKey(now)
    for (const key of keys) {
      const day = this.dayUsage(key.project_key, key.model, dayKey)
      const recent = this.recentUsageRows(key.project_key, key.model, now)
      const stateValue = this.db.prepare(`
        SELECT transient_count, cooldown_until, quota_unavailable_until,
               last_safe_error, last_error_at
        FROM quota_domain_state WHERE project_key = ? AND model = ?
      `).get(key.project_key, key.model)
      const state = stateValue === undefined ? null : requireDomainStateRow(stateValue)
      const domain: AdminQuotaDomainSnapshot = {
        model: key.model,
        rollingRequests: recent.length,
        rollingInputTokens: recent.reduce((sum, row) => sum + accountedInput(row), 0),
        ...day,
        transientFailureCount: state?.transient_count ?? 0,
        cooldownUntil: state?.cooldown_until ?? null,
        quotaUnavailableUntil: state?.quota_unavailable_until ?? null,
        lastSafeError: state?.last_safe_error ?? null,
        lastSafeErrorAt: state?.last_error_at ?? null
      }
      const domains = projects.get(key.project_key) ?? []
      domains.push(domain)
      projects.set(key.project_key, domains)
    }

    return [...projects.entries()].map(([projectKey, domains]) => ({
      projectKey,
      domains
    }))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  private recentUsageRows(
    projectKey: string,
    model: string,
    now: number
  ): AttemptUsageRow[] {
    return this.db.prepare(`
      SELECT state, budget_class, reserved_at, dispatched_at,
             reserved_input_tokens, reserved_total_tokens,
             accounted_input_tokens, accounted_total_tokens, budget_overrun
      FROM quota_attempts
      WHERE project_key = ? AND model = ? AND state <> 'released'
        AND COALESCE(dispatched_at, reserved_at) > ?
      ORDER BY COALESCE(dispatched_at, reserved_at) ASC, attempt_id ASC
    `).all(projectKey, model, now - ROLLING_WINDOW_MS).map(requireAttemptUsageRow)
  }

  private dayUsage(projectKey: string, model: string, dayKey: string) {
    const rows = this.db.prepare(`
      SELECT state, budget_class, reserved_at, dispatched_at,
             reserved_input_tokens, reserved_total_tokens,
             accounted_input_tokens, accounted_total_tokens, budget_overrun
      FROM quota_attempts
      WHERE project_key = ? AND model = ? AND provider_day_key = ?
        AND state <> 'released'
    `).all(projectKey, model, dayKey).map(requireAttemptUsageRow)

    let dayInputTokens = 0
    let dayTotalTokens = 0
    let normalRequests = 0
    let normalTotalTokens = 0
    let reserveRequests = 0
    let reserveTotalTokens = 0
    let budgetOverrunCount = 0
    for (const row of rows) {
      const total = accountedTotal(row)
      dayInputTokens += accountedInput(row)
      dayTotalTokens += total
      budgetOverrunCount += row.budget_overrun === 1 ? 1 : 0
      if (row.budget_class === 'normal') {
        normalRequests += 1
        normalTotalTokens += total
      } else if (row.budget_class === 'reserve') {
        reserveRequests += 1
        reserveTotalTokens += total
      }
    }

    return {
      dayRequests: rows.length,
      dayInputTokens,
      dayTotalTokens,
      normalRequests,
      normalTotalTokens,
      reserveRequests,
      reserveTotalTokens,
      budgetOverrunCount
    }
  }

  private ensureDomainState(projectKey: string, model: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO quota_domain_state (
        project_key, model, transient_count
      ) VALUES (?, ?, 0)
    `).run(bounded(projectKey, 'projectKey'), bounded(model, 'model', 256))
  }

  private projectKeyFor(attemptId: string): string {
    const row = this.db.prepare(
      'SELECT project_key FROM quota_attempts WHERE attempt_id = ?'
    ).get(attemptId) as { project_key?: unknown } | undefined
    if (!row || typeof row.project_key !== 'string') throw new Error('attempt project missing')
    return row.project_key
  }

  private modelFor(attemptId: string): string {
    const row = this.db.prepare(
      'SELECT model FROM quota_attempts WHERE attempt_id = ?'
    ).get(attemptId) as { model?: unknown } | undefined
    if (!row || typeof row.model !== 'string') throw new Error('attempt model missing')
    return row.model
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
      CREATE TABLE IF NOT EXISTS quota_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS quota_attempts (
        attempt_id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL,
        config_generation INTEGER NOT NULL CHECK (config_generation >= 1),
        project_key TEXT NOT NULL,
        model TEXT NOT NULL,
        thinking TEXT NOT NULL CHECK (thinking IN ('low', 'medium', 'high')),
        budget_class TEXT NOT NULL CHECK (budget_class IN ('normal', 'reserve')),
        state TEXT NOT NULL CHECK (state IN ('reserved', 'dispatched', 'settled', 'released', 'uncertain')),
        reserved_at INTEGER NOT NULL,
        dispatched_at INTEGER,
        settled_at INTEGER,
        provider_day_key TEXT NOT NULL,
        reserved_input_tokens INTEGER NOT NULL CHECK (reserved_input_tokens >= 0),
        reserved_total_tokens INTEGER NOT NULL CHECK (reserved_total_tokens >= 0),
        actual_input_tokens INTEGER,
        actual_output_tokens INTEGER,
        actual_thought_tokens INTEGER,
        actual_tool_tokens INTEGER,
        actual_total_tokens INTEGER,
        accounted_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (accounted_input_tokens >= 0),
        accounted_total_tokens INTEGER NOT NULL DEFAULT 0 CHECK (accounted_total_tokens >= 0),
        usage_quality TEXT NOT NULL,
        result_class TEXT,
        safe_error_code TEXT,
        flash_request_limit INTEGER,
        flash_total_token_limit INTEGER,
        budget_overrun INTEGER NOT NULL DEFAULT 0 CHECK (budget_overrun IN (0, 1))
      );

      CREATE INDEX IF NOT EXISTS idx_quota_attempt_domain_day
        ON quota_attempts(project_key, model, provider_day_key);
      CREATE INDEX IF NOT EXISTS idx_quota_attempt_domain_reserved
        ON quota_attempts(project_key, model, reserved_at);
      CREATE INDEX IF NOT EXISTS idx_quota_attempt_domain_dispatched
        ON quota_attempts(project_key, model, dispatched_at);

      CREATE TABLE IF NOT EXISTS quota_domain_state (
        project_key TEXT NOT NULL,
        model TEXT NOT NULL,
        transient_count INTEGER NOT NULL DEFAULT 0 CHECK (transient_count >= 0),
        cooldown_until INTEGER,
        quota_unavailable_until INTEGER,
        last_safe_error TEXT,
        last_error_at INTEGER,
        PRIMARY KEY (project_key, model)
      );

      CREATE TABLE IF NOT EXISTS credential_health (
        project_key TEXT NOT NULL,
        process_instance_id TEXT NOT NULL,
        disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
        safe_error_code TEXT,
        disabled_at INTEGER,
        PRIMARY KEY (project_key, process_instance_id)
      );
    `)

    const existing = this.db
      .prepare('SELECT value FROM quota_meta WHERE key = ?')
      .get('schema_version') as { value?: unknown } | undefined
    if (existing === undefined) {
      this.db.prepare('INSERT INTO quota_meta (key, value) VALUES (?, ?)')
        .run('schema_version', QUOTA_SCHEMA_VERSION)
    } else if (existing.value !== QUOTA_SCHEMA_VERSION) {
      throw new Error(`unsupported AI quota schema version: ${String(existing.value)}`)
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('AI quota ledger is closed')
  }
}

function rollingRetryAt(
  rows: readonly AttemptUsageRow[],
  request: QuotaAdmissionRequest,
  reason: 'rpm' | 'input_tpm'
): number | null {
  let count = rows.length
  let input = rows.reduce((sum, row) => sum + accountedInput(row), 0)
  for (const row of rows) {
    count -= 1
    input -= accountedInput(row)
    const requestFits = reason === 'rpm'
      ? count + 1 <= request.providerLimits.rpm
      : input + request.reservedInputTokens <= request.providerLimits.inputTpm
    if (requestFits) {
      return eventAt(row) + ROLLING_WINDOW_MS
    }
  }
  return null
}

function eventAt(row: AttemptUsageRow): number {
  return row.dispatched_at ?? row.reserved_at
}

function accountedInput(row: AttemptUsageRow): number {
  return row.state === 'reserved' || row.state === 'dispatched'
    ? row.reserved_input_tokens
    : row.accounted_input_tokens
}

function accountedTotal(row: AttemptUsageRow): number {
  return row.state === 'reserved' || row.state === 'dispatched'
    ? row.reserved_total_tokens
    : row.accounted_total_tokens
}

function validateAdmissionRequest(request: QuotaAdmissionRequest): void {
  validateTimestamp(request.now, 'request.now')
  if (!Number.isInteger(request.configGeneration) || request.configGeneration < 1) {
    throw new RangeError('configGeneration must be a positive integer')
  }
  for (const [name, value] of Object.entries({
    reservedInputTokens: request.reservedInputTokens,
    reservedTotalTokens: request.reservedTotalTokens,
    rpm: request.providerLimits.rpm,
    inputTpm: request.providerLimits.inputTpm,
    rpd: request.providerLimits.rpd
  })) {
    if (!Number.isInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive integer`)
    }
  }
  if (request.reservedTotalTokens < request.reservedInputTokens) {
    throw new RangeError('reservedTotalTokens must be >= reservedInputTokens')
  }
  if (request.flashBudget) {
    if (!Number.isInteger(request.flashBudget.requestLimit) || request.flashBudget.requestLimit < 1) {
      throw new RangeError('flash requestLimit must be a positive integer')
    }
    if (!Number.isInteger(request.flashBudget.totalTokenLimit) || request.flashBudget.totalTokenLimit < 1) {
      throw new RangeError('flash totalTokenLimit must be a positive integer')
    }
  }
  bounded(request.attemptId, 'attemptId')
  bounded(request.decisionId, 'decisionId')
  bounded(request.projectKey, 'projectKey')
  bounded(request.model, 'model', 256)
}

function validateUsage(usage: GeminiUsageAccounting): void {
  for (const [name, value] of Object.entries(usage)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative integer`)
    }
  }
}

function validateTimestamp(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`)
  }
}

function bounded(value: string, name: string, max = 128): string {
  const normalized = value.trim()
  if (normalized.length < 1 || normalized.length > max) {
    throw new RangeError(`${name} must be between 1 and ${max} characters`)
  }
  return normalized
}

function requireAttemptUsageRow(value: unknown): AttemptUsageRow {
  if (!isObject(value)) throw new Error('invalid quota attempt usage row')
  return {
    state: requireString(value.state, 'state'),
    budget_class: requireString(value.budget_class, 'budget_class'),
    reserved_at: requireNumber(value.reserved_at, 'reserved_at'),
    dispatched_at: nullableNumber(value.dispatched_at, 'dispatched_at'),
    reserved_input_tokens: requireInteger(value.reserved_input_tokens, 'reserved_input_tokens'),
    reserved_total_tokens: requireInteger(value.reserved_total_tokens, 'reserved_total_tokens'),
    accounted_input_tokens: requireInteger(value.accounted_input_tokens, 'accounted_input_tokens'),
    accounted_total_tokens: requireInteger(value.accounted_total_tokens, 'accounted_total_tokens'),
    budget_overrun: requireInteger(value.budget_overrun, 'budget_overrun')
  }
}

function requireAttemptRow(value: unknown): AttemptRow {
  const usage = requireAttemptUsageRow(value)
  if (!isObject(value)) throw new Error('invalid quota attempt row')
  return {
    ...usage,
    attempt_id: requireString(value.attempt_id, 'attempt_id'),
    provider_day_key: requireString(value.provider_day_key, 'provider_day_key'),
    flash_request_limit: nullableInteger(value.flash_request_limit, 'flash_request_limit'),
    flash_total_token_limit: nullableInteger(value.flash_total_token_limit, 'flash_total_token_limit')
  }
}

function requireDomainStateRow(value: unknown): DomainStateRow {
  if (!isObject(value)) throw new Error('invalid quota domain state row')
  return {
    transient_count: requireInteger(value.transient_count, 'transient_count'),
    cooldown_until: nullableNumber(value.cooldown_until, 'cooldown_until'),
    quota_unavailable_until: nullableNumber(value.quota_unavailable_until, 'quota_unavailable_until'),
    last_safe_error: nullableString(value.last_safe_error, 'last_safe_error'),
    last_error_at: nullableNumber(value.last_error_at, 'last_error_at')
  }
}

function requireDomainKeyRow(value: unknown): DomainKeyRow {
  if (!isObject(value)) throw new Error('invalid quota domain key row')
  return {
    project_key: requireString(value.project_key, 'project_key'),
    model: requireString(value.model, 'model')
  }
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

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`invalid sqlite ${field}`)
  }
  return value
}

function nullableNumber(value: unknown, field: string): number | null {
  if (value === null) return null
  return requireNumber(value, field)
}

function requireInteger(value: unknown, field: string): number {
  const number = requireNumber(value, field)
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`invalid sqlite ${field}`)
  }
  return number
}

function nullableInteger(value: unknown, field: string): number | null {
  if (value === null) return null
  return requireInteger(value, field)
}

function requireNonNegativeInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`invalid sqlite ${field}`)
  }
  return value
}
