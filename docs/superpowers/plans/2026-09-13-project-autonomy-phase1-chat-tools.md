# Project Autonomy Phase 1: Chat Feedback and Automatic Tool Use Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make current one-goal gameplay visibly acknowledge/complete in Minecraft chat and make resource gathering automatically equip a suitable available tool before digging.

**Architecture:** Add a bounded chat-output method to the existing Minecraft adapter, then subscribe a small `ChatFeedbackController` to authoritative goal lifecycle events and render only safe deterministic messages through the existing `ChatRenderer`. Add a pure deterministic harvest-tool selector and call it inside `MineflayerGatheringRuntime` immediately before `bot.dig`; no extra Gemini call is introduced.

**Tech Stack:** TypeScript 7, Node.js 24, Mineflayer 4.39, Zod 4.5.4, node:test/tsx.

**Spec:** `docs/superpowers/specs/2026-09-13-project-autonomy-construction-design.md`

## Global Constraints

- No model call is used to phrase routine ACK/COMPLETE/FAILURE chat.
- Chat output never includes provider errors, prompts, secrets, raw reasoning, coordinates, UUIDs, or internal policy details.
- Existing `ChatRenderer` remains the text boundary and keeps its 180-character default cap.
- Gathering keeps the existing `ResourceMutationPermit` check before world mutation.
- If no suitable tool exists, gathering may still use the hand when the block is legally diggable.
- Tool selection must not make generic navigation capable of digging/building.
- Full suite and typecheck must pass after each task.

---

## File structure

- Modify `src/minecraft/adapter.ts` — expose bounded chat output on `MinecraftAdapter`.
- Modify `src/minecraft/mineflayer-adapter.ts` — implement `sendChat()` through the ready Mineflayer bot.
- Modify `src/minecraft/fake-adapter.ts` — record sent chat for deterministic tests.
- Create `src/agent/chat-feedback.ts` — translate goal lifecycle events into `ChatRenderer` outcomes with deduplication.
- Modify `src/main.ts` — wire the feedback controller to production events and dispose it on shutdown.
- Create `src/minecraft/tool-selection.ts` — pure harvest-tool ranking policy.
- Modify `src/minecraft/mineflayer-gathering.ts` — calculate/equip selected tool before `bot.dig`.
- Test `tests/agent/chat-feedback.test.ts`.
- Test `tests/minecraft/mineflayer-adapter.test.ts`.
- Test `tests/minecraft/fake-adapter.test.ts`.
- Test `tests/minecraft/tool-selection.test.ts`.
- Test `tests/minecraft/mineflayer-gathering.test.ts`.
- Modify `tests/main.test.ts` or create `tests/main-chat-feedback.test.ts` for production wiring.

---

### Task 1: Add a bounded Minecraft chat output port

**Files:**
- Modify: `src/minecraft/adapter.ts`
- Modify: `src/minecraft/mineflayer-adapter.ts`
- Modify: `src/minecraft/fake-adapter.ts`
- Test: `tests/minecraft/mineflayer-adapter.test.ts`
- Test: `tests/minecraft/fake-adapter.test.ts`

**Interfaces:**
- Consumes: existing spawned/ready Mineflayer bot lifecycle.
- Produces: `MinecraftAdapter.sendChat(message: string): Promise<boolean>`; returns `true` only when a ready bot accepted the bounded message for sending.

- [ ] **Step 1: Write the failing Mineflayer adapter chat tests**

Add tests that expect a ready bot to receive one bounded message and an unspawned/disconnected adapter to return `false` without calling `bot.chat`.

```ts
const sent: string[] = []
const bot = createFakeBot({
  chat(message: string) {
    sent.push(message)
  }
})

await adapter.connect()
bot.emit('spawn')

assert.equal(await adapter.sendChat('完成了。'), true)
assert.deepEqual(sent, ['完成了。'])
```

Also assert validation:

```ts
await assert.rejects(
  () => adapter.sendChat(' '.repeat(2)),
  /chat message must be non-empty/
)
await assert.rejects(
  () => adapter.sendChat('x'.repeat(257)),
  /chat message must be at most 256 characters/
)
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
npm test -- tests/minecraft/mineflayer-adapter.test.ts tests/minecraft/fake-adapter.test.ts
```

Expected: compile/test failure because `MinecraftAdapter.sendChat` does not exist.

