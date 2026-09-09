# MC_AI_Player Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Minecraft Java Edition cooperative player runtime where AI makes high-level structured decisions, deterministic code performs gameplay, hidden reasoning can never reach the actuator path, and the system can later integrate with Moxue through a thin contract only after standalone validation passes.

**Architecture:** Mineflayer owns Minecraft protocol/game state, a bounded observation/state layer feeds deterministic Goal/Skill/Safety components, and a provider-neutral DecisionProvider may submit only schema-validated high-level intents. MC memory, telemetry, control API, replay, and low-power validation stay inside `MC_AI_Player`; `DC_BOT` is read-only until the final integration gate.

**Tech Stack:** Node.js 24 LTS, TypeScript 7.0.2, tsx 4.23.13, Zod 4.5.4, Mineflayer 4.39.0 candidate, mineflayer-pathfinder 2.4.5 candidate, better-sqlite3 12.11.1 candidate for Phase 3, @google/genai 2.21.0 for the first real DecisionProvider, Node built-in HTTP/SSE, Node test runner through `tsx --test`.

**Spec:** `docs/superpowers/specs/2026-09-10-mc-ai-player-design.md`

## Global Constraints

- `neko0115/DC_BOT` is read-only throughout Tasks 1-17. Do not create branches, commits, PRs, files, issues, or database changes in DC_BOT.
- Baseline gameplay must not require OCR, screenshots, or a GUI.
- AI may choose high-level goals only; no model output may directly issue movement keys, raw protocol packets, shell code, JavaScript, or arbitrary Minecraft commands.
- Free-text command parsing is forbidden. Never regex-search or substring-search mixed model text for JSON/actions.
- Hidden/intermediate reasoning must be discarded at the provider boundary and must never enter SkillExecutor, Minecraft chat, telemetry, replay fixtures, or MC memory.
- Any provider mode that cannot separate final structured output from mixed reasoning/free text is invalid for gameplay.
- Invalid AI decisions fail closed: preserve the current safe state and start no new AI action.
- Generic navigation starts with `canDig=false`; block mutation is granted only inside explicit approved skills.
- PvP is disabled by default.
- Emergency stop has the highest runtime priority and must cancel active goal + active skill + pathfinder.
- MC memory is a separate store. Never share or directly read/write a DC_BOT SQLite file.
- Control API binds to `127.0.0.1` by default. Non-loopback bind requires a bearer token at startup.
- Long-running gameplay goals return a `goal_id`; HTTP requests must not remain open until gameplay finishes.
- Node.js 24 LTS is the supported runtime line for v1. Linux x64 and Linux ARM64 are required validation targets.
- Exact Mineflayer/pathfinder/SQLite dependency pins are accepted only after their compatibility probes pass; failure blocks the dependent task rather than silently changing libraries.

---

## Locked file map

The implementation should converge on this structure. Do not add a broad `utils.ts`; put behavior next to its owner.

```text
MC_AI_Player/
├─ package.json
├─ package-lock.json
├─ tsconfig.json
├─ .gitignore
├─ .env.example
├─ README.md
├─ docs/
│  ├─ superpowers/specs/2026-09-10-mc-ai-player-design.md
│  ├─ superpowers/plans/2026-09-10-mc-ai-player-implementation.md
│  ├─ contracts/decision-v1.md
│  └─ operations/pi-deployment.md
├─ src/
│  ├─ config.ts
│  ├─ main.ts
│  ├─ contracts/
│  │  ├─ decision.ts
│  │  ├─ events.ts
│  │  ├─ goals.ts
│  │  └─ skills.ts
│  ├─ telemetry/
│  │  ├─ event-bus.ts
│  │  ├─ recorder.ts
│  │  └─ replay.ts
│  ├─ minecraft/
│  │  ├─ adapter.ts
│  │  ├─ fake-adapter.ts
│  │  ├─ mineflayer-adapter.ts
│  │  └─ observation-bridge.ts
│  ├─ state/
│  │  ├─ world-state.ts
│  │  └─ world-state-cache.ts
│  ├─ safety/
│  │  └─ policy.ts
│  ├─ goals/
│  │  └─ goal-manager.ts
│  ├─ skills/
│  │  ├─ registry.ts
│  │  ├─ executor.ts
│  │  ├─ navigation.ts
│  │  ├─ survival.ts
│  │  ├─ inventory.ts
│  │  └─ gathering.ts
│  ├─ memory/
│  │  ├─ repository.ts
│  │  └─ sqlite-repository.ts
│  ├─ agent/
│  │  ├─ provider.ts
│  │  ├─ context-builder.ts
│  │  ├─ decision-gate.ts
│  │  ├─ fake-provider.ts
│  │  ├─ gemini-provider.ts
│  │  └─ chat-renderer.ts
│  └─ api/
│     └─ control-server.ts
├─ tests/
│  ├─ contracts/
│  ├─ telemetry/
│  ├─ minecraft/
│  ├─ state/
│  ├─ safety/
│  ├─ goals/
│  ├─ skills/
│  ├─ memory/
│  ├─ agent/
│  ├─ api/
│  ├─ scenarios/
│  └─ replay/
├─ fixtures/
│  ├─ observations/
│  ├─ replay/
│  └─ provider/
└─ scripts/
   ├─ probe-platform.ts
   ├─ soak.ts
   └─ chaos.ts
```

