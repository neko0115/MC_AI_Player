import type {
  WorkspaceConstraints,
  WorkspacePurpose,
  WorkspaceRegion
} from './contracts.js'
import {
  WorkspaceLifecycleError,
  WorkspaceLifecycleService
} from './lifecycle-service.js'
import type {
  WorkspaceRepository
} from './repository.js'
import type {
  WorkspaceSelectionSource
} from './selection-source.js'

export type WorkspaceManagementErrorCode =
  | 'workspace_selection_unavailable'
  | 'workspace_selection_stale'
  | 'workspace_selection_missing'
  | 'workspace_not_found'
  | 'workspace_not_owner'
  | 'workspace_archived'
  | 'workspace_already_archived'
  | 'workspace_already_active'
  | 'workspace_selection_owner_mismatch'
  | 'workspace_selection_scope_mismatch'

export class WorkspaceManagementError extends Error {
  constructor(
    readonly code: WorkspaceManagementErrorCode
  ) {
    super(code)
  }
}

export interface WorkspaceManagementOptions {
  readonly worldKey: string
  readonly repository: WorkspaceRepository
  readonly selections?: WorkspaceSelectionSource
}

export interface CreateWorkspaceRequest {
  readonly dimension: string
  readonly actorPrincipal: string
  readonly label: string
  readonly purpose: WorkspacePurpose
  readonly tags?: readonly string[]
  readonly constraints?: WorkspaceConstraints
}

export interface ListWorkspaceRequest {
  readonly dimension?: string
  readonly actorPrincipal: string
  readonly includeArchived?: boolean
}

export class WorkspaceManagementService {
  private readonly worldKey: string
  private readonly lifecycle: WorkspaceLifecycleService

  constructor(
    private readonly options: WorkspaceManagementOptions
  ) {
    const worldKey = options.worldKey.trim()
    if (
      worldKey.length < 1 ||
      worldKey.length > 256
    ) {
      throw new TypeError(
        'worldKey must be non-empty and <= 256 characters'
      )
    }
    this.worldKey = worldKey
    this.lifecycle =
      new WorkspaceLifecycleService(
        options.repository
      )
  }

  create(
    request: CreateWorkspaceRequest
  ): WorkspaceRegion {
    const actor =
      normalizePrincipal(
        request.actorPrincipal
      )
    const dimension =
      normalizeDimension(
        request.dimension
      )
    const selection =
      this.requireCurrentSelection(
        actor,
        dimension
      )

    return this.lifecycle.createFromSelection({
      selection,
      actorPrincipal: actor,
      label: request.label,
      purpose: request.purpose,
      ...(request.tags === undefined
        ? {}
        : { tags: [...request.tags] }),
      ...(request.constraints === undefined
        ? {}
        : {
            constraints:
              structuredClone(
                request.constraints
              )
          })
    })
  }

  list(
    request: ListWorkspaceRequest
  ): WorkspaceRegion[] {
    const actor =
      normalizePrincipal(
        request.actorPrincipal
      )
    const dimension =
      request.dimension === undefined
        ? undefined
        : normalizeDimension(
            request.dimension
          )

    return this.options.repository.search({
      worldKey: this.worldKey,
      ...(dimension === undefined
        ? {}
        : { dimension }),
      ownerPrincipal: actor,
      includeArchived:
        request.includeArchived === true,
      limit: 100
    })
  }

  get(
    workspaceId: string,
    actorPrincipal: string
  ): WorkspaceRegion {
    return this.requireOwned(
      workspaceId,
      actorPrincipal
    )
  }

  rename(
    workspaceId: string,
    actorPrincipal: string,
    label: string
  ): WorkspaceRegion {
    return this.mapLifecycle(() =>
      this.lifecycle.rename(
        workspaceId,
        normalizePrincipal(
          actorPrincipal
        ),
        label
      )
    )
  }

  resizeFromCurrentSelection(
    workspaceId: string,
    actorPrincipal: string
  ): WorkspaceRegion {
    const workspace =
      this.requireOwned(
        workspaceId,
        actorPrincipal
      )
    if (workspace.status !== 'active') {
      throw new WorkspaceManagementError(
        'workspace_archived'
      )
    }

    const selection =
      this.requireCurrentSelection(
        workspace.ownerPrincipal,
        workspace.dimension
      )

    return this.mapLifecycle(() =>
      this.lifecycle.replaceBoundsFromSelection(
        workspace.id,
        workspace.ownerPrincipal,
        selection
      )
    )
  }

