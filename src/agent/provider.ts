import { z } from 'zod'

export const StructuredProviderModeSchema = z.enum(['schema', 'function_call'])
export type StructuredProviderMode = z.infer<typeof StructuredProviderModeSchema>

const ProviderNameSchema = z.string().trim().min(1).max(128)
const ProviderCodeSchema = z.string().trim().min(1).max(128)

export const ProviderResultSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('structured'),
      value: z.unknown(),
      provider: ProviderNameSchema,
      mode: StructuredProviderModeSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal('invalid'),
      code: ProviderCodeSchema,
      provider: ProviderNameSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal('timeout'),
      provider: ProviderNameSchema
    })
    .strict()
])

export type ProviderResult = z.infer<typeof ProviderResultSchema>

export interface DecisionRequest<TContext = unknown> {
  readonly context: TContext
}

export interface DecisionProvider<TContext = unknown> {
  decide(request: DecisionRequest<TContext>): Promise<ProviderResult>
}