---

### Task 1: Bootstrap the repository and prove the runtime/toolchain

**Phase:** 0

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `README.md`
- Create: `scripts/probe-platform.ts`
- Test: `tests/contracts/platform-probe.test.ts`

**Interfaces:**
- Consumes: Node.js 24 LTS.
- Produces: reproducible npm environment, `npm test`, `npm run typecheck`, and a compatibility report object from `runPlatformProbe()`.

- [ ] **Step 1: Write the failing platform-probe test**

```ts
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
```

- [ ] **Step 2: Create `package.json` with exact initial candidates**

```json
{
  "name": "mc-ai-player",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24 <25" },
  "scripts": {
    "test": "tsx --test",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "probe": "tsx scripts/probe-platform.ts"
  },
  "dependencies": {
    "mineflayer": "4.39.0",
    "mineflayer-pathfinder": "2.4.5",
    "zod": "4.5.4"
  },
  "devDependencies": {
    "@types/node": "24.13.3",
    "tsx": "4.23.13",
    "typescript": "7.0.2"
  }
}
```

- [ ] **Step 3: Create strict NodeNext TypeScript configuration**

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "rootDir": ".",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "scripts/**/*.ts"]
}
```

- [ ] **Step 4: Install and lock dependencies**

Run:

```bash
npm install
```

Expected: `package-lock.json` created and install exits 0.

- [ ] **Step 5: Implement the minimal probe**

```ts
import { pathToFileURL } from 'node:url'

export async function runPlatformProbe() {
  const nodeMajor = Number(process.versions.node.split('.')[0])
  await import('mineflayer')
  await import('mineflayer-pathfinder')
  return {
    nodeMajor,
    arch: process.arch,
    platform: process.platform,
    mineflayerLoaded: true,
    pathfinderLoaded: true
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await runPlatformProbe(), null, 2))
}
```

- [ ] **Step 6: Run the probe and test suite**

Run:

```bash
npm run probe
npm test
npm run typecheck
```

Expected: probe reports Node 24; tests and typecheck exit 0.

- [ ] **Step 7: Record the compatibility decision in README**

Document the exact Node/Mineflayer/pathfinder versions and host architecture used. State that a failed ARM64 probe blocks the Raspberry Pi gate and must not be papered over by switching libraries without review.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore .env.example README.md scripts/probe-platform.ts tests/contracts/platform-probe.test.ts
git commit -m "chore: bootstrap mc player runtime"
```

---

### Task 2: Define executable contracts before connecting Minecraft

**Phase:** 0

**Files:**
- Create: `src/contracts/decision.ts`
- Create: `src/contracts/events.ts`
- Create: `src/contracts/goals.ts`
- Create: `src/contracts/skills.ts`
- Create: `docs/contracts/decision-v1.md`
- Test: `tests/contracts/decision.test.ts`
- Test: `tests/contracts/goals.test.ts`

**Interfaces:**
- Consumes: Zod.
- Produces: `DecisionV1`, `GoalRequest`, `SkillName`, `RuntimeEvent` schemas and TypeScript types used by every later task.

- [ ] **Step 1: Write failing strict-schema tests**

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { DecisionV1Schema } from '../../src/contracts/decision.js'

test('decision rejects reasoning fields and unknown properties', () => {
  const result = DecisionV1Schema.safeParse({
    version: 1,
    intent: 'gather_resource',
    args: { resource: 'oak_log', quantity: 32 },
    reasoning: 'hidden thought'
  })
  assert.equal(result.success, false)
})

test('decision accepts one allowlisted high-level intent', () => {
  const result = DecisionV1Schema.parse({
    version: 1,
    intent: 'gather_resource',
    args: { resource: 'oak_log', quantity: 32 }
  })
  assert.equal(result.intent, 'gather_resource')
})
```

- [ ] **Step 2: Implement `DecisionV1Schema` as a strict discriminated union**

Use `.strict()` on every object. Include only:

```text
follow_player
stay
go_to
return_home
eat
equip
gather_resource
deposit_item
withdraw_item
```

Do not add `reason`, `analysis`, `thought`, arbitrary `command`, or raw chat text fields.

- [ ] **Step 3: Define goal lifecycle**

```ts
export type GoalStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export interface GoalRecord {
  goalId: string
  request: GoalRequest
  status: GoalStatus
  source: 'player' | 'ai' | 'system'
  createdAt: number
  updatedAt: number
}
```

- [ ] **Step 4: Define skill contract**

```ts
export type SkillStatus = 'succeeded' | 'failed' | 'cancelled'

export interface SkillResult {
  status: SkillStatus
  code: string
  summary?: string
}

export interface SkillContext {
  signal: AbortSignal
}

export interface SkillDefinition<A> {
  readonly name: string
  execute(context: SkillContext, args: A): Promise<SkillResult>
}
```

- [ ] **Step 5: Define normalized runtime events**

At minimum: `connected`, `disconnected`, `spawned`, `player_seen`, `player_chat`, `health_changed`, `inventory_changed`, `goal_started`, `goal_completed`, `goal_failed`, `skill_started`, `skill_completed`, `skill_failed`, `emergency_stop`, `decision_accepted`, `decision_rejected`, `memory_written`, `stuck`.

- [ ] **Step 6: Run tests and typecheck**

```bash
npm test
npm run typecheck
```

Expected: all contract tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/contracts docs/contracts tests/contracts
git commit -m "feat: define strict gameplay contracts"
```

