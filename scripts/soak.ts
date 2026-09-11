import { pathToFileURL } from 'node:url'

export type ResourceTelemetryMetricName =
  | 'pathfinderPlanningDurationMs'
  | 'activeGoalAgeMs'
  | 'eventQueueDepth'
  | 'memoryRowCount'
  | 'aiDecisionLatencyMs'

export interface ResourceTelemetryProbe {
  readonly pathfinderPlanningDurationMs?: () => number | null | Promise<number | null>
  readonly activeGoalStartedAtMs?: () => number | null | Promise<number | null>
  readonly eventQueueDepth?: () => number | null | Promise<number | null>
  readonly memoryRowCount?: () => number | null | Promise<number | null>
  readonly aiDecisionLatencyMs?: () => number | null | Promise<number | null>
}

export interface ResourceTelemetrySample {
  readonly at: number
  readonly rssBytes: number
  readonly heapUsedBytes: number
  readonly eventLoopLagMs: number
  readonly pathfinderPlanningDurationMs: number | null
  readonly activeGoalAgeMs: number | null
  readonly eventQueueDepth: number | null
  readonly memoryRowCount: number | null
  readonly aiDecisionLatencyMs: number | null
  readonly missingMetrics: readonly ResourceTelemetryMetricName[]
}

export interface ResourceTelemetrySampleOptions {
  readonly now?: () => number
  readonly sleep?: (delayMs: number) => Promise<void>
  readonly lagProbeDelayMs?: number
  readonly memoryUsage?: () => NodeJS.MemoryUsage
}

export interface SoakCounters {
  readonly goalsSucceeded: number
  readonly goalsFailed: number
  readonly goalsCancelled: number
  readonly reconnectCount: number
  readonly stuckCount: number
  readonly aiRejectedDecisionCount: number
  readonly reasoningLeakageCount: number
  readonly uncaughtExceptionCount: number
}

export interface PercentileSummary {
  readonly p50: number
  readonly p95: number
  readonly max: number
}

export interface SoakSummary extends SoakCounters {
  readonly sampleCount: number
  readonly startRssBytes: number
  readonly endRssBytes: number
  readonly maxRssBytes: number
  readonly maxHeapUsedBytes: number
  readonly eventLoopLagMs: PercentileSummary
  readonly memoryRowGrowth: number | null
  readonly missingMetrics: readonly ResourceTelemetryMetricName[]
  readonly evidenceComplete: boolean
}

export interface CollectSoakOptions extends ResourceTelemetrySampleOptions {
  readonly durationMs: number
  readonly intervalMs: number
}

const RUNTIME_METRICS: readonly ResourceTelemetryMetricName[] = [
  'pathfinderPlanningDurationMs',
  'activeGoalAgeMs',
  'eventQueueDepth',
  'memoryRowCount',
  'aiDecisionLatencyMs'
]

export async function sampleResourceTelemetry(
  probe: ResourceTelemetryProbe,
  options: ResourceTelemetrySampleOptions = {}
): Promise<ResourceTelemetrySample> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? (delayMs => new Promise(resolve => setTimeout(resolve, delayMs)))
  const memoryUsage = options.memoryUsage ?? process.memoryUsage
  const lagProbeDelayMs = options.lagProbeDelayMs ?? 50
  validateNonNegativeFinite(lagProbeDelayMs, 'lagProbeDelayMs')

  const scheduledAt = now()
  await sleep(lagProbeDelayMs)
  const sampledAt = now()
  const eventLoopLagMs = Math.max(0, sampledAt - scheduledAt - lagProbeDelayMs)
  const usage = memoryUsage()

  const missingMetrics: ResourceTelemetryMetricName[] = []
  const pathfinderPlanningDurationMs = await readMetric(
    'pathfinderPlanningDurationMs',
    probe.pathfinderPlanningDurationMs,
    missingMetrics,
    value => value >= 0
  )
  const activeGoalStartedAtMs = await readMetric(
    'activeGoalAgeMs',
    probe.activeGoalStartedAtMs,
    missingMetrics,
    value => value >= 0
  )
  const activeGoalAgeMs = activeGoalStartedAtMs === null
    ? null
    : Math.max(0, sampledAt - activeGoalStartedAtMs)
  const eventQueueDepth = await readMetric(
    'eventQueueDepth',
    probe.eventQueueDepth,
    missingMetrics,
    value => Number.isInteger(value) && value >= 0
  )
  const memoryRowCount = await readMetric(
    'memoryRowCount',
    probe.memoryRowCount,
    missingMetrics,
    value => Number.isInteger(value) && value >= 0
  )
  const aiDecisionLatencyMs = await readMetric(
    'aiDecisionLatencyMs',
    probe.aiDecisionLatencyMs,
    missingMetrics,
    value => value >= 0
  )

  return {
    at: sampledAt,
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    eventLoopLagMs,
    pathfinderPlanningDurationMs,
    activeGoalAgeMs,
    eventQueueDepth,
    memoryRowCount,
    aiDecisionLatencyMs,
    missingMetrics
  }
}

