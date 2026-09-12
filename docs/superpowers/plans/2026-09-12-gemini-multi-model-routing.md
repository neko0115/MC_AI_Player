# Gemini Multi-Model Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved deterministic Gemini Lite/Flash routing architecture, including trusted manual deep-think, an ordered Google Project pool, durable quota accounting, a production decision coordinator, and a loopback-only Admin API without weakening the existing deterministic gameplay and SafetyPolicy boundaries.

**Architecture:** The runtime keeps AI planning provider-neutral at the Coordinator boundary. A deterministic instruction analyzer and `balanced-v1` policy create an immutable RoutePlan, ProjectPool obtains one JIT AttemptLease at a time from a durable SQLite QuotaLedger, and GeminiTransport performs exactly one SDK/API attempt per lease with no SDK-level retry. DecisionCoordinator owns AiTask lifecycle and stale-result rejection; routing/auth/quota components never execute gameplay directly, and every accepted action passes the latest registered-skill and SafetyPolicy checks before GoalManager submission.

**Tech Stack:** Node.js 24, TypeScript 7.0.2, tsx 4.23.13, Zod 4.5.4, better-sqlite3 12.11.1, Mineflayer 4.39.0, mineflayer-pathfinder 2.4.5, @google/genai 2.21.0, Node built-in HTTP, `Intl.DateTimeFormat` for `America/Los_Angeles`, Node test runner through `tsx --test`.

**Spec:** `docs/superpowers/specs/2026-09-12-gemini-multi-model-routing-design.md`

## Global Constraints

- Work only on `feature/gemini-multi-model-routing`; protected `main` is changed only by PR merge.
- At execution time, create/use an isolated worktree with `superpowers:using-git-worktrees`; do not implement directly in the main checkout.
- `neko0115/DC_BOT` is out of scope and must not be modified.
- `MC_AI_PROVIDER=fake` remains the safe default and must not require a routing file, Google credential, Admin token, or production quota DB.
- `MC_AI_PROVIDER=gemini` requires a valid `data/ai-routing.json` (or `MC_AI_ROUTING_CONFIG`) and every referenced credential environment variable; missing values fail startup closed.
- Routine route: `gemini-3.5-flash-lite`, thinking `low`.
- Complex route: `gemini-3.8-flash`, thinking `medium`; high only for trusted manual deep-think, `consecutive_replan_count >= 2`, or trusted deterministic critical context.
- Automatic routing can never use the Flash reserve region. Reserve use requires a valid ManualRouteGrant or local-admin capability.
- Flash normal/reserve admission is per Project: first 70% normal, final 30% reserve. Each attempt is wholly `normal` or wholly `reserve`.
- Credential health is keyed by stable anonymous `projectKey`; quota is keyed by `projectKey + model`.
- Quota values are deployment input. Missing admission-critical limits fail closed; no production quota number is inferred from documentation or hard-coded into runtime code.
- `data/ai-quota.sqlite3` is independent from `data/mc_memory.sqlite3` and must never contain prompts, chat text, objectives, raw API keys, real Google Project IDs, privileged UUIDs, raw provider bodies, or thought text.
- Quota reservation and `dispatched` state must be durable before the HTTP request is sent.
- Gemini SDK automatic retry must be disabled so one AttemptLease corresponds to one API attempt.
- Provider `content_blocked` and local SafetyPolicy rejection are terminal and never trigger model/Project failover to bypass safety.
- Runtime events never call Gemini directly. They only update state/evidence or enqueue work into the DecisionCoordinator mailbox.
- AiTask, DecisionDemand, task queue, ManualRouteGrant, and in-flight decisions are volatile and are never replayed after process restart.
- Minecraft usernames are never privileged credentials. Offline server identity mode always yields untrusted Minecraft-chat principals.
- Admin API is a separate loopback-only listener and additionally requires `MC_ADMIN_TOKEN`.
- Existing release gates remain evidence-driven: real Gemini live validation, production coordinator validation, 30-minute human collaboration, Pi/mini-PC measurement, 4-8h soak, missing storage/home skill wiring, and later DC_BOT integration.

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

If the baseline is red, stop implementation and diagnose the baseline before creating feature changes.

---

## Locked file map

Keep responsibilities focused. Do not create a catch-all `utils.ts`.

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

---

### Task 1: Replace legacy single-model environment authority with routing-config contracts

**Files:**
- Modify: `src/config.ts` (`AiConfig`, new identity/admin loaders)
- Create: `src/agent/routing/config.ts`
- Create: `tests/agent/routing/config.test.ts`
- Modify: `tests/agent/provider-config.test.ts`
- Create: `config/ai-routing.example.json`
- Modify: `.env.example`

**Interfaces:**
- Produces `AiConfig = {provider:'fake'} | {provider:'gemini'; routingConfigPath:string}`.
- Produces `MinecraftServerIdentityMode = 'online' | 'offline'` via `loadMinecraftServerIdentityMode()`.
- Produces `AdminApiConfig = {enabled:false} | {enabled:true; host:'127.0.0.1'; port:number; bearerToken:string}`.
- Produces `ValidatedRoutingConfig` and `parseRoutingConfig(raw: unknown)`; no raw credential secret is part of this type.

- [ ] **Step 1: Rewrite provider-config tests to establish the new authority boundary**

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  loadAdminApiConfig,
  loadAiConfig,
  loadMinecraftServerIdentityMode
} from '../../src/config.js'

test('fake provider remains secret-free and routing-file-free', () => {
  assert.deepEqual(loadAiConfig({}), { provider: 'fake' })
  assert.deepEqual(loadAiConfig({ MC_AI_PROVIDER: 'fake' }), { provider: 'fake' })
})

test('gemini provider uses the routing file and ignores legacy single-model authority', () => {
  assert.deepEqual(loadAiConfig({
    MC_AI_PROVIDER: 'gemini',
    MC_AI_MODEL: 'legacy-model-must-not-win',
    MC_AI_API_KEY: 'legacy-key-must-not-win'
  }), { provider: 'gemini', routingConfigPath: 'data/ai-routing.json' })

  assert.deepEqual(loadAiConfig({
    MC_AI_PROVIDER: 'gemini',
    MC_AI_ROUTING_CONFIG: 'D:/private/router.json'
  }), { provider: 'gemini', routingConfigPath: 'D:/private/router.json' })
})

test('server identity fails closed to offline', () => {
  assert.equal(loadMinecraftServerIdentityMode({}), 'offline')
  assert.equal(loadMinecraftServerIdentityMode({ MC_SERVER_IDENTITY_MODE: 'online' }), 'online')
  assert.equal(loadMinecraftServerIdentityMode({ MC_SERVER_IDENTITY_MODE: 'typo' }), 'offline')
})

test('admin API is disabled without its dedicated token', () => {
  assert.deepEqual(loadAdminApiConfig({}), { enabled: false })
  assert.deepEqual(loadAdminApiConfig({ MC_ADMIN_TOKEN: 'admin-secret', MC_ADMIN_PORT: '8767' }), {
    enabled: true,
    host: '127.0.0.1',
    port: 8767,
    bearerToken: 'admin-secret'
  })
})
```

- [ ] **Step 2: Run RED**

```powershell
npx tsx --test tests/agent/provider-config.test.ts
```

Expected: FAIL because Gemini still requires `MC_AI_MODEL` / `MC_AI_API_KEY` and the identity/admin loaders do not exist.

- [ ] **Step 3: Add startup config types/loaders**

```ts
export type MinecraftServerIdentityMode = 'online' | 'offline'

