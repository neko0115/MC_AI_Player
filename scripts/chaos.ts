export const CHAOS_CASES = [
  'server_disconnect',
  'server_restart',
  'pathfinder_stuck',
  'target_disappears',
  'inventory_full',
  'bot_dies',
  'ai_timeout',
  'ai_invalid_mixed_reasoning',
  'memory_repository_unavailable',
  'sse_client_disconnect_storm'
] as const

export type ChaosCase = typeof CHAOS_CASES[number]
export type ChaosConvergedState = 'recovered' | 'failed_safe' | 'disconnected' | 'stopped'

export interface ChaosResolution {
  readonly state: ChaosConvergedState
  readonly code: string
  readonly reasoningLeakageCount: number
  readonly uncaughtExceptionCount: number
}

export interface ChaosOutcome extends ChaosResolution {
  readonly scenario: ChaosCase
  readonly durationMs: number
}

export interface ChaosInjector {
  inject(scenario: ChaosCase, signal: AbortSignal): Promise<ChaosResolution>
}

export interface RunChaosSuiteOptions {
  readonly scenarios?: readonly ChaosCase[]
  readonly timeoutMs: number
  readonly now?: () => number
  readonly scheduleTimeout?: (callback: () => void, timeoutMs: number) => ReturnType<typeof setTimeout>
  readonly clearScheduledTimeout?: (handle: ReturnType<typeof setTimeout>) => void
}

const VALID_STATES = new Set<ChaosConvergedState>([
  'recovered',
  'failed_safe',
  'disconnected',
  'stopped'
])

export async function runChaosSuite(
  injector: ChaosInjector,
  options: RunChaosSuiteOptions
): Promise<ChaosOutcome[]> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be a positive finite number')
  }
  const scenarios = options.scenarios ?? CHAOS_CASES
  validateScenarios(scenarios)
  const now = options.now ?? Date.now
  const scheduleTimeout = options.scheduleTimeout ?? setTimeout
  const clearScheduledTimeout = options.clearScheduledTimeout ?? clearTimeout
  const outcomes: ChaosOutcome[] = []

  for (const scenario of scenarios) {
    const startedAt = now()
    const controller = new AbortController()
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null

    const injection = Promise.resolve().then(() => injector.inject(scenario, controller.signal))
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = scheduleTimeout(() => {
        controller.abort('chaos_timeout')
        reject(new Error(`Chaos case ${scenario} timed out after ${options.timeoutMs}ms`))
      }, options.timeoutMs)
    })

    let resolution: ChaosResolution
    try {
      resolution = await Promise.race([injection, timeout])
    } finally {
      if (timeoutHandle !== null) clearScheduledTimeout(timeoutHandle)
    }

    validateResolution(scenario, resolution)
    outcomes.push({
      scenario,
      ...resolution,
      durationMs: Math.max(0, now() - startedAt)
    })
  }

  return outcomes
}

function validateScenarios(scenarios: readonly ChaosCase[]): void {
  if (scenarios.length === 0) throw new RangeError('at least one chaos scenario is required')
  const allowed = new Set<string>(CHAOS_CASES)
  for (const scenario of scenarios) {
    if (!allowed.has(scenario)) {
      throw new TypeError(`unsupported chaos scenario: ${String(scenario)}`)
    }
  }
}

function validateResolution(scenario: ChaosCase, resolution: ChaosResolution): void {
  if (!VALID_STATES.has(resolution.state)) {
    throw new Error(`Chaos case ${scenario} returned an undefined state`)
  }
  const code = resolution.code.trim()
  if (!code || code.length > 128) {
    throw new Error(`Chaos case ${scenario} returned an invalid code`)
  }
  validateCount(resolution.reasoningLeakageCount, 'reasoningLeakageCount')
  validateCount(resolution.uncaughtExceptionCount, 'uncaughtExceptionCount')
  if (resolution.reasoningLeakageCount !== 0) {
    throw new Error(`Chaos case ${scenario} leaked reasoning`)
  }
  if (resolution.uncaughtExceptionCount !== 0) {
    throw new Error(`Chaos case ${scenario} produced an uncaught exception`)
  }
}

function validateCount(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`)
  }
}