  changePurpose(
    workspaceId: string,
    actorPrincipal: string,
    purpose: WorkspacePurpose
  ): WorkspaceRegion {
    return this.mapLifecycle(() =>
      this.lifecycle.changePurpose(
        workspaceId,
        normalizePrincipal(
          actorPrincipal
        ),
        purpose
      )
    )
  }

  replaceTags(
    workspaceId: string,
    actorPrincipal: string,
    tags: readonly string[]
  ): WorkspaceRegion {
    return this.mapLifecycle(() =>
      this.lifecycle.replaceTags(
        workspaceId,
        normalizePrincipal(
          actorPrincipal
        ),
        tags
      )
    )
  }

  changeConstraints(
    workspaceId: string,
    actorPrincipal: string,
    constraints: WorkspaceConstraints
  ): WorkspaceRegion {
    return this.mapLifecycle(() =>
      this.lifecycle.changeConstraints(
        workspaceId,
        normalizePrincipal(
          actorPrincipal
        ),
        constraints
      )
    )
  }

  archive(
    workspaceId: string,
    actorPrincipal: string
  ): WorkspaceRegion {
    return this.mapLifecycle(() =>
      this.lifecycle.archive(
        workspaceId,
        normalizePrincipal(
          actorPrincipal
        )
      )
    )
  }

  restore(
    workspaceId: string,
    actorPrincipal: string
  ): WorkspaceRegion {
    return this.mapLifecycle(() =>
      this.lifecycle.restore(
        workspaceId,
        normalizePrincipal(
          actorPrincipal
        )
      )
    )
  }

  audit(
    workspaceId: string,
    actorPrincipal: string,
    limit = 50
  ) {
    const workspace =
      this.requireOwned(
        workspaceId,
        actorPrincipal
      )
    return this.options.repository.listAudit(
      workspace.id,
      limit
    )
  }

  private requireOwned(
    workspaceId: string,
    actorPrincipal: string
  ): WorkspaceRegion {
    const actor =
      normalizePrincipal(
        actorPrincipal
      )
    const workspace =
      this.options.repository.get(
        workspaceId
      )

    if (
      !workspace ||
      workspace.worldKey !== this.worldKey
    ) {
      throw new WorkspaceManagementError(
        'workspace_not_found'
      )
    }

    if (
      workspace.ownerPrincipal !== actor
    ) {
      throw new WorkspaceManagementError(
        'workspace_not_owner'
      )
    }

    return structuredClone(workspace)
  }

  private requireCurrentSelection(
    actorPrincipal: string,
    dimension: string
  ) {
    const source =
      this.options.selections
    if (!source) {
      throw new WorkspaceManagementError(
        'workspace_selection_unavailable'
      )
    }

    const status = source.status()
    if (status.state === 'unavailable') {
      throw new WorkspaceManagementError(
        'workspace_selection_unavailable'
      )
    }
    if (status.state === 'stale') {
      throw new WorkspaceManagementError(
        'workspace_selection_stale'
      )
    }

    const selection = source.latest({
      worldKey: this.worldKey,
      dimension,
      playerId: actorPrincipal
    })

    if (!selection) {
      throw new WorkspaceManagementError(
        'workspace_selection_missing'
      )
    }

    return selection
  }

  private mapLifecycle(
    operation: () => WorkspaceRegion
  ): WorkspaceRegion {
    try {
      return operation()
    } catch (error) {
      if (
        error instanceof WorkspaceLifecycleError
      ) {
        throw new WorkspaceManagementError(
          error.code
        )
      }
      throw error
    }
  }
}

function normalizePrincipal(
  value: string
): string {
  const normalized = value.trim()
  if (
    normalized.length < 1 ||
    normalized.length > 128
  ) {
    throw new TypeError(
      'actorPrincipal must be non-empty and <= 128 characters'
    )
  }
  return normalized
}

function normalizeDimension(
  value: string
): string {
  const normalized =
    value.trim().toLowerCase()
  if (
    normalized.length < 1 ||
    normalized.length > 128
  ) {
    throw new TypeError(
      'dimension must be non-empty and <= 128 characters'
    )
  }
  return normalized
}
