# Gemini Multi-Model Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Review gate:** The architecture/spec is approved. This implementation plan is complete and self-reviewed, but implementation must not begin until the user explicitly approves this plan.

**Goal:** Implement the approved deterministic Gemini Lite/Flash routing architecture, including trusted manual deep-think, an ordered Google Project pool, durable quota accounting, a production decision coordinator, and a loopback-only Admin API without weakening deterministic gameplay or SafetyPolicy boundaries.

**Architecture:** DecisionCoordinator owns when a logical AI decision is needed and builds the latest task-aware context. A deterministic instruction analyzer plus `balanced-v1` policy produces an immutable RoutePlan. RoutedDecisionExecutor owns Project selection, quota admission, retries/failover, and Gemini transport attempts; its routing details never leak back into Coordinator. Gemini proposes only validated high-level outcomes, while registered-skill checks, SafetyPolicy, GoalManager, and SkillExecutor remain deterministic authorities.

**Tech Stack:** Node.js 24, TypeScript 7.0.2, tsx 4.23.13, Zod 4.5.4, better-sqlite3 12.11.1, Mineflayer 4.39.0, mineflayer-pathfinder 2.4.5, @google/genai 2.21.0, Node built-in HTTP, `Intl.DateTimeFormat` for `America/Los_Angeles`, Node test runner through `tsx --test`.

**Spec:** `docs/superpowers/specs/2026-09-12-gemini-multi-model-routing-design.md`

## Global Constraints

- Work only on `feature/gemini-multi-model-routing`; protected `main` changes only by PR merge.
- At implementation time create/use an isolated worktree with `superpowers:using-git-worktrees`; do not implement in the main checkout.
- `neko0115/DC_BOT` is out of scope and must not be modified.
- `MC_AI_PROVIDER=fake` remains the safe default and requires no routing file, Google credential, Admin token, or production quota DB.
- `MC_AI_PROVIDER=gemini` requires a valid `data/ai-routing.json` (or `MC_AI_ROUTING_CONFIG`) and every referenced credential environment variable; missing data fails startup closed.
- Routine: `gemini-3.5-flash-lite` + `low`. Complex: `gemini-3.8-flash` + `medium`. High only for trusted manual deep-think, `consecutive_replan_count >= 2`, or trusted deterministic critical context.
- Automatic routing never uses Flash reserve. Reserve requires a valid ManualRouteGrant or local-admin authority.
- Flash budget is per Project: first 70% normal, final 30% reserve. One attempt is wholly `normal` or `reserve`.
- Credential health key: stable anonymous `projectKey`. Quota key: `projectKey + model`.
- Quota values are deployment input. Missing admission-critical limits fail closed; production values are never inferred or hard-coded.
- `data/ai-quota.sqlite3` is independent from `data/mc_memory.sqlite3` and never stores prompts, chat, task objectives, raw API keys, real Google Project IDs, privileged UUIDs, raw provider bodies, or thought text.
- Reservation and `dispatched` state are durable before HTTP send.
- Gemini SDK automatic retry is disabled: one AttemptLease equals one actual provider attempt.
- Provider `content_blocked` and local SafetyPolicy rejection are terminal; no failover may be used to bypass them.
- Runtime events never call Gemini directly; they update state/evidence or enqueue Coordinator work.
- AiTask, DecisionDemand, task queue, ManualRouteGrant, and in-flight decisions are volatile and never replay after restart.
- Minecraft username is never a privileged credential. Offline server identity mode always yields untrusted chat principals.
- Admin API is a separate loopback-only listener and also requires `MC_ADMIN_TOKEN`.
- Existing release gates remain evidence-driven: real Gemini live validation, production coordinator validation, 30-minute human collaboration, Pi/mini-PC measurement, 4–8h soak, missing home/storage skill wiring, and later DC_BOT integration.

---

## Pre-flight before Task 1

Run from the isolated feature worktree:

```powershell
npm ci
npm test
npm run typecheck
git status --short
git branch --show-current
```

Expected:

```text
all existing tests PASS
typecheck PASS
git status clean
feature/gemini-multi-model-routing
```

If baseline is red, stop feature implementation and diagnose it first.

---

## Locked file map

```text
src/
├─ config.ts
├─ main.ts
├─ contracts/
│  ├─ decision.ts
│  ├─ events.ts
│  ├─ goals.ts
│  └─ skills.ts
├─ agent/
│  ├─ provider.ts
│  ├─ context-builder.ts
│  ├─ decision-gate.ts
│  ├─ fake-provider.ts
│  ├─ skill-catalog.ts
│  ├─ providers/
│  │  └─ gemini.ts
│  └─ routing/
│     ├─ contracts.ts
│     ├─ config.ts
│     ├─ config-manager.ts
│     ├─ complexity.ts
│     ├─ provider-day.ts
│     ├─ quota-ledger.ts
│     ├─ project-pool.ts
│     ├─ error-policy.ts
│     └─ routed-executor.ts
├─ runtime/
│  ├─ ai-task.ts
│  ├─ trigger-classifier.ts
│  ├─ decision-coordinator.ts
│  └─ goal-execution-loop.ts
├─ minecraft/
│  ├─ identity-registry.ts
│  ├─ manual-ai-command.ts
│  ├─ adapter.ts
│  ├─ observation-bridge.ts
│  └─ mineflayer-adapter.ts
├─ goals/
│  └─ goal-manager.ts
├─ skills/
│  ├─ registry.ts
│  └─ executor.ts
└─ api/
   ├─ control-server.ts
   └─ admin-server.ts

config/
└─ ai-routing.example.json

tests/
├─ contracts/events.test.ts
├─ agent/routing/
│  ├─ config.test.ts
│  ├─ config-manager.test.ts
│  ├─ complexity.test.ts
│  ├─ provider-day.test.ts
│  ├─ quota-ledger.test.ts
│  ├─ project-pool.test.ts
│  ├─ error-policy.test.ts
│  └─ routed-executor.test.ts
├─ agent/providers/gemini.test.ts
├─ agent/decision-gate.test.ts
├─ agent/context-builder.test.ts
├─ skills/registry.test.ts
├─ minecraft/identity-registry.test.ts
├─ minecraft/manual-ai-command.test.ts
├─ runtime/ai-task.test.ts
├─ runtime/trigger-classifier.test.ts
├─ runtime/decision-coordinator.test.ts
├─ api/admin-server.test.ts
├─ api/control-server.test.ts
└─ scenarios/gemini-routing-coordinator.test.ts

scripts/
└─ validate-gemini-routing-live.ts
```

Do not add a broad `utils.ts`; behavior belongs beside its owner.

---

### Task 1: Replace legacy single-model authority with routing-config contracts

**Files:**
- Modify: `src/config.ts`
- Create: `src/agent/routing/config.ts`
- Modify: `tests/agent/provider-config.test.ts`
- Create: `tests/agent/routing/config.test.ts`
- Create: `config/ai-routing.example.json`
- Modify: `.env.example`

**Interfaces:**
- `AiConfig = {provider:'fake'} | {provider:'gemini'; routingConfigPath:string}`.
- `loadMinecraftServerIdentityMode(): 'online' | 'offline'`.
- `AdminApiConfig = {enabled:false} | {enabled:true; host:'127.0.0.1'; port:number; bearerToken:string}`.
- `parseRoutingConfig(raw): ValidatedRoutingConfig` contains `apiKeyEnv`, never key material.

- [ ] **Step 1: Rewrite RED provider-config tests**