export type AiConfig =
  | { readonly provider: 'fake' }
  | { readonly provider: 'gemini'; readonly routingConfigPath: string }

export type AdminApiConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true
      readonly host: '127.0.0.1'
      readonly port: number
      readonly bearerToken: string
    }

const DEFAULT_AI_ROUTING_PATH = 'data/ai-routing.json'
const DEFAULT_ADMIN_PORT = 8767

export function loadMinecraftServerIdentityMode(
  env: Readonly<Record<string, string | undefined>>
): MinecraftServerIdentityMode {
  return env.MC_SERVER_IDENTITY_MODE?.trim().toLowerCase() === 'online'
    ? 'online'
    : 'offline'
}
```

`loadAiConfig()` ignores legacy `MC_AI_MODEL` / `MC_AI_API_KEY` as routing authority. `loadAdminApiConfig()` hard-codes `127.0.0.1`, validates port `1..65535`, caps token length at 4096, and returns `{enabled:false}` when the token is absent.

- [ ] **Step 4: Write routing JSON schema tests**

```ts
function validConfig() {
  return {
    version: 1,
    models: {
      routine: {
        name: 'gemini-3.5-flash-lite',
        reservation: { inputTokenOverhead: 256, generationTokenAllowance: { low: 512 } }
      },
      complex: {
        name: 'gemini-3.8-flash',
        reservation: {
          inputTokenOverhead: 256,
          generationTokenAllowance: { medium: 2048, high: 4096 }
        }
      }
    },
    projects: [{
      projectKey: 'pool-a',
      apiKeyEnv: 'MC_AI_KEY_PRIMARY',
      providerLimits: {
        routine: { rpm: 10, inputTpm: 10000, rpd: 100 },
        complex: { rpm: 10, inputTpm: 10000, rpd: 100 }
      },
      flashBudget: {
        requestLimit: 80,
        totalTokenLimit: 100000,
        resetWindow: 'america-los-angeles-day',
        source: 'operator_policy'
      }
    }],
    manualAccess: {
      ownerUuid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      operatorAllowlistUuids: ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']
    }
  }
}

test('routing config is strict and requires positive admission limits', () => {
  assert.equal(parseRoutingConfig(validConfig()).projects[0]?.projectKey, 'pool-a')
  const duplicate = validConfig()
  duplicate.projects.push({ ...duplicate.projects[0]! })
  assert.throws(() => parseRoutingConfig(duplicate), /projectKey/i)
  const noBudget = validConfig()
  noBudget.projects[0]!.flashBudget.totalTokenLimit = 0
  assert.throws(() => parseRoutingConfig(noBudget), /totalTokenLimit/i)
})
```

- [ ] **Step 5: Implement strict schema + semantic validation**

After Zod parsing:

```ts
const projectKeys = parsed.projects.map(project => project.projectKey)
if (new Set(projectKeys).size !== projectKeys.length) {
  throw new Error('routing config projectKey values must be unique')
}
for (const project of parsed.projects) {
  if (project.flashBudget.requestLimit > project.providerLimits.complex.rpd) {
    throw new Error(`flash requestLimit exceeds complex rpd for ${project.projectKey}`)
  }
}
```

Normalize privileged UUIDs to lowercase 32-hex and reject malformed values. Keep `apiKeyEnv`, never key material, in `ValidatedRoutingConfig`.

- [ ] **Step 6: Run GREEN + typecheck**

```powershell
npx tsx --test tests/agent/provider-config.test.ts tests/agent/routing/config.test.ts
npm run typecheck
```

- [ ] **Step 7: Update public examples**

`.env.example` must contain:

```dotenv
MC_AI_PROVIDER=fake
MC_AI_ROUTING_CONFIG=data/ai-routing.json
MC_SERVER_IDENTITY_MODE=offline
MC_AI_KEY_PRIMARY=
MC_AI_KEY_BACKUP=
MC_ADMIN_PORT=8767
MC_ADMIN_TOKEN=

# Deprecated after multi-model routing; ignored as Gemini routing authority.
MC_AI_MODEL=
MC_AI_API_KEY=
```

`config/ai-routing.example.json` uses the exact schema, anonymous `pool-a` / `pool-b`, fake UUIDs, environment-variable names only, and visibly illustrative non-production quota numbers.

- [ ] **Step 8: Commit**

```powershell
git add src/config.ts src/agent/routing/config.ts tests/agent/provider-config.test.ts tests/agent/routing/config.test.ts config/ai-routing.example.json .env.example
git commit -m "feat: define multi-model routing configuration"
```

---

### Task 2: Separate cancellation from failure and carry current-session player identity evidence

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

**Interfaces:**
- Adds `player_left`, `goal_cancelled`, `skill_cancelled` RuntimeEvent branches.
- `player_chat` optionally carries `playerId` from the current Mineflayer session.

- [ ] **Step 1: Add RED event tests**

```ts
assert.deepEqual(bridge.chat('Boss', '墨雪跟我來', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), {
  type: 'player_chat', at: 1234, player: 'Boss',
  playerId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  message: '墨雪跟我來'
})
assert.deepEqual(bridge.playerLeft('Boss', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), {
  type: 'player_left', at: 1234, player: 'Boss',
  playerId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
})
```

GoalManager must publish `goal_cancelled` for `preempted_by_player`; SkillExecutor must publish `skill_cancelled` after AbortSignal cancellation.

- [ ] **Step 2: Run RED**

```powershell
npx tsx --test tests/contracts/events.test.ts tests/goals/goal-manager.test.ts tests/skills/executor.test.ts tests/minecraft/observation-bridge.test.ts tests/minecraft/mineflayer-adapter.test.ts
```

- [ ] **Step 3: Extend RuntimeEventSchema with strict bounded branches**

```ts
const EventCodeSchema = z.string().trim().min(1).max(128)

z.object({
  type: z.literal('player_chat'), at: AtSchema,
  player: z.string().trim().min(1).max(64),
  playerId: z.string().trim().min(1).max(128).optional(),
  message: z.string().max(1000)
}).strict()

z.object({
  type: z.literal('player_left'), at: AtSchema,
  player: z.string().trim().min(1).max(64),
  playerId: z.string().trim().min(1).max(128).optional()
}).strict()

z.object({ type: z.literal('goal_cancelled'), at: AtSchema, goalId: EventCodeSchema, code: EventCodeSchema }).strict()
z.object({ type: z.literal('skill_cancelled'), at: AtSchema, skill: SkillNameSchema, code: EventCodeSchema }).strict()
```

- [ ] **Step 4: Emit cancellation-specific events**

```ts
if (result.status === 'succeeded') {
  await this.events?.publish({ type: 'skill_completed', at: this.now(), skill: active.name })
} else if (result.status === 'cancelled') {
  await this.events?.publish({
    type: 'skill_cancelled', at: this.now(), skill: active.name,
    code: sanitizeCode(result.code, 'cancelled')
  })
} else {
  await this.events?.publish({
    type: 'skill_failed', at: this.now(), skill: active.name,
    code: sanitizeCode(result.code, 'failed')
  })
}
```

GoalManager uses `goal_cancelled` for cancelled SkillResult, player preemption, emergency-stop cancellation, and continuous-goal supersession; only true failures emit `goal_failed`.

- [ ] **Step 5: Carry current chat UUID / player-left evidence**

```ts
const playerId = bot.players[username]?.uuid?.trim()
this.emit(this.bridge.chat(username, message, playerId || undefined))
```

Add `playerLeft` listener and bridge method using the leaving player's UUID when available.

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

### Task 3: Upgrade the decision contract to action / complete / blocked and make context task-aware

**Files:**
- Modify: `src/contracts/decision.ts`
- Modify: `src/agent/context-builder.ts`
- Modify: `src/skills/registry.ts`
- Create: `src/agent/skill-catalog.ts`
- Modify: `tests/agent/context-builder.test.ts`
- Modify: `tests/contracts/decision.test.ts`
- Create: `tests/skills/registry.test.ts`

**Interfaces:**
- Produces `DecisionOutcomeV2Schema` / `DecisionOutcomeV2`.
- Produces `DecisionContext.task`.
- Produces `SkillRegistry.has(name)`, `registeredNames()`, and `registeredDecisionSkills(registry)`.

- [ ] **Step 1: Write RED DecisionOutcome tests**

```ts
assert.equal(DecisionOutcomeV2Schema.parse({
  version: 2,
  outcome: 'action',
  action: { intent: 'gather_resource', args: { resource: 'oak_log', quantity: 4 } }
}).outcome, 'action')

