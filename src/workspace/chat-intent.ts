import { z } from 'zod'

export const WORKSPACE_CHAT_INTENT_CONTRACT_VERSION = 1
import {
  WorkspaceConstraintsSchema,
  WorkspacePurposeSchema,
  WorkspaceUsePolicySchema,
  type WorkspacePurpose,
  type WorkspaceUsePolicy
} from './contracts.js'

const WorkspaceIntentLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)

const WorkspaceIntentTagSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)

export const WorkspaceReferenceSchema =
  z.discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('explicit'),
        value: z
          .string()
          .trim()
          .min(1)
          .max(128)
      })
      .strict(),
    z
      .object({
        kind: z.literal('current_selection')
      })
      .strict(),
    z
      .object({
        kind: z.literal('conversation')
      })
      .strict(),
    z
      .object({
        kind: z.literal('nearby')
      })
      .strict(),
    z
      .object({
        kind: z.literal('recent')
      })
      .strict()
  ])

export type WorkspaceReference =
  z.infer<typeof WorkspaceReferenceSchema>

const WorkspaceCreateIntentSchema = z
  .object({
    kind: z.literal('create'),
    label: WorkspaceIntentLabelSchema,
    purpose: WorkspacePurposeSchema,
    moxueUsePolicy:
      WorkspaceUsePolicySchema,
    tags: z
      .array(WorkspaceIntentTagSchema)
      .max(32)
      .optional(),
    constraints:
      WorkspaceConstraintsSchema.optional()
  })
  .strict()

const WorkspaceRenameIntentSchema = z
  .object({
    kind: z.literal('rename'),
    target: WorkspaceReferenceSchema,
    label: WorkspaceIntentLabelSchema
  })
  .strict()

const WorkspaceResizeIntentSchema = z
  .object({
    kind: z.literal('resize'),
    target: WorkspaceReferenceSchema
  })
  .strict()

const WorkspacePurposeIntentSchema = z
  .object({
    kind: z.literal('change_purpose'),
    target: WorkspaceReferenceSchema,
    purpose: WorkspacePurposeSchema
  })
  .strict()

const WorkspaceUsePolicyIntentSchema = z
  .object({
    kind: z.literal(
      'change_use_policy'
    ),
    target: WorkspaceReferenceSchema,
    moxueUsePolicy:
      WorkspaceUsePolicySchema
  })
  .strict()

const WorkspaceTagsIntentSchema = z
  .object({
    kind: z.literal('replace_tags'),
    target: WorkspaceReferenceSchema,
    tags: z
      .array(WorkspaceIntentTagSchema)
      .max(32)
  })
  .strict()

const WorkspaceConstraintsIntentSchema = z
  .object({
    kind: z.literal(
      'change_constraints'
    ),
    target: WorkspaceReferenceSchema,
    constraints:
      WorkspaceConstraintsSchema
  })
  .strict()

const WorkspaceArchiveIntentSchema = z
  .object({
    kind: z.literal('archive'),
    target: WorkspaceReferenceSchema
  })
  .strict()

const WorkspaceRestoreIntentSchema = z
  .object({
    kind: z.literal('restore'),
    target: WorkspaceReferenceSchema
  })
  .strict()

const WorkspaceListIntentSchema = z
  .object({
    kind: z.literal('list'),
    includeArchived:
      z.boolean().optional()
  })
  .strict()

const WorkspaceShowIntentSchema = z
  .object({
    kind: z.literal('show'),
    target: WorkspaceReferenceSchema
  })
  .strict()

const WorkspaceNotWorkspaceIntentSchema = z
  .object({
    kind: z.literal('not_workspace')
  })
  .strict()

const WorkspaceClarifyIntentSchema = z
  .object({
    kind: z.literal('clarify'),
    reason: z.enum([
      'ambiguous_intent',
      'ambiguous_reference',
      'missing_reference',
      'missing_selection',
      'missing_semantics'
    ])
  })
  .strict()