```ts
test('fake provider remains secret-free and routing-file-free', () => {
  assert.deepEqual(loadAiConfig({}), { provider: 'fake' })
})

test('gemini uses routing-file authority, not legacy model/key values', () => {
  assert.deepEqual(loadAiConfig({
    MC_AI_PROVIDER: 'gemini',
    MC_AI_MODEL: 'ignored-model',
    MC_AI_API_KEY: 'ignored-key'
  }), { provider: 'gemini', routingConfigPath: 'data/ai-routing.json' })
})

test('identity mode fails closed to offline', () => {
  assert.equal(loadMinecraftServerIdentityMode({}), 'offline')
  assert.equal(loadMinecraftServerIdentityMode({ MC_SERVER_IDENTITY_MODE: 'online' }), 'online')
  assert.equal(loadMinecraftServerIdentityMode({ MC_SERVER_IDENTITY_MODE: 'bad' }), 'offline')
})

test('admin API is disabled without its dedicated token', () => {
  assert.deepEqual(loadAdminApiConfig({}), { enabled: false })
  assert.deepEqual(loadAdminApiConfig({ MC_ADMIN_TOKEN: 'secret', MC_ADMIN_PORT: '8767' }), {
    enabled: true, host: '127.0.0.1', port: 8767, bearerToken: 'secret'
  })
})
```

- [ ] **Step 2: Run RED**

```powershell
npx tsx --test tests/agent/provider-config.test.ts
```

Expected: FAIL on new config types/loaders and legacy Gemini requirements.

- [ ] **Step 3: Implement startup loaders**

```ts
export type MinecraftServerIdentityMode = 'online' | 'offline'
export type AiConfig =
  | { readonly provider: 'fake' }
  | { readonly provider: 'gemini'; readonly routingConfigPath: string }
export type AdminApiConfig =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly host: '127.0.0.1'; readonly port: number; readonly bearerToken: string }
```

`MC_AI_ROUTING_CONFIG` defaults to `data/ai-routing.json`; `MC_SERVER_IDENTITY_MODE` returns online only for exact normalized `online`; Admin host is fixed to `127.0.0.1`, port range `1..65535`, token max 4096 chars, and absent token means disabled. Legacy `MC_AI_MODEL` / `MC_AI_API_KEY` are ignored as routing authority.

- [ ] **Step 4: Write RED routing-schema tests**

Use this valid shape and mutate one constraint per test:

```ts
const valid = {
  version: 1,
  models: {
    routine: { name: 'gemini-3.5-flash-lite', reservation: { inputTokenOverhead: 256, generationTokenAllowance: { low: 512 } } },
    complex: { name: 'gemini-3.8-flash', reservation: { inputTokenOverhead: 256, generationTokenAllowance: { medium: 2048, high: 4096 } } }
  },
  projects: [{
    projectKey: 'pool-a', apiKeyEnv: 'MC_AI_KEY_PRIMARY',
    providerLimits: {
      routine: { rpm: 10, inputTpm: 10000, rpd: 100 },
      complex: { rpm: 10, inputTpm: 10000, rpd: 100 }
    },
    flashBudget: { requestLimit: 80, totalTokenLimit: 100000, resetWindow: 'america-los-angeles-day', source: 'operator_policy' }
  }],
  manualAccess: {
    ownerUuid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    operatorAllowlistUuids: ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']
  }
}
```

Assert duplicate projectKey, zero/negative limits, malformed UUID, unknown fields, empty project pool, and `flashBudget.requestLimit > complex.rpd` fail.

- [ ] **Step 5: Implement strict Zod + semantic validation**

Normalize privileged UUIDs to lowercase 32-hex. Require unique projectKey and nonempty `apiKeyEnv`. Keep all quota/reservation numbers positive integers. Reject unknown keys via `.strict()`.

- [ ] **Step 6: Run GREEN + typecheck**

```powershell
npx tsx --test tests/agent/provider-config.test.ts tests/agent/routing/config.test.ts
npm run typecheck
```

- [ ] **Step 7: Add safe examples**

`.env.example` adds `MC_AI_ROUTING_CONFIG`, `MC_SERVER_IDENTITY_MODE`, `MC_AI_KEY_PRIMARY`, `MC_AI_KEY_BACKUP`, `MC_ADMIN_PORT`, `MC_ADMIN_TOKEN`; marks `MC_AI_MODEL` and `MC_AI_API_KEY` deprecated/ignored. `config/ai-routing.example.json` uses anonymous project keys, fake UUIDs, environment-variable names, and clearly illustrative non-production quota values.

- [ ] **Step 8: Commit**

```powershell
git add src/config.ts src/agent/routing/config.ts tests/agent/provider-config.test.ts tests/agent/routing/config.test.ts config/ai-routing.example.json .env.example
git commit -m "feat: define multi-model routing configuration"
```

---

### Task 2: Separate cancellation from failure and carry current-session identity evidence

**Files:**
- Modify: `src/contracts/events.ts`
- Modify: `src/goals/goal-manager.ts`
- Modify: `src/skills/executor.ts`
- Modify: `src/minecraft/observation-bridge.ts`
- Modify: `src/minecraft/mineflayer-adapter.ts`
- Create: `tests/contracts/events.test.ts`
- Modify: `tests/goals/goal-manager.test.ts`
- Modify: `tests/skills/executor.test.ts`
- Modify: `tests/minecraft/observation-bridge.test.ts`
- Modify: `tests/minecraft/mineflayer-adapter.test.ts`

**Interfaces:** Adds RuntimeEvent branches `player_left`, `goal_cancelled`, `skill_cancelled`; `player_chat` gains optional `playerId`.

- [ ] **Step 1: Add RED event/cancellation tests**

```ts
assert.deepEqual(bridge.chat('Boss', '墨雪跟我來', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), {
  type: 'player_chat', at: 1234, player: 'Boss', playerId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', message: '墨雪跟我來'
})
assert.deepEqual(bridge.playerLeft('Boss', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), {
  type: 'player_left', at: 1234, player: 'Boss', playerId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
})
```

GoalManager player preemption must emit `goal_cancelled`, not `goal_failed`. Aborted SkillExecutor work must emit `skill_cancelled`, not `skill_failed`.

- [ ] **Step 2: Run RED**

```powershell
npx tsx --test tests/contracts/events.test.ts tests/goals/goal-manager.test.ts tests/skills/executor.test.ts tests/minecraft/observation-bridge.test.ts tests/minecraft/mineflayer-adapter.test.ts
```

- [ ] **Step 3: Add strict event branches**

Use bounded `EventCodeSchema` max 128 chars; player names max 64, IDs max 128, chat max 1000. Add strict schemas for `player_left`, `goal_cancelled`, `skill_cancelled`.

- [ ] **Step 4: Split completion/cancellation/failure publishing**

SkillExecutor publishes one of completed/cancelled/failed. GoalManager publishes `goal_cancelled` for cancelled result, player preemption, emergency stop cancellation, and continuous-goal supersession; only true failed results publish `goal_failed`.

- [ ] **Step 5: Carry current UUID evidence**

At chat event time use `bot.players[username]?.uuid`; emit through `ObservationBridge.chat(username,message,playerId)`. Add Mineflayer `playerLeft` listener and `ObservationBridge.playerLeft()`.

- [ ] **Step 6: Run GREEN + typecheck**

```powershell
npx tsx --test tests/contracts/events.test.ts tests/goals/goal-manager.test.ts tests/skills/executor.test.ts tests/minecraft/observation-bridge.test.ts tests/minecraft/mineflayer-adapter.test.ts
npm run typecheck
```

- [ ] **Step 7: Commit**