assert.deepEqual(DecisionOutcomeV2Schema.parse({ version: 2, outcome: 'complete' }), {
  version: 2, outcome: 'complete'
})

assert.equal(DecisionOutcomeV2Schema.parse({
  version: 2, outcome: 'blocked', reason: 'capability_unavailable'
}).reason, 'capability_unavailable')

assert.throws(() => DecisionOutcomeV2Schema.parse({
  version: 2, outcome: 'blocked', reason: 'free text is forbidden'
}))
```

- [ ] **Step 2: Add RED context/registry tests**

Context input/output contains:

```ts
task: {
  taskId: 'task-1',
  objective: '採 16 個橡木，回家後放進基地箱子',
  phase: 'active',
  consecutiveReplans: 0,
  previousAction: null
}
```

Registry test proves an unregistered `deposit_item` is not advertised even though `SkillNameSchema` knows the name.

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

export const DecisionBlockedReasonSchema = z.enum([
  'no_safe_action', 'missing_information', 'capability_unavailable'
])

export const DecisionOutcomeV2Schema = z.discriminatedUnion('outcome', [
  z.object({ version: z.literal(2), outcome: z.literal('action'), action: DecisionActionSchema }).strict(),
  z.object({ version: z.literal(2), outcome: z.literal('complete') }).strict(),
  z.object({
    version: z.literal(2), outcome: z.literal('blocked'),
    reason: DecisionBlockedReasonSchema
  }).strict()
])
```

No explanation/reasoning field is allowed.

- [ ] **Step 5: Add bounded task context and registered-skill catalog**

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

ContextBuilder truncates objective/directive before provider use. Add `SkillRegistry.has()` and `registeredNames()`. `skill-catalog.ts` contains a fixed description record and returns only registry-present decision intents.

- [ ] **Step 6: Run GREEN + typecheck, commit**

```powershell
npx tsx --test tests/contracts/decision.test.ts tests/agent/context-builder.test.ts tests/skills/registry.test.ts
npm run typecheck
git add src/contracts/decision.ts src/agent/context-builder.ts src/agent/skill-catalog.ts src/skills/registry.ts tests/contracts/decision.test.ts tests/agent/context-builder.test.ts tests/skills/registry.test.ts
git commit -m "feat: add task-aware decision outcomes"
```

---

### Task 4: Implement deterministic instruction analysis and `balanced-v1` complexity assessment

**Files:**
- Create: `src/agent/routing/contracts.ts`
- Create: `src/agent/routing/complexity.ts`
- Create: `tests/agent/routing/complexity.test.ts`

**Interfaces:**
- Produces `ComplexityEvidence`, `ComplexityAssessment`, `RoutePlan`, `ThinkingLevel`, `RouteClass`, `BudgetClass`.
- Produces `analyzeInstructionComplexity(instruction)` and `assessComplexity(evidence)`.
- Provider output can never modify these values for the current logical decision.

- [ ] **Step 1: Write RED instruction-analyzer tests**

```ts
assert.deepEqual(analyzeInstructionComplexity('跟我來'), {})
assert.equal(analyzeInstructionComplexity('採木頭然後回基地放箱子').multiStep, true)
assert.equal(analyzeInstructionComplexity('採木頭然後回基地放箱子').multiSkill, true)
assert.equal(analyzeInstructionComplexity('自己想辦法找到鐵').openEndedMethod, true)
assert.equal(analyzeInstructionComplexity('把之前說的木頭拿出來，背包不夠就再補').crossContextReasoning, true)
assert.equal(analyzeInstructionComplexity('墨雪仔細想一下').manualComplexityHint, true)
```

V1 deterministic phrase/family tables are fixed program data:

```ts
const OPEN_ENDED = ['自己想辦法', '找個辦法', '你自己決定', 'figure it out', 'find a way']
const MANUAL_HINTS = ['仔細想', '認真想', '用大模型', 'think hard', 'use the big model']
const STEP_CONNECTORS = ['然後', '之後', '接著', '再', 'then', 'and then']
```

Skill-family keyword groups must cover gather, navigation, storage, survival, and equipment; `multiSkill` is true only when at least two distinct groups match. `crossContextReasoning` is true only when at least two explicit domain groups (memory-reference, inventory, world/location, player) match.

- [ ] **Step 2: Write RED score/high tests**

```ts
const cases = [
  [{}, { score: 0, routeClass: 'routine', thinking: 'low' }],
  [{ multiStep: true }, { score: 3, routeClass: 'routine', thinking: 'low' }],
  [{ openEndedMethod: true }, { score: 4, routeClass: 'complex', thinking: 'medium' }],
  [{ multiStep: true, multiSkill: true }, { score: 5, routeClass: 'complex', thinking: 'medium' }],
  [{ goalFailed: true, stuck: true }, { score: 4, routeClass: 'complex', thinking: 'medium' }],
  [{ manualComplexityHint: true }, { score: 2, routeClass: 'routine', thinking: 'low' }]
] as const
```

Also assert:

```ts
assert.equal(assessComplexity({ replanCount: 2 }).highReason, 'repeated_replanning')
assert.equal(assessComplexity({ criticalContext: true }).highReason, 'critical_context')
assert.equal(assessComplexity({ manualDeep: true }).highReason, 'manual_deep_think')
```

- [ ] **Step 3: Run RED**

```powershell
npx tsx --test tests/agent/routing/complexity.test.ts
```

- [ ] **Step 4: Implement routing contracts and exact weights**

```ts
export type RouteClass = 'routine' | 'complex'
export type ThinkingLevel = 'low' | 'medium' | 'high'
export type BudgetClass = 'normal' | 'reserve'

export interface ComplexityEvidence {
  readonly multiStep?: boolean
  readonly multiSkill?: boolean
  readonly openEndedMethod?: boolean
  readonly crossContextReasoning?: boolean
  readonly goalFailed?: boolean
  readonly stuck?: boolean
  readonly manualComplexityHint?: boolean
  readonly riskContext?: boolean
  readonly replanCount?: number
  readonly criticalContext?: boolean
  readonly manualDeep?: boolean
}
```

Weights: multi-step 3, multi-skill 2, open-ended 4, cross-context 2, goal-failed 2, stuck 2, manual hint 2, risk 3. Score `<4` -> routine/low; `>=4` -> complex/medium. High overrides are independent of score.

- [ ] **Step 5: Implement immutable RoutePlan**