---

### Task 3: Build structured telemetry and replay without reasoning leakage

**Phase:** 0

**Files:**
- Create: `src/telemetry/event-bus.ts`
- Create: `src/telemetry/recorder.ts`
- Create: `src/telemetry/replay.ts`
- Test: `tests/telemetry/event-bus.test.ts`
- Test: `tests/telemetry/recorder.test.ts`
- Test: `tests/replay/replay.test.ts`

**Interfaces:**
- Consumes: `RuntimeEvent`.
- Produces: `RuntimeEventBus.publish(event)`, JSONL recorder, deterministic `ReplayReader`.

- [ ] **Step 1: Write the event-order test**

```ts
test('event bus preserves publish order', async () => {
  const bus = new RuntimeEventBus()
  const seen: string[] = []
  bus.subscribe(event => seen.push(event.type))
  await bus.publish({ type: 'connected', at: 1 })
  await bus.publish({ type: 'spawned', at: 2 })
  assert.deepEqual(seen, ['connected', 'spawned'])
})
```

- [ ] **Step 2: Write the recorder redaction test**

Attempt to publish an object containing `reasoning`, `thought`, or `analysis` through a deliberately unsafe cast and assert the recorder rejects it instead of serializing it.

- [ ] **Step 3: Implement the bus and recorder**

Recorder rules:

- JSONL only.
- One validated `RuntimeEvent` per line.
- No raw provider response field.
- No hidden reasoning field.
- Rotation by configured max file bytes.
- Recorder failure logs locally and does not crash Minecraft control.

- [ ] **Step 4: Implement replay**

`ReplayReader` yields validated `RuntimeEvent` objects in source order. Invalid lines fail the replay test with line number and never enter runtime state.

- [ ] **Step 5: Run tests**

```bash
npm test
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/telemetry tests/telemetry tests/replay
git commit -m "feat: add bounded gameplay telemetry and replay"
```

---

### Task 4: Introduce a fake Minecraft adapter and bounded world state

**Phase:** 0

**Files:**
- Create: `src/minecraft/adapter.ts`
- Create: `src/minecraft/fake-adapter.ts`
- Create: `src/state/world-state.ts`
- Create: `src/state/world-state-cache.ts`
- Create: `fixtures/observations/basic-session.json`
- Test: `tests/state/world-state-cache.test.ts`
- Test: `tests/minecraft/fake-adapter.test.ts`

**Interfaces:**
- Produces: `MinecraftAdapter` interface and `WorldStateCache.apply(event)`.
- Later Mineflayer adapter must satisfy the same interface.

- [ ] **Step 1: Define adapter interface**

```ts
export interface MinecraftAdapter {
  connect(): Promise<void>
  disconnect(): Promise<void>
  stopMotion(): Promise<void>
  onEvent(listener: (event: RuntimeEvent) => void): () => void
}
```

Do not expose the Mineflayer `Bot` object outside the concrete adapter.

- [ ] **Step 2: Write bounded-cache tests**

Test that:

- recent events keep only the configured maximum;
- nearby players replace by identity instead of append forever;
- inventory is a current snapshot, not an unbounded history;
- disconnect clears transient entity state but preserves no long-term memory.

- [ ] **Step 3: Implement `WorldStateCache`**

Expose a snapshot method returning immutable copies:

```ts
interface WorldStateSnapshot {
  connected: boolean
  spawned: boolean
  health: number
  food: number
  dimension: string | null
  position: { x: number; y: number; z: number } | null
  nearbyPlayers: ReadonlyArray<PlayerSnapshot>
  inventory: ReadonlyArray<ItemStackSnapshot>
  recentEvents: ReadonlyArray<RuntimeEvent>
}
```

- [ ] **Step 4: Add fake adapter fixture playback**

The fake adapter should read `fixtures/observations/basic-session.json` and emit events without a Minecraft server. This becomes the authoritative fast test harness for later components.

- [ ] **Step 5: Run tests and commit**

```bash
npm test
npm run typecheck
git add src/minecraft/adapter.ts src/minecraft/fake-adapter.ts src/state fixtures/observations tests/state tests/minecraft
git commit -m "feat: add minecraft adapter contract and bounded state"
```

---

### Task 5: Connect Mineflayer in observation-only mode

**Phase:** 1

**Files:**
- Modify: `package.json` only if the Phase 0 probe established a different exact compatible Mineflayer/pathfinder pin.
- Create: `src/config.ts`
- Modify: `.env.example`
- Create: `src/minecraft/mineflayer-adapter.ts`
- Create: `src/minecraft/observation-bridge.ts`
- Test: `tests/minecraft/observation-bridge.test.ts`
- Test: `tests/minecraft/mineflayer-adapter.test.ts`

**Interfaces:**
- Consumes: `MinecraftAdapter`, `RuntimeEventBus`.
- Produces: passive Minecraft events. No movement APIs are exposed yet.

- [ ] **Step 1: Write mapping tests using fake Mineflayer-shaped events**

Verify normalization for spawn, player entity appearance, chat, health/food, inventory update, kicked/end/error.

- [ ] **Step 2: Implement config validation**

Required environment keys:

```text
MC_HOST
MC_PORT
MC_USERNAME
MC_AUTH
```

Optional:

```text
MC_VERSION
MC_LOG_LEVEL
```

Secrets never appear in telemetry.

- [ ] **Step 3: Implement observation-only adapter**

Construct Mineflayer bot, attach event listeners, publish normalized events. Do not load pathfinder yet and do not call movement controls.

- [ ] **Step 4: Add reconnect state without automatic infinite thrash**

Use bounded exponential backoff with a maximum delay and a configured maximum consecutive attempts before entering `disconnected`/operator-required state.

- [ ] **Step 5: Live validation on a private test server**

Evidence to capture manually in `README.md` or a test log:

```text
connect PASS
spawn PASS
player_seen PASS
player_chat PASS
health_changed PASS
inventory_changed PASS
disconnect PASS
reconnect PASS
no movement observed PASS
```

- [ ] **Step 6: Run automated tests and commit**

```bash
npm test
npm run typecheck
git add src/config.ts src/minecraft .env.example tests/minecraft package.json package-lock.json README.md
git commit -m "feat: add observation-only mineflayer adapter"
```

---

### Task 6: Build SafetyPolicy before any movement skill

**Phase:** 2

**Files:**
- Create: `src/safety/policy.ts`
- Test: `tests/safety/policy.test.ts`

**Interfaces:**
- Consumes: `GoalRequest`, `WorldStateSnapshot`, skill metadata.
- Produces: `SafetyDecision = allow | deny | preempt`.

- [ ] **Step 1: Write deny-by-default tests**

```ts
test('unknown skill is denied', () => {
  assert.equal(policy.authorizeSkill('raw_command', {}, state).allowed, false)
})

test('generic navigation cannot dig', () => {
  assert.equal(policy.navigationPolicy().canDig, false)
})

test('low health preempts non-critical gather goal', () => {
  assert.equal(policy.runtimeAction(lowHealthState, gatherGoal).kind, 'preempt')
})
```

- [ ] **Step 2: Encode initial policies**

Include:

- PvP false.
- generic `canDig=false`.
- block placement/destruction denied unless skill metadata has explicit capability.
- no action when disconnected/not spawned.
- low-health and starvation preemption thresholds configured in one place.
- emergency stop always allowed and always preemptive.

- [ ] **Step 3: Run tests and commit**

```bash
npm test
npm run typecheck
git add src/safety tests/safety
git commit -m "feat: add fail-closed gameplay safety policy"
```

---

### Task 7: Implement GoalManager, SkillRegistry, and cancellation semantics

**Phase:** 2

**Files:**
- Create: `src/goals/goal-manager.ts`
- Create: `src/skills/registry.ts`
- Create: `src/skills/executor.ts`
- Test: `tests/goals/goal-manager.test.ts`
- Test: `tests/skills/executor.test.ts`

**Interfaces:**
- Produces: one authoritative active goal; allowlisted skill execution; abort propagation.

- [ ] **Step 1: Write preemption tests**

Cases:

- AI goal starts when idle.
- direct player goal preempts AI goal.
- emergency stop cancels active goal and skill.
- second AI goal queues rather than races active goal.
- cancelled skill result cannot later mark goal succeeded.

- [ ] **Step 2: Implement registry**

`SkillRegistry.register(definition)` rejects duplicate names. `get(name)` returns only registered definitions.

- [ ] **Step 3: Implement executor with AbortController**

Every active skill gets one controller. `cancelActive(reason)` aborts it exactly once and waits for cleanup.

- [ ] **Step 4: Implement GoalManager state transitions**

Only GoalManager may change `GoalRecord.status`. Emit lifecycle events for every transition.

- [ ] **Step 5: Run tests and commit**

```bash
npm test
npm run typecheck
git add src/goals src/skills/registry.ts src/skills/executor.ts tests/goals tests/skills
git commit -m "feat: add deterministic goal and skill runtime"
```

---

### Task 8: Add navigation, follow, stay, and stop with pathfinder hardening

**Phase:** 2

**Files:**
- Modify: `src/minecraft/adapter.ts`
- Modify: `src/minecraft/mineflayer-adapter.ts`
- Create: `src/skills/navigation.ts`
- Test: `tests/skills/navigation.test.ts`

**Interfaces:**
- Adds adapter methods that are semantic, not raw Mineflayer object access:
  - `goTo(position, options, signal)`
  - `followPlayer(name, range, signal)`
  - `holdPosition(signal)`
  - `stopMotion()`

- [ ] **Step 1: Write tests against a fake movement adapter**

Verify:

- follow uses a dynamic target;
- cancellation invokes `stopMotion`;
- generic go-to passes `canDig=false`;
- stuck result becomes structured failure;
- emergency stop force-clears the pathfinder goal.

- [ ] **Step 2: Load `mineflayer-pathfinder` inside the concrete adapter**

Set explicit pathfinding budgets rather than defaults:

```ts
bot.pathfinder.thinkTimeout = 3000
bot.pathfinder.tickTimeout = 25
bot.pathfinder.searchRadius = 96
```

Treat these as initial conservative values to profile later, not universal truths.

- [ ] **Step 3: Configure `Movements`**

Start from:

```ts
movements.canDig = false
movements.allow1by1towers = false
```

Any additional destructive/building behavior remains false until a dedicated skill needs it.

- [ ] **Step 4: Implement skills**