```powershell
git add src/contracts/events.ts src/goals/goal-manager.ts src/skills/executor.ts src/minecraft/observation-bridge.ts src/minecraft/mineflayer-adapter.ts tests/contracts/events.test.ts tests/goals/goal-manager.test.ts tests/skills/executor.test.ts tests/minecraft/observation-bridge.test.ts tests/minecraft/mineflayer-adapter.test.ts
git commit -m "refactor: separate runtime cancellation events"
```

---

### Task 3: Upgrade decision contract and make context task-aware

**Files:**
- Modify: `src/contracts/decision.ts`
- Modify: `src/agent/context-builder.ts`
- Modify: `src/skills/registry.ts`
- Create: `src/agent/skill-catalog.ts`
- Modify: `tests/contracts/decision.test.ts`
- Modify: `tests/agent/context-builder.test.ts`
- Create: `tests/skills/registry.test.ts`

**Interfaces:** Produces `DecisionOutcomeV2Schema`, `DecisionOutcomeV2`, `DecisionContext.task`, `SkillRegistry.has()`, `registeredNames()`, `registeredDecisionSkills()`.

- [ ] **Step 1: Write RED outcome tests**

```ts
DecisionOutcomeV2Schema.parse({
  version: 2, outcome: 'action',
  action: { intent: 'gather_resource', args: { resource: 'oak_log', quantity: 4 } }
})
DecisionOutcomeV2Schema.parse({ version: 2, outcome: 'complete' })
DecisionOutcomeV2Schema.parse({ version: 2, outcome: 'blocked', reason: 'capability_unavailable' })
assert.throws(() => DecisionOutcomeV2Schema.parse({ version: 2, outcome: 'blocked', reason: 'free text' }))
```

- [ ] **Step 2: Add RED context/registry tests**

Context must preserve bounded semantic task fields `taskId`, `objective`, phase `active`, consecutiveReplans, previousAction, optional ephemeralDirective. Registry test proves schema-known but unregistered `deposit_item` is not advertised.

- [ ] **Step 3: Run RED**

```powershell
npx tsx --test tests/contracts/decision.test.ts tests/agent/context-builder.test.ts tests/skills/registry.test.ts
```

- [ ] **Step 4: Implement exact V2 schema**

```ts
const DecisionActionSchema = z.discriminatedUnion('intent', [
  z.object({ intent: z.literal('follow_player'), args: FollowPlayerArgsSchema }).strict(),
  z.object({ intent: z.literal('stay'), args: StayArgsSchema }).strict(),
  z.object({ intent: z.literal('go_to'), args: GoToArgsSchema }).strict(),
  z.object({ intent: z.literal('return_home'), args: ReturnHomeArgsSchema }).strict(),
  z.object({ intent: z.literal('eat'), args: EatArgsSchema }).strict(),
  z.object({ intent: z.literal('equip'), args: EquipArgsSchema }).strict(),
  z.object({ intent: z.literal('gather_resource'), args: GatherResourceArgsSchema }).strict(),
  z.object({ intent: z.literal('deposit_item'), args: DepositItemArgsSchema }).strict(),
  z.object({ intent: z.literal('withdraw_item'), args: WithdrawItemArgsSchema }).strict()
])
export const DecisionBlockedReasonSchema = z.enum(['no_safe_action','missing_information','capability_unavailable'])
export const DecisionOutcomeV2Schema = z.discriminatedUnion('outcome', [
  z.object({ version: z.literal(2), outcome: z.literal('action'), action: DecisionActionSchema }).strict(),
  z.object({ version: z.literal(2), outcome: z.literal('complete') }).strict(),
  z.object({ version: z.literal(2), outcome: z.literal('blocked'), reason: DecisionBlockedReasonSchema }).strict()
])
```

No reasoning/explanation field is allowed.

- [ ] **Step 5: Implement task context and skill catalog**

```ts
export interface DecisionTaskContext {
  readonly taskId: string
  readonly objective: string
  readonly phase: 'active'
  readonly consecutiveReplans: number
  readonly previousAction: GoalRequest['kind'] | null
  readonly ephemeralDirective?: string
}
```

ContextBuilder truncates objective/directive before provider use. SkillRegistry adds `has()` and `registeredNames()`. `skill-catalog.ts` maps decision intents to fixed descriptions and filters through registry presence.

- [ ] **Step 6: Run GREEN + typecheck, commit**

```powershell
npx tsx --test tests/contracts/decision.test.ts tests/agent/context-builder.test.ts tests/skills/registry.test.ts
npm run typecheck
git add src/contracts/decision.ts src/agent/context-builder.ts src/agent/skill-catalog.ts src/skills/registry.ts tests/contracts/decision.test.ts tests/agent/context-builder.test.ts tests/skills/registry.test.ts
git commit -m "feat: add task-aware decision outcomes"
```

---

### Task 4: Implement deterministic instruction analysis and `balanced-v1`

**Files:**
- Create: `src/agent/routing/contracts.ts`
- Create: `src/agent/routing/complexity.ts`
- Create: `tests/agent/routing/complexity.test.ts`

**Interfaces:** Defines route/evidence contracts used by ProjectPool, both logical executors, and Coordinator.

- [ ] **Step 1: Write RED instruction-analyzer tests**

Assert simple follow has no evidence; “採木頭然後回基地放箱子” sets `multiStep` and `multiSkill`; “自己想辦法找到鐵” sets openEndedMethod; explicit memory/inventory combination sets crossContextReasoning; “仔細想” sets only manualComplexityHint.

V1 phrase tables are fixed program data:

```ts
const OPEN_ENDED = ['自己想辦法','找個辦法','你自己決定','figure it out','find a way']
const MANUAL_HINTS = ['仔細想','認真想','用大模型','think hard','use the big model']
const STEP_CONNECTORS = ['然後','之後','接著','再','then','and then']
```

Skill-family keyword groups cover gather/navigation/storage/survival/equipment. Cross-context domain groups cover memory-reference/inventory/world-location/player. `multiSkill`/`crossContextReasoning` require >=2 distinct matched groups.

- [ ] **Step 2: Write RED score/high tests**

Table: empty=0 routine/low; multiStep=3 routine/low; openEnded=4 complex/medium; multiStep+multiSkill=5 complex/medium; goalFailed+stuck=4 complex/medium; manualHint=2 routine/low. `replanCount:2` => highReason repeated_replanning; `criticalContext` => critical_context; `manualDeep` => manual_deep_think.

- [ ] **Step 3: Run RED**

```powershell
npx tsx --test tests/agent/routing/complexity.test.ts
```

- [ ] **Step 4: Define exact shared routing contracts**

```ts
export type RouteClass = 'routine' | 'complex'
export type ThinkingLevel = 'low' | 'medium' | 'high'
export type BudgetClass = 'normal' | 'reserve'

export interface ComplexityEvidence {
  readonly multiStep?: boolean; readonly multiSkill?: boolean; readonly openEndedMethod?: boolean
  readonly crossContextReasoning?: boolean; readonly goalFailed?: boolean; readonly stuck?: boolean
  readonly manualComplexityHint?: boolean; readonly riskContext?: boolean
  readonly replanCount?: number; readonly criticalContext?: boolean; readonly manualDeep?: boolean
}

export interface RoutePlan {
  readonly decisionId: string
  readonly policy: 'balanced-v1'
  readonly routeClass: RouteClass
  readonly thinking: ThinkingLevel
  readonly reserveAuthorized: boolean
  readonly reasons: readonly string[]
  readonly highReason: 'manual_deep_think' | 'repeated_replanning' | 'critical_context' | null
}

export interface AttemptLease {
  readonly attemptId: string; readonly decisionId: string; readonly configGeneration: number
  readonly projectKey: string; readonly projectLabel: string; readonly credentialHandle: string
  readonly model: string; readonly thinking: ThinkingLevel; readonly budgetClass: BudgetClass
  readonly reservationId: string
}

export interface LogicalDecisionRequest {
  readonly context: DecisionContext
  readonly routePlan: RoutePlan
}

export type LogicalDecisionResult =
  | { readonly kind: 'success'; readonly providerResult: ProviderResult }
  | { readonly kind: 'safety_blocked'; readonly code: 'content_blocked' }
  | { readonly kind: 'unavailable'; readonly retryAt: number | null }
  | { readonly kind: 'invalid_response'; readonly code: string }
  | { readonly kind: 'configuration_error'; readonly code: string }
  | { readonly kind: 'cancelled' }

export interface LogicalDecisionExecutor {
  execute(request: LogicalDecisionRequest, signal: AbortSignal): Promise<LogicalDecisionResult>
}
```