```ts
export interface RoutePlan {
  readonly decisionId: string
  readonly policy: 'balanced-v1'
  readonly routeClass: RouteClass
  readonly thinking: ThinkingLevel
  readonly reserveAuthorized: boolean
  readonly reasons: readonly string[]
  readonly highReason: 'manual_deep_think' | 'repeated_replanning' | 'critical_context' | null
}
```

Freeze the object and reasons array. Retry/failover never recomputes it.

- [ ] **Step 6: Run GREEN + typecheck, commit**

```powershell
npx tsx --test tests/agent/routing/complexity.test.ts
npm run typecheck
git add src/agent/routing/contracts.ts src/agent/routing/complexity.ts tests/agent/routing/complexity.test.ts
git commit -m "feat: add deterministic complexity routing policy"
```

---

### Task 5: Add session-scoped Minecraft identity and Manual Deep command parsing

**Files:**
- Create: `src/minecraft/identity-registry.ts`
- Create: `src/minecraft/manual-ai-command.ts`
- Create: `tests/minecraft/identity-registry.test.ts`
- Create: `tests/minecraft/manual-ai-command.test.ts`

**Interfaces:**
- Produces `MinecraftPrincipal`, `MinecraftIdentityRegistry`, and `parseManualAiCommand(message)`.
- Natural-language complexity hints come from `analyzeInstructionComplexity()` in Task 4; this task grants capabilities only for explicit privileged commands.

- [ ] **Step 1: Write RED identity tests**

```ts
const policy = {
  ownerUuid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  operatorAllowlistUuids: ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']
}
assert.equal(registry.resolveChat({
  mode: 'offline', player: 'Boss', playerId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', policy
}).kind, 'minecraft_untrusted')
assert.equal(registry.resolveChat({
  mode: 'online', player: 'Boss', playerId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', policy
}).kind, 'minecraft_owner')
assert.equal(registry.resolveChat({
  mode: 'online', player: 'Op', playerId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', policy
}).kind, 'minecraft_operator')
assert.equal(registry.resolveChat({ mode: 'online', player: 'Boss', policy }).kind, 'minecraft_untrusted')
```

Add tests for disconnect/new-session invalidation, player-left removal, and chat UUID/cache mismatch -> untrusted.

- [ ] **Step 2: Write RED command tests**

```ts
assert.deepEqual(parseManualAiCommand('!moxue deep 重新規劃採木頭'), {
  kind: 'deep_new', instruction: '重新規劃採木頭'
})
assert.deepEqual(parseManualAiCommand('!moxue deep current 再確認背包和箱子'), {
  kind: 'deep_current', directive: '再確認背包和箱子'
})
assert.deepEqual(parseManualAiCommand('!moxue deep current'), {
  kind: 'deep_current'
})
assert.equal(parseManualAiCommand('!moxue deep'), null)
```

- [ ] **Step 3: Run RED**

```powershell
npx tsx --test tests/minecraft/identity-registry.test.ts tests/minecraft/manual-ai-command.test.ts
```

- [ ] **Step 4: Implement UUID normalization/principal resolution**

```ts
export function normalizeMinecraftUuid(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase().replaceAll('-', '') ?? ''
  return /^[0-9a-f]{32}$/.test(normalized) ? normalized : null
}
```

Registry keeps in-process `sessionGeneration`; connected starts a generation, disconnected clears, player_seen upserts, player_left removes. Online privileged resolution requires valid current chat UUID evidence and rejects mismatch with current-session cached identity. Offline always returns untrusted.

- [ ] **Step 5: Implement bounded command parser**

Accept exact case-insensitive `!moxue deep` and `!moxue deep current`. Trim whitespace; cap instruction/directive at 1000 characters; reject empty `deep_new`; never parse passwords/secrets.

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

**Interfaces:**
- Produces `SqliteQuotaLedger` with `allocateConfigGeneration()`, `admitAttempt()`, `markDispatched()`, `settleAttempt()`, `releaseReservation()`, `recoverIncompleteAttempts()`, health/cooldown methods, `adminSnapshot()`, and `close()`.
- Later ProjectPool is the only production caller of admission.

- [ ] **Step 1: Write RED provider-day tests**

```ts
assert.equal(providerDayKey(Date.parse('2026-09-12T06:59:59Z')), '2026-09-11')
assert.equal(providerDayKey(Date.parse('2026-09-12T07:00:00Z')), '2026-09-12')
```

Use `Intl.DateTimeFormat` with `timeZone:'America/Los_Angeles'`, never a fixed UTC offset.

- [ ] **Step 2: Write RED ledger lifecycle tests with a temp SQLite file**

Prove: generation monotonic across reopen; transactional reservation; durable dispatch; actual settlement replaces hold; pre-dispatch release; crash recovery (`reserved -> released`, `dispatched -> uncertain`); rolling RPM/TPM includes active holds; RPD uses provider-day; normal admission blocks on either 70% request or token ceiling; actual-over-reservation sets overrun.

- [ ] **Step 3: Run RED**

```powershell
npx tsx --test tests/agent/routing/provider-day.test.ts tests/agent/routing/quota-ledger.test.ts
```

- [ ] **Step 4: Create schema version 1**

```sql
CREATE TABLE quota_attempts (
  attempt_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  config_generation INTEGER NOT NULL,
  project_key TEXT NOT NULL,
  model TEXT NOT NULL,
  thinking TEXT NOT NULL,
  budget_class TEXT NOT NULL,
  state TEXT NOT NULL,
  reserved_at INTEGER NOT NULL,
  dispatched_at INTEGER,
  settled_at INTEGER,
  provider_day_key TEXT NOT NULL,
  reserved_input_tokens INTEGER NOT NULL,
  reserved_total_tokens INTEGER NOT NULL,
  actual_input_tokens INTEGER,
  actual_output_tokens INTEGER,
  actual_thought_tokens INTEGER,
  actual_tool_tokens INTEGER,
  actual_total_tokens INTEGER,
  accounted_input_tokens INTEGER NOT NULL,
  accounted_total_tokens INTEGER NOT NULL,
  usage_quality TEXT NOT NULL,
  result_class TEXT,
  safe_error_code TEXT,
  budget_overrun INTEGER NOT NULL DEFAULT 0
);
```

Also create indexed `quota_domain_state`, `credential_health`, and `quota_meta`. Use WAL, foreign keys, busy timeout 5000, synchronous NORMAL, and schema-version fail-closed behavior matching memory SQLite style.

- [ ] **Step 5: Implement transactional admission**

```ts
export interface QuotaAdmissionRequest {
  readonly attemptId: string
  readonly decisionId: string
  readonly configGeneration: number
  readonly projectKey: string
  readonly model: string
  readonly thinking: ThinkingLevel
  readonly budgetClass: BudgetClass
  readonly now: number
  readonly reservedInputTokens: number
  readonly reservedTotalTokens: number
  readonly providerLimits: { readonly rpm: number; readonly inputTpm: number; readonly rpd: number }
  readonly flashBudget?: { readonly requestLimit: number; readonly totalTokenLimit: number }
}
```

Inside one transaction, query settled accounting + active holds, evaluate every limit, and insert `reserved` only when all gates pass. Normal Flash ceiling is `Math.floor(limit * 0.70)` for both request and token budgets; reserve may use full configured budget only when upstream selected reserve class.

- [ ] **Step 6: Implement settlement/recovery exactly**

`markDispatched`: only `reserved -> dispatched`. `releaseReservation`: only `reserved -> released`. `settleAttempt`: only dispatched. Actual usage replaces reservation accounting. Rejected pre-inference errors without usage account reserved input only; ambiguous timeout/network/5xx/local-abort/content-block/malformed/crash paths without usage account full reserved totals. Startup recovery releases `reserved`, converts unsettled `dispatched` to terminal `uncertain` conservative charge.