Register:

```text
follow_player
stay
go_to
stop
```

Each takes strict validated args and respects `AbortSignal`.

- [ ] **Step 5: Live private-server test**

Run a scripted 10-minute sequence:

```text
follow 3 min
stay 1 min
go_to three nearby points
interrupt go_to with stop
follow moving player
disconnect during movement
```

Capture event logs and confirm no unauthorized digging.

- [ ] **Step 6: Commit**

```bash
npm test
npm run typecheck
git add src/minecraft src/skills/navigation.ts tests/skills/navigation.test.ts
git commit -m "feat: add safe deterministic navigation skills"
```

---

### Task 9: Add survival and inventory primitives

**Phase:** 2

**Files:**
- Create: `src/skills/survival.ts`
- Create: `src/skills/inventory.ts`
- Test: `tests/skills/survival.test.ts`
- Test: `tests/skills/inventory.test.ts`

**Interfaces:**
- Produces: `eat`, `equip`, `deposit_item`, `withdraw_item`.
- Uses semantic inventory APIs only.

- [ ] **Step 1: Write food-selection tests**

Pick edible items by configured preference and never consume excluded/special items.

- [ ] **Step 2: Implement `eat` with safety preemption**

If hunger threshold is crossed during a non-critical task, SafetyPolicy can pause/cancel the task and execute `eat`.

- [ ] **Step 3: Implement chest transactions**

Rules:

- identify target chest by explicit coordinate or memory ID;
- validate expected block type;
- open, perform bounded transaction, close in `finally`;
- no "deposit everything" wildcard in v1;
- full inventory/chest returns structured failure.

- [ ] **Step 4: Test cancellation and disconnect cleanup**

Ensure open-container operations do not stay logically active after abort/disconnect.

- [ ] **Step 5: Commit**

```bash
npm test
npm run typecheck
git add src/skills/survival.ts src/skills/inventory.ts tests/skills
git commit -m "feat: add survival and inventory skills"
```

---

### Task 10: Add deterministic resource gathering and return-home behavior

**Phase:** 2

**Files:**
- Create: `src/skills/gathering.ts`
- Modify: `src/skills/navigation.ts`
- Test: `tests/skills/gathering.test.ts`
- Test: `tests/scenarios/deterministic-gather.test.ts`

**Interfaces:**
- Produces: `find_resource`, `gather_resource`, `return_home`.
- Block mutation is scoped only to `gather_resource` after SafetyPolicy approval.

- [ ] **Step 1: Write scenario with fake world**

Fixture contains:

- player/base coordinate;
- oak logs in two clusters;
- a protected block zone;
- inventory capacity.

Assert the gather task chooses valid logs, does not mutate protected blocks, reaches requested quantity, and returns home.

- [ ] **Step 2: Implement bounded resource search**

Search by block IDs/tags within configured radius. Do not scan unbounded chunks or persist the scan as memory.

- [ ] **Step 3: Grant temporary digging capability only to gathering**

The gathering skill may request a narrow capability token from SafetyPolicy:

```ts
{ mutateBlocks: true, allowedBlockNames: ['oak_log'] }
```

The adapter still refuses unrelated block mutation.

- [ ] **Step 4: Add stuck/retry budget**

Maximum retries and search expansions are explicit. Exhaustion returns `failed/stuck` rather than spinning forever.

- [ ] **Step 5: Prove deterministic Phase 2 without AI**

Run the scenario using only direct GoalRequests. No DecisionProvider is instantiated.

Expected: follow/stay/navigation/eat/inventory/gather/return flows all operate without model calls.

- [ ] **Step 6: Commit**

```bash
npm test
npm run typecheck
git add src/skills tests/skills tests/scenarios
git commit -m "feat: add deterministic resource gathering"
```

---

### Task 11: Add dedicated MC memory with restart persistence

**Phase:** 3

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/memory/repository.ts`
- Create: `src/memory/sqlite-repository.ts`
- Test: `tests/memory/repository.test.ts`
- Test: `tests/memory/restart.test.ts`

**Interfaces:**
- Produces:
  - `remember(memory)`
  - `search(query)`
  - `forget(id)`
  - `close()`
- Memory types: landmark, structure, storage, resource, hazard, player_instruction, route, episode, task_history.

- [ ] **Step 1: Add the SQLite candidate only after an install probe**

Install exact candidate:

```bash
npm install better-sqlite3@12.11.1
```

Run on Linux x64 and Linux ARM64/glibc before accepting the commit.

If install/load fails on required ARM64 hardware, stop Task 11 and revise the storage-driver design; do not silently substitute another native binding.

- [ ] **Step 2: Write repository tests against a temporary database**

Test:

- exact duplicate reinforcement instead of duplicate row;
- coordinate/radius query;
- dimension filter;
- type/tag filter;
- recency/importance ordering;
- player instruction survives restart;
- transient world snapshots have no repository API and therefore cannot be inserted accidentally.

- [ ] **Step 3: Create schema with one writer**

Use WAL and a single repository instance. Tables:

```text
memories
memory_tags
schema_meta
```

No Discord IDs or DC_BOT memory IDs are required in v1.

- [ ] **Step 4: Implement bounded search**

Return a maximum configurable result count and summarized fields. Never dump the full database into AI context.

- [ ] **Step 5: Restart test**

Create DB -> write base/storage/hazard -> close -> reopen -> query same facts.

- [ ] **Step 6: Commit**

```bash
npm test
npm run typecheck
git add package.json package-lock.json src/memory tests/memory
git commit -m "feat: add persistent minecraft memory"
```

---

### Task 12: Build ContextBuilder and the Reasoning Isolation Decision Gate

**Phase:** 4 prerequisite — no real provider yet

**Files:**
- Create: `src/agent/provider.ts`
- Create: `src/agent/context-builder.ts`
- Create: `src/agent/decision-gate.ts`
- Create: `src/agent/fake-provider.ts`
- Create: `fixtures/provider/reasoning-isolation.json`
- Test: `tests/agent/context-builder.test.ts`
- Test: `tests/agent/decision-gate.test.ts`
- Test: `tests/agent/reasoning-isolation.test.ts`

**Interfaces:**
- Produces:
  - `DecisionProvider.decide(request): Promise<ProviderResult>`
  - `ContextBuilder.build(...)`
  - `DecisionGate.accept(providerResult, state): AcceptedDecision | RejectedDecision`

- [ ] **Step 1: Define provider result so raw text has no executable variant**

```ts
export type ProviderResult =
  | { kind: 'structured'; value: unknown; provider: string; mode: 'schema' | 'function_call' }
  | { kind: 'invalid'; code: string; provider: string }
  | { kind: 'timeout'; provider: string }
