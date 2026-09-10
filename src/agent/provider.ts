export type StructuredProviderMode = 'schema' | 'function_call'

export type ProviderResult =
  | {
      readonly kind: 'structured'
      readonly value: unknown
      readonly provider: string
      readonly mode: StructuredProviderMode
    }
  | {
      readonly kind: 'invalid'
      readonly code: string
      readonly provider: string
    }
  | {
      readonly kind: 'timeout'
      readonly provider: string
    }

export interface DecisionRequest<TContext = unknown> {
  readonly context: TContext
}

export interface DecisionProvider<TContext = unknown> {
  decide(request: DecisionRequest<TContext>): Promise<ProviderResult>
}
