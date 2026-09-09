# Windows + Raspberry Pi Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that MC_AI_Player can be developed and exercised on Windows x64, then run headlessly on Linux ARM64 and the known Raspberry Pi 3 Model B without requiring a Minecraft GUI/Launcher on the runtime host.

**Architecture:** Windows is the primary interactive development/E2E machine and may host the controlled Minecraft test server plus a human Java client. MC_AI_Player remains a headless Mineflayer client everywhere. Raspberry Pi validation measures protocol/runtime/pathfinding/memory performance only; AI inference stays remote and Minecraft rendering is never part of the Pi workload.

**Tech Stack:** Node.js 24 LTS, TypeScript, Mineflayer, mineflayer-pathfinder, SQLite MC memory, Windows PowerShell, Raspberry Pi OS 64-bit, Linux ARM64 telemetry, controlled Minecraft Java test server.

**Spec:** `docs/superpowers/specs/2026-09-10-mc-ai-player-design.md`

## Global Constraints

- `neko0115/DC_BOT` stays read-only throughout this plan.
- Raspberry Pi target is the previously identified Raspberry Pi 3 Model B with 1 GB RAM and ARM64/aarch64 userspace target.
- The Pi must not run Minecraft Launcher, the graphical Java client, OCR, screen capture, or local rendering for normal MC_AI_Player operation.
- Node.js 24 is the v1 runtime line.
- Windows x64 is a required development/E2E environment, not a second architecture fork.
- Linux x64 and Linux ARM64 remain required release validation targets.
- A Pi benchmark is invalid while undervoltage/throttling is active or if the board was booted with an unstable supply and historical throttle bits remain set.
- Use a stable 5 V / >=2.5 A supply for Pi release measurement; 5 V / 3 A is preferred for the known setup.
- AI inference is remote for Pi tests. Local LLM inference is outside the v1 Pi budget.
- Generic navigation keeps `canDig=false`; platform tuning must not weaken SafetyPolicy.
- Performance tuning must change bounded search/cache/time budgets before changing gameplay contracts.

---

### Task P1: Establish native Windows x64 development baseline

**Files:**
- Modify when Task 1 exists: `scripts/probe-platform.ts`
- Modify when Task 1 exists: `package.json`
- Create during implementation: `tests/platform/windows-baseline.test.ts`
- Create during implementation: `docs/operations/windows-testing.md`

**Interfaces:**
- Consumes: the main plan's `runPlatformProbe()`.
- Produces: a reproducible Windows report containing OS, architecture, Node version, Mineflayer/pathfinder import status, and test result metadata.

- [ ] **Step 1: Prove native toolchain before Minecraft E2E**

Run in PowerShell from the repository root:

```powershell
node --version
node -p "process.platform + ' ' + process.arch"
npm ci
npm run probe
npm test
npm run typecheck
```

Required observations:

```text
Node major: 24
platform: win32
architecture: x64
Mineflayer import: pass
pathfinder import: pass
unit tests: pass
typecheck: pass
```

Do not substitute WSL results for this Windows gate.

- [ ] **Step 2: Add a Windows-specific platform regression test**

The test must skip on non-Windows hosts and, on Windows, assert `process.platform === 'win32'`, `process.arch === 'x64'`, and Node major 24. It must not encode absolute drive letters or user-profile paths.

- [ ] **Step 3: Document Windows test topology**

Use this topology:

```text
Windows x64
├─ MC_AI_Player process
├─ controlled Minecraft Java test server
├─ human Minecraft Java client
└─ telemetry/test console
```

MC_AI_Player connects through Mineflayer and does not require a second graphical Minecraft window.

- [ ] **Step 4: Record baseline evidence**

Save a structured artifact under the future test artifact directory with:

```text
node_version
platform
architecture
package_lock_hash
minecraft_test_version
mineflayer_version
pathfinder_version
test_summary
```

No API keys, account tokens, or local absolute secret paths may be recorded.

- [ ] **Step 5: Commit when implementation reaches this task**

```bash
git add scripts/probe-platform.ts package.json tests/platform/windows-baseline.test.ts docs/operations/windows-testing.md
git commit -m "test: establish Windows gameplay baseline"
```

---

### Task P2: Prove headless Minecraft operation before Raspberry Pi deployment