```

Do not add `{ kind: 'text'; text: string }` to this gameplay interface.

- [ ] **Step 2: Write hard regression tests for the original failure mode**

Fixtures must include:

```text
<think>I should gather wood...</think>{"version":1,...}
I think first... {"version":1,...}
{"version":1,...} done
{"version":1,...}{"version":1,...}
```

Every mixed-text fixture must become `RejectedDecision` or `ProviderResult.kind='invalid'`.

- [ ] **Step 3: Add separate-reasoning success fixture**

Simulate a provider SDK result where reasoning exists in a distinct provider-only field and final function arguments are separate. The adapter fixture discards reasoning and returns only `kind:'structured'`.

Assert the accepted decision object contains no reasoning string and telemetry contains no reasoning string.

- [ ] **Step 4: Build bounded context**

Include only:

- current goal;
- health/food/position/dimension;
- relevant nearby players;
- inventory summary;
- bounded recent important events;
- bounded relevant MC memories;
- allowlisted skill descriptions;
- safety constraints.

Do not include raw chunk dumps or full event history.

- [ ] **Step 5: Gate through strict schema + SafetyPolicy**

Order is fixed:

```text
ProviderResult structured
-> DecisionV1Schema.safeParse
-> intent/skill mapping
-> SafetyPolicy
-> GoalRequest
```

Any failure emits `decision_rejected` and starts no goal.

- [ ] **Step 6: Add actuator reachability test**

Use spies on `GoalManager.submit()` and `SkillExecutor.execute()`. Feed every invalid/mixed reasoning fixture and assert both call counts remain zero.

- [ ] **Step 7: Commit**

```bash
npm test
npm run typecheck
git add src/agent fixtures/provider tests/agent
git commit -m "feat: isolate model reasoning from gameplay decisions"
```

**Hard gate:** Do not begin Task 13 unless every reasoning-isolation test passes.

---

### Task 13: Add the first real high-reasoning provider with structured output only

**Phase:** 4

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.env.example`
- Create: `src/agent/gemini-provider.ts`
- Create: `src/agent/chat-renderer.ts`
- Test: `tests/agent/gemini-provider.test.ts`
- Test: `tests/agent/chat-renderer.test.ts`

**Interfaces:**
- Consumes: `DecisionProvider`.
- Produces: Gemini adapter that returns only `ProviderResult` and never returns model free text to gameplay code.

- [ ] **Step 1: Add exact SDK pin and explicit provider configuration**

```bash
npm install @google/genai@2.21.0
```

Add to `.env.example`:

```text
MC_AI_PROVIDER=fake
MC_AI_MODEL=
MC_AI_API_KEY=
```

`fake` remains the default. Real gameplay startup with `MC_AI_PROVIDER=gemini` requires a non-empty model and API key; there is no implicit model fallback.

- [ ] **Step 2: Write mocked-SDK tests before implementation**

Cases:

- separate thought/reasoning part + one final structured function call -> structured PASS;
- final strict JSON-schema result only -> structured PASS;
- plain text answer -> invalid;
- text + structured output in an inseparable response mode -> invalid;
- multiple final calls -> invalid;
- timeout -> timeout;
- SDK exception -> invalid;
- unknown fields -> rejected by DecisionGate.

- [ ] **Step 3: Implement explicit provider capability check**

At startup/provider initialization record:

```ts
interface ProviderCapabilities {
  structuredFinal: boolean
  reasoningSeparated: boolean
}
```

Gameplay mode is enabled only if `structuredFinal === true` and reasoning is either absent or separately typed.

- [ ] **Step 4: Do not use response `.text` as a decision source**

The adapter may inspect SDK-native structured/function-call parts only. Any implementation that calls `response.text` and parses commands/JSON from it fails code review.

- [ ] **Step 5: Separate chat rendering**

`ChatRenderer` accepts semantic outcomes such as:

```ts
{ kind: 'goal_started', intent: 'gather_resource', target: 'oak_log', quantity: 32 }
```

