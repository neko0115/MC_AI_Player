import type {
  WorkspacePoint,
  WorkspaceRegion,
  WorkspaceSelection
} from './contracts.js'
import {
  normalizeWorkspaceSemanticContext,
  type WorkspaceChatIntent,
  type WorkspaceIntentInterpreter,
  type WorkspaceReference
} from './chat-intent.js'
import {
  WorkspaceManagementError,
  type WorkspaceManagementService
} from './management-service.js'
import type {
  WorkspaceRepository
} from './repository.js'
import {
  WorkspaceResolver,
  type WorkspaceResolution
} from './resolver.js'
import type {
  WorkspaceSelectionSource
} from './selection-source.js'

export interface WorkspaceChatRouteInput {
  readonly utterance: string
  readonly actorPrincipal: string
  readonly dimension: string | null
  readonly playerPosition?: WorkspacePoint | null
}

export type WorkspaceChatRouteResult =
  | {
      readonly kind: 'fallback'
    }
  | {
      readonly kind: 'handled'
      readonly operation:
        Exclude<
          WorkspaceChatIntent['kind'],
          'not_workspace' | 'clarify'
        >
      readonly workspace?: WorkspaceRegion
      readonly workspaces?: readonly WorkspaceRegion[]
    }
  | {
      readonly kind: 'clarify'
      readonly reason:
        | 'ambiguous_intent'
        | 'ambiguous_reference'
        | 'missing_reference'
        | 'missing_selection'
        | 'missing_semantics'
      readonly candidates?: readonly WorkspaceRegion[]
    }
  | {
      readonly kind: 'rejected'
      readonly code: string
    }

export interface WorkspaceChatInstructionRouter {
  route(
    input: WorkspaceChatRouteInput,
    signal: AbortSignal
  ): Promise<WorkspaceChatRouteResult>
}

export interface WorkspaceChatRouterOptions {
  readonly worldKey: string
  readonly interpreter: WorkspaceIntentInterpreter
  readonly management: WorkspaceManagementService
  readonly repository: WorkspaceRepository
  readonly selections?: WorkspaceSelectionSource
}