Import `DecisionContext` and `ProviderResult` as types only. `LogicalDecisionResult` deliberately contains no AttemptLease/Project fields.

- [ ] **Step 5: Implement exact weights and immutable RoutePlan**

Weights: multi-step 3, multi-skill 2, open-ended 4, cross-context 2, goal-failed 2, stuck 2, manual hint 2, risk 3. Score `<4` -> routine/low; `>=4` -> complex/medium. High overrides do not change score. Freeze RoutePlan and reasons.

- [ ] **Step 6: Run GREEN + typecheck, commit**

```powershell
npx tsx --test tests/agent/routing/complexity.test.ts
npm run typecheck
git add src/agent/routing/contracts.ts src/agent/routing/complexity.ts tests/agent/routing/complexity.test.ts
git commit -m "feat: add deterministic complexity routing policy"
```

---

### Task 5: Add session-scoped Minecraft identity and Manual Deep parsing

**Files:**
- Create: `src/minecraft/identity-registry.ts`
- Create: `src/minecraft/manual-ai-command.ts`
- Create: `tests/minecraft/identity-registry.test.ts`
- Create: `tests/minecraft/manual-ai-command.test.ts`

**Interfaces:** `MinecraftIdentityRegistry` resolves principals; parser recognizes only explicit privileged commands. Natural-language complexity hints remain Task 4 evidence, not capability.

- [ ] **Step 1: Write RED identity tests**

Offline owner-looking UUID => untrusted. Online normalized owner UUID => owner. Online allowlisted UUID => operator. Missing/malformed/mismatched current chat UUID => untrusted. Disconnect/new session clears identity; player_left removes entry.

- [ ] **Step 2: Write RED command tests**

```ts
assert.deepEqual(parseManualAiCommand('!moxue deep 重新規劃採木頭'), { kind:'deep_new', instruction:'重新規劃採木頭' })
assert.deepEqual(parseManualAiCommand('!moxue deep current 再確認背包和箱子'), { kind:'deep_current', directive:'再確認背包和箱子' })
assert.deepEqual(parseManualAiCommand('!moxue deep current'), { kind:'deep_current' })
assert.equal(parseManualAiCommand('!moxue deep'), null)
```

- [ ] **Step 3: Run RED**

```powershell
npx tsx --test tests/minecraft/identity-registry.test.ts tests/minecraft/manual-ai-command.test.ts
```

- [ ] **Step 4: Implement UUID normalization/registry**

```ts
export function normalizeMinecraftUuid(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase().replaceAll('-', '') ?? ''
  return /^[0-9a-f]{32}$/.test(normalized) ? normalized : null
}
```

Registry owns in-process sessionGeneration. Online privileged resolution requires current chat UUID evidence and agreement with current-session identity when cached. Offline always returns untrusted.

- [ ] **Step 5: Implement bounded parser**

Accept case-insensitive exact `!moxue deep <nonempty instruction>` and `!moxue deep current [directive]`; max instruction/directive 1000 chars; no password/secret command path.

- [ ] **Step 6: Run GREEN + typecheck, commit**

```powershell
npx tsx --test tests/minecraft/identity-registry.test.ts tests/minecraft/manual-ai-command.test.ts
npm run typecheck
git add src/minecraft/identity-registry.ts src/minecraft/manual-ai-command.ts tests/minecraft/identity-registry.test.ts tests/minecraft/manual-ai-command.test.ts
git commit -m "feat: add trusted Minecraft AI command identity"
```

---

### Task 6: Build durable QuotaLedger and provider-day accounting

**Files:**
- Create: `src/agent/routing/provider-day.ts`
- Create: `src/agent/routing/quota-ledger.ts`
- Create: `tests/agent/routing/provider-day.test.ts`
- Create: `tests/agent/routing/quota-ledger.test.ts`

**Interfaces:** `SqliteQuotaLedger` owns config generation, reservations, dispatch/settlement, crash recovery, cooldown/quota state, process credential health, admin snapshots, and close.

- [ ] **Step 1: Write RED provider-day tests**

```ts
assert.equal(providerDayKey(Date.parse('2026-09-12T06:59:59Z')), '2026-09-11')
assert.equal(providerDayKey(Date.parse('2026-09-12T07:00:00Z')), '2026-09-12')
```

Use `Intl.DateTimeFormat` with `America/Los_Angeles`, not fixed offsets.

- [ ] **Step 2: Write RED ledger lifecycle tests**

Using temp SQLite, prove global generation monotonic across reopen; admission reserves transactionally; dispatch durable; actual usage replaces hold; release only before dispatch; startup recovery releases reserved and converts unsettled dispatched to terminal uncertain conservative charge; rolling RPM/TPM includes active holds; RPD uses provider-day; normal Flash admission blocks on either 70% request or token ceiling; actual over reservation sets `budget_overrun`.

- [ ] **Step 3: Run RED**

```powershell
npx tsx --test tests/agent/routing/provider-day.test.ts tests/agent/routing/quota-ledger.test.ts
```

- [ ] **Step 4: Create schema version 1**

`quota_attempts` fields: attempt_id, decision_id, config_generation, project_key, model, thinking, budget_class, state, reserved/dispatched/settled timestamps, provider_day_key, reserved input/total, actual input/output/thought/tool/total, accounted input/total, usage_quality, result_class, safe_error_code, budget_overrun. Add indexed `quota_domain_state`, `credential_health`, and `quota_meta`. Apply foreign_keys ON, busy_timeout 5000, synchronous NORMAL, WAL for file DB, schema-version fail closed.

- [ ] **Step 5: Implement transactional admission interface**

```ts
export interface QuotaAdmissionRequest {
  readonly attemptId: string; readonly decisionId: string; readonly configGeneration: number
  readonly projectKey: string; readonly model: string; readonly thinking: ThinkingLevel
  readonly budgetClass: BudgetClass; readonly now: number
  readonly reservedInputTokens: number; readonly reservedTotalTokens: number
  readonly providerLimits: { readonly rpm: number; readonly inputTpm: number; readonly rpd: number }
  readonly flashBudget?: { readonly requestLimit: number; readonly totalTokenLimit: number }
}
```

One SQLite transaction reads settled+active holds, evaluates all gates, and inserts `reserved` only on success. Normal Flash uses `floor(limit*0.70)` for request and token budgets; reserve can use full configured budget only when ProjectPool selected reserve.

- [ ] **Step 6: Implement settlement/recovery**

`markDispatched`: reserved->dispatched only. `releaseReservation`: reserved->released only. `settleAttempt`: dispatched->settled only. Actual usage replaces reservation. Missing-usage early 400/401/403/404/429 charges request + reserved input. Ambiguous timeout/network/5xx/local-abort/content-block/malformed/crash without usage charges request + full reserved total. Startup turns reserved into released, dispatched into uncertain.

- [ ] **Step 7: Implement health methods**