and produces player chat by deterministic templates first. A second small model path may be added later only behind a separate interface that has no actuator access.

- [ ] **Step 6: Live provider validation**

Run a fixed set of 50 decision requests in the high-reasoning mode intended for production. Evidence:

```text
structured final accepted: N
provider invalid: N
schema rejected: N
reasoning leakage to decision object: 0
reasoning leakage to telemetry: 0
reasoning leakage to Minecraft chat: 0
```

Any leakage count above zero blocks the provider.

- [ ] **Step 7: Commit**

```bash
npm test
npm run typecheck
git add package.json package-lock.json .env.example src/agent tests/agent
git commit -m "feat: add structured high-reasoning decision provider"
```

---

### Task 14: Add local Control API and SSE event stream

**Phase:** 5 support

**Files:**
- Create: `src/api/control-server.ts`
- Create: `src/main.ts`
- Modify: `src/config.ts`
- Modify: `package.json`
- Modify: `.env.example`
- Test: `tests/api/control-server.test.ts`

**Interfaces:**
- Produces:
  - `GET /health`
  - `GET /v1/status`
  - `POST /v1/goals`
  - `POST /v1/stop`
  - `GET /v1/memory/search`
  - `GET /v1/events`

- [ ] **Step 1: Write loopback/token security tests**

Assert:

- `127.0.0.1` starts without token;
- `0.0.0.0` without token throws during startup;
- non-loopback with token starts;
- invalid bearer token gets 401.

- [ ] **Step 2: Write asynchronous-goal test**

`POST /v1/goals` returns:

```json
{ "accepted": true, "goal_id": "..." }
```

before the gameplay goal completes.

- [ ] **Step 3: Implement with Node `http`**

Keep the API dependency-free. Apply body size limit and JSON schema validation before GoalManager.

- [ ] **Step 4: Implement SSE**

Send only validated RuntimeEvents. Disconnecting an SSE client must not affect gameplay.

- [ ] **Step 5: Add the composition root**

`src/main.ts` is the only place that wires concrete implementations together. It should:

```text
load validated config
create RuntimeEventBus + recorder
create MCMemory repository
create WorldStateCache
create SafetyPolicy
create MineflayerAdapter
create SkillRegistry/Executor
create GoalManager
create selected DecisionProvider
create ControlServer
connect Minecraft
start HTTP/SSE
```

No other module may construct the entire application graph. Add `"start": "tsx src/main.ts"` to `package.json`.

- [ ] **Step 6: Commit**

```bash
npm test
npm run typecheck
git add src/api src/main.ts src/config.ts package.json .env.example tests/api
git commit -m "feat: add local control api and composition root"
```

---

### Task 15: Prove cooperative gameplay end-to-end

**Phase:** 5

**Files:**
- Create: `tests/scenarios/cooperative-session.test.ts`
- Create: `fixtures/replay/cooperative-session.jsonl`
- Modify: `README.md`

**Interfaces:**
- Uses all prior components.
- Produces a repeatable acceptance scenario and a live-validation checklist.

- [ ] **Step 1: Build deterministic replay scenario**

Sequence:

```text
player enters
follow_player
player says/assigns gather 16 oak logs
decision accepted
gather_resource
inventory reaches 16 logs
return to player/base
deposit or handoff surrogate completes
memory writes base + forest/resource observation + task outcome
resume follow
```

For automated replay, model decisions come from `FakeProvider`.

- [ ] **Step 2: Add real-provider variation**

Replay the same state transitions but obtain only the high-level gather decision from the real provider. Assert the resulting GoalRequest is equivalent to the fake provider's allowed intent.

- [ ] **Step 3: Run 30-minute private-server session**

Required evidence:

```text
uncommanded block destruction: 0
PVP attempts: 0
raw-text decisions executed: 0
reasoning leakage: 0
stuck loops > retry budget: 0
emergency stop failures: 0
goal lifecycle inconsistencies: 0
```

- [ ] **Step 4: Commit**

```bash
npm test
npm run typecheck
git add tests/scenarios fixtures/replay README.md
git commit -m "test: add cooperative minecraft acceptance scenario"
```

---

### Task 16: Add low-power profiling, soak, and chaos gates

**Phases:** 6 and 7

**Files:**
- Create: `scripts/soak.ts`
- Create: `scripts/chaos.ts`
- Create: `docs/operations/pi-deployment.md`
- Test: `tests/scenarios/chaos.test.ts`
- Modify: `README.md`

**Interfaces:**
- Produces measured deployment evidence for Linux x64 and Linux ARM64.

- [ ] **Step 1: Add resource telemetry**

Sample at a low cadence:

```text
process RSS
heap used
event-loop lag
pathfinder planning duration
active goal age
event queue depth
memory row count
AI decision latency
```

Do not send these samples to the AI context by default.

- [ ] **Step 2: Establish baseline budgets from an idle + follow + gather run**

Run the same scenario on mini PC and Raspberry Pi-class ARM64 hardware. Record p50/p95/max rather than inventing fixed numbers before measurement.

The pass rule is:

- no sustained memory growth after warm-up;
- no event-loop starvation that causes gameplay timeouts;
- pathfinder respects its configured time/search budgets;
- CPU/RSS measurements are documented for both hardware classes.

- [ ] **Step 3: Implement chaos injections**