export const WorkspaceChatIntentSchema =
  z.discriminatedUnion('kind', [
    WorkspaceCreateIntentSchema,
    WorkspaceRenameIntentSchema,
    WorkspaceResizeIntentSchema,
    WorkspacePurposeIntentSchema,
    WorkspaceUsePolicyIntentSchema,
    WorkspaceTagsIntentSchema,
    WorkspaceConstraintsIntentSchema,
    WorkspaceArchiveIntentSchema,
    WorkspaceRestoreIntentSchema,
    WorkspaceListIntentSchema,
    WorkspaceShowIntentSchema,
    WorkspaceNotWorkspaceIntentSchema,
    WorkspaceClarifyIntentSchema
  ])

export type WorkspaceChatIntent =
  z.infer<typeof WorkspaceChatIntentSchema>

export interface WorkspaceSemanticWorkspaceSummary {
  readonly id: string
  readonly label: string
  readonly purpose: WorkspacePurpose
  readonly moxueUsePolicy: WorkspaceUsePolicy
  readonly status: 'active' | 'archived'
  readonly dimension: string
}

export interface WorkspaceSemanticSelectionSummary {
  readonly available: boolean
  readonly id: string | null
  readonly dimension: string | null
}

export interface WorkspaceSemanticContext {
  readonly utterance: string
  readonly actorPrincipal: string
  readonly dimension: string | null
  readonly selection:
    WorkspaceSemanticSelectionSummary
  readonly conversationWorkspaceId:
    string | null
  readonly recentWorkspaceId:
    string | null
  readonly workspaces:
    readonly WorkspaceSemanticWorkspaceSummary[]
}

export interface WorkspaceIntentInterpreter {
  interpret(
    context: WorkspaceSemanticContext,
    signal: AbortSignal
  ): Promise<WorkspaceChatIntent>

  learnSuccessful?(
    context: WorkspaceSemanticContext,
    intent: WorkspaceChatIntent
  ): Promise<void> | void

  revoke?(
    context: WorkspaceSemanticContext
  ): Promise<number> | number
}

export function normalizeWorkspaceSemanticContext(
  input: WorkspaceSemanticContext
): WorkspaceSemanticContext {
  const utterance = input.utterance.trim()
  const actorPrincipal =
    input.actorPrincipal.trim()

  if (
    utterance.length < 1 ||
    utterance.length > 1000
  ) {
    throw new TypeError(
      'workspace utterance must be 1..1000 characters'
    )
  }
  if (
    actorPrincipal.length < 1 ||
    actorPrincipal.length > 128
  ) {
    throw new TypeError(
      'workspace actor principal must be 1..128 characters'
    )
  }

  const dimension =
    normalizeOptionalText(
      input.dimension,
      128
    )
  const conversationWorkspaceId =
    normalizeOptionalText(
      input.conversationWorkspaceId,
      128
    )
  const recentWorkspaceId =
    normalizeOptionalText(
      input.recentWorkspaceId,
      128
    )

  const selection = {
    available:
      input.selection.available === true,
    id:
      input.selection.available
        ? normalizeOptionalText(
            input.selection.id,
            128
          )
        : null,
    dimension:
      input.selection.available
        ? normalizeOptionalText(
            input.selection.dimension,
            128
          )
        : null
  }

  const workspaces =
    input.workspaces
      .slice(0, 32)
      .map(workspace => ({
        id: boundedRequiredText(
          workspace.id,
          128,
          'workspace id'
        ),
        label: boundedRequiredText(
          workspace.label,
          128,
          'workspace label'
        ),
        purpose:
          WorkspacePurposeSchema.parse(
            workspace.purpose
          ),
        moxueUsePolicy:
          WorkspaceUsePolicySchema.parse(
            workspace.moxueUsePolicy
          ),
        status: workspace.status,
        dimension:
          boundedRequiredText(
            workspace.dimension,
            128,
            'workspace dimension'
          )
      }))

  return {
    utterance,
    actorPrincipal,
    dimension,
    selection,
    conversationWorkspaceId,
    recentWorkspaceId,
    workspaces
  }
}

function normalizeOptionalText(
  value: string | null,
  max: number
): string | null {
  if (value === null) return null
  const normalized = value.trim()
  if (
    normalized.length < 1 ||
    normalized.length > max
  ) {
    return null
  }
  return normalized
}

function boundedRequiredText(
  value: string,
  max: number,
  field: string
): string {
  const normalized = value.trim()
  if (
    normalized.length < 1 ||
    normalized.length > max
  ) {
    throw new TypeError(
      `${field} must be 1..${max} characters`
    )
  }
  return normalized
}
