import {
  WorkspaceConstraintsSchema,
  WorkspacePurposeSchema,
  type WorkspaceConstraints,
  type WorkspacePurpose,
  type WorkspaceRegion,
  type WorkspaceRegionInput,
  type WorkspaceSelection
} from './contracts.js'
import {
  normalizeWorkspaceBounds
} from './geometry.js'
import type {
  WorkspaceRepository
} from './repository.js'

export type WorkspaceLifecycleErrorCode =
  | 'workspace_not_found'
  | 'workspace_not_owner'
  | 'workspace_archived'
  | 'workspace_already_archived'
  | 'workspace_already_active'
  | 'workspace_selection_owner_mismatch'
  | 'workspace_selection_scope_mismatch'

export class WorkspaceLifecycleError extends Error {
  constructor(
    readonly code: WorkspaceLifecycleErrorCode
  ) {
    super(code)
  }
}

export interface CreateWorkspaceFromSelectionInput {
  readonly selection: WorkspaceSelection
  readonly actorPrincipal: string
  readonly label: string
  readonly purpose: WorkspacePurpose
  readonly tags?: readonly string[]
  readonly constraints?: WorkspaceConstraints
}

export class WorkspaceLifecycleService {
  constructor(
    private readonly repository: WorkspaceRepository
  ) {}

  createFromSelection(
    input: CreateWorkspaceFromSelectionInput
  ): WorkspaceRegion {
    assertSelectionActor(
      input.selection,
      input.actorPrincipal
    )

    const purpose =
      WorkspacePurposeSchema.parse(input.purpose)
    const constraints =
      WorkspaceConstraintsSchema.parse(
        input.constraints ?? {}
      )

    return this.repository.create(
      {
        worldKey: input.selection.worldKey,
        dimension: input.selection.dimension,
        bounds: normalizeWorkspaceBounds(
          input.selection.pointA,
          input.selection.pointB
        ),
        label: input.label,
        purpose,
        tags: [...(input.tags ?? [])],
        constraints,
        ownerPrincipal: input.actorPrincipal,
        sourceSelectionId: input.selection.id
      },
      {
        actorPrincipal: input.actorPrincipal,
        action: 'created',
        safeSummary: 'Workspace created from trusted selection',
        sourceSelectionId: input.selection.id
      }
    )
  }

  rename(
    workspaceId: string,
    actorPrincipal: string,
    label: string
  ): WorkspaceRegion {
    const workspace =
      this.requireMutableOwned(
        workspaceId,
        actorPrincipal
      )

    return this.requireUpdated(
      this.repository.update(
        workspace.id,
        toInput(workspace, { label }),
        {
          actorPrincipal,
          action: 'renamed',
          safeSummary: 'Workspace renamed'
        }
      )
    )
  }

  replaceBoundsFromSelection(
    workspaceId: string,
    actorPrincipal: string,
    selection: WorkspaceSelection
  ): WorkspaceRegion {
    const workspace =
      this.requireMutableOwned(
        workspaceId,
        actorPrincipal
      )

    assertSelectionActor(
      selection,
      actorPrincipal
    )
    if (
      selection.worldKey !== workspace.worldKey ||
      selection.dimension.toLowerCase() !==
        workspace.dimension.toLowerCase()
    ) {
      throw new WorkspaceLifecycleError(
        'workspace_selection_scope_mismatch'
      )
    }

    return this.requireUpdated(
      this.repository.update(
        workspace.id,
        toInput(workspace, {
          bounds: normalizeWorkspaceBounds(
            selection.pointA,
            selection.pointB
          ),
          sourceSelectionId: selection.id
        }),
        {
          actorPrincipal,
          action: 'resized',
          safeSummary:
            'Workspace bounds replaced from trusted selection',
          sourceSelectionId: selection.id
        }
      )
    )
  }

  changePurpose(
    workspaceId: string,
    actorPrincipal: string,
    purpose: WorkspacePurpose
  ): WorkspaceRegion {
    const workspace =
      this.requireMutableOwned(
        workspaceId,
        actorPrincipal
      )

    return this.requireUpdated(
      this.repository.update(
        workspace.id,
        toInput(workspace, {
          purpose:
            WorkspacePurposeSchema.parse(purpose)
        }),
        {
          actorPrincipal,
          action: 'purpose_changed',
          safeSummary: 'Workspace purpose changed'
        }
      )
    )
  }

