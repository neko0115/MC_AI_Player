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

export interface ProviderCapabilities {
  readonly structuredFinal: boolean
  readonly reasoningSeparated: boolean
}

export const SAFE_GAMEPLAY_PROVIDER_CAPABILITIES: ProviderCapabilities = Object.freeze({
  structuredFinal: true,
  reasoningSeparated: true
})

export interface DecisionRequest<TContext = unknown> {
  readonly context: TContext
}

export interface DecisionProvider<TContext = unknown> {
  readonly capabilities: ProviderCapabilities
  decide(request: DecisionRequest<TContext>): Promise<ProviderResult>
}

export function assertGameplayProviderCapabilities(
  provider: Pick<DecisionProvider, 'capabilities'>
): void {
  if (provider.capabilities.structuredFinal !== true) {
    throw new Error('gameplay provider requires structured final output')
  }
  if (provider.capabilities.reasoningSeparated !== true) {
    throw new Error('gameplay provider requires reasoning separation')
  }
}