- [ ] **Step 3: Add the interface and Mineflayer implementation**

In `src/minecraft/adapter.ts` add:

```ts
export interface MinecraftAdapter {
  connect(): Promise<void>
  disconnect(): Promise<void>
  sendChat(message: string): Promise<boolean>
  goTo(position: Position, options: NavigationOptions, signal: AbortSignal): Promise<SkillResult>
  followPlayer(player: string, range: number, signal: AbortSignal): Promise<SkillResult>
  holdPosition(signal: AbortSignal): Promise<SkillResult>
  stopMotion(): Promise<void>
  onEvent(listener: MinecraftEventListener): () => void
}
```

In `MineflayerAdapter` implement:

```ts
async sendChat(message: string): Promise<boolean> {
  const normalized = message.trim()
  if (!normalized) throw new TypeError('chat message must be non-empty')
  if (normalized.length > 256) throw new RangeError('chat message must be at most 256 characters')

  const bot = this.readyBot()
  if (!bot) return false
  bot.chat(normalized)
  return true
}
```

The fake adapter should append normalized messages to a public/read-only test-visible array such as `sentChatMessages` and return `false` when its fake connection/spawn state is not ready.

- [ ] **Step 4: Run focused tests and typecheck**

```powershell
npm test -- tests/minecraft/mineflayer-adapter.test.ts tests/minecraft/fake-adapter.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/minecraft/adapter.ts src/minecraft/mineflayer-adapter.ts src/minecraft/fake-adapter.ts tests/minecraft/mineflayer-adapter.test.ts tests/minecraft/fake-adapter.test.ts
git commit -m "feat: add bounded Minecraft chat output"
```

---

### Task 2: Wire deterministic lifecycle chat feedback

**Files:**
- Create: `src/agent/chat-feedback.ts`
- Modify: `src/main.ts`
- Test: `tests/agent/chat-feedback.test.ts`
- Test: `tests/main-chat-feedback.test.ts`

**Interfaces:**
- Consumes: `RuntimeEventBus`, `GoalManager.getGoal(goalId)`, existing `ChatRenderer`, `MinecraftAdapter.sendChat`.
- Produces: `ChatFeedbackController.start(): void`, `dispose(): void`.

- [ ] **Step 1: Write RED tests for started/completed/failed messages and deduplication**

Define a fake goal lookup containing:

```ts
{
  goalId: 'g1',
  request: { kind: 'gather_resource', args: { resource: 'oak_log', quantity: 16 } },
  status: 'running',
  source: 'ai',
  createdAt: 1,
  updatedAt: 1
}
```

Assert event translations:

```ts
await events.publish({ type: 'goal_started', at: 1, goalId: 'g1' })
assert.deepEqual(messages, ['好，我去找 16 個 oak_log。'])

await events.publish({ type: 'goal_completed', at: 2, goalId: 'g1' })
assert.deepEqual(messages, ['好，我去找 16 個 oak_log。', '完成了。'])
```

For `goal_failed`, assert `這次沒有完成。`. Publish the same event twice and assert only one message is sent for the same `(type, goalId, code)` fingerprint.

Do not emit chat for `goal_cancelled` with `superseded_by_ai_task`; that transition is internal and would create noise when the user changes commands.

- [ ] **Step 2: Run the focused test and verify RED**

```powershell
npm test -- tests/agent/chat-feedback.test.ts
```

Expected: module not found / controller not defined.

- [ ] **Step 3: Implement `ChatFeedbackController`**

Use this shape:

```ts
export interface ChatFeedbackGoalPort {
  getGoal(goalId: string): GoalRecord | undefined
}

export interface ChatFeedbackOutputPort {
  sendChat(message: string): Promise<boolean>
}

export class ChatFeedbackController {
  constructor(options: {
    events: RuntimeEventBus
    goals: ChatFeedbackGoalPort
    output: ChatFeedbackOutputPort
    renderer?: ChatRenderer
  }) {}

  start(): void
  dispose(): void
}
```

Map request args safely:

```ts
function startedOutcome(goal: GoalRecord): ChatOutcome {
  switch (goal.request.kind) {
    case 'gather_resource':
      return {
        kind: 'goal_started',
        intent: goal.request.kind,
        target: goal.request.args.resource,
        quantity: goal.request.args.quantity
      }
    case 'follow_player':
      return {
        kind: 'goal_started',
        intent: goal.request.kind,
        target: goal.request.args.player
      }
    default:
      return { kind: 'goal_started', intent: goal.request.kind }
  }
}
```

