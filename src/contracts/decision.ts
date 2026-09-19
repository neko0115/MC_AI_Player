import { z } from 'zod'
import {
  decisionSkillContracts,
  type DecisionActionFromCatalog,
  type DecisionV1FromCatalog
} from './skill-catalog.js'

const decisionContracts = decisionSkillContracts()

const DecisionActionSchema: z.ZodType<DecisionActionFromCatalog> =
  schemaUnion<DecisionActionFromCatalog>(
    decisionContracts.map(entry => {
      if (entry.argsSchema === null) {
        throw new Error(
          `decision skill is missing args schema: ${entry.name}`
        )
      }
      return z
        .object({
          intent: z.literal(entry.name),
          args: entry.argsSchema
        })
        .strict()
    })
  )

export const DecisionV1Schema: z.ZodType<DecisionV1FromCatalog> =
  schemaUnion<DecisionV1FromCatalog>(
    decisionContracts.map(entry => {
      if (entry.argsSchema === null) {
        throw new Error(
          `decision skill is missing args schema: ${entry.name}`
        )
      }
      return z
        .object({
          version: z.literal(1),
          intent: z.literal(entry.name),
          args: entry.argsSchema
        })
        .strict()
    })
  )

export const DecisionBlockedReasonSchema = z.enum([
  'no_safe_action',
  'missing_information',
  'capability_unavailable'
])

export const DecisionOutcomeV2Schema = z.discriminatedUnion('outcome', [
  z
    .object({
      version: z.literal(2),
      outcome: z.literal('action'),
      action: DecisionActionSchema
    })
    .strict(),
  z
    .object({
      version: z.literal(2),
      outcome: z.literal('complete')
    })
    .strict(),
  z
    .object({
      version: z.literal(2),
      outcome: z.literal('blocked'),
      reason: DecisionBlockedReasonSchema
    })
    .strict()
])

export type DecisionV1 = DecisionV1FromCatalog
export type DecisionIntent = DecisionV1['intent']
export type DecisionOutcomeV2 = z.infer<typeof DecisionOutcomeV2Schema>
export type DecisionAction = DecisionActionFromCatalog
export type DecisionBlockedReason = z.infer<typeof DecisionBlockedReasonSchema>

function schemaUnion<T>(
  schemas: readonly z.ZodType[]
): z.ZodType<T> {
  if (schemas.length < 2) {
    throw new Error('decision action catalog must contain at least two entries')
  }
  return z.union(
    schemas as [z.ZodType, z.ZodType, ...z.ZodType[]]
  ) as z.ZodType<T>
}