```ts
recordTransientFailure(projectKey, model, now, retryAfterMs?): number
recordDomainSuccess(projectKey, model): void
markQuotaUnavailable(projectKey, model, until, safeCode): void
disableCredentialForProcess(projectKey, processInstanceId, safeCode, now): void
credentialDisabled(projectKey, processInstanceId): boolean
domainAvailability(projectKey, model, now): { available: boolean; retryAt: number | null }
adminSnapshot(now): readonly AdminQuotaProjectSnapshot[]
close(): void
```

Cooldown sequence 5s,15s,30s,60s; effective cooldown uses max(policy delay, Retry-After). Success resets counter.

- [ ] **Step 8: Run GREEN + typecheck, commit**

```powershell
npx tsx --test tests/agent/routing/provider-day.test.ts tests/agent/routing/quota-ledger.test.ts
npm run typecheck
git add src/agent/routing/provider-day.ts src/agent/routing/quota-ledger.ts tests/agent/routing/provider-day.test.ts tests/agent/routing/quota-ledger.test.ts
git commit -m "feat: add durable Gemini quota ledger"
```

---

### Task 7: Add atomic RoutingConfigManager and generation-scoped credentials

**Files:**
- Create: `src/agent/routing/config-manager.ts`
- Create: `tests/agent/routing/config-manager.test.ts`

**Interfaces:** Produces immutable `RoutingConfigSnapshot`, initial activation, reload, snapshot, and opaque credential resolution.

- [ ] **Step 1: Write RED activation/reload tests**

Prove every apiKeyEnv is validated before activation; missing credential leaves active config untouched; valid reload gets higher generation; old credential handle remains resolvable for in-flight attempt; reordered Projects retain projectKey identity; changed manual access returns `authorizationChanged=true`.

- [ ] **Step 2: Run RED**

```powershell
npx tsx --test tests/agent/routing/config-manager.test.ts
```

- [ ] **Step 3: Implement immutable snapshot shapes**

```ts
export interface RoutingProjectSnapshot {
  readonly projectKey: string
  readonly credentialHandle: string
  readonly providerLimits: ValidatedRoutingProject['providerLimits']
  readonly flashBudget: ValidatedRoutingProject['flashBudget']
}
export interface RoutingConfigSnapshot {
  readonly generation: number
  readonly models: ValidatedRoutingConfig['models']
  readonly projects: readonly RoutingProjectSnapshot[]
  readonly manualAccess: ValidatedRoutingConfig['manualAccess']
}
```

Opaque generated handles map to raw secrets only in process memory and old handles remain until process exit.

- [ ] **Step 4: Implement atomic reload result**

```ts
export type RoutingReloadResult =
  | { readonly kind:'reloaded'; readonly generation:number; readonly authorizationChanged:boolean }
  | { readonly kind:'rejected'; readonly code:'invalid_config'|'missing_credential' }
```

Read, parse, semantic-validate, credential-validate, then allocate generation and swap. Failed candidate never clears old snapshot.

- [ ] **Step 5: Run GREEN + typecheck, commit**

```powershell
npx tsx --test tests/agent/routing/config-manager.test.ts
npm run typecheck
git add src/agent/routing/config-manager.ts tests/agent/routing/config-manager.test.ts
git commit -m "feat: add atomic routing config manager"
```

---

### Task 8: Implement JIT ProjectPool admission and 70/30 estimation

**Files:**
- Create: `src/agent/routing/project-pool.ts`
- Create: `tests/agent/routing/project-pool.test.ts`

**Interfaces:** Consumes RoutePlan/current snapshot/prepared payload byte count/process instance ID/QuotaLedger; returns one AttemptLease or unavailable retryAt.

- [ ] **Step 1: Write RED ordering tests**

Prove routine stays Lite across pool; automatic complex scans all normal only; reserve-authorized complex scans every normal before any reserve; primary returns after cooldown; credential-disabled skips both models; Flash-domain failure does not block Lite-domain use; all cooldowns return earliest retryAt; all credentials disabled returns retryAt null.

- [ ] **Step 2: Write RED conservative reservation tests**

```ts
export function estimateReservation(bytes: number, overhead: number, generationAllowance: number) {
  const inputTokens = bytes + overhead
  return { inputTokens, totalTokens: inputTokens + generationAllowance }
}
```

One UTF-8 byte reserves at most one input token plus configured overhead; no countTokens API call.

- [ ] **Step 3: Run RED**

```powershell
npx tsx --test tests/agent/routing/project-pool.test.ts
```

- [ ] **Step 4: Implement AttemptLease construction from shared contract**

Public `projectLabel` is `primary`, `backup-1`, ... derived from current ordered index. Internal/admin `projectKey` remains stable across reorders. Raw key is absent.

- [ ] **Step 5: Implement scan policy**

Routine: normal scan using routine model. Automatic complex: normal scan using complex model. Reserve-authorized complex: complete normal scan then reserve scan. Each candidate calls ledger admission; rejected/skipped candidate does not consume API attempt budget.

- [ ] **Step 6: Run GREEN + typecheck, commit**

```powershell
npx tsx --test tests/agent/routing/project-pool.test.ts
npm run typecheck
git add src/agent/routing/project-pool.ts tests/agent/routing/project-pool.test.ts
git commit -m "feat: add quota-aware Gemini project pool"
```

---

### Task 9: Refactor Gemini into a one-attempt transport with usage/error facts

**Files:**
- Modify: `src/agent/providers/gemini.ts`
- Modify: `tests/agent/providers/gemini.test.ts`
- Modify: `tests/agent/reasoning-isolation.test.ts`

**Interfaces:** `GeminiTransport.prepare(context)` returns immutable payload; `execute(prepared,lease,signal)` performs exactly one attempt and returns normalized facts.

- [ ] **Step 1: Write RED per-attempt request tests**

Use a lease containing configGeneration/projectKey/projectLabel/credentialHandle/model/thinking/budgetClass. Assert request uses lease model/thinking, store false, stream false, thinking_summaries none, tool_choice any, retryAttempts exactly 1. Success fixture includes actual input/output/thought/tool/total usage and result omits thought text.

- [ ] **Step 2: Add RED safe-error tests**

Fake 401 authentication, 403 permission_denied, 429 quota_exceeded, 503, TimeoutError, network error, local AbortError, content_blocked, and malformed function call. Normalized result must not carry raw error.message.

- [ ] **Step 3: Run RED**

```powershell
npx tsx --test tests/agent/providers/gemini.test.ts tests/agent/reasoning-isolation.test.ts
```

- [ ] **Step 4: Implement prepared payload**

```ts
export interface PreparedGeminiPayload {
  readonly input: string
  readonly systemInstruction: string
  readonly tools: readonly GeminiFunctionTool[]
  readonly utf8Bytes: number
}
```

Tool schema mirrors DecisionOutcomeV2 exactly; only one forced `submit_decision`; no reasoning fields.

- [ ] **Step 5: Implement single-attempt SDK adapter**

```ts
export interface GeminiInteractionClient {
  create(
    request: GeminiInteractionRequest,
    options: { readonly timeout: number; readonly retryAttempts: 1; readonly signal: AbortSignal }
  ): Promise<GeminiInteractionResponse>
}
```

Real @google/genai 2.21.0 mapping sets SDK retry attempts to 1, maps timeout, passes AbortSignal through SDK request abort option, and resolves raw key only from opaque credential handle inside transport.

- [ ] **Step 6: Normalize usage/facts**

```ts
export interface GeminiUsage {
  readonly inputTokens:number; readonly outputTokens:number; readonly thoughtTokens:number
  readonly toolTokens:number; readonly totalTokens:number
}
```

Transport result union is success/generation_error/content_blocked/api_error/timeout/network_error/cancelled. It chooses no retry/failover policy.

