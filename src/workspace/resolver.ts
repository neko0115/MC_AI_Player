import {
  WorkspacePointSchema,
  type WorkspaceBounds,
  type WorkspacePoint,
  type WorkspaceRegion,
  type WorkspaceSelection
} from './contracts.js'
import {
  normalizeWorkspaceBounds,
  workspacesIntersect
} from './geometry.js'
import type {
  WorkspaceRepository
} from './repository.js'

export type WorkspaceResolutionReason =
  | 'explicit'
  | 'conversation'
  | 'selection_source'
  | 'selection_intersection'
  | 'nearby'
  | 'recent'

export type WorkspaceResolution =
  | {
      readonly kind: 'resolved'
      readonly reason: WorkspaceResolutionReason
      readonly workspace: WorkspaceRegion
    }
  | {
      readonly kind: 'ambiguous'
      readonly reason:
        | 'explicit'
        | 'selection_source'
        | 'selection_intersection'
        | 'nearby'
      readonly candidates: readonly WorkspaceRegion[]
    }
  | {
      readonly kind: 'none'
      readonly reason:
        | 'explicit_not_found'
        | 'no_match'
    }

export interface ResolveWorkspaceInput {
  readonly worldKey: string
  readonly dimension: string
  readonly actorPrincipal: string
  readonly explicitReference?: string
  readonly conversationWorkspaceId?: string
  readonly selection?: WorkspaceSelection
  readonly playerPosition?: WorkspacePoint
  readonly nearbyRadius?: number
  readonly recentWorkspaceId?: string
  readonly includeArchived?: boolean
}

const DEFAULT_NEARBY_RADIUS = 32
const MAX_NEARBY_RADIUS = 128
const MAX_CANDIDATES = 100

export class WorkspaceResolver {
  constructor(
    private readonly repository: WorkspaceRepository
  ) {}

  resolve(
    input: ResolveWorkspaceInput
  ): WorkspaceResolution {
    const scope = normalizeScope(input)

    if (input.explicitReference !== undefined) {
      return this.resolveExplicit(
        scope,
        input.explicitReference
      )
    }

    const conversation = this.activeOwnedById(
      scope,
      input.conversationWorkspaceId,
      input.includeArchived === true
    )
    if (conversation) {
      return resolved(
        'conversation',
        conversation
      )
    }

    const candidates = this.repository.search({
      worldKey: scope.worldKey,
      dimension: scope.dimension,
      ownerPrincipal: scope.actorPrincipal,
      includeArchived:
        input.includeArchived === true,
      limit: MAX_CANDIDATES
    })

    if (input.selection !== undefined) {
      const selectionResult =
        resolveBySelection(
          candidates,
          scope,
          input.selection
        )
      if (selectionResult) {
        return selectionResult
      }
    }

    if (input.playerPosition !== undefined) {
      const point =
        WorkspacePointSchema.parse(
          input.playerPosition
        )
      const radius =
        normalizeNearbyRadius(
          input.nearbyRadius
        )
      const nearby =
        candidates.filter(
          workspace =>
            squaredDistancePointToBounds(
              point,
              workspace.bounds
            ) <= radius * radius
        )

      if (nearby.length === 1) {
        return resolved(
          'nearby',
          nearby[0]!
        )
      }

      if (nearby.length > 1) {
        return ambiguous(
          'nearby',
          nearby
        )
      }
    }

    const recent = this.activeOwnedById(
      scope,
      input.recentWorkspaceId,
      input.includeArchived === true
    )
    if (recent) {
      return resolved(
        'recent',
        recent
      )
    }

    return {
      kind: 'none',
      reason: 'no_match'
    }
  }

  private resolveExplicit(
    scope: NormalizedScope,
    reference: string
  ): WorkspaceResolution {
    const normalizedReference =
      normalizeReference(reference)

    if (normalizedReference.length === 0) {
      return {
        kind: 'none',
        reason: 'explicit_not_found'
      }
    }

    const direct =
      this.ownedById(
        scope,
        normalizedReference,
        input.includeArchived === true
      )
    if (direct) {
      return resolved(
        'explicit',
        direct
      )
    }

    const candidates = this.repository.search({
      worldKey: scope.worldKey,
      dimension: scope.dimension,
      ownerPrincipal: scope.actorPrincipal,
      includeArchived:
        input.includeArchived === true,
      limit: MAX_CANDIDATES
    })

    const normalizedLabel =
      normalizedReference.toLowerCase()
    const matches =
      candidates.filter(
        workspace =>
          workspace.label
            .trim()
            .toLowerCase() ===
          normalizedLabel
      )

    if (matches.length === 1) {
      return resolved(
        'explicit',
        matches[0]!
      )
    }

    if (matches.length > 1) {
      return ambiguous(
        'explicit',
        matches
      )
    }

    return {
      kind: 'none',
      reason: 'explicit_not_found'
    }
  }

  private activeOwnedById(
    scope: NormalizedScope,
    id: string | undefined,
    includeArchived = false
  ): WorkspaceRegion | null {
    return this.ownedById(
      scope,
      id,
      includeArchived
    )
  }