export class WorkspaceChatRouter
implements WorkspaceChatInstructionRouter {
  private readonly worldKey: string
  private readonly resolver: WorkspaceResolver
  private readonly conversation =
    new Map<string, string>()
  private readonly recent =
    new Map<string, string>()

  constructor(
    private readonly options: WorkspaceChatRouterOptions
  ) {
    const worldKey =
      options.worldKey.trim()
    if (
      worldKey.length < 1 ||
      worldKey.length > 256
    ) {
      throw new TypeError(
        'worldKey must be non-empty and <= 256 characters'
      )
    }
    this.worldKey = worldKey
    this.resolver =
      new WorkspaceResolver(
        options.repository
      )
  }

  async route(
    input: WorkspaceChatRouteInput,
    signal: AbortSignal
  ): Promise<WorkspaceChatRouteResult> {
    if (signal.aborted) {
      return {
        kind: 'rejected',
        code: 'workspace_chat_cancelled'
      }
    }

    const actor =
      normalizeActor(
        input.actorPrincipal
      )
    const dimension =
      normalizeDimension(
        input.dimension
      )
    const selection =
      this.currentSelection(
        actor,
        dimension
      )
    const workspaces =
      this.options.management
        .list({
          actorPrincipal: actor,
          ...(dimension === null
            ? {}
            : { dimension }),
          includeArchived: true
        })
        .slice(0, 32)

    const semanticContext =
      normalizeWorkspaceSemanticContext({
        utterance: input.utterance,
        actorPrincipal: actor,
        dimension,
        selection: {
          available:
            selection !== null,
          id:
            selection?.id ?? null,
          dimension:
            selection?.dimension ?? null
        },
        conversationWorkspaceId:
          this.conversation.get(actor) ??
          null,
        recentWorkspaceId:
          this.recent.get(actor) ??
          null,
        workspaces:
          workspaces.map(workspace => ({
            id: workspace.id,
            label: workspace.label,
            purpose: workspace.purpose,
            moxueUsePolicy:
              workspace.moxueUsePolicy,
            status: workspace.status,
            dimension:
              workspace.dimension
          }))
      })

    const intent =
      await this.options.interpreter
        .interpret(
          semanticContext,
          signal
        )

    if (signal.aborted) {
      return {
        kind: 'rejected',
        code: 'workspace_chat_cancelled'
      }
    }

    if (intent.kind === 'not_workspace') {
      return { kind: 'fallback' }
    }

    if (intent.kind === 'clarify') {
      return {
        kind: 'clarify',
        reason: intent.reason
      }
    }

    try {
      const result =
        this.executeIntent(
          intent,
          {
            actor,
            dimension,
            selection,
            playerPosition:
              input.playerPosition ??
              null
          }
        )

      if (
        result.kind === 'handled' &&
        this.options.interpreter
          .learnSuccessful
      ) {
        try {
          await this.options.interpreter
            .learnSuccessful(
              semanticContext,
              intent
            )
        } catch {
          // Learning is advisory. A cache write failure
          // must never turn a successful Workspace
          // operation into a user-visible failure.
        }
      }

      return result
    } catch (error) {
      if (
        error instanceof
          WorkspaceManagementError
      ) {
        return mapManagementFailure(
          error.code
        )
      }
      throw error
    }
  }

  private executeIntent(
    intent: Exclude<
      WorkspaceChatIntent,
      { kind: 'not_workspace' } |
      { kind: 'clarify' }
    >,
    context: {
      readonly actor: string
      readonly dimension: string | null
      readonly selection: WorkspaceSelection | null
      readonly playerPosition: WorkspacePoint | null
    }
  ): WorkspaceChatRouteResult {
    if (intent.kind === 'create') {
      if (context.dimension === null) {
        return {
          kind: 'clarify',
          reason: 'missing_selection'
        }
      }

      const workspace =
        this.options.management.create({
          dimension:
            context.dimension,
          actorPrincipal:
            context.actor,
          label: intent.label,
          purpose: intent.purpose,
          moxueUsePolicy:
            intent.moxueUsePolicy,
          ...(intent.tags === undefined
            ? {}
            : { tags: intent.tags }),
          ...(intent.constraints === undefined
            ? {}
            : {
                constraints:
                  intent.constraints
              })
        })
      this.bind(
        context.actor,
        workspace.id
      )
      return {
        kind: 'handled',
        operation: intent.kind,
        workspace
      }
    }

    if (intent.kind === 'list') {
      const workspaces =
        this.options.management.list({
          actorPrincipal:
            context.actor,
          ...(context.dimension === null
            ? {}
            : {
                dimension:
                  context.dimension
              }),
          includeArchived:
            intent.includeArchived === true
        })
      return {
        kind: 'handled',
        operation: intent.kind,
        workspaces
      }
    }

    if (context.dimension === null) {
      return {
        kind: 'clarify',
        reason: 'missing_reference'
      }
    }

    const resolution =
      this.resolveTarget(
        intent.target,
        {
          actor: context.actor,
          dimension:
            context.dimension,
          selection:
            context.selection,
          playerPosition:
            context.playerPosition,
          includeArchived:
            intent.kind === 'restore'
        }
      )

    if (resolution.kind === 'ambiguous') {
      return {
        kind: 'clarify',
        reason: 'ambiguous_reference',
        candidates:
          resolution.candidates
      }
    }

    if (resolution.kind === 'none') {
      return {
        kind: 'clarify',
        reason:
          intent.target.kind ===
            'current_selection'
            ? 'missing_selection'
            : 'missing_reference'
      }
    }

    const workspace =
      resolution.workspace
    let updated: WorkspaceRegion

    switch (intent.kind) {
      case 'show':
        updated =
          this.options.management.get(
            workspace.id,
            context.actor
          )
        break

      case 'rename':
        updated =
          this.options.management.rename(
            workspace.id,
            context.actor,
            intent.label
          )
        break

      case 'resize':
        updated =
          this.options.management
            .resizeFromCurrentSelection(
              workspace.id,
              context.actor
            )
        break

      case 'change_purpose':
        updated =
          this.options.management
            .changePurpose(
              workspace.id,
              context.actor,
              intent.purpose
            )
        break

      case 'change_use_policy':
        updated =
          this.options.management
            .changeUsePolicy(
              workspace.id,
              context.actor,
              intent.moxueUsePolicy
            )
        break

      case 'replace_tags':
        updated =
          this.options.management
            .replaceTags(
              workspace.id,
              context.actor,
              intent.tags
            )
        break

      case 'change_constraints':
        updated =
          this.options.management
            .changeConstraints(
              workspace.id,
              context.actor,
              intent.constraints
            )
        break

      case 'archive':
        updated =
          this.options.management.archive(
            workspace.id,
            context.actor
          )
        this.conversation.delete(
          context.actor
        )
        this.recent.set(
          context.actor,
          updated.id
        )
        return {
          kind: 'handled',
          operation: intent.kind,
          workspace: updated
        }

      case 'restore':
        updated =
          this.options.management.restore(
            workspace.id,
            context.actor
          )
        break

      default:
        return assertNever(intent)
    }

    this.bind(
      context.actor,
      updated.id
    )
    return {
      kind: 'handled',
      operation: intent.kind,
      workspace: updated
    }
  }

  private resolveTarget(
    reference: WorkspaceReference,
    context: {
      readonly actor: string
      readonly dimension: string
      readonly selection: WorkspaceSelection | null
      readonly playerPosition: WorkspacePoint | null
      readonly includeArchived: boolean
    }
  ): WorkspaceResolution {
    const base = {
      worldKey: this.worldKey,
      dimension: context.dimension,
      actorPrincipal: context.actor,
      includeArchived:
        context.includeArchived
    }

    switch (reference.kind) {
      case 'explicit':
        return this.resolver.resolve({
          ...base,
          explicitReference:
            reference.value
        })

      case 'current_selection':
        if (!context.selection) {
          return {
            kind: 'none',
            reason: 'no_match'
          }
        }
        return this.resolver.resolve({
          ...base,
          selection:
            context.selection
        })

      case 'conversation': {
        const workspaceId =
          this.conversation.get(
            context.actor
          )
        if (workspaceId === undefined) {
          return {
            kind: 'none',
            reason: 'no_match'
          }
        }
        return this.resolver.resolve({
          ...base,
          conversationWorkspaceId:
            workspaceId
        })
      }

      case 'nearby':
        if (!context.playerPosition) {
          return {
            kind: 'none',
            reason: 'no_match'
          }
        }
        return this.resolver.resolve({
          ...base,
          playerPosition:
            context.playerPosition
        })

      case 'recent': {
        const workspaceId =
          this.recent.get(
            context.actor
          )
        if (workspaceId === undefined) {
          return {
            kind: 'none',
            reason: 'no_match'
          }
        }
        return this.resolver.resolve({
          ...base,
          recentWorkspaceId:
            workspaceId
        })
      }

      default:
        return assertNever(reference)
    }
  }

  private currentSelection(
    actor: string,
    dimension: string | null
  ): WorkspaceSelection | null {
    if (
      !this.options.selections ||
      dimension === null
    ) {
      return null
    }

    if (
      this.options.selections
        .status().state !== 'current'
    ) {
      return null
    }

    return this.options.selections.latest({
      worldKey: this.worldKey,
      dimension,
      playerId: actor
    })
  }

  private bind(
    actor: string,
    workspaceId: string
  ): void {
    this.conversation.set(
      actor,
      workspaceId
    )
    this.recent.set(
      actor,
      workspaceId
    )
  }
}

function mapManagementFailure(
  code: WorkspaceManagementError['code']
): WorkspaceChatRouteResult {
  switch (code) {
    case 'workspace_selection_unavailable':
    case 'workspace_selection_stale':
    case 'workspace_selection_missing':
      return {
        kind: 'clarify',
        reason: 'missing_selection'
      }

    case 'workspace_not_found':
      return {
        kind: 'clarify',
        reason: 'missing_reference'
      }

    default:
      return {
        kind: 'rejected',
        code
      }
  }
}

function normalizeActor(
  value: string
): string {
  const normalized = value.trim()
  if (
    normalized.length < 1 ||
    normalized.length > 128
  ) {
    throw new TypeError(
      'actorPrincipal must be 1..128 characters'
    )
  }
  return normalized
}

function normalizeDimension(
  value: string | null
): string | null {
  if (value === null) return null
  const normalized =
    value.trim().toLowerCase()
  if (
    normalized.length < 1 ||
    normalized.length > 128
  ) {
    return null
  }
  return normalized
}

function assertNever(
  value: never
): never {
  throw new Error(
    'unreachable workspace chat intent: ' +
    JSON.stringify(value)
  )
}