- [ ] **Step 7: Run GREEN + typecheck, commit**

```powershell
npx tsx --test tests/agent/providers/gemini.test.ts tests/agent/reasoning-isolation.test.ts
npm run typecheck
git add src/agent/providers/gemini.ts tests/agent/providers/gemini.test.ts tests/agent/reasoning-isolation.test.ts
git commit -m "refactor: make Gemini provider a routed single-attempt transport"
```

---

### Task 10: Implement error policy and RoutedDecisionExecutor

**Files:**
- Create: `src/agent/routing/error-policy.ts`
- Create: `src/agent/routing/routed-executor.ts`
- Create: `tests/agent/routing/error-policy.test.ts`
- Create: `tests/agent/routing/routed-executor.test.ts`

**Interfaces:** Implements shared `LogicalDecisionExecutor`; Coordinator receives only shared LogicalDecisionResult and never AttemptLease/Project details.

- [ ] **Step 1: Write RED policy matrix**

401/403 credential-fatal; quota_exceeded domain unavailable; rate_limit_exceeded/too_many_requests/unknown429 transient; 408/409-aborted/500/502/503/504/network/timeout transient; invalid_request/parameter_unknown/model_not_found/generic nonretry4xx configuration error; content_blocked safety terminal; generation error one clean repair; local cancellation terminal cancelled. Safety code classification precedes status-family fallback.

- [ ] **Step 2: Implement closed AttemptPolicy union**

```ts
export type AttemptPolicy =
  | { kind:'success' }
  | { kind:'credential_fatal'; safeCode:string }
  | { kind:'quota_unavailable'; safeCode:string; retryAt:number }
  | { kind:'transient'; safeCode:string; retryAfterMs?:number }
  | { kind:'safety_terminal'; safeCode:'content_blocked' }
  | { kind:'generation_retry'; safeCode:string }
  | { kind:'configuration_error'; safeCode:string }
  | { kind:'cancelled' }
```

- [ ] **Step 3: Write RED executor tests**

Prove immutable RoutePlan across attempts; A transient -> B success; A 401 -> disable then B; content block -> no B; generation error gets one clean retry only; all unavailable returns earliest retryAt; all process-disabled returns null retryAt; local cancellation gets no retry/health penalty; every dispatched attempt settles before next lease; max actual attempts = configuredProjectCount + 4; success returned to Coordinator contains only providerResult.

- [ ] **Step 4: Run RED**

```powershell
npx tsx --test tests/agent/routing/error-policy.test.ts tests/agent/routing/routed-executor.test.ts
```

- [ ] **Step 5: Implement shared LogicalDecisionExecutor**

`execute(request,signal)` first calls `transport.prepare(request.context)`, then uses `request.routePlan` unchanged. For each attempt: pool.nextLease -> ledger.markDispatched -> transport.execute -> classify -> settle/health update. JIT failover immediately uses another eligible Project; wait abortably only if every candidate is temporarily unavailable. Generation repair consumes at most one repair opportunity and does not alter plan/model/thinking/reserve authorization. Publish routing telemetry internally; strip lease before returning success.

- [ ] **Step 6: Run GREEN + typecheck, commit**

```powershell
npx tsx --test tests/agent/routing/error-policy.test.ts tests/agent/routing/routed-executor.test.ts
npm run typecheck
git add src/agent/routing/error-policy.ts src/agent/routing/routed-executor.ts tests/agent/routing/error-policy.test.ts tests/agent/routing/routed-executor.test.ts
git commit -m "feat: add routed Gemini retry and failover executor"
```

---

### Task 11: Refactor DecisionGate into task-aware outcome gate

**Files:**
- Modify: `src/agent/decision-gate.ts`
- Modify: `src/agent/provider.ts`
- Modify: `tests/agent/decision-gate.test.ts`
- Modify: `tests/agent/provider-capabilities.test.ts`

**Interfaces:** `GatedOutcome = action | complete | blocked | rejected`; no direct Goal submission path remains.

- [ ] **Step 1: Write RED tests**

Complete returns gated complete; blocked returns bounded reason; unregistered action returns `skill_not_registered`; malformed provider result and SafetyPolicy rejection remain fail closed.

- [ ] **Step 2: Run RED**

```powershell
npx tsx --test tests/agent/decision-gate.test.ts tests/agent/provider-capabilities.test.ts
```

- [ ] **Step 3: Implement V2 gate**

Parse ProviderResult -> DecisionOutcomeV2. Complete/blocked create no GoalRequest. Action maps nested action intent/args, verifies registered skill, then authorizeSkill + runtimeAction against latest WorldState. Remove `DecisionPipeline` direct submission so Coordinator owns generation/staleness and GoalManager submission.

- [ ] **Step 4: Run GREEN + typecheck, commit**

```powershell
npx tsx --test tests/agent/decision-gate.test.ts tests/agent/provider-capabilities.test.ts
npm run typecheck
git add src/agent/decision-gate.ts src/agent/provider.ts tests/agent/decision-gate.test.ts tests/agent/provider-capabilities.test.ts
git commit -m "refactor: gate task outcomes before coordinator execution"
```

---

### Task 12: Add AiTask, one-shot grants, and trigger classification

**Files:**
- Create: `src/runtime/ai-task.ts`
- Create: `src/runtime/trigger-classifier.ts`
- Create: `tests/runtime/ai-task.test.ts`
- Create: `tests/runtime/trigger-classifier.test.ts`

**Interfaces:** Produces AiTask, ManualRouteGrant, AiTaskQueue, DecisionDemand, TriggerClassifier; uses Task 4 analyzer for base instruction evidence.

- [ ] **Step 1: Write RED task/grant tests**

Prove bounded objective/source/principal/generation; max 8 pending; grant consumed once; task/session-generation invalidation; true failure increments consecutive+total; cancellation/supersede does not; successful action resets consecutive only; new process structures do not restore tasks/grants.

- [ ] **Step 2: Write RED trigger tests**

State-only event -> no demand. `stuck` and `skill_failed` add evidence under goal cause; `goal_failed` creates one replan boundary; `goal_cancelled` no replan; `goal_completed` continues only active task goal. Address prefixes: `!moxue`, `墨雪`, `moxue` case-insensitive, or configured bot username; strip one leading punctuation delimiter and reject empty instruction. Different explicit requests remain separate. New task base evidence equals `analyzeInstructionComplexity(instruction)`.

- [ ] **Step 3: Run RED**

```powershell
npx tsx --test tests/runtime/ai-task.test.ts tests/runtime/trigger-classifier.test.ts
```

- [ ] **Step 4: Implement bounded volatile contracts**

```ts
export interface DecisionDemand {
  readonly demandId:string
  readonly taskId:string
  readonly causeKeys:ReadonlySet<string>
  readonly reasons:ReadonlySet<string>
  readonly createdAt:number
}
```

No WorldState snapshot stored. Objective/directive max 1000 chars. Deep-current grant binds active task ID+generation+Minecraft session generation and never arms a future task.

- [ ] **Step 5: Run GREEN + typecheck, commit**

```powershell
npx tsx --test tests/runtime/ai-task.test.ts tests/runtime/trigger-classifier.test.ts
npm run typecheck
git add src/runtime/ai-task.ts src/runtime/trigger-classifier.ts tests/runtime/ai-task.test.ts tests/runtime/trigger-classifier.test.ts
git commit -m "feat: add AI task and decision demand primitives"
```

---

### Task 13: Implement actor/mailbox DecisionCoordinator

**Files:**
- Create: `src/runtime/decision-coordinator.ts`
- Create: `tests/runtime/decision-coordinator.test.ts`