  replaceTags(
    workspaceId: string,
    actorPrincipal: string,
    tags: readonly string[]
  ): WorkspaceRegion {
    const workspace =
      this.requireMutableOwned(
        workspaceId,
        actorPrincipal
      )

    return this.requireUpdated(
      this.repository.update(
        workspace.id,
        toInput(workspace, {
          tags: [...tags]
        }),
        {
          actorPrincipal,
          action: 'tags_changed',
          safeSummary: 'Workspace tags replaced'
        }
      )
    )
  }

  changeConstraints(
    workspaceId: string,
    actorPrincipal: string,
    constraints: WorkspaceConstraints
  ): WorkspaceRegion {
    const workspace =
      this.requireMutableOwned(
        workspaceId,
        actorPrincipal
      )

    return this.requireUpdated(
      this.repository.update(
        workspace.id,
        toInput(workspace, {
          constraints:
            WorkspaceConstraintsSchema.parse(
              constraints
            )
        }),
        {
          actorPrincipal,
          action: 'constraints_changed',
          safeSummary:
            'Workspace constraints changed'
        }
      )
    )
  }

  archive(
    workspaceId: string,
    actorPrincipal: string
  ): WorkspaceRegion {
    const workspace =
      this.requireOwned(
        workspaceId,
        actorPrincipal
      )

    if (workspace.status === 'archived') {
      throw new WorkspaceLifecycleError(
        'workspace_already_archived'
      )
    }

    return this.requireUpdated(
      this.repository.setStatus(
        workspace.id,
        'archived',
        {
          actorPrincipal,
          action: 'archived',
          safeSummary: 'Workspace archived'
        }
      )
    )
  }

  restore(
    workspaceId: string,
    actorPrincipal: string
  ): WorkspaceRegion {
    const workspace =
      this.requireOwned(
        workspaceId,
        actorPrincipal
      )

    if (workspace.status === 'active') {
      throw new WorkspaceLifecycleError(
        'workspace_already_active'
      )
    }

    return this.requireUpdated(
      this.repository.setStatus(
        workspace.id,
        'active',
        {
          actorPrincipal,
          action: 'restored',
          safeSummary: 'Workspace restored'
        }
      )
    )
  }

  private requireMutableOwned(
    workspaceId: string,
    actorPrincipal: string
  ): WorkspaceRegion {
    const workspace =
      this.requireOwned(
        workspaceId,
        actorPrincipal
      )
    if (workspace.status !== 'active') {
      throw new WorkspaceLifecycleError(
        'workspace_archived'
      )
    }
    return workspace
  }

  private requireOwned(
    workspaceId: string,
    actorPrincipal: string
  ): WorkspaceRegion {
    const workspace =
      this.repository.get(workspaceId)
    if (!workspace) {
      throw new WorkspaceLifecycleError(
        'workspace_not_found'
      )
    }
    if (
      workspace.ownerPrincipal !==
      actorPrincipal
    ) {
      throw new WorkspaceLifecycleError(
        'workspace_not_owner'
      )
    }
    return workspace
  }

  private requireUpdated(
    workspace: WorkspaceRegion | null
  ): WorkspaceRegion {
    if (!workspace) {
      throw new WorkspaceLifecycleError(
        'workspace_not_found'
      )
    }
    return workspace
  }
}

function assertSelectionActor(
  selection: WorkspaceSelection,
  actorPrincipal: string
): void {
  if (
    selection.playerId !== actorPrincipal
  ) {
    throw new WorkspaceLifecycleError(
      'workspace_selection_owner_mismatch'
    )
  }
}

function toInput(
  workspace: WorkspaceRegion,
  overrides: Partial<WorkspaceRegionInput>
): WorkspaceRegionInput {
  return {
    worldKey:
      overrides.worldKey ??
      workspace.worldKey,
    dimension:
      overrides.dimension ??
      workspace.dimension,
    bounds:
      overrides.bounds
        ? {
            min: { ...overrides.bounds.min },
            max: { ...overrides.bounds.max }
          }
        : {
            min: { ...workspace.bounds.min },
            max: { ...workspace.bounds.max }
          },
    label:
      overrides.label ??
      workspace.label,
    purpose:
      overrides.purpose ??
      workspace.purpose,
    tags:
      overrides.tags
        ? [...overrides.tags]
        : [...workspace.tags],
    constraints:
      structuredClone(
        overrides.constraints ??
        workspace.constraints
      ),
    ownerPrincipal:
      overrides.ownerPrincipal ??
      workspace.ownerPrincipal,
    sourceSelectionId:
      overrides.sourceSelectionId === undefined
        ? workspace.sourceSelectionId
        : overrides.sourceSelectionId
  }
}