Automated fake-adapter cases:

```text
server disconnect
server restart
pathfinder stuck
target disappears
inventory full
bot dies
AI timeout
AI invalid mixed reasoning output
memory repository unavailable
SSE client disconnect storm
```

Every case must converge to a defined state rather than hang.

- [ ] **Step 4: Run 4-8 hour soak**

At minimum capture:

```text
start/end RSS
max RSS
goal counts by outcome
reconnect count
stuck count
AI rejected decision count
reasoning leakage count
uncaught exceptions
memory row growth
```

- [ ] **Step 5: Write Pi deployment instructions**

Include Node 24 ARM64 install verification, service environment, loopback API default, systemd unit outline, log location, and rollback procedure. Do not include credentials.

- [ ] **Step 6: Commit**

```bash
npm test
npm run typecheck
git add scripts docs/operations tests/scenarios README.md
git commit -m "test: add low-power soak and chaos gates"
```

---

### Task 17: Build a mock Moxue adapter and enforce the DC_BOT integration gate

**Phases:** 8 and 9

**Files:**
- Create: `tests/api/moxue-mock-adapter.test.ts`
- Create: `docs/contracts/moxue-integration-v1.md`
- Modify: `README.md`

**Interfaces:**
- Consumes only MC_AI_Player HTTP/SSE contract.
- Produces the proposed future DC_BOT adapter contract without modifying DC_BOT.

- [ ] **Step 1: Write mock adapter**

The mock may call only:

```text
GET  /health
GET  /v1/status
POST /v1/goals
POST /v1/stop
GET  /v1/memory/search
GET  /v1/events
```

It must not import any MC_AI_Player internal module.

- [ ] **Step 2: Test process separation**

Start MC_AI_Player as a child process, point the mock adapter at the HTTP API, assign a fake/replay goal, consume SSE, stop the process, restart it, and verify memory/status behavior through the public contract only.

- [ ] **Step 3: Write future Moxue contract document**

Proposed future DC_BOT tool actions:

```text
status
assign_goal
emergency_stop
recall
```

Long-running actions return immediately with `goal_id`.

Minecraft spontaneous events remain a separate future EventBridge design and are not implemented in DC_BOT by this plan.

- [ ] **Step 4: Run the final standalone gate checklist**

All must be true before any DC_BOT write is allowed:

```text
DC_BOT changes during project: 0
DC_BOT DB dependency: 0
Discord token dependency: 0
baseline OCR dependency: 0
free-text command parsing: 0
raw model text -> actuator paths: 0
reasoning -> player chat leaks: 0
reasoning -> telemetry leaks: 0
invalid decisions fail closed: PASS
deterministic no-AI gameplay: PASS
memory restart: PASS
reconnect: PASS
30-minute cooperative E2E: PASS
4-8 hour soak: PASS
ARM64 profile: PASS or explicit hardware blocker
mock Moxue adapter: PASS
```

- [ ] **Step 5: Do not modify DC_BOT yet**

If the gate passes, stop this implementation plan. Start a new Superpowers Architectural design specifically for the DC_BOT integration PR. That separate design must re-read the then-current DC_BOT Tool Gateway, Agent Coordinator, and Memory contracts before proposing changes.

- [ ] **Step 6: Commit**

```bash
npm test
npm run typecheck
git add tests/api/moxue-mock-adapter.test.ts docs/contracts/moxue-integration-v1.md README.md
git commit -m "docs: define moxue integration gate"
```

---

## Mandatory execution order

```text
Task 1  bootstrap/probe
  ↓
Task 2  contracts
  ↓
Task 3  telemetry/replay
  ↓
Task 4  fake adapter/state
  ↓
Task 5  observation-only Mineflayer
  ↓
Task 6  safety
  ↓
Task 7  goal/skill runtime
  ↓
Task 8  navigation
  ↓
Task 9  survival/inventory
  ↓
Task 10 deterministic gathering
  ↓
Task 11 MC memory
  ↓
Task 12 reasoning isolation gate
  ↓ HARD GATE
Task 13 real high-reasoning provider
  ↓
Task 14 control API/SSE
  ↓
Task 15 cooperative E2E
  ↓
Task 16 low-power + soak + chaos
  ↓
Task 17 mock Moxue integration
  ↓
STOP — new design required before touching DC_BOT
```

## Review gates between tasks

Each task is independently reviewable. Before moving to the next task:

1. Run the exact task tests plus full `npm test`.
2. Run `npm run typecheck`.
3. Review `git diff --check`.
4. Review the changed-file diff for accidental DC_BOT paths, secrets, free-text decision parsing, or hidden-reasoning persistence.
5. Commit only after the evidence is clean.

## Special review gate for Task 12 -> Task 13

Task 13 is forbidden until fresh test output proves all of these:

```text
mixed text + JSON rejected
<think> + JSON rejected
multiple decisions rejected
unknown reasoning fields rejected
separate reasoning + final structured call accepted
raw provider text never reaches GoalManager
raw provider text never reaches SkillExecutor
reasoning never reaches telemetry/replay
reasoning never reaches ChatRenderer
invalid provider output starts zero new goals
```

## Plan completion definition

This plan is complete only when Task 17's gate has evidence. Completion of this plan does **not** authorize automatic DC_BOT modification; it authorizes starting a separate integration design review.