- [ ] **Step 7: Implement domain/process health**

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

Transient policy: 5s -> 15s -> 30s -> 60s, and `max(policyDelay, retryAfterMs)` when Retry-After exists. Success resets transient counter.

- [ ] **Step 8: Run GREEN + typecheck, commit**

```powershell
npx tsx --test tests/agent/routing/provider-day.test.ts tests/agent/routing/quota-ledger.test.ts
npm run typecheck
git add src/agent/routing/provider-day.ts src/agent/routing/quota-ledger.ts tests/agent/routing/provider-day.test.ts tests/agent/routing/quota-ledger.test.ts
git commit -m "feat: add durable Gemini quota ledger"
```

---

### Task 7: Add atomic RoutingConfigManager activation and generation-scoped credentials

**Files:**
- Create: `src/agent/routing/config-manager.ts`
- Create: `tests/agent/routing/config-manager.test.ts`

**Interfaces:**
- Consumes `ValidatedRoutingConfig` and `SqliteQuotaLedger.allocateConfigGeneration()`.
- Produces immutable `RoutingConfigSnapshot`, `activateInitial()`, `reload()`, `snapshot()`, and `resolveCredential(handle)`.

- [ ] **Step 1: Write RED activation/reload tests**

Prove: initial activation validates every `apiKeyEnv`; missing credential does not replace active config; valid reload increases generation atomically; old-generation credential handles remain resolvable for in-flight attempts; reordering does not alter `projectKey`; authorization changes are reported.

- [ ] **Step 2: Run RED**

```powershell
npx tsx --test tests/agent/routing/config-manager.test.ts
```

- [ ] **Step 3: Implement immutable snapshots**

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

Credential handles are opaque generated IDs and never contain key material. Keep `handle -> secret` only in process memory; retain old handles until process exit so generation N attempts can finish after N+1 reload.

- [ ] **Step 4: Implement atomic reload result**

```ts
export type RoutingReloadResult =
  | { readonly kind: 'reloaded'; readonly generation: number; readonly authorizationChanged: boolean }
  | { readonly kind: 'rejected'; readonly code: 'invalid_config' | 'missing_credential' }
```

Read/parse/credential-validate before generation allocation/swap. Failed reload leaves old snapshot active.

- [ ] **Step 5: Run GREEN + typecheck, commit**

```powershell
npx tsx --test tests/agent/routing/config-manager.test.ts
npm run typecheck
git add src/agent/routing/config-manager.ts tests/agent/routing/config-manager.test.ts
git commit -m "feat: add atomic routing config manager"
```

---

### Task 8: Implement JIT ProjectPool admission and 70/30 reservation estimation

**Files:**
- Create: `src/agent/routing/project-pool.ts`
- Create: `tests/agent/routing/project-pool.test.ts`

**Interfaces:**
- Consumes immutable RoutePlan, current RoutingConfigSnapshot, prepared payload bytes, process instance ID, and QuotaLedger.
- Produces exactly one AttemptLease or unavailable result with retryAt.
- No network I/O/retry loop lives here.

- [ ] **Step 1: Write RED ordering tests**

Prove: routine stays Lite across pool; automatic complex scans all normal and never reserve; manual complex scans all normal before any reserve; primary returns after cooldown; credential-disabled skips both models; Flash domain failure does not block Lite domain; all cooldowns return earliest retryAt; all credentials disabled return null retryAt.

- [ ] **Step 2: Write RED reservation-estimator tests**

```ts
export function estimateReservation(
  utf8PayloadBytes: number,
  inputTokenOverhead: number,
  generationAllowance: number
) {
  const input = utf8PayloadBytes + inputTokenOverhead
  return { inputTokens: input, totalTokens: input + generationAllowance }
}
```

This deliberately conservative estimate avoids a separate countTokens request.

- [ ] **Step 3: Run RED**

```powershell
npx tsx --test tests/agent/routing/project-pool.test.ts
```

- [ ] **Step 4: Define AttemptLease with safe public role label**

```ts
export interface AttemptLease {
  readonly attemptId: string
  readonly decisionId: string
  readonly configGeneration: number
  readonly projectKey: string
  readonly projectLabel: string // "primary", "backup-1", ... for public telemetry/status
  readonly credentialHandle: string
  readonly model: string
  readonly thinking: ThinkingLevel
  readonly budgetClass: BudgetClass
  readonly reservationId: string
}
```

`projectKey` is internal/admin anonymous identity; public status uses only `projectLabel`.

- [ ] **Step 5: Implement scan policy**

Routine: one normal scan using routine model. Complex automatic: one normal scan. Complex reserve-authorized: all normal candidates first, then all reserve candidates. Call ledger admission while scanning; skipped/non-admitted candidates do not consume API-attempt budget.

- [ ] **Step 6: Run GREEN + typecheck, commit**

```powershell
npx tsx --test tests/agent/routing/project-pool.test.ts
npm run typecheck
git add src/agent/routing/project-pool.ts tests/agent/routing/project-pool.test.ts
git commit -m "feat: add quota-aware Gemini project pool"
```

---

### Task 9: Refactor Gemini into a one-attempt transport with usage and safe error normalization

**Files:**
- Modify: `src/agent/providers/gemini.ts`
- Modify: `tests/agent/providers/gemini.test.ts`
- Modify: `tests/agent/reasoning-isolation.test.ts`

**Interfaces:**
- Produces `PreparedGeminiPayload` and normalized AttemptResult.
- Consumes AttemptLease and opaque CredentialResolver.
- Exactly one SDK/API attempt per execute call; no routing policy here.

- [ ] **Step 1: Write RED per-attempt request tests**

```ts
const result = await transport.execute(prepared, {
  attemptId: 'a1', decisionId: 'd1', configGeneration: 3,
  projectKey: 'pool-b', projectLabel: 'backup-1', credentialHandle: 'cred-3-b',
  model: 'gemini-3.8-flash', thinking: 'medium', budgetClass: 'normal', reservationId: 'a1'
}, new AbortController().signal)

assert.equal(fake.requests[0]?.request.model, 'gemini-3.8-flash')
assert.equal(fake.requests[0]?.request.generation_config.thinking_level, 'medium')
assert.equal(fake.requests[0]?.request.store, false)
assert.equal(fake.requests[0]?.options.retryAttempts, 1)
```

Success response fixture includes actual usage fields and test asserts normalized input/output/thought/tool/total counts; thought text never appears.

- [ ] **Step 2: Add RED safe-error tests**

Fake structured SDK errors: 401 authentication, 403 permission_denied, 429 quota_exceeded, 503, TimeoutError, local AbortError, content_blocked, malformed function call. Raw error message is never returned.

- [ ] **Step 3: Run RED**

```powershell
npx tsx --test tests/agent/providers/gemini.test.ts tests/agent/reasoning-isolation.test.ts
```

- [ ] **Step 4: Build V2 forced-function payload**

```ts
export interface PreparedGeminiPayload {
  readonly input: string
  readonly systemInstruction: string
  readonly tools: readonly GeminiFunctionTool[]
  readonly utf8Bytes: number
}
```

Tool schema mirrors `DecisionOutcomeV2`: action contains an intent-discriminated action object; complete and blocked are terminal branches. Keep one forced `submit_decision`, `store=false`, `stream=false`, `thinking_summaries='none'`.

