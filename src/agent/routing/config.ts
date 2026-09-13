import { z } from 'zod'

const PositiveIntegerSchema = z.number().int().positive()
const ProjectKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'projectKey must be a lowercase anonymous identifier')
const ApiKeyEnvSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'apiKeyEnv must be an environment-variable name')
const ModelNameSchema = z.string().trim().min(1).max(256)
const PrivilegedUuidSchema = z
  .string()
  .trim()
  .transform(value => value.toLowerCase().replaceAll('-', ''))
  .pipe(z.string().regex(/^[0-9a-f]{32}$/, 'privileged UUID must be 32 hexadecimal characters'))

const ProviderLimitsSchema = z
  .object({
    rpm: PositiveIntegerSchema,
    inputTpm: PositiveIntegerSchema,
    rpd: PositiveIntegerSchema
  })
  .strict()

const RoutineModelSchema = z
  .object({
    name: ModelNameSchema,
    reservation: z
      .object({
        inputTokenOverhead: PositiveIntegerSchema,
        generationTokenAllowance: z
          .object({ low: PositiveIntegerSchema })
          .strict()
      })
      .strict()
  })
  .strict()

const ComplexModelSchema = z
  .object({
    name: ModelNameSchema,
    reservation: z
      .object({
        inputTokenOverhead: PositiveIntegerSchema,
        generationTokenAllowance: z
          .object({
            medium: PositiveIntegerSchema,
            high: PositiveIntegerSchema
          })
          .strict()
      })
      .strict()
  })
  .strict()

const RoutingProjectSchema = z
  .object({
    projectKey: ProjectKeySchema,
    apiKeyEnv: ApiKeyEnvSchema,
    providerLimits: z
      .object({
        routine: ProviderLimitsSchema,
        complex: ProviderLimitsSchema
      })
      .strict(),
    flashBudget: z
      .object({
        requestLimit: PositiveIntegerSchema,
        totalTokenLimit: PositiveIntegerSchema,
        resetWindow: z.literal('america-los-angeles-day'),
        source: z.literal('operator_policy')
      })
      .strict()
  })
  .strict()

const RoutingConfigSchema = z
  .object({
    version: z.literal(1),
    models: z
      .object({
        routine: RoutineModelSchema,
        complex: ComplexModelSchema
      })
      .strict(),
    projects: z.array(RoutingProjectSchema).min(1),
    manualAccess: z
      .object({
        ownerUuid: PrivilegedUuidSchema,
        operatorAllowlistUuids: z.array(PrivilegedUuidSchema).max(256)
      })
      .strict()
  })
  .strict()

export type ValidatedRoutingProject = z.infer<typeof RoutingProjectSchema>
export type ValidatedRoutingConfig = z.infer<typeof RoutingConfigSchema>

export function parseRoutingConfig(raw: unknown): ValidatedRoutingConfig {
  const parsed = RoutingConfigSchema.parse(raw)

  const projectKeys = parsed.projects.map(project => project.projectKey)
  if (new Set(projectKeys).size !== projectKeys.length) {
    throw new Error('routing config projectKey values must be unique')
  }

  const operatorUuids = parsed.manualAccess.operatorAllowlistUuids
  if (new Set(operatorUuids).size !== operatorUuids.length) {
    throw new Error('routing config operator UUID values must be unique')
  }

  for (const project of parsed.projects) {
    if (project.flashBudget.requestLimit > project.providerLimits.complex.rpd) {
      throw new Error(`flash requestLimit exceeds complex rpd for ${project.projectKey}`)
    }
  }

  return parsed
}