**Files:**
- Consumes main-plan files: `src/minecraft/mineflayer-adapter.ts`, `src/minecraft/observation-bridge.ts`
- Create during implementation: `tests/scenarios/headless-client.e2e.test.ts`
- Create during implementation: `docs/operations/headless-runtime.md`

**Interfaces:**
- Produces: evidence that the runtime host needs only Node.js + MC_AI_Player and can appear on the Minecraft server as a player without a GUI client.

- [ ] **Step 1: Start a controlled Java test server on the Windows test machine or another LAN host**

Use the exact Minecraft version accepted by the Phase 0 compatibility probe. Early controlled testing may use test authentication policy appropriate for the isolated environment; production online-mode authentication is a separate credential gate.

- [ ] **Step 2: Start MC_AI_Player without Minecraft Launcher**

The test must launch only the Node process. Assert connection lifecycle reaches:

```text
connected
spawned
```

- [ ] **Step 3: Join with a human Java client and verify mutual presence**

Required observations:

```text
human client sees MC_AI_Player player entity
MC_AI_Player observes human player
player chat reaches normalized observation
health/inventory state remains readable
```

- [ ] **Step 4: Add a negative dependency check**

Document and test that startup does not shell out to Minecraft Launcher, Java game client binaries, GUI automation, OCR tools, screenshot libraries, or display-server commands.

- [ ] **Step 5: Commit when implemented**

```bash
git add tests/scenarios/headless-client.e2e.test.ts docs/operations/headless-runtime.md
git commit -m "test: prove headless minecraft client operation"
```

---

### Task P3: Establish Linux ARM64 and Pi 3B preflight gate

**Files:**
- Create during implementation: `scripts/platform-preflight.ts`
- Create during implementation: `tests/platform/linux-arm64-preflight.test.ts`
- Create during implementation: `docs/operations/pi-deployment.md`

**Interfaces:**
- Produces: `PlatformPreflightReport` containing architecture, memory, Node version, throttling state where available, and runtime dependency status.

- [ ] **Step 1: Verify the Pi boot/runtime environment**

On the Raspberry Pi:

```bash
uname -m
getconf LONG_BIT
node --version
free -m
```

Required target:

```text
uname -m: aarch64
userspace: 64-bit
Node major: 24
```

If the host reports 32-bit userspace, stop the ARM64 gate and correct the OS/runtime environment instead of working around it in application code.

- [ ] **Step 2: Verify power/throttling before benchmarking**

On Raspberry Pi OS:

```bash
vcgencmd get_throttled
```

Release benchmark precondition:

```text
get_throttled=0x0
```

If active or historical undervoltage/throttle bits are present, correct the supply, reboot, and repeat preflight before collecting performance evidence.

- [ ] **Step 3: Run dependency/import probe on ARM64**

```bash
npm ci
npm run probe
npm test
npm run typecheck
```

At the phase where SQLite is introduced, include the exact SQLite package installation/runtime probe. A native-module failure is a blocker with captured logs; do not silently swap database libraries.

- [ ] **Step 4: Assert headless environment independence**

The Pi process must start without `DISPLAY`/Wayland requirements and without Minecraft GUI installation. Record whether a desktop environment is absent; absence must not prevent MC_AI_Player startup.

- [ ] **Step 5: Commit when implemented**

```bash
git add scripts/platform-preflight.ts tests/platform/linux-arm64-preflight.test.ts docs/operations/pi-deployment.md
git commit -m "test: add linux arm64 runtime preflight"
```

---

### Task P4: Benchmark Pi 3B deterministic gameplay budget

**Files:**
- Create during implementation: `scripts/benchmark-runtime.ts`
- Create during implementation: `tests/platform/pi-budget.test.ts`
- Create during implementation: `fixtures/platform/pi3b-budget.json`

**Interfaces:**
- Produces: a structured benchmark summary consumed by the release gate.

- [ ] **Step 1: Implement bounded telemetry sampler**

Sample at a fixed interval and record:

```ts
interface RuntimeBudgetSample {
  at: number
  rssBytes: number
  heapUsedBytes: number
  cpuUserMicros: number
  cpuSystemMicros: number
  eventLoopLagMs: number
  swapObserved: boolean
}
```

Pathfinder scenario records also include path planning duration and replan count.

- [ ] **Step 2: Run scenarios separately before combined cooperative play**

Required scenarios:

```text
A idle connected: 10 min
B follow player: 10 min
C navigate 32 blocks: >=20 repetitions
D navigate 64 blocks: >=20 repetitions
E bounded resource search + gather
F return_home
G inventory/chest operation
H SQLite memory write/query/reopen
I remote AI decision request with actuator isolated
J disconnect/reconnect cycles: >=10
```

Do not run a huge unbounded A* goal merely to stress the Pi. The purpose is to characterize the production architecture.

- [ ] **Step 3: Apply initial engineering budgets**

These are pass targets to validate, not assumptions:

```text
normal RSS: < 500 MB
short peak RSS: < 700 MB
sustained swap thrashing: no
unbounded RSS growth: no
event-loop lag: < 100 ms for the large majority of normal samples
```

A single slow path calculation does not automatically fail the device; repeated latency that prevents reliable gameplay does.

- [ ] **Step 4: Tune only bounded deterministic controls if needed**

Allowed first-response tuning knobs:

```text
path segment length
searchRadius
tickTimeout
thinkTimeout
view distance
WorldStateCache radius
replan frequency
```

After each change, rerun the same scenario and preserve before/after evidence. Do not compensate by bypassing safety checks or moving low-level gameplay decisions into AI.

- [ ] **Step 5: Classify Pi result**

Exactly one result is recorded:

```text
PASS
PASS_WITH_LIMITS
HARDWARE_BLOCKED
```

`PASS_WITH_LIMITS` must state concrete limits such as maximum recommended path segment or view/cache radius. `HARDWARE_BLOCKED` must identify measured bottleneck evidence rather than saying only that the Pi is slow.

- [ ] **Step 6: Commit when implemented**

```bash
git add scripts/benchmark-runtime.ts tests/platform/pi-budget.test.ts fixtures/platform/pi3b-budget.json
git commit -m "test: benchmark raspberry pi gameplay budget"
```

---

### Task P5: Run cross-platform cooperative release gate

**Files:**
- Modify during implementation: `scripts/soak.ts`
- Create during implementation: `tests/scenarios/platform-release.e2e.test.ts`
- Create during implementation: `docs/operations/platform-release-gate.md`

**Interfaces:**
- Consumes: deterministic skills, MC memory, Reasoning Isolation, Control API, Pi benchmark.
- Produces: final platform evidence used by Phase 6/7; it does not authorize DC_BOT integration by itself.

- [ ] **Step 1: Run Windows cooperative E2E**

Required sequence:

```text
connect
human player joins
follow human
gather bounded resource
return to human/base
perform inventory handoff/storage action
persist relevant MC memory
restart MC_AI_Player
retrieve remembered location/task fact
continue safely
```

Minimum continuous session: 30 minutes.

- [ ] **Step 2: Run Linux x64 automated gate**

Run full unit/integration/replay/reasoning-isolation suite. No platform-specific behavior may be skipped merely because it was demonstrated on Windows.

- [ ] **Step 3: Run Linux ARM64 runtime gate**

Run the same platform-independent automated suite that can execute on ARM64 plus headless connection and deterministic gameplay smoke tests.

- [ ] **Step 4: Run Pi 3B cooperative soak appropriate to its measured budget**

Use the exact tuning parameters accepted by Task P4. Record CPU/RSS/event-loop/pathfinding metrics throughout. Remote AI may be enabled only after the main plan's Reasoning Isolation hard gate is already passing.

- [ ] **Step 5: Produce platform matrix**

Required output format:

```text
Windows x64: PASS/FAIL
Linux x64: PASS/FAIL
Linux ARM64: PASS/FAIL
Raspberry Pi 3B: PASS/PASS_WITH_LIMITS/HARDWARE_BLOCKED
Mini PC: NOT_TESTED/PASS/FAIL
Minecraft GUI required on runtime host: NO
OCR required for baseline: NO
DC_BOT modified: NO
```

- [ ] **Step 6: Commit when implemented**

```bash
git add scripts/soak.ts tests/scenarios/platform-release.e2e.test.ts docs/operations/platform-release-gate.md
git commit -m "test: add cross-platform release gate"
```

## Execution note

This is a subordinate plan to the main 17-task implementation plan. Execute P1 alongside the bootstrap/platform probe, P2 after observation-only connectivity exists, P3 before declaring ARM64 support, P4 after deterministic gameplay + MC memory are available, and P5 during Phase 6/7. None of P1-P5 permits changes to DC_BOT.