export async function collectSoakSamples(
  probe: ResourceTelemetryProbe,
  options: CollectSoakOptions
): Promise<ResourceTelemetrySample[]> {
  validatePositiveFinite(options.durationMs, 'durationMs')
  validatePositiveFinite(options.intervalMs, 'intervalMs')
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? (delayMs => new Promise(resolve => setTimeout(resolve, delayMs)))
  const startedAt = now()
  const samples: ResourceTelemetrySample[] = []

  while (samples.length === 0 || now() - startedAt < options.durationMs) {
    samples.push(await sampleResourceTelemetry(probe, options))
    if (now() - startedAt >= options.durationMs) break
    await sleep(options.intervalMs)
  }
  return samples
}

export function summarizeSoak(
  samples: readonly ResourceTelemetrySample[],
  counters: SoakCounters
): SoakSummary {
  if (samples.length === 0) {
    throw new RangeError('at least one telemetry sample is required')
  }
  validateCounters(counters)

  const first = samples[0]
  const last = samples[samples.length - 1]
  if (!first || !last) throw new RangeError('at least one telemetry sample is required')

  const missing = new Set<ResourceTelemetryMetricName>()
  for (const sample of samples) {
    for (const metric of sample.missingMetrics) missing.add(metric)
  }
  const missingMetrics = RUNTIME_METRICS.filter(metric => missing.has(metric))

  const firstRows = first.memoryRowCount
  const lastRows = last.memoryRowCount
  const memoryRowGrowth = firstRows === null || lastRows === null
    ? null
    : lastRows - firstRows

  return {
    sampleCount: samples.length,
    startRssBytes: first.rssBytes,
    endRssBytes: last.rssBytes,
    maxRssBytes: Math.max(...samples.map(sample => sample.rssBytes)),
    maxHeapUsedBytes: Math.max(...samples.map(sample => sample.heapUsedBytes)),
    eventLoopLagMs: percentileSummary(samples.map(sample => sample.eventLoopLagMs)),
    memoryRowGrowth,
    ...counters,
    missingMetrics,
    evidenceComplete:
      missingMetrics.length === 0 &&
      counters.reasoningLeakageCount === 0 &&
      counters.uncaughtExceptionCount === 0
  }
}

async function readMetric(
  name: ResourceTelemetryMetricName,
  read: (() => number | null | Promise<number | null>) | undefined,
  missing: ResourceTelemetryMetricName[],
  valid: (value: number) => boolean
): Promise<number | null> {
  if (!read) {
    missing.push(name)
    return null
  }
  try {
    const value = await read()
    if (value === null || !Number.isFinite(value) || !valid(value)) {
      missing.push(name)
      return null
    }
    return value
  } catch {
    missing.push(name)
    return null
  }
}

function percentileSummary(values: readonly number[]): PercentileSummary {
  if (values.length === 0) throw new RangeError('percentile values cannot be empty')
  const sorted = [...values].sort((a, b) => a - b)
  return {
    p50: nearestRank(sorted, 0.50),
    p95: nearestRank(sorted, 0.95),
    max: sorted[sorted.length - 1] ?? 0
  }
}

function nearestRank(sorted: readonly number[], percentile: number): number {
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1)
  return sorted[index] ?? 0
}

function validateCounters(counters: SoakCounters): void {
  for (const [name, value] of Object.entries(counters)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative integer`)
    }
  }
}

function validateNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`)
  }
}

function validatePositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`)
  }
}

async function runCli(): Promise<void> {
  const durationMs = parsePositiveEnv('MC_SOAK_DURATION_MS', 60_000)
  const intervalMs = parsePositiveEnv('MC_SOAK_INTERVAL_MS', 5_000)
  const samples = await collectSoakSamples({}, { durationMs, intervalMs })
  const summary = summarizeSoak(samples, {
    goalsSucceeded: 0,
    goalsFailed: 0,
    goalsCancelled: 0,
    reconnectCount: 0,
    stuckCount: 0,
    aiRejectedDecisionCount: 0,
    reasoningLeakageCount: 0,
    uncaughtExceptionCount: 0
  })
  console.log(JSON.stringify({ samples, summary }, null, 2))
}

function parsePositiveEnv(name: string, fallback: number): number {
  const text = process.env[name]?.trim()
  if (!text) return fallback
  const value = Number(text)
  validatePositiveFinite(value, name)
  return value
}

function isEntrypoint(): boolean {
  const script = process.argv[1]
  return Boolean(script && import.meta.url === pathToFileURL(script).href)
}

if (isEntrypoint()) {
  void runCli().catch(() => {
    console.error('soak telemetry collection failed')
    process.exitCode = 1
  })
}