Contain output failures with `void output.sendChat(...).catch(() => {})`; chat failure must never stop gameplay.

- [ ] **Step 4: Wire it in `createApplication()`**

After `GoalManager`/event bus/runtime exist, construct and start one controller:

```ts
const chatFeedback = new ChatFeedbackController({
  events,
  goals,
  output: runtime.adapter
})
chatFeedback.start()
```

Dispose it during application shutdown before the adapter disconnects:

```ts
chatFeedback.dispose()
```

Add an integration test with a fake runtime adapter proving one `goal_started` and one `goal_completed` produce exactly two chat messages and that application close does not emit an extra message.

- [ ] **Step 5: Run focused tests, full suite, and typecheck**

```powershell
npm test -- tests/agent/chat-feedback.test.ts tests/main-chat-feedback.test.ts tests/agent/chat-renderer.test.ts
npm test
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent/chat-feedback.ts src/main.ts tests/agent/chat-feedback.test.ts tests/main-chat-feedback.test.ts
git commit -m "feat: report goal lifecycle in Minecraft chat"
```

---

### Task 3: Add a pure deterministic harvest-tool selector

**Files:**
- Create: `src/minecraft/tool-selection.ts`
- Test: `tests/minecraft/tool-selection.test.ts`

**Interfaces:**
- Consumes: candidates computed from live Mineflayer inventory/block dig-time data.
- Produces:

```ts
export interface HarvestToolCandidate {
  readonly name: string
  readonly itemType: number
  readonly digTimeMs: number
  readonly durabilityRemaining: number | null
  readonly maxDurability: number | null
}

export interface HarvestToolPolicy {
  readonly minimumDurabilityReserve: number
  readonly preserveFraction: number
}

export function selectHarvestTool(
  candidates: readonly HarvestToolCandidate[],
  bareHandDigTimeMs: number,
  policy?: Partial<HarvestToolPolicy>
): HarvestToolCandidate | null
```

- [ ] **Step 1: Write RED selector tests**

Cover:

```ts
assert.equal(
  selectHarvestTool([
    { name: 'iron_axe', itemType: 1, digTimeMs: 400, durabilityRemaining: 120, maxDurability: 250 },
    { name: 'wooden_axe', itemType: 2, digTimeMs: 900, durabilityRemaining: 50, maxDurability: 59 }
  ], 3000)?.name,
  'iron_axe'
)
```

Also cover:

- no candidate faster than bare hand -> `null`;
- fastest candidate below the reserve threshold is skipped when a healthy slower candidate exists;
- all candidates below reserve -> choose `null` rather than destroy a protected-last-use tool;
- `NaN`, negative, or zero dig times are rejected from ranking;
- deterministic tie break: lower `digTimeMs`, then higher durability fraction, then lexical `name`.

- [ ] **Step 2: Run focused test and verify RED**

```powershell
npm test -- tests/minecraft/tool-selection.test.ts
```

Expected: module missing.

- [ ] **Step 3: Implement the minimal selector**

Default policy:

```ts
const DEFAULT_POLICY: HarvestToolPolicy = {
  minimumDurabilityReserve: 8,
  preserveFraction: 0.05
}
```

A candidate is healthy when either durability is unknown or:

```ts
const reserve = Math.max(
  policy.minimumDurabilityReserve,
  Math.ceil((candidate.maxDurability ?? 0) * policy.preserveFraction)
)
const healthy = candidate.durabilityRemaining === null || candidate.durabilityRemaining > reserve
```

Only candidates with finite positive `digTimeMs < bareHandDigTimeMs` participate.

- [ ] **Step 4: Run focused tests and typecheck**

```powershell
npm test -- tests/minecraft/tool-selection.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/minecraft/tool-selection.ts tests/minecraft/tool-selection.test.ts
git commit -m "feat: select harvest tools deterministically"
```

---

### Task 4: Equip the selected tool before resource digging

**Files:**
- Modify: `src/minecraft/mineflayer-gathering.ts`
- Test: `tests/minecraft/mineflayer-gathering.test.ts`
- Test: `tests/minecraft/gathering-live.e2e.test.ts`