**Interfaces:** Consumes events/state/goals/memory/registry+catalog/identity/manual policy/DecisionGate/LogicalDecisionExecutor; produces start, dispose, status, submitAdminDeepThink, invalidateManualGrants, clearAiWork.

- [ ] **Step 1: Write RED non-blocking mailbox test**

Unresolved fake LogicalDecisionExecutor Promise must not block `RuntimeEventBus.publish(player_chat)`; inventory/emergency-stop events must still enqueue while decision is in flight.

- [ ] **Step 2: Add RED single-flight/stale tests**

One logical decision max; state updates do not spawn another; emergency stop invalidates result; direct player goal supersedes active AI task while existing queued explicit tasks remain queued; ordinary inventory/position does not stale; final gate uses latest state.

- [ ] **Step 3: Add RED multi-step/replan tests**

Explicit task -> action gather -> goal_completed -> continuation -> next registered action -> complete. One stuck+skill_failed+goal_failed chain -> one replan. First failure may score Flash-medium; second consecutive failed execution makes next decision high with reserveAuthorized false; successful action resets consecutive count.

- [ ] **Step 4: Add RED queue/continuous tests**

Bounded skill + new task queues without abort. `follow_player`/`stay` may be safely superseded and emit cancellation. Eight pending allowed; ninth rejected. Different players do not merge.

- [ ] **Step 5: Add RED unavailable/recovery/reconnect tests**

Unavailable AI lets deterministic skill finish. retryAt schedules exactly one wake. Recovery dispatches one fresh decision using latest state. null retryAt causes no polling. Disconnect suspends ordinary task/invalidate decision; reconnect+spawn does one fresh decision. Manual grant invalidates on disconnect and is not downgraded.

- [ ] **Step 6: Implement mailbox state ownership**

```ts
coordinator: 'running'|'stopped'
activeTask: AiTask|null
execution: 'idle'|'decision_pending'|'decision_in_flight'|'goal_running'
aiAvailability: 'available'|'unavailable'
minecraftReady: boolean
```

Pending queue is AiTaskQueue. RuntimeEvent listener clones/enqueues and returns immediately; serialized mailbox processes transitions. Provider completion is enqueued back.

- [ ] **Step 7: Implement dispatch/finalization**

At safe boundary: latest state + task + memories + registered skills -> DecisionContext; combine base/causal/grant evidence; assess; build immutable RoutePlan; call `logicalExecutor.execute({context,routePlan},signal)`. Consume grant only on dispatch. On success verify task/session generation then DecisionGate latest state + registry; action -> GoalManager, complete/blocked -> close task/start next. Safety terminal never re-prompts.

- [ ] **Step 8: Run GREEN + typecheck, commit**

```powershell
npx tsx --test tests/runtime/decision-coordinator.test.ts
npm run typecheck
git add src/runtime/decision-coordinator.ts tests/runtime/decision-coordinator.test.ts
git commit -m "feat: add production AI decision coordinator"
```

---

### Task 14: Add loopback-only Admin API

**Files:**
- Create: `src/api/admin-server.ts`
- Create: `tests/api/admin-server.test.ts`

**Interfaces:** Quota snapshot, routing reload, local-admin deep-think; host fixed 127.0.0.1; dedicated token constant-time checked.

- [ ] **Step 1: Write RED auth/bind tests**

No non-loopback host input exists; missing/wrong bearer ->401; correct Admin token works; Control token does not; errors never echo token.

- [ ] **Step 2: Write RED endpoint tests**

Quota shows anonymous projectKey + safe metrics only. Valid reload -> generation; invalid -> old config stays. Deep-think requires nonempty instruction and Idempotency-Key behavior: same key/body returns original; same key/different body ->409; cache max 256 oldest-first.

- [ ] **Step 3: Run RED**

```powershell
npx tsx --test tests/api/admin-server.test.ts
```

- [ ] **Step 4: Implement narrow ports**

```ts
export interface AdminQuotaPort { snapshot(): unknown }
export interface AdminRoutingPort { reload(): Promise<RoutingReloadResult> }
export interface AdminDecisionPort {
  submitDeepThink(instruction:string): Promise<{taskId:string}>
  invalidateManualGrants(reason:string): void
}
```

Authorization-changing reload invalidates pending privileged grants before success response.

- [ ] **Step 5: Run GREEN + typecheck, commit**

```powershell
npx tsx --test tests/api/admin-server.test.ts
npm run typecheck
git add src/api/admin-server.ts tests/api/admin-server.test.ts
git commit -m "feat: add protected AI admin API"
```

---

### Task 15: Add safe telemetry and `/v1/status` AI summary

**Files:**
- Modify: `src/contracts/events.ts`
- Modify: `src/api/control-server.ts`
- Modify: `src/agent/routing/routed-executor.ts`
- Modify: `src/runtime/decision-coordinator.ts`
- Modify: `tests/contracts/events.test.ts`
- Modify: `tests/api/control-server.test.ts`

**Interfaces:** Safe telemetry events and ControlAiStatusPort only; public uses projectLabel, never projectKey.

- [ ] **Step 1: Write RED event-schema tests**

Model-route event includes decisionId/model/thinking/project label/reasons/reserveAuthorized/reserveUsed; rejects extra prompt/objective/UUID/key fields. Add bounded complexity_assessment, attempt_result, ai_availability_changed, task_started/completed/blocked/superseded schemas.

- [ ] **Step 2: Write RED status test**

AI payload fields: routine_model, complex_model, available, active_project label, coarse flash_auto_used_pct, manual_deep_think_available, coordinator_state, active_task_id, active_goal_kind, pending_task_count, decision_in_flight. No objective, UUID, real project identity, raw error, or precise reserve diagnostics.

- [ ] **Step 3: Run RED**

```powershell
npx tsx --test tests/contracts/events.test.ts tests/api/control-server.test.ts
```

- [ ] **Step 4: Publish at ownership boundaries**

Coordinator publishes task/complexity/availability. RoutedExecutor publishes route/attempt after admission/settlement and uses `lease.projectLabel` publicly. Raw errors never enter event bus.

- [ ] **Step 5: Extend ControlServer**

Add `ControlAiStatusPort` to options and clone only safe bounded fields. Existing Minecraft/goal status stays intact.

- [ ] **Step 6: Run GREEN + typecheck, commit**

```powershell
npx tsx --test tests/contracts/events.test.ts tests/api/control-server.test.ts
npm run typecheck
git add src/contracts/events.ts src/api/control-server.ts src/agent/routing/routed-executor.ts src/runtime/decision-coordinator.ts tests/contracts/events.test.ts tests/api/control-server.test.ts
git commit -m "feat: expose safe AI routing observability"
```

---

### Task 16: Wire fake and Gemini stacks into the composition root

**Files:**
- Modify: `src/main.ts`
- Modify: `tests/main.test.ts`
- Modify: `tests/main-storage-bootstrap.test.ts`

**Interfaces:** Fake mode has no routing file/quota DB/Admin dependency. Gemini mode composes QuotaLedger -> ConfigManager -> ProjectPool -> GeminiTransport -> RoutedDecisionExecutor. Both expose shared `LogicalDecisionExecutor` to Coordinator.

- [ ] **Step 1: Write RED fake-mode composition test**

Replace old `createDecisionProvider` dependency seam with `createLogicalDecisionExecutor` injection. Assert fake mode creates no quota DB, reads no routing JSON, and needs no Admin token/Google secret.

- [ ] **Step 2: Write RED Gemini composition/shutdown tests**

Temp routing JSON + test env + fake transport. Assert initial config activation and ledger recovery happen before API exposure; adapter connects before Control/Admin start; Admin starts only with token; shutdown closes Admin then Control, clears AI work, stops goals/runtime, closes quota ledger and memory.