- [ ] **Step 5: Implement one-attempt SDK adapter**

Expose an injected test interface:

```ts
export interface GeminiInteractionClient {
  create(
    request: GeminiInteractionRequest,
    options: { readonly timeout: number; readonly retryAttempts: 1; readonly signal: AbortSignal }
  ): Promise<GeminiInteractionResponse>
}
```

The real @google/genai 2.21.0 adapter maps `retryAttempts:1` to SDK `retryOptions: { attempts: 1 }`, maps timeout to the SDK timeout option, and passes AbortSignal through the SDK request abort field. Cache clients by opaque credential handle; resolve raw key only inside this boundary.

- [ ] **Step 6: Normalize usage/result facts**

```ts
export interface GeminiUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly thoughtTokens: number
  readonly toolTokens: number
  readonly totalTokens: number
}
```

Transport returns success/generation_error/content_blocked/api_error/timeout/network_error/cancelled facts only. It does not choose retry/failover policy.

- [ ] **Step 7: Run GREEN + typecheck, commit**

```powershell
npx tsx --test tests/agent/providers/gemini.test.ts tests/agent/reasoning-isolation.test.ts
npm run typecheck
git add src/agent/providers/gemini.ts tests/agent/providers/gemini.test.ts tests/agent/reasoning-isolation.test.ts
git commit -m "refactor: make Gemini provider a routed single-attempt transport"
```

---

### Task 10: Implement provider error policy and bounded RoutedDecisionExecutor

**Files:**
- Create: `src/agent/routing/error-policy.ts`
- Create: `src/agent/routing/routed-executor.ts`
- Create: `tests/agent/routing/error-policy.test.ts`
- Create: `tests/agent/routing/routed-executor.test.ts`

**Interfaces:**
- Produces pure `classifyAttemptResult()` and `RoutedDecisionExecutor.execute()`.
- Coordinator sees only LogicalDecisionResult.

- [ ] **Step 1: Write RED error-policy matrix**

Exact policy table: 401/403 credential-fatal; quota_exceeded domain unavailable; rate_limit_exceeded/too_many_requests/unknown429 transient; 408/409-aborted/500/502/503/504/network/timeout transient; invalid_request/parameter_unknown/model_not_found/generic non-retry 4xx configuration error; content_blocked safety terminal; generation error one clean repair retry; local cancellation terminal cancelled.

- [ ] **Step 2: Implement pure closed union**

```ts
export type AttemptPolicy =
  | { kind: 'success' }
  | { kind: 'credential_fatal'; safeCode: string }
  | { kind: 'quota_unavailable'; safeCode: string; retryAt: number }
  | { kind: 'transient'; safeCode: string; retryAfterMs?: number }
  | { kind: 'safety_terminal'; safeCode: 'content_blocked' }
  | { kind: 'generation_retry'; safeCode: string }
  | { kind: 'configuration_error'; safeCode: string }
  | { kind: 'cancelled' }
```

Safety/content code classification precedes HTTP family classification.

- [ ] **Step 3: Write RED executor tests**

Prove immutable RoutePlan, A transient -> B success, A 401 -> B success, content block -> no B, one generation repair only, unavailable retryAt semantics, cancellation no penalty, settlement before next attempt, and `maxApiAttempts = configuredProjectCount + 4`.

- [ ] **Step 4: Define LogicalDecisionResult exactly**

```ts
export type LogicalDecisionResult =
  | { readonly kind: 'success'; readonly providerResult: ProviderResult; readonly lease: AttemptLease }
  | { readonly kind: 'safety_blocked'; readonly code: 'content_blocked' }
  | { readonly kind: 'unavailable'; readonly retryAt: number | null }
  | { readonly kind: 'invalid_response'; readonly code: string }
  | { readonly kind: 'configuration_error'; readonly code: string }
  | { readonly kind: 'cancelled' }
```

- [ ] **Step 5: Implement sequential loop**

```ts
for (let attempts = 0; attempts < maxAttempts; attempts += 1) {
  if (signal.aborted) return { kind: 'cancelled' }
  const leaseResult = this.pool.nextLease(plan, prepared)
  if (leaseResult.kind === 'unavailable') return leaseResult
  this.ledger.markDispatched(leaseResult.lease.reservationId, this.now())
  const attempt = await this.transport.execute(prepared, leaseResult.lease, signal)
  const policy = classifyAttemptResult(attempt, this.now())
  this.settleAndRecord(leaseResult.lease, attempt, policy)
  // branch only on the closed AttemptPolicy union
}
```

Never recalculate RoutePlan. Immediately use another eligible Project instead of sleeping; sleep abortably only when every candidate is temporarily unavailable.

- [ ] **Step 6: Run GREEN + typecheck, commit**

```powershell
npx tsx --test tests/agent/routing/error-policy.test.ts tests/agent/routing/routed-executor.test.ts
npm run typecheck
git add src/agent/routing/error-policy.ts src/agent/routing/routed-executor.ts tests/agent/routing/error-policy.test.ts tests/agent/routing/routed-executor.test.ts
git commit -m "feat: add routed Gemini retry and failover executor"
```

---

### Task 11: Refactor DecisionGate into a task-aware outcome gate with no direct Goal submission

**Files:**
- Modify: `src/agent/decision-gate.ts`
- Modify: `src/agent/provider.ts`
- Modify: `tests/agent/decision-gate.test.ts`
- Modify: `tests/agent/provider-capabilities.test.ts`

**Interfaces:**
- Produces `GatedOutcome = action | complete | blocked | rejected`.
- DecisionGate accepts provider result + latest state + registered-skill predicate.
- Removes direct DecisionPipeline goal submission.

- [ ] **Step 1: Write RED complete/blocked/unregistered tests**

```ts
assert.deepEqual(await gate.accept(structured({ version: 2, outcome: 'complete' }), state, () => true), {
  kind: 'complete', provider: 'fake', mode: 'function_call'
})
assert.deepEqual(await gate.accept(structured({
  version: 2, outcome: 'blocked', reason: 'missing_information'
}), state, () => true), {
  kind: 'blocked', provider: 'fake', mode: 'function_call', reason: 'missing_information'
})
```

Action with unavailable skill returns rejected `skill_not_registered`. Keep malformed-result and SafetyPolicy tests.

- [ ] **Step 2: Run RED**

```powershell
npx tsx --test tests/agent/decision-gate.test.ts tests/agent/provider-capabilities.test.ts
```

- [ ] **Step 3: Implement V2 mapping**

For action, map `outcome.action.intent/args` to GoalRequest, check registered skill, then SafetyPolicy. Complete/blocked create no goal. Remove `DecisionPipeline` so Coordinator owns final submission/stale checks.

- [ ] **Step 4: Run GREEN + typecheck, commit**

```powershell
npx tsx --test tests/agent/decision-gate.test.ts tests/agent/provider-capabilities.test.ts
npm run typecheck
git add src/agent/decision-gate.ts src/agent/provider.ts tests/agent/decision-gate.test.ts tests/agent/provider-capabilities.test.ts
git commit -m "refactor: gate task outcomes before coordinator execution"
```

---

### Task 12: Add volatile AiTask, one-shot grants, and deterministic trigger classification

**Files:**
- Create: `src/runtime/ai-task.ts`
- Create: `src/runtime/trigger-classifier.ts`
- Create: `tests/runtime/ai-task.test.ts`
- Create: `tests/runtime/trigger-classifier.test.ts`