**Interfaces:**
- Consumes: `selectHarvestTool()` from Task 3.
- Produces: existing `harvestResourceBlock()` behavior plus deterministic equip-before-dig.

- [ ] **Step 1: Write RED gathering tests**

Extend the fake bot/block so the block exposes a deterministic `digTime(itemType)` result and inventory has `iron_axe` plus irrelevant items. Record calls to `bot.equip` and `bot.dig`.

Assert order:

```ts
assert.deepEqual(calls, [
  'equip:iron_axe:hand',
  'dig:oak_log'
])
```

Add cases:

- no useful tool -> no equip call, existing dig still occurs;
- selected tool vanishes before equip -> return `tool_unavailable` without digging;
- equip throws/disconnects -> return `tool_equip_failed` or `disconnected` without digging;
- abort after equip -> cancelled without digging;
- low-durability valuable candidate is not chosen when a healthy alternative exists.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
npm test -- tests/minecraft/mineflayer-gathering.test.ts
```

Expected: tests fail because gathering calls `bot.dig` directly.

- [ ] **Step 3: Add Mineflayer candidate extraction and equip step**

Immediately after validating the target block and before the `before = inventoryCount(...)` snapshot, compute bare-hand and item dig times from the live block. Convert each inventory item to a `HarvestToolCandidate` using registry durability where available. Call `selectHarvestTool`.

Use a helper with this contract so Mineflayer-specific metadata stays contained:

```ts
function harvestToolCandidates(bot: Bot, block: any): HarvestToolCandidate[]
```

If a tool is selected, re-find the live inventory stack by `name` and `type`, then:

```ts
try {
  await bot.equip(item, 'hand')
} catch (error) {
  if (signal.aborted) return cancelled(signal)
  if (disconnected) return { status: 'failed', code: 'disconnected' }
  return { status: 'failed', code: 'tool_equip_failed' }
}
```

Do not alter `ResourceMutationPermit` validation.

- [ ] **Step 4: Run focused tests, existing gathering regressions, full suite, and typecheck**

```powershell
npm test -- tests/minecraft/tool-selection.test.ts tests/minecraft/mineflayer-gathering.test.ts tests/skills/gathering.test.ts tests/skills/gathering-live-regressions.test.ts tests/minecraft/gathering-approach-regressions.test.ts
npm test
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/minecraft/mineflayer-gathering.ts tests/minecraft/mineflayer-gathering.test.ts tests/minecraft/gathering-live.e2e.test.ts
git commit -m "feat: equip suitable tools while gathering"
```

---

### Task 5: Private-server live validation for Phase 1

**Files:**
- Modify: `docs/superpowers/plans/2026-09-13-project-autonomy-phase1-chat-tools.md` only to append measured evidence after the run.

**Interfaces:**
- Consumes: completed Tasks 1-4.
- Produces: human-observed PASS/FAIL evidence; no production behavior change.

- [ ] **Step 1: Restart MC_AI_Player from the Phase 1 implementation HEAD**

```powershell
cd D:\MC_AI_player-worktrees\project-autonomy-construction
node --env-file=.env --import tsx src/main.ts
```

- [ ] **Step 2: Verify chat lifecycle with existing commands**

In Minecraft send:

```text
墨雪，待在這裡
墨雪，跟著我
墨雪，幫我挖 4 個木頭
```

Expected:

- each accepted command gets one concise ACK in Minecraft chat;
- completed finite gather gets one completion line;
- superseding `stay`/`follow` does not spam cancellation messages;
- no raw event/provider/error details appear in chat.

- [ ] **Step 3: Verify automatic tool use**

Give Moxue an axe and a non-tool item, then ask for logs. Observe that she visibly equips the axe before breaking logs and still completes the gather task. Repeat once without an axe and verify the gather path still behaves safely rather than failing solely because no tool exists.

- [ ] **Step 4: Record evidence and final verification**

```powershell
npm test
npm run typecheck
git status --short
```

Append a dated PASS/FAIL evidence section containing only safe observations and commit it:

```bash
git add docs/superpowers/plans/2026-09-13-project-autonomy-phase1-chat-tools.md
git commit -m "docs: record phase 1 live validation"
```

Phase 1 is complete only when automated tests/typecheck pass and both chat feedback and tool-use live checks pass.