- [ ] **Step 3: Run RED**

```powershell
npx tsx --test tests/main.test.ts tests/main-storage-bootstrap.test.ts
```

- [ ] **Step 4: Implement exact composition helper interfaces**

```ts
export interface FakeDecisionStackOptions {
  readonly provider: DecisionProvider<DecisionContext>
}

export interface GeminiDecisionStackOptions {
  readonly routingConfigPath: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly quotaFilename: string
  readonly processInstanceId: string
  readonly events: RuntimeEventBus
  readonly now?: () => number
}

export interface GeminiDecisionStack {
  readonly executor: LogicalDecisionExecutor
  readonly configManager: RoutingConfigManager
  readonly quotaLedger: SqliteQuotaLedger
  close(): void
}

function createFakeDecisionStack(options: FakeDecisionStackOptions): LogicalDecisionExecutor
function createGeminiDecisionStack(options: GeminiDecisionStackOptions): GeminiDecisionStack
```

Fake executor implements `execute({context},signal)` by calling the injected safe fake DecisionProvider once and mapping it to shared LogicalDecisionResult; it ignores infrastructure routing because fake mode must not consume production quota. Gemini helper activates config, recovers ledger, builds ProjectPool/GeminiTransport/RoutedDecisionExecutor, and returns the stack. Use `DEFAULT_MEMORY_PATH='data/mc_memory.sqlite3'`, `DEFAULT_QUOTA_PATH='data/ai-quota.sqlite3'`, and one `processInstanceId=randomUUID()` per application instance.

- [ ] **Step 5: Wire Coordinator before adapter events**

Coordinator subscribes before Minecraft can emit chat/session events. Pass latest state, memory, registry/catalog, identity mode/registry, manual policy snapshot, goals, and shared logical executor through narrow ports.

- [ ] **Step 6: Wire `/v1/stop` semantics**

GoalManager emergency stop remains deterministic actuator stop. Coordinator consumes emergency_stop, clears active/pending AI work and grants, aborts in-flight decision generation, then remains running+idle.

- [ ] **Step 7: Run full automated suite**

```powershell
npx tsx --test tests/main.test.ts tests/main-storage-bootstrap.test.ts
npm test
npm run typecheck
```

- [ ] **Step 8: Commit**

```powershell
git add src/main.ts tests/main.test.ts tests/main-storage-bootstrap.test.ts
git commit -m "feat: wire multi-model routing into MC_AI_Player"
```

---

### Task 17: Add E2E, real Gemini validation harness, and final docs/gates

**Files:**
- Create: `tests/scenarios/gemini-routing-coordinator.test.ts`
- Create: `scripts/validate-gemini-routing-live.ts`
- Modify: `package.json`
- Modify: `package-lock.json` only if npm changes it
- Modify: `README.md`
- Modify: `.env.example` only for validation corrections
- Modify: `docs/superpowers/specs/2026-09-12-gemini-multi-model-routing-design.md` status after verified implementation

**Interfaces:** Scenario uses real Coordinator+QuotaLedger+ProjectPool with fake transport; live harness uses real Gemini only under explicit opt-in and outputs safe evidence.

- [ ] **Step 1: Write deterministic E2E fake-transport scenario**

One flow proves: simple addressed task -> Lite/low primary; primary Lite transient -> backup Lite; multi-step -> Flash/medium directly; coalesced runtime failure -> one replan; second consecutive failure -> Flash/high without reserve; trusted online deep -> Flash/high and all normal Projects checked before reserve; content_blocked terminal no failover; AI unavailable lets deterministic skill finish and recovery makes one fresh decision using latest state.

- [ ] **Step 2: Run E2E and fix owning component only**

```powershell
npx tsx --test tests/scenarios/gemini-routing-coordinator.test.ts
```

Do not weaken unit invariants to make E2E pass.

- [ ] **Step 3: Implement opt-in live script**

Skip unless `MC_AI_LIVE_VALIDATION=1`, `MC_AI_PROVIDER=gemini`, and private routing config is available. Validate routine Lite-low, complex Flash-medium, local-admin deep Flash-high, and actual usage settlement. Print only anonymous project label/key, model, thinking, safe reason, usage counts, PASS/FAIL; never print instruction/prompt/key/raw provider body/real Google Project ID. Add package script `validate:gemini-live`.

- [ ] **Step 4: Update README operations**

Document private config copy, MC_AI_KEY_* secrets outside JSON, current AI Studio provider limits, fail-closed missing limits, online/offline trust, both deep commands, loopback Admin endpoints, 70/30 semantics, quota DB privacy, and truthful remaining release gates.

- [ ] **Step 5: Run automated final verification**

```powershell
npm test
npm run typecheck
npm run probe
git diff --check
git status --short
```

- [ ] **Step 6: Run real Gemini gate only with private credentials**

```powershell
$env:MC_AI_LIVE_VALIDATION='1'
npm run validate:gemini-live
```

If quota/config prevents execution, retain the gate as pending; fake evidence never substitutes.

- [ ] **Step 7: Run security searches**

```powershell
git diff main...HEAD -- . ':!package-lock.json'
git grep -n "MC_AI_KEY_" -- ':!config/ai-routing.example.json' ':!.env.example' ':!docs/**'
git grep -n -E "AIza[0-9A-Za-z_-]+" -- .
```

Expected: no real keys; no prompt/objective persistence in quota/telemetry; no non-loopback Admin bind; no raw provider error logging.

- [ ] **Step 8: Update spec status truthfully**

If architecture is implemented but environmental gates remain, status says `Implemented architecture; real-environment release gates remain pending where listed below.` Never mark 30-minute human, Pi measurement, 4–8h soak, missing skill wiring, or DC_BOT integration complete without evidence.

- [ ] **Step 9: Commit final tests/docs**

```powershell
git add tests/scenarios/gemini-routing-coordinator.test.ts scripts/validate-gemini-routing-live.ts package.json package-lock.json README.md .env.example docs/superpowers/specs/2026-09-12-gemini-multi-model-routing-design.md
git commit -m "test: validate Gemini multi-model routing"
```

- [ ] **Step 10: Re-run branch-wide verification**

```powershell
npm test
npm run typecheck
npm run probe
git diff --check main...HEAD
git status --short
```

Expected: PASS and clean worktree.

- [ ] **Step 11: Update Draft PR #4 for implementation review; never auto-merge**

Summarize implementation, automated/live evidence, and pending release gates. Mark ready only after required CI is green on current head. Never bypass protected-main rules.

---

## Plan self-check mapping

```text
Config / fake-vs-gemini migration             Tasks 1, 7, 16
Cancellation semantics / chat UUID evidence   Task 2
DecisionOutcome + task-aware context           Tasks 3, 11
Instruction signals + balanced-v1              Task 4
Online/offline identity + manual deep          Tasks 5, 12, 13
Durable quota / crash consistency              Task 6
Atomic reload + config generations             Tasks 7, 14
Primary-first pool + 70/30 admission           Task 8
One-attempt Gemini + actual usage/error facts  Task 9
Retry/failover taxonomy                        Task 10
AiTask / coalescing / task queue               Task 12
Production mailbox Coordinator                 Task 13
Admin trust boundary                           Task 14
Telemetry + /v1/status                         Task 15
Composition root / fake seam                   Task 16
E2E + real Gemini release gate                 Task 17
```

No task may broaden DC_BOT integration, proxy UUID trust, concurrent autonomous tasks, speculative parallel calls, server-side Gemini conversation state, or arbitrary complexity-weight hot reload. Those remain separate future architecture changes.
