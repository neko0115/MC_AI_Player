import assert from 'node:assert/strict'
import test from 'node:test'
import {
  sampleResourceTelemetry,
  summarizeSoak,
  type ResourceTelemetryProbe,
  type ResourceTelemetrySample
} from '../../scripts/soak.js'
import {
  CHAOS_CASES,
  runChaosSuite,
  type ChaosInjector,
  type ChaosResolution
} from '../../scripts/chaos.js'

const COMPLETE_PROBE: ResourceTelemetryProbe = {
  pathfinderPlanningDurationMs: () => 42,
  activeGoalStartedAtMs: () => 900,
  eventQueueDepth: () => 3,
  memoryRowCount: () => 27,
  aiDecisionLatencyMs: () => 88
}

test('resource telemetry samples process metrics, event-loop lag, and bounded runtime probe values', async () => {
  let now = 1000
  const sample = await sampleResourceTelemetry(COMPLETE_PROBE, {
    now: () => now,
    sleep: async delayMs => {
      now += delayMs + 12
    },
    lagProbeDelayMs: 50,
    memoryUsage: () => ({
      rss: 400_000_000,
      heapTotal: 220_000_000,
      heapUsed: 180_000_000,
      external: 4_000_000,
      arrayBuffers: 1_000_000
    })
  })

  assert.deepEqual(sample, {
    at: 1062,
    rssBytes: 400_000_000,
    heapUsedBytes: 180_000_000,
    eventLoopLagMs: 12,
    pathfinderPlanningDurationMs: 42,
    activeGoalAgeMs: 162,
    eventQueueDepth: 3,
    memoryRowCount: 27,
    aiDecisionLatencyMs: 88,
    missingMetrics: []
  })
})

test('resource telemetry marks unavailable runtime metrics instead of inventing measurements', async () => {
  let now = 10_000
  const sample = await sampleResourceTelemetry({}, {
    now: () => now,
    sleep: async delayMs => {
      now += delayMs
    },
    lagProbeDelayMs: 25,
    memoryUsage: () => ({
      rss: 100,
      heapTotal: 90,
      heapUsed: 80,
      external: 2,
      arrayBuffers: 1
    })
  })

  assert.equal(sample.pathfinderPlanningDurationMs, null)
  assert.equal(sample.activeGoalAgeMs, null)
  assert.equal(sample.eventQueueDepth, null)
  assert.equal(sample.memoryRowCount, null)
  assert.equal(sample.aiDecisionLatencyMs, null)
  assert.deepEqual(sample.missingMetrics, [
    'pathfinderPlanningDurationMs',
    'activeGoalAgeMs',
    'eventQueueDepth',
    'memoryRowCount',
    'aiDecisionLatencyMs'
  ])
})

test('soak summary reports measured percentiles and release counters without declaring incomplete evidence complete', () => {
  const samples: ResourceTelemetrySample[] = [
    completeSample(1, 100, 50, 1, 10),
    completeSample(2, 120, 60, 2, 12),
    completeSample(3, 110, 55, 9, 14)
  ]

  const summary = summarizeSoak(samples, {
    goalsSucceeded: 7,
    goalsFailed: 1,
    goalsCancelled: 2,
    reconnectCount: 3,
    stuckCount: 1,
    aiRejectedDecisionCount: 4,
    reasoningLeakageCount: 0,
    uncaughtExceptionCount: 0
  })

  assert.equal(summary.startRssBytes, 100)
  assert.equal(summary.endRssBytes, 110)
  assert.equal(summary.maxRssBytes, 120)
  assert.equal(summary.maxHeapUsedBytes, 60)
  assert.deepEqual(summary.eventLoopLagMs, { p50: 2, p95: 9, max: 9 })
  assert.equal(summary.memoryRowGrowth, 4)
  assert.equal(summary.goalsSucceeded, 7)
  assert.equal(summary.reconnectCount, 3)
  assert.equal(summary.reasoningLeakageCount, 0)
  assert.equal(summary.uncaughtExceptionCount, 0)
  assert.equal(summary.evidenceComplete, true)

  const incomplete = summarizeSoak([
    { ...samples[0]!, aiDecisionLatencyMs: null, missingMetrics: ['aiDecisionLatencyMs'] }
  ], {
    goalsSucceeded: 0,
    goalsFailed: 0,
    goalsCancelled: 0,
    reconnectCount: 0,
    stuckCount: 0,
    aiRejectedDecisionCount: 0,
    reasoningLeakageCount: 0,
    uncaughtExceptionCount: 0
  })
  assert.equal(incomplete.evidenceComplete, false)
  assert.deepEqual(incomplete.missingMetrics, ['aiDecisionLatencyMs'])
})

test('chaos suite runs every required injection and each case converges to a defined safe state', async () => {
  const seen: string[] = []
  const injector: ChaosInjector = {
    async inject(name): Promise<ChaosResolution> {
      seen.push(name)
      const state = name === 'server_disconnect'
        ? 'disconnected'
        : name === 'server_restart'
          ? 'recovered'
          : name === 'sse_client_disconnect_storm'
            ? 'recovered'
            : 'failed_safe'
      return {
        state,
        code: `handled_${name}`,
        reasoningLeakageCount: 0,
        uncaughtExceptionCount: 0
      }
    }
  }

  const outcomes = await runChaosSuite(injector, { timeoutMs: 250 })

  assert.deepEqual(seen, CHAOS_CASES)
  assert.equal(outcomes.length, CHAOS_CASES.length)
  assert.equal(outcomes.every(outcome => outcome.durationMs >= 0), true)
  assert.equal(outcomes.every(outcome => outcome.reasoningLeakageCount === 0), true)
  assert.equal(outcomes.every(outcome => outcome.uncaughtExceptionCount === 0), true)
  assert.equal(
    outcomes.every(outcome => ['recovered', 'failed_safe', 'disconnected', 'stopped'].includes(outcome.state)),
    true
  )
})

test('chaos suite fails instead of hanging when an injection never converges', async () => {
  const injector: ChaosInjector = {
    async inject() {
      return new Promise<ChaosResolution>(() => {})
    }
  }

  await assert.rejects(
    runChaosSuite(injector, {
      scenarios: ['pathfinder_stuck'],
      timeoutMs: 25
    }),
    /pathfinder_stuck.*timed out/i
  )
})

function completeSample(
  at: number,
  rssBytes: number,
  heapUsedBytes: number,
  eventLoopLagMs: number,
  memoryRowCount: number
): ResourceTelemetrySample {
  return {
    at,
    rssBytes,
    heapUsedBytes,
    eventLoopLagMs,
    pathfinderPlanningDurationMs: 5,
    activeGoalAgeMs: 100,
    eventQueueDepth: 0,
    memoryRowCount,
    aiDecisionLatencyMs: 20,
    missingMetrics: []
  }
}
