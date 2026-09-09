import assert from 'node:assert/strict'
import test from 'node:test'
import { runPlatformProbe } from '../../scripts/probe-platform.js'

test('platform probe reports supported node line and architecture', async () => {
  const report = await runPlatformProbe()
  assert.equal(report.nodeMajor, 24)
  assert.ok(['x64', 'arm64'].includes(report.arch))
  assert.equal(report.mineflayerLoaded, true)
  assert.equal(report.pathfinderLoaded, true)
})