**Interfaces:**
- Produces AiTask, ManualRouteGrant, AiTaskQueue, DecisionDemand, TriggerClassifier.
- Uses `analyzeInstructionComplexity()` from Task 4 for base task evidence.
- Queue policy: one active + max eight pending; reject newest at capacity.

- [ ] **Step 1: Write RED task/grant tests**

Prove objective/source/principal/generation storage; 8 pending limit; grant consumed once; invalid on task/session generation change; failure vs cancellation counters; success resets consecutive count; no persistence/replay.

- [ ] **Step 2: Write RED trigger tests**

State-only event -> state_only. `stuck`/`skill_failed` attach evidence to one goal cause. `goal_failed` creates one replan boundary. `goal_cancelled` does not. `goal_completed` continues only active task goal. Different addressed instructions stay separate.

V1 deterministic address prefixes: `!moxue`, `墨雪`, `moxue` case-insensitive, or configured Minecraft bot username. Strip one leading punctuation/comma/colon after address and reject empty instruction.

Assert explicit task stores `analyzeInstructionComplexity(instruction)` output as base evidence.

- [ ] **Step 3: Run RED**

```powershell
npx tsx --test tests/runtime/ai-task.test.ts tests/runtime/trigger-classifier.test.ts
```

- [ ] **Step 4: Implement bounded volatile types**

```ts
export interface DecisionDemand {
  readonly demandId: string
  readonly taskId: string
  readonly causeKeys: ReadonlySet<string>
  readonly reasons: ReadonlySet<string>
  readonly createdAt: number
}
```

Demand stores no WorldState snapshot. Task objective/directive max 1000 chars. Deep-current grant targets current task ID/generation and never arms a future task.

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

**Interfaces:**
- Consumes events, state, goals, memory, registry/catalog, identity, config/manual-access snapshot, complexity policy, DecisionGate, and logical decision executor.
- Produces `start()`, `dispose()`, `status()`, `submitAdminDeepThink()`, `invalidateManualGrants()`, `clearAiWork(reason)`.

- [ ] **Step 1: Write RED non-blocking mailbox test**

Use unresolved fake executor; `events.publish(player_chat)` must complete while decision promise remains pending. Inventory/emergency-stop events must still enter mailbox.

- [ ] **Step 2: Add RED single-flight/stale tests**

Prove one decision in flight; state updates do not spawn a second; emergency stop invalidates result; direct player goal supersedes active AI task while preserving previously queued explicit tasks; ordinary inventory/position updates do not stale result; final gate uses latest state.

- [ ] **Step 3: Add RED multi-step/replan tests**

Flow: explicit -> action gather -> goal_completed -> continuation -> next registered action -> complete. `stuck + skill_failed + goal_failed` -> one replan. First failure can route Flash-medium via score; second consecutive failure makes next decision high with `reserveAuthorized=false`; action success resets consecutive count.

- [ ] **Step 4: Add RED queue/continuous tests**

Bounded skill + new task queues without abort. `follow_player` / `stay` can be safely superseded by a new explicit task and publish cancellation, not failure. Max eight pending. Different players never merge.

- [ ] **Step 5: Add RED unavailable/recovery/reconnect tests**

AI unavailable lets active skill finish. `retryAt` creates exactly one wake-up. Recovery creates one fresh decision using latest state. Null retryAt causes no polling. Disconnect suspends ordinary task/invalidate decision; reconnect+spawn creates one fresh decision. Manual grant dies on disconnect and does not downgrade.

- [ ] **Step 6: Implement mailbox state ownership**

```ts
coordinator: 'running' | 'stopped'
activeTask: AiTask | null
pendingTasks: AiTaskQueue
execution: 'idle' | 'decision_pending' | 'decision_in_flight' | 'goal_running'
aiAvailability: 'available' | 'unavailable'
minecraftReady: boolean
```

RuntimeEvent subscriber clones/enqueues and returns void. A Promise tail or explicit queue serializes transitions; Gemini is awaited outside event publisher and completion is enqueued back.

- [ ] **Step 7: Implement decision dispatch/finalization**

At safe boundary: latest state -> task-aware context -> current memory/registered skills -> evidence + one-shot grant -> assessment -> immutable RoutePlan -> one AbortController executor call. Consume grant only when dispatch occurs. On result, verify task/session generation, call DecisionGate with latest state and `registry.has`, then action submit / complete / blocked. Safety rejection is terminal.

- [ ] **Step 8: Run GREEN + typecheck, commit**

```powershell
npx tsx --test tests/runtime/decision-coordinator.test.ts
npm run typecheck
git add src/runtime/decision-coordinator.ts tests/runtime/decision-coordinator.test.ts
git commit -m "feat: add production AI decision coordinator"
```

---

### Task 14: Add loopback-only Admin API and local deep-think/reload entrypoints

**Files:**
- Create: `src/api/admin-server.ts`
- Create: `tests/api/admin-server.test.ts`

**Interfaces:**
- Consumes RoutingConfigManager, QuotaLedger admin snapshot, Coordinator admin port.
- Exposes quota/reload/deep-think endpoints; host structurally fixed to 127.0.0.1 and token compared constant-time.

- [ ] **Step 1: Write RED auth/bind tests**

Prove no non-loopback host option exists; missing/wrong Authorization -> 401; correct Admin token works; Control token does not; token never appears in error JSON.

- [ ] **Step 2: Write RED endpoint tests**

Quota returns anonymous projectKey + bounded metrics only. Reload valid -> new generation; invalid -> safe error + old generation. Deep-think requires instruction and supports `Idempotency-Key`: same key+same body returns original response; same key+different body ->409. Cache max 256 oldest-first.

- [ ] **Step 3: Run RED**

```powershell
npx tsx --test tests/api/admin-server.test.ts
```

- [ ] **Step 4: Implement narrow ports**

```ts
export interface AdminQuotaPort { snapshot(): unknown }
export interface AdminRoutingPort { reload(): Promise<RoutingReloadResult> }
export interface AdminDecisionPort {
  submitDeepThink(instruction: string): Promise<{ taskId: string }>
  invalidateManualGrants(reason: string): void
}
```

On successful authorization-changing reload, invalidate pending privileged grants before response.

- [ ] **Step 5: Run GREEN + typecheck, commit**

```powershell
npx tsx --test tests/api/admin-server.test.ts
npm run typecheck
git add src/api/admin-server.ts tests/api/admin-server.test.ts
git commit -m "feat: add protected AI admin API"
```

---

### Task 15: Add safe telemetry and extend `/v1/status`

**Files:**
- Modify: `src/contracts/events.ts`
- Modify: `src/api/control-server.ts`
- Modify: `src/agent/routing/routed-executor.ts`
- Modify: `src/runtime/decision-coordinator.ts`
- Modify: `tests/contracts/events.test.ts`
- Modify: `tests/api/control-server.test.ts`

**Interfaces:**
- Safe events: complexity_assessment, model_route, attempt_result, ai_availability_changed, task_started/completed/blocked/superseded.
- Adds `ControlAiStatusPort`.

- [ ] **Step 1: Write RED safe-event schema tests**

```ts
{
  type: 'model_route', at: 1, decisionId: 'd1',
  model: 'gemini-3.8-flash', thinking: 'medium', project: 'backup-1',
  reasons: ['multi_step', 'multi_skill'], reserveAuthorized: false, reserveUsed: false
}
```

No raw projectKey in public event, no API key/prompt/objective/UUID/raw provider body.

- [ ] **Step 2: Write RED status test**

