import { z } from 'zod'

export const WORKSPACE_MAX_HORIZONTAL_SPAN = 8192
export const WORKSPACE_MAX_VERTICAL_SPAN = 1024

const WorkspaceIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9_.:-]+$/)

const WorkspaceLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)

const WorkspaceTagSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)

const WorkspaceCoordinateSchema = z
  .number()
  .int()
  .min(-30_000_000)
  .max(30_000_000)

export const WorkspacePointSchema = z
  .object({
    x: WorkspaceCoordinateSchema,
    y: WorkspaceCoordinateSchema,
    z: WorkspaceCoordinateSchema
  })
  .strict()

export type WorkspacePoint = z.infer<typeof WorkspacePointSchema>

export const WorkspaceBoundsSchema = z
  .object({
    min: WorkspacePointSchema,
    max: WorkspacePointSchema
  })
  .strict()
  .superRefine((bounds, context) => {
    if (
      bounds.min.x > bounds.max.x ||
      bounds.min.y > bounds.max.y ||
      bounds.min.z > bounds.max.z
    ) {
      context.addIssue({
        code: 'custom',
        message: 'workspace bounds min must be <= max on every axis'
      })
      return
    }

    const sizeX = bounds.max.x - bounds.min.x + 1
    const sizeY = bounds.max.y - bounds.min.y + 1
    const sizeZ = bounds.max.z - bounds.min.z + 1

    if (
      sizeX > WORKSPACE_MAX_HORIZONTAL_SPAN ||
      sizeZ > WORKSPACE_MAX_HORIZONTAL_SPAN
    ) {
      context.addIssue({
        code: 'custom',
        message:
          `workspace horizontal span must be <= ${WORKSPACE_MAX_HORIZONTAL_SPAN}`
      })
    }

    if (sizeY > WORKSPACE_MAX_VERTICAL_SPAN) {
      context.addIssue({
        code: 'custom',
        message:
          `workspace vertical span must be <= ${WORKSPACE_MAX_VERTICAL_SPAN}`
      })
    }
  })

export type WorkspaceBounds = z.infer<typeof WorkspaceBoundsSchema>

export const WorkspacePurposeSchema = z.enum([
  'production',
  'farm',
  'storage',
  'construction',
  'lighting',
  'protected',
  'transit',
  'custom'
])

export type WorkspacePurpose = z.infer<typeof WorkspacePurposeSchema>

export const WorkspaceConstraintsSchema = z
  .object({
    preserveExistingStructures: z.boolean().optional(),
    temporaryInfrastructureAllowed: z.boolean().optional(),
    protected: z.boolean().optional(),
    requestedSpacing: z.number().int().min(1).max(64).optional(),
    lighting: z
      .object({
        blockLightMin: z.number().int().min(0).max(15),
        spawnSafeRequired: z.boolean()
      })
      .strict()
      .optional()
  })
  .strict()

export type WorkspaceConstraints =
  z.infer<typeof WorkspaceConstraintsSchema>

export const WorkspaceSelectionSchema = z
  .object({
    id: WorkspaceIdentifierSchema,
    generation: z.number().int().nonnegative(),
    worldKey: z.string().trim().min(1).max(256),
    dimension: z.string().trim().min(1).max(128),
    playerId: z.string().trim().min(1).max(128),
    playerName: z.string().trim().min(1).max(64),
    pointA: WorkspacePointSchema,
    pointB: WorkspacePointSchema,
    selectedAt: z.number().int().nonnegative()
  })
  .strict()

export type WorkspaceSelection =
  z.infer<typeof WorkspaceSelectionSchema>

export const WorkspaceRegionSchema = z
  .object({
    id: WorkspaceIdentifierSchema,
    worldKey: z.string().trim().min(1).max(256),
    dimension: z.string().trim().min(1).max(128),
    bounds: WorkspaceBoundsSchema,
    label: WorkspaceLabelSchema,
    purpose: WorkspacePurposeSchema,
    tags: z.array(WorkspaceTagSchema).max(32),
    constraints: WorkspaceConstraintsSchema,
    ownerPrincipal: z.string().trim().min(1).max(128),
    sourceSelectionId: WorkspaceIdentifierSchema.nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative()
  })
  .strict()

export type WorkspaceRegion =
  z.infer<typeof WorkspaceRegionSchema>


export const WorkspaceRegionInputSchema = WorkspaceRegionSchema
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true
  })
  .strict()

export type WorkspaceRegionInput =
  z.input<typeof WorkspaceRegionInputSchema>

export const WorkspaceSearchQuerySchema = z
  .object({
    worldKey: z.string().trim().min(1).max(256),
    dimension: z.string().trim().min(1).max(128).optional(),
    purposes: z.array(WorkspacePurposeSchema).min(1).max(8).optional(),
    tags: z.array(WorkspaceTagSchema).min(1).max(32).optional(),
    ownerPrincipal: z.string().trim().min(1).max(128).optional(),
    intersects: WorkspaceBoundsSchema.optional(),
    limit: z.number().int().min(1).max(100).optional()
  })
  .strict()

export type WorkspaceSearchQuery =
  z.input<typeof WorkspaceSearchQuerySchema>
