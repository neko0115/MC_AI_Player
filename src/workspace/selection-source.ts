import {
  WorkspaceSelectionQuerySchema,
  WorkspaceSelectionSnapshotSchema,
  type WorkspaceSelection,
  type WorkspaceSelectionQuery
} from './contracts.js'

export type WorkspaceSelectionSyncState =
  | 'current'
  | 'stale'
  | 'unavailable'

export interface WorkspaceSelectionSourceStatus {
  readonly state: WorkspaceSelectionSyncState
  readonly lastSuccessAt: number | null
  readonly lastErrorCode: string | null
}

export interface WorkspaceSelectionSource {
  latest(
    query: WorkspaceSelectionQuery
  ): WorkspaceSelection | null
  status(): WorkspaceSelectionSourceStatus
}

export interface WorkspaceSelectionTrackerOptions {
  readonly now?: () => number
  readonly maxSelectionAgeMs?: number
}

const DEFAULT_MAX_SELECTION_AGE_MS = 10 * 60 * 1000

export class WorkspaceSelectionTracker
implements WorkspaceSelectionSource {
  private readonly now: () => number
  private readonly maxSelectionAgeMs: number
  private selections = new Map<string, WorkspaceSelection>()
  private lastGeneratedAt: number | null = null
  private lastSuccessAt: number | null = null
  private lastErrorCode: string | null = null

  constructor(
    options: WorkspaceSelectionTrackerOptions = {}
  ) {
    this.now = options.now ?? Date.now
    this.maxSelectionAgeMs =
      options.maxSelectionAgeMs ??
      DEFAULT_MAX_SELECTION_AGE_MS

    if (
      !Number.isInteger(this.maxSelectionAgeMs) ||
      this.maxSelectionAgeMs < 1 ||
      this.maxSelectionAgeMs > 24 * 60 * 60 * 1000
    ) {
      throw new RangeError(
        'maxSelectionAgeMs must be an integer between 1 and 86400000'
      )
    }
  }

  refresh(input: unknown): boolean {
    const parsed =
      WorkspaceSelectionSnapshotSchema.safeParse(input)
    if (!parsed.success) {
      this.noteFailure('invalid_selection_snapshot')
      return false
    }

    if (
      this.lastGeneratedAt !== null &&
      parsed.data.generatedAt < this.lastGeneratedAt
    ) {
      this.noteFailure('out_of_order_selection_snapshot')
      return false
    }

    if (
      this.lastGeneratedAt !== null &&
      parsed.data.generatedAt === this.lastGeneratedAt
    ) {
      if (!snapshotEqualsCurrent(
        parsed.data.selections,
        this.selections
      )) {
        this.noteFailure('selection_snapshot_conflict')
        return false
      }
      this.lastSuccessAt = this.now()
      this.lastErrorCode = null
      return true
    }

    const next = new Map<string, WorkspaceSelection>()

    for (const selection of parsed.data.selections) {
      const key = selectionKey(selection)
      if (next.has(key)) {
        this.noteFailure('duplicate_selection_identity')
        return false
      }

      const previous = this.selections.get(key)
      if (
        previous &&
        selectionIsOlder(selection, previous)
      ) {
        this.noteFailure('out_of_order_selection_snapshot')
        return false
      }

      if (
        previous &&
        selectionIsSameVersion(selection, previous) &&
        !selectionEquals(selection, previous)
      ) {
        this.noteFailure('selection_generation_conflict')
        return false
      }

      next.set(key, cloneSelection(selection))
    }

    this.selections = next
    this.lastGeneratedAt = parsed.data.generatedAt
    this.lastSuccessAt = this.now()
    this.lastErrorCode = null
    return true
  }

  noteFailure(code: string): void {
    this.lastErrorCode =
      normalizeErrorCode(code)
  }

  latest(
    query: WorkspaceSelectionQuery
  ): WorkspaceSelection | null {
    const parsed =
      WorkspaceSelectionQuerySchema.parse(query)

    if (this.status().state !== 'current') {
      return null
    }

    const selection = this.selections.get(
      selectionKey(parsed)
    )
    if (!selection) return null

    const age = this.now() - selection.selectedAt
    if (
      age < 0 ||
      age > this.maxSelectionAgeMs
    ) {
      return null
    }

    return cloneSelection(selection)
  }

  status(): WorkspaceSelectionSourceStatus {
    return {
      state:
        this.lastSuccessAt === null
          ? 'unavailable'
          : this.lastErrorCode === null
            ? 'current'
            : 'stale',
      lastSuccessAt: this.lastSuccessAt,
      lastErrorCode: this.lastErrorCode
    }
  }
}

function snapshotEqualsCurrent(
  selections: readonly WorkspaceSelection[],
  current: ReadonlyMap<string, WorkspaceSelection>
): boolean {
  if (selections.length !== current.size) return false

  for (const selection of selections) {
    const existing = current.get(selectionKey(selection))
    if (
      !existing ||
      !selectionIsSameVersion(selection, existing) ||
      !selectionEquals(selection, existing)
    ) {
      return false
    }
  }
  return true
}

function selectionKey(value: {
  readonly worldKey: string
  readonly dimension: string
  readonly playerId: string
}): string {
  return [
    value.worldKey.trim(),
    value.dimension.trim().toLowerCase(),
    value.playerId.trim()
  ].join('\u0000')
}

function selectionIsOlder(
  incoming: WorkspaceSelection,
  previous: WorkspaceSelection
): boolean {
  if (incoming.selectedAt < previous.selectedAt) {
    return true
  }
  return (
    incoming.selectedAt === previous.selectedAt &&
    incoming.generation < previous.generation
  )
}

function selectionIsSameVersion(
  left: WorkspaceSelection,
  right: WorkspaceSelection
): boolean {
  return (
    left.selectedAt === right.selectedAt &&
    left.generation === right.generation
  )
}

function selectionEquals(
  left: WorkspaceSelection,
  right: WorkspaceSelection
): boolean {
  return (
    left.id === right.id &&
    left.worldKey === right.worldKey &&
    left.dimension === right.dimension &&
    left.playerId === right.playerId &&
    left.playerName === right.playerName &&
    left.pointA.x === right.pointA.x &&
    left.pointA.y === right.pointA.y &&
    left.pointA.z === right.pointA.z &&
    left.pointB.x === right.pointB.x &&
    left.pointB.y === right.pointB.y &&
    left.pointB.z === right.pointB.z
  )
}

function cloneSelection(
  selection: WorkspaceSelection
): WorkspaceSelection {
  return {
    ...selection,
    pointA: { ...selection.pointA },
    pointB: { ...selection.pointB }
  }
}

function normalizeErrorCode(
  value: string
): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .slice(0, 128)

  return normalized || 'selection_source_failed'
}