```json
{
  "ai": {
    "routine_model": "gemini-3.5-flash-lite",
    "complex_model": "gemini-3.8-flash",
    "available": true,
    "active_project": "primary",
    "flash_auto_used_pct": 42,
    "manual_deep_think_available": true,
    "coordinator_state": "goal_running",
    "active_task_id": "task-1",
    "active_goal_kind": "gather_resource",
    "pending_task_count": 1,
    "decision_in_flight": false
  }
}
```

No objective/UUID/real Project ID/detailed reserve diagnostics.

- [ ] **Step 3: Run RED**

```powershell
npx tsx --test tests/contracts/events.test.ts tests/api/control-server.test.ts
```

- [ ] **Step 4: Publish only safe telemetry at owners**

Coordinator publishes task/complexity/availability; RoutedExecutor publishes route/attempt after admission/settlement using `AttemptLease.projectLabel` for public events. Raw provider errors never enter event bus.

- [ ] **Step 5: Extend status composition**

Add `aiStatus` port to ControlServerOptions and clone only bounded safe fields into payload; existing Minecraft/goal status remains unchanged.

- [ ] **Step 6: Run GREEN + typecheck, commit**

```powershell
npx tsx --test tests/contracts/events.test.ts tests/api/control-server.test.ts
npm run typecheck
git add src/contracts/events.ts src/api/control-server.ts src/agent/routing/routed-executor.ts src/runtime/decision-coordinator.ts tests/contracts/events.test.ts tests/api/control-server.test.ts
git commit -m "feat: expose safe AI routing observability"
```

---

### Task 16: Wire fake and Gemini modes into the composition root

**Files:**
- Modify: `src/main.ts`
- Modify: `tests/main.test.ts`
- Modify: `tests/main-storage-bootstrap.test.ts`

**Interfaces:**
- Fake mode: direct provider-neutral logical executor; no routing file/quota DB/Admin unless explicitly injected.
- Gemini mode: QuotaLedger -> RoutingConfigManager -> ProjectPool -> GeminiTransport -> RoutedDecisionExecutor -> Coordinator -> optional AdminServer.

- [ ] **Step 1: Update harness seam and write RED fake-mode test**

Replace old `createDecisionProvider` dependency with a provider-neutral logical executor factory while retaining fake DecisionProvider capability checks inside the fake stack. Assert fake mode never reads routing JSON or creates `data/ai-quota.sqlite3`.

- [ ] **Step 2: Write RED Gemini composition tests**

Use temp routing config + test credential env + fake Gemini transport. Assert: config activation/recovery before API exposure; Minecraft connect before Control/Admin start; Admin starts only with token; shutdown closes Admin then Control, clears AI work, stops goals/runtime, closes quota DB and memory.

- [ ] **Step 3: Run RED**

```powershell
npx tsx --test tests/main.test.ts tests/main-storage-bootstrap.test.ts
```

- [ ] **Step 4: Implement composition helpers**

```ts
function createFakeDecisionStack(/* narrow deps */): LogicalDecisionExecutor
function createGeminiDecisionStack(/* narrow deps */): GeminiDecisionStack
```

Use `DEFAULT_MEMORY_PATH='data/mc_memory.sqlite3'`, `DEFAULT_QUOTA_PATH='data/ai-quota.sqlite3'`, and one `processInstanceId = randomUUID()` per application process passed to ProjectPool/QuotaLedger health checks.

- [ ] **Step 5: Wire Coordinator before adapter events**

Coordinator subscribes before Minecraft emits chat/session events. Feed latest state, memory, registered skill catalog, identity mode/registry, active routing snapshot/manual policy, goals, and executor through narrow ports.

- [ ] **Step 6: Wire `/v1/stop` semantics through emergency_stop event**

GoalManager still stops deterministic actuator. Coordinator consumes emergency_stop, clears active/pending AI work/grants, invalidates in-flight generation, then remains running+idle.

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

### Task 17: Add E2E scenarios, real Gemini validation harness, and final docs/gates

**Files:**
- Create: `tests/scenarios/gemini-routing-coordinator.test.ts`
- Create: `scripts/validate-gemini-routing-live.ts`
- Modify: `package.json`
- Modify: `package-lock.json` only if npm changes scripts/metadata in the lockfile
- Modify: `README.md`
- Modify: `.env.example` only for corrections discovered during validation
- Modify: `docs/superpowers/specs/2026-09-12-gemini-multi-model-routing-design.md` status after verified implementation

**Interfaces:**
- Scenario uses real Coordinator + real QuotaLedger + real ProjectPool with fake transport.
- Live harness runs real Gemini only under explicit opt-in and outputs safe evidence.

- [ ] **Step 1: Write E2E fake-transport scenario**

Prove in one deterministic scenario: simple addressed task -> Lite/low pool-a; pool-a Lite transient -> pool-b; multi-step -> Flash/medium with no Lite waste; coalesced runtime failure -> one replan; second consecutive failure -> Flash/high no reserve; trusted online deep -> Flash/high, all normal checked before reserve; content_blocked terminal no failover; AI unavailable lets deterministic skill finish and recovery makes one fresh decision using latest state.

- [ ] **Step 2: Run scenario and fix only owning components**

```powershell
npx tsx --test tests/scenarios/gemini-routing-coordinator.test.ts
```

Do not weaken unit invariants to make E2E pass.

- [ ] **Step 3: Implement opt-in live script**

Skip unless all are true:

```text
MC_AI_LIVE_VALIDATION=1
MC_AI_PROVIDER=gemini
MC_AI_ROUTING_CONFIG=<private file>
```

Run routine -> Lite-low, complex multi-step -> Flash-medium, local-admin deep -> Flash-high, and verify response usage settles actual input/output/thought/total into quota ledger. Print only projectLabel/projectKey anonymous identity, model, thinking, safe reason, usage counts, PASS/FAIL. Never print instruction/prompt/key/raw error/real Project ID.

Add:

```json
"validate:gemini-live": "tsx scripts/validate-gemini-routing-live.ts"
```

- [ ] **Step 4: Update README operations**

Document private config copy path, MC_AI_KEY_* secrets outside JSON, active AI Studio provider limits, fail-closed missing limits, online/offline trust, both deep commands, loopback Admin endpoints, 70/30 semantics, quota DB privacy, and remaining release gates.

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

If unavailable/quota/config blocks it, keep live gate pending and record the safe result; fake evidence never substitutes for real Gemini evidence.

- [ ] **Step 7: Run final security searches**

```powershell
git diff main...HEAD -- . ':!package-lock.json'
git grep -n "MC_AI_KEY_" -- ':!config/ai-routing.example.json' ':!.env.example' ':!docs/**'
git grep -n -E "AIza[0-9A-Za-z_-]+" -- .
```

Expected: no real key, no prompt/objective persistence in quota/telemetry, no Admin non-loopback bind, no raw provider error logging.

- [ ] **Step 8: Update spec status truthfully**

If code/tests are complete but release evidence remains pending, use status text such as:

```text
Implemented architecture; real-environment release gates remain pending where listed below.
```

Do not mark 30-minute human, Pi measurement, 4-8h soak, missing skill wiring, or DC_BOT integration complete without evidence.

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

- [ ] **Step 11: Update Draft PR #4 for implementation review, never auto-merge**

Summarize implemented routing, automated tests, live evidence, and still-pending release gates. Mark ready only after required CI is green on current head. Do not bypass protected-main requirements.

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

No task may broaden DC_BOT integration, proxy UUID trust, concurrent autonomous tasks, speculative parallel calls, server-side Gemini conversation state, or arbitrary complexity-weight hot reload. Those remain future architecture changes.