  private ownedById(
    scope: NormalizedScope,
    id: string | undefined,
    includeArchived: boolean
  ): WorkspaceRegion | null {
    if (id === undefined) return null
    const normalizedId =
      normalizeReference(id)
    if (normalizedId.length === 0) {
      return null
    }

    const workspace =
      this.repository.get(normalizedId)
    if (!workspace) return null

    if (
      (!includeArchived &&
        workspace.status !== 'active') ||
      workspace.worldKey !== scope.worldKey ||
      workspace.dimension.toLowerCase() !==
        scope.dimension ||
      workspace.ownerPrincipal !==
        scope.actorPrincipal
    ) {
      return null
    }

    return cloneWorkspace(workspace)
  }
}

interface NormalizedScope {
  readonly worldKey: string
  readonly dimension: string
  readonly actorPrincipal: string
}

function normalizeScope(
  input: ResolveWorkspaceInput
): NormalizedScope {
  const worldKey = input.worldKey.trim()
  const dimension =
    input.dimension.trim().toLowerCase()
  const actorPrincipal =
    input.actorPrincipal.trim()

  if (
    worldKey.length < 1 ||
    worldKey.length > 256
  ) {
    throw new TypeError(
      'worldKey must be non-empty and <= 256 characters'
    )
  }

  if (
    dimension.length < 1 ||
    dimension.length > 128
  ) {
    throw new TypeError(
      'dimension must be non-empty and <= 128 characters'
    )
  }

  if (
    actorPrincipal.length < 1 ||
    actorPrincipal.length > 128
  ) {
    throw new TypeError(
      'actorPrincipal must be non-empty and <= 128 characters'
    )
  }

  return {
    worldKey,
    dimension,
    actorPrincipal
  }
}

function resolveBySelection(
  candidates: readonly WorkspaceRegion[],
  scope: NormalizedScope,
  selection: WorkspaceSelection
): WorkspaceResolution | null {
  if (
    selection.worldKey !== scope.worldKey ||
    selection.dimension.toLowerCase() !==
      scope.dimension ||
    selection.playerId !== scope.actorPrincipal
  ) {
    return null
  }

  const exact =
    candidates.filter(
      workspace =>
        workspace.sourceSelectionId ===
        selection.id
    )

  if (exact.length === 1) {
    return resolved(
      'selection_source',
      exact[0]!
    )
  }

  if (exact.length > 1) {
    return ambiguous(
      'selection_source',
      exact
    )
  }

  const selectionBounds =
    normalizeWorkspaceBounds(
      selection.pointA,
      selection.pointB
    )

  const intersecting =
    candidates.filter(
      workspace =>
        workspacesIntersect(
          workspace.bounds,
          selectionBounds
        )
    )

  if (intersecting.length === 1) {
    return resolved(
      'selection_intersection',
      intersecting[0]!
    )
  }

  if (intersecting.length > 1) {
    return ambiguous(
      'selection_intersection',
      intersecting
    )
  }

  return null
}

function normalizeReference(
  value: string
): string {
  return value.trim()
}

function normalizeNearbyRadius(
  value: number | undefined
): number {
  const radius =
    value ?? DEFAULT_NEARBY_RADIUS

  if (
    !Number.isFinite(radius) ||
    !Number.isInteger(radius) ||
    radius < 0 ||
    radius > MAX_NEARBY_RADIUS
  ) {
    throw new RangeError(
      `nearbyRadius must be an integer between 0 and ${MAX_NEARBY_RADIUS}`
    )
  }

  return radius
}

function squaredDistancePointToBounds(
  point: WorkspacePoint,
  bounds: WorkspaceBounds
): number {
  const dx =
    axisDistance(
      point.x,
      bounds.min.x,
      bounds.max.x
    )
  const dy =
    axisDistance(
      point.y,
      bounds.min.y,
      bounds.max.y
    )
  const dz =
    axisDistance(
      point.z,
      bounds.min.z,
      bounds.max.z
    )

  return dx * dx + dy * dy + dz * dz
}

function axisDistance(
  value: number,
  min: number,
  max: number
): number {
  if (value < min) return min - value
  if (value > max) return value - max
  return 0
}

function resolved(
  reason: WorkspaceResolutionReason,
  workspace: WorkspaceRegion
): WorkspaceResolution {
  return {
    kind: 'resolved',
    reason,
    workspace: cloneWorkspace(workspace)
  }
}

function ambiguous(
  reason:
    | 'explicit'
    | 'selection_source'
    | 'selection_intersection'
    | 'nearby',
  candidates: readonly WorkspaceRegion[]
): WorkspaceResolution {
  return {
    kind: 'ambiguous',
    reason,
    candidates: candidates
      .map(cloneWorkspace)
      .sort((left, right) =>
        left.label.localeCompare(right.label) ||
        left.id.localeCompare(right.id)
      )
  }
}

function cloneWorkspace(
  workspace: WorkspaceRegion
): WorkspaceRegion {
  return structuredClone(workspace)
}
