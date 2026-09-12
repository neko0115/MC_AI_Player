# Gemini Multi-Model Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved deterministic Gemini Lite/Flash routing architecture, including trusted manual deep-think, an ordered Google Project pool, durable quota accounting, a production decision coordinator, and a loopback-only Admin API without weakening the existing deterministic gameplay and SafetyPolicy boundaries.

**Architecture:** The runtime will keep AI planning provider-neutral at the Coordinator boundary. A deterministic complexity policy creates an immutable RoutePlan, the ProjectPool obtains one JIT AttemptLease at a time from a durable SQLite QuotaLedger, and GeminiTransport performs exactly one SDK/API attempt per lease with no SDK-level retry. The DecisionCoordinator owns AiTask lifecycle and stale-result rejection; routing/auth/quota components never execute gameplay directly, and every accepted action still passes the latest registered-skill and SafetyPolicy checks before GoalManager submission.

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
├─ config.ts                                  # startup env config only
├─ main.ts                                    # composition root only
├─ contracts/
│  ├─ decision.ts                             # DecisionOutcomeV2 schema
│  ├─ events.ts                               # normalized runtime/telemetry events
│  ├─ goals.ts
│  └─ skills.ts
├─ agent/
│  ├─ provider.ts                             # provider-neutral final-output contract
│  ├─ context-builder.ts                      # bounded task-aware DecisionContext
│  ├─ decision-gate.ts                        # outcome validation + latest SafetyPolicy gate
│  ├─ fake-provider.ts
│  ├─ skill-catalog.ts                        # descriptions filtered by registered skills
│  ├─ providers/
│  │  └─ gemini.ts                            # stateless one-attempt Gemini transport
│  └─ routing/
│     ├─ contracts.ts                         # RoutePlan / AttemptLease / result types
│     ├─ config.ts                            # private JSON schema/parser
│     ├─ config-manager.ts                    # atomic activation + generation credentials
│     ├─ complexity.ts                        # balanced-v1
│     ├─ provider-day.ts                      # America/Los_Angeles day key
│     ├─ quota-ledger.ts                      # durable reservations/accounting/health
│     ├─ project-pool.ts                      # JIT primary-first admission
│     ├─ error-policy.ts                      # normalized provider classification
│     └─ routed-executor.ts                   # bounded sequential retry/failover
├─ runtime/
│  ├─ ai-task.ts                              # volatile task/grant/queue types
│  ├─ trigger-classifier.ts                   # deterministic chat/event demand classification
│  ├─ decision-coordinator.ts                 # actor/mailbox state machine
│  └─ goal-execution-loop.ts
├─ minecraft/
│  ├─ identity-registry.ts                    # session-scoped UUID principal resolution
│  ├─ manual-ai-command.ts                    # deep/current + complexity hint parser
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
├─ agent/routing/
│  ├─ config.test.ts
│  ├─ complexity.test.ts
│  ├─ provider-day.test.ts
│  ├─ quota-ledger.test.ts
│  ├─ project-pool.test.ts
│  ├─ error-policy.test.ts
│  └─ routed-executor.test.ts
├─ agent/providers/gemini.test.ts
├─ agent/decision-gate.test.ts
├─ agent/context-builder.test.ts
├─ minecraft/identity-registry.test.ts
├─ minecraft/manual-ai-command.test.ts
├─ minecraft/observation-bridge.test.ts
├─ minecraft/mineflayer-adapter.test.ts
├─ runtime/ai-task.test.ts
├─ runtime/trigger-classifier.test.ts
├─ runtime/decision-coordinator.test.ts
├─ api/admin-server.test.ts
├─ api/control-server.test.ts
├─ goals/goal-manager.test.ts
├─ skills/executor.test.ts
├─ main.test.ts
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
- Produces: `AiConfig = {provider:'fake'} | {provider:'gemini'; routingConfigPath:string}`.
- Produces: `MinecraftServerIdentityMode = 'online' | 'offline'` via `loadMinecraftServerIdentityMode()`.
- Produces: `AdminApiConfig = {enabled:false} | {enabled:true; host:'127.0.0.1'; port:number; bearerToken:string}`.
- Produces: `ValidatedRoutingConfig` and `parseRoutingConfig(raw: unknown)`; no raw credential secret is part of this type.
- Later tasks consume the exact field names defined here.

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
  }), {
    provider: 'gemini',
    routingConfigPath: 'data/ai-routing.json'
  })
  assert.deepEqual(loadAiConfig({
    MC_AI_PROVIDER: 'gemini',
    MC_AI_ROUTING_CONFIG: 'D:/private/router.json'
  }), {
    provider: 'gemini',
    routingConfigPath: 'D:/private/router.json'
  })
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

- [ ] **Step 2: Run the provider-config test and verify RED**

Run:

```powershell
npx tsx --test tests/agent/provider-config.test.ts
```

Expected: FAIL because the new loaders/types do not exist and `loadAiConfig()` still requires `MC_AI_MODEL` / `MC_AI_API_KEY`.

- [ ] **Step 3: Add the startup config types and loaders**

Implement this public shape in `src/config.ts`:

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

`loadAiConfig()` must require only `MC_AI_PROVIDER` plus the routing path for Gemini. `MC_AI_MODEL` and `MC_AI_API_KEY` are ignored as routing authority. `loadAdminApiConfig()` must hard-code host `127.0.0.1`, validate port `1..65535`, cap token length at 4096, and return disabled when the token is absent.

- [ ] **Step 4: Write the routing JSON schema tests**

Use a single valid fixture function and mutate one rule per test:

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseRoutingConfig } from '../../../src/agent/routing/config.js'

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

- [ ] **Step 5: Implement `ValidatedRoutingConfig` with strict Zod schemas and semantic validation**

Required semantic checks after Zod parsing:

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

Normalize owner/operator UUIDs to lowercase 32-hex at parse time; reject malformed privileged UUIDs. Keep `apiKeyEnv`, never a key value, in `ValidatedRoutingConfig`.

- [ ] **Step 6: Run config tests and typecheck**

```powershell
npx tsx --test tests/agent/provider-config.test.ts tests/agent/routing/config.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Add safe public configuration examples**

Update `.env.example` to add:

```dotenv
MC_AI_PROVIDER=fake
MC_AI_ROUTING_CONFIG=data/ai-routing.json
MC_SERVER_IDENTITY_MODE=offline
MC_AI_KEY_PRIMARY=
MC_AI_KEY_BACKUP=
MC_ADMIN_PORT=8767
MC_ADMIN_TOKEN=

# Deprecated after the multi-model routing migration; ignored as Gemini routing authority.
MC_AI_MODEL=
MC_AI_API_KEY=
```

Create `config/ai-routing.example.json` with the exact schema above, anonymous `pool-a` / `pool-b`, and clearly non-production illustrative quota values. Include only fake UUIDs and environment-variable names.

- [ ] **Step 8: Commit Task 1**

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
- Modify: `tests/contracts/events.test.ts` if present; otherwise create it
- Modify: `tests/goals/goal-manager.test.ts`
- Modify: `tests/skills/executor.test.ts`
- Modify: `tests/minecraft/observation-bridge.test.ts`
- Modify: `tests/minecraft/mineflayer-adapter.test.ts`

**Interfaces:**
- Produces new `RuntimeEvent` branches: `player_left`, `goal_cancelled`, `skill_cancelled`.
- Changes `player_chat` to optionally carry `playerId` from the current Mineflayer session.
- Later Coordinator tests rely on cancellation never being represented as `goal_failed` / `skill_failed`.

- [ ] **Step 1: Add RED tests for event semantics**

Required assertions:

```ts
assert.deepEqual(bridge.chat('Boss', '墨雪跟我來', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), {
  type: 'player_chat',
  at: 1234,
  player: 'Boss',
  playerId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  message: '墨雪跟我來'
})

assert.deepEqual(bridge.playerLeft('Boss', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), {
  type: 'player_left',
  at: 1234,
  player: 'Boss',
  playerId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
})
```

GoalManager cancellation test must assert `preempted_by_player` publishes `goal_cancelled`, not `goal_failed`. SkillExecutor cancellation test must assert an aborted skill publishes `skill_cancelled`.

- [ ] **Step 2: Run the focused tests and verify RED**

```powershell
npx tsx --test tests/goals/goal-manager.test.ts tests/skills/executor.test.ts tests/minecraft/observation-bridge.test.ts tests/minecraft/mineflayer-adapter.test.ts
```

Expected: FAIL on missing event branches and current failure-only cancellation behavior.

- [ ] **Step 3: Extend `RuntimeEventSchema`**

Add strict branches equivalent to:

```ts
z.object({
  type: z.literal('player_chat'),
  at: AtSchema,
  player: z.string().trim().min(1).max(64),
  playerId: z.string().trim().min(1).max(128).optional(),
  message: z.string().max(1000)
}).strict()

z.object({
  type: z.literal('player_left'),
  at: AtSchema,
  player: z.string().trim().min(1).max(64),
  playerId: z.string().trim().min(1).max(128).optional()
}).strict()

z.object({ type: z.literal('goal_cancelled'), at: AtSchema, goalId: Identifier, code: Identifier }).strict()
z.object({ type: z.literal('skill_cancelled'), at: AtSchema, skill: SkillNameSchema, code: Identifier }).strict()
```

Use the existing bounded identifier conventions rather than introducing unbounded strings.

- [ ] **Step 4: Emit cancellation-specific events**

In `SkillExecutor.run()`:

```ts
if (result.status === 'succeeded') {
  await this.events?.publish({ type: 'skill_completed', at: this.now(), skill: active.name })
} else if (result.status === 'cancelled') {
  await this.events?.publish({
    type: 'skill_cancelled',
    at: this.now(),
    skill: active.name,
    code: sanitizeCode(result.code, 'cancelled')
  })
} else {
  await this.events?.publish({
    type: 'skill_failed',
    at: this.now(),
    skill: active.name,
    code: sanitizeCode(result.code, 'failed')
  })
}
```

In GoalManager, use `goal_cancelled` for cancelled `SkillResult`, player preemption, emergency stop cancellation, and continuous-goal supersession; reserve `goal_failed` for true failure only.

- [ ] **Step 5: Carry current chat UUID and player-left evidence from Mineflayer**

Update `ObservationBridge.chat()` and add `playerLeft()`. In the Mineflayer `chat` listener, read the current UUID at the moment of chat:

```ts
const playerId = bot.players[username]?.uuid?.trim()
this.emit(this.bridge.chat(username, message, playerId || undefined))
```

Add a `playerLeft` listener that emits the leaving player's username and UUID when available.

- [ ] **Step 6: Run focused tests plus typecheck**

```powershell
npx tsx --test tests/goals/goal-manager.test.ts tests/skills/executor.test.ts tests/minecraft/observation-bridge.test.ts tests/minecraft/mineflayer-adapter.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

```powershell
git add src/contracts/events.ts src/goals/goal-manager.ts src/skills/executor.ts src/minecraft/observation-bridge.ts src/minecraft/mineflayer-adapter.ts tests/goals tests/skills tests/minecraft
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
- Modify: `tests/contracts/decision.test.ts` if present; otherwise create it
- Create/modify: `tests/skills/registry.test.ts`

**Interfaces:**
- Produces: `DecisionOutcomeV2Schema` / `DecisionOutcomeV2`.
- Produces task-aware `DecisionContext.task`.
- Produces `SkillRegistry.has(name)` and `registeredNames()`.
- Produces `registeredDecisionSkills(registry)` from `src/agent/skill-catalog.ts`.

- [ ] **Step 1: Write RED decision-schema tests**

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { DecisionOutcomeV2Schema } from '../../src/contracts/decision.js'

test('DecisionOutcomeV2 accepts action, complete, and bounded blocked outcomes', () => {
  assert.equal(DecisionOutcomeV2Schema.parse({
    version: 2,
    outcome: 'action',
    intent: 'gather_resource',
    args: { resource: 'oak_log', quantity: 4 }
  }).outcome, 'action')

  assert.deepEqual(DecisionOutcomeV2Schema.parse({ version: 2, outcome: 'complete' }), {
    version: 2,
    outcome: 'complete'
  })

  assert.equal(DecisionOutcomeV2Schema.parse({
    version: 2,
    outcome: 'blocked',
    reason: 'capability_unavailable'
  }).reason, 'capability_unavailable')

  assert.throws(() => DecisionOutcomeV2Schema.parse({
    version: 2,
    outcome: 'blocked',
    reason: 'arbitrary free text'
  }))
})
```

- [ ] **Step 2: Add RED ContextBuilder and registry tests**

ContextBuilder must receive:

```ts
task: {
  taskId: 'task-1',
  objective: '採 16 個橡木，回家後放進基地箱子',
  phase: 'active',
  consecutiveReplans: 0,
  previousAction: null
}
```

and return the same bounded semantic task block in DecisionContext. Add a registry test proving an unregistered `deposit_item` is not advertised even though it exists in the global skill-name schema.

- [ ] **Step 3: Run the focused tests and verify RED**

```powershell
npx tsx --test tests/contracts/decision.test.ts tests/agent/context-builder.test.ts tests/skills/registry.test.ts
```

- [ ] **Step 4: Implement the V2 outcome schema**

Use a strict discriminated union:

```ts
export const DecisionBlockedReasonSchema = z.enum([
  'no_safe_action',
  'missing_information',
  'capability_unavailable'
])

export const DecisionOutcomeV2Schema = z.discriminatedUnion('outcome', [
  z.object({
    version: z.literal(2),
    outcome: z.literal('action'),
    intent: z.literal('follow_player'),
    args: FollowPlayerArgsSchema
  }).strict(),
  // repeat one strict action branch for every executable decision intent
  z.object({ version: z.literal(2), outcome: z.literal('complete') }).strict(),
  z.object({
    version: z.literal(2),
    outcome: z.literal('blocked'),
    reason: DecisionBlockedReasonSchema
  }).strict()
])
```

Do not add reasoning/explanation fields.

- [ ] **Step 5: Add task context and registered-skill catalog**

Add:

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

Bound objective/directive length in ContextBuilder before provider use. Add registry methods:

```ts
has(name: SkillName): boolean
registeredNames(): readonly SkillName[]
```

Create a fixed description map in `skill-catalog.ts` and filter it through `registry.has()` so unregistered production capabilities are never advertised.

- [ ] **Step 6: Run focused tests and typecheck**

```powershell
npx tsx --test tests/contracts/decision.test.ts tests/agent/context-builder.test.ts tests/skills/registry.test.ts
npm run typecheck
```

- [ ] **Step 7: Commit Task 3**

```powershell
git add src/contracts/decision.ts src/agent/context-builder.ts src/agent/skill-catalog.ts src/skills/registry.ts tests/contracts tests/agent/context-builder.test.ts tests/skills/registry.test.ts
git commit -m "feat: add task-aware decision outcomes"
```

---

### Task 4: Implement deterministic `balanced-v1` complexity assessment

**Files:**
- Create: `src/agent/routing/contracts.ts`
- Create: `src/agent/routing/complexity.ts`
- Create: `tests/agent/routing/complexity.test.ts`

**Interfaces:**
- Produces `ComplexityEvidence`, `ComplexityAssessment`, `RoutePlan`, `ThinkingLevel`, `RouteClass`, and `BudgetClass` types.
- Produces `assessComplexity(evidence): ComplexityAssessment` and `buildRoutePlan(decisionId, assessment, reserveAuthorized): RoutePlan`.
- Later Coordinator creates evidence; later RoutedDecisionExecutor consumes immutable RoutePlan.

- [ ] **Step 1: Write table-driven RED tests for all approved thresholds**

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

Add explicit tests:

```ts
assert.equal(assessComplexity({ replanCount: 2 }).thinking, 'high')
assert.equal(assessComplexity({ criticalContext: true }).thinking, 'high')
assert.equal(assessComplexity({ scoreNoise: 999 } as never).routeClass, undefined) // TypeScript should reject unknown evidence in real code
```

For a trusted manual deep request, use `manualDeep: true` and assert high thinking plus high reason `manual_deep_think`; reserve authorization remains a separate RoutePlan input, not a score side effect.

- [ ] **Step 2: Run RED**

```powershell
npx tsx --test tests/agent/routing/complexity.test.ts
```

- [ ] **Step 3: Define exact routing contracts**

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

Use policy name literal `balanced-v1` and exact weights from the approved spec. High overrides do not alter the numerical score.

- [ ] **Step 4: Implement immutable RoutePlan creation**

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

`buildRoutePlan()` must `Object.freeze()` the returned object and reason array so retries cannot mutate model class/thinking/reserve authorization.

- [ ] **Step 5: Run tests and typecheck**

```powershell
npx tsx --test tests/agent/routing/complexity.test.ts
npm run typecheck
```

- [ ] **Step 6: Commit Task 4**

```powershell
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
- Produces `MinecraftPrincipal` and `MinecraftIdentityRegistry`.
- Produces `parseManualAiCommand(message)` and `containsManualComplexityHint(message)`.
- Consumes `MinecraftServerIdentityMode` and current `manualAccess` config.

- [ ] **Step 1: Write RED identity tests**

Cover all trust boundaries:

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

Also assert `disconnected` / new session invalidates pending identity state and `player_left` removes the matching identity.

- [ ] **Step 2: Write RED parser tests**

```ts
assert.deepEqual(parseManualAiCommand('!moxue deep 重新規劃採木頭'), {
  kind: 'deep_new',
  instruction: '重新規劃採木頭'
})
assert.deepEqual(parseManualAiCommand('!moxue deep current 再確認背包和箱子'), {
  kind: 'deep_current',
  directive: '再確認背包和箱子'
})
assert.equal(parseManualAiCommand('!moxue deep'), null)
assert.equal(containsManualComplexityHint('墨雪仔細想一下'), true)
assert.equal(containsManualComplexityHint('跟我來'), false)
```

- [ ] **Step 3: Run RED**

```powershell
npx tsx --test tests/minecraft/identity-registry.test.ts tests/minecraft/manual-ai-command.test.ts
```

- [ ] **Step 4: Implement normalization and principal resolution**

Use a single UUID normalizer:

```ts
export function normalizeMinecraftUuid(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase().replaceAll('-', '') ?? ''
  return /^[0-9a-f]{32}$/.test(normalized) ? normalized : null
}
```

`MinecraftIdentityRegistry` keeps a monotonically increasing in-process `sessionGeneration`; `connected` begins a generation, `disconnected` clears entries, `player_seen` upserts, and `player_left` removes. `resolveChat()` must require valid current chat UUID evidence in `online` mode and fail closed on any mismatch with a cached current-session entry.

- [ ] **Step 5: Implement bounded command parsing**

Accept only exact case-insensitive command prefixes `!moxue deep` and `!moxue deep current`. Trim whitespace, cap instruction/directive at 1000 characters, and reject empty new-task instructions. Do not accept passwords or credential-like suffixes.

Natural-language complexity hints are a fixed bounded phrase set such as:

```ts
const COMPLEXITY_HINTS = ['仔細想', '認真想', '用大模型', 'think hard', 'use the big model'] as const
```

They produce only a hint boolean, never a capability.

- [ ] **Step 6: Run tests and commit**

```powershell
npx tsx --test tests/minecraft/identity-registry.test.ts tests/minecraft/manual-ai-command.test.ts
npm run typecheck
git add src/minecraft/identity-registry.ts src/minecraft/manual-ai-command.ts tests/minecraft/identity-registry.test.ts tests/minecraft/manual-ai-command.test.ts
git commit -m "feat: add trusted Minecraft AI command identity"
```

---

### Task 6: Build the durable QuotaLedger and provider-day accounting

**Files:**
- Create: `src/agent/routing/provider-day.ts`
- Create: `src/agent/routing/quota-ledger.ts`
- Create: `tests/agent/routing/provider-day.test.ts`
- Create: `tests/agent/routing/quota-ledger.test.ts`

**Interfaces:**
- Produces `SqliteQuotaLedger` with config-generation allocation, durable admission, dispatch, settlement, reservation release, crash recovery, cooldown/quota state, credential process health, and safe quota snapshots.
- Produces `providerDayKey(timestampMs)` using `America/Los_Angeles`.
- Later ProjectPool is the only production caller of `admitAttempt()`.

- [ ] **Step 1: Write RED provider-day tests including DST-safe dates**

```ts
assert.equal(providerDayKey(Date.parse('2026-09-12T06:59:59Z')), '2026-09-11')
assert.equal(providerDayKey(Date.parse('2026-09-12T07:00:00Z')), '2026-09-12')
```

Use `Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year:'numeric', month:'2-digit', day:'2-digit' })` rather than hand-coded UTC offsets.

- [ ] **Step 2: Write RED ledger lifecycle tests against a temporary SQLite file**

Required scenarios:

```text
allocateConfigGeneration() returns increasing values across repository reopen
admitAttempt() reserves request/input/total capacity transactionally
markDispatched() persists before transport use
settleAttempt(actual usage) replaces reservation with actual accounting
releaseReservation() works only before dispatched
recoverIncompleteAttempts() releases reserved rows and converts dispatched rows to uncertain conservative charges
rolling RPM/TPM includes unsettled reservations conservatively
RPD uses provider_day_key
normal Flash admission rejects a request that would cross the 70% request OR token ceiling
actual > reservation sets budget_overrun=true
```

- [ ] **Step 3: Run RED**

```powershell
npx tsx --test tests/agent/routing/provider-day.test.ts tests/agent/routing/quota-ledger.test.ts
```

- [ ] **Step 4: Create the SQLite schema exactly around attempts, domain state, credential health, and meta**

Use schema version `1` and WAL/busy-timeout settings matching the existing memory repository style. Core table fields:

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

Add indexes for `(project_key, model, dispatched_at)`, `(project_key, model, provider_day_key)`, and active attempt states. Add `quota_domain_state`, `credential_health`, and `quota_meta` tables with only safe bounded fields.

- [ ] **Step 5: Implement transactionally safe admission**

Define a request like:

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

Inside one `better-sqlite3` transaction: query settled accounting + active holds, evaluate all limits, and insert a `reserved` row only when all gates pass. For `budgetClass='normal'`, ceiling is `Math.floor(limit * 0.70)` for both Flash request and total-token budgets; `reserve` may use up to 100% but is never admitted when `reserveAuthorized` was false upstream.

- [ ] **Step 6: Implement dispatch / settlement / recovery invariants**

`markDispatched()` may transition only `reserved -> dispatched`. `releaseReservation()` may transition only `reserved -> released`. `settleAttempt()` may transition `dispatched -> settled` and must use actual usage when present; conservative rejected errors account `reservedInputTokens` as both input and total, while ambiguous/timeout/crash paths account the full reserved totals.

On startup:

```ts
reserved   -> released
dispatched -> uncertain
```

`uncertain` stores conservative accounting and is terminal.

- [ ] **Step 7: Implement domain health methods**

Add exact methods used later:

```ts
recordTransientFailure(projectKey, model, now, retryAfterMs?): number
recordDomainSuccess(projectKey, model): void
markQuotaUnavailable(projectKey, model, until, safeCode): void
disableCredentialForProcess(projectKey, processInstanceId, safeCode, now): void
credentialDisabled(projectKey, processInstanceId): boolean
domainAvailability(projectKey, model, now): { available: boolean; retryAt: number | null }
adminSnapshot(now): readonly AdminQuotaProjectSnapshot[]
```

Transient cooldown sequence is 5s, 15s, 30s, 60s; success resets the counter.

- [ ] **Step 8: Run tests, typecheck, commit**

```powershell
npx tsx --test tests/agent/routing/provider-day.test.ts tests/agent/routing/quota-ledger.test.ts
npm run typecheck
git add src/agent/routing/provider-day.ts src/agent/routing/quota-ledger.ts tests/agent/routing/provider-day.test.ts tests/agent/routing/quota-ledger.test.ts
git commit -m "feat: add durable Gemini quota ledger"
```

---

### Task 7: Add atomic RoutingConfigManager activation and generation-scoped credential handles

**Files:**
- Create: `src/agent/routing/config-manager.ts`
- Create: `tests/agent/routing/config-manager.test.ts`

**Interfaces:**
- Consumes `ValidatedRoutingConfig` and `SqliteQuotaLedger.allocateConfigGeneration()`.
- Produces `RoutingConfigSnapshot`, `RoutingConfigManager.activateInitial()`, `reload()`, `snapshot()`, and `resolveCredential(handle)`.
- Credential handles are opaque strings; raw keys never leave the manager/transport boundary.

- [ ] **Step 1: Write RED activation/reload tests**

Cover:

```text
initial activation validates every apiKeyEnv before allocating/switching
missing credential leaves previous config active
valid reload allocates a higher generation and atomically swaps
old generation credential handles remain resolvable for in-flight attempts
reordering project entries does not change stable projectKey accounting identity
owner/allowlist change is reported as authorizationChanged=true
```

Use an injected `readTextFile` function and fake quota-generation allocator to keep tests filesystem-independent.

- [ ] **Step 2: Run RED**

```powershell
npx tsx --test tests/agent/routing/config-manager.test.ts
```

- [ ] **Step 3: Implement immutable snapshots and opaque handles**

Define:

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

Credential handle format may be opaque generated IDs; it must not equal or include the raw key. Keep an in-process map `handle -> secret` and retain old handles until process exit so an attempt issued under generation N can finish after generation N+1 activates.

- [ ] **Step 4: Implement atomic reload result**

```ts
export type RoutingReloadResult =
  | { readonly kind: 'reloaded'; readonly generation: number; readonly authorizationChanged: boolean }
  | { readonly kind: 'rejected'; readonly code: 'invalid_config' | 'missing_credential' }
```

Read, parse, credential-validate, and semantic-validate the candidate before allocation/swap. Never clear active state first.

- [ ] **Step 5: Run tests and commit**

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
- Consumes immutable `RoutePlan`, current `RoutingConfigSnapshot`, prepared payload byte size, and QuotaLedger.
- Produces exactly one `AttemptLease` or an unavailable result with `retryAt`.
- Does not perform network I/O or retry loops.

- [ ] **Step 1: Write RED pool-order tests**

Required cases:

```text
routine uses routine model across pool-a -> pool-b and never Flash
complex automatic scans pool-a normal -> pool-b normal and never reserve
trusted manual complex scans every normal Project before any reserve Project
primary returns after cooldown expires
401-disabled credential is skipped for both models
Flash quota-unavailable on pool-a does not prevent Lite pool-a use
all cooldowns return earliest retryAt
all process-disabled credentials return retryAt=null
```

- [ ] **Step 2: Write RED reservation-estimator tests**

The V1 estimator is intentionally conservative and deterministic:

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

One UTF-8 byte is treated as no more than one reserved input token, then model-configured overhead and generation allowance are added. This is deliberately conservative and avoids a separate `countTokens` API call.

- [ ] **Step 3: Run RED**

```powershell
npx tsx --test tests/agent/routing/project-pool.test.ts
```

- [ ] **Step 4: Define `AttemptLease` audit fields**

```ts
export interface AttemptLease {
  readonly attemptId: string
  readonly decisionId: string
  readonly configGeneration: number
  readonly projectKey: string
  readonly credentialHandle: string
  readonly model: string
  readonly thinking: ThinkingLevel
  readonly budgetClass: BudgetClass
  readonly reservationId: string
}
```

No raw key is present.

- [ ] **Step 5: Implement primary-first scan policy**

For routine: one normal scan using `models.routine`.

For complex without reserve authorization: one normal scan using `models.complex`.

For complex with reserve authorization: scan all Projects normal first; only if no normal attempt can be admitted, scan all Projects reserve. Call `QuotaLedger.admitAttempt()` while scanning; a non-admitted candidate is skipped without consuming an API-attempt slot.

- [ ] **Step 6: Run tests and commit**

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

**Interfaces:**
- Replaces constructor-fixed model/thinking provider behavior with `GeminiTransport.prepare()` and `execute()`.
- Consumes `AttemptLease` and an opaque `CredentialResolver`.
- Produces `PreparedGeminiPayload` and normalized `AttemptResult` including token usage when available.
- Performs exactly one SDK HTTP attempt; no project failover or policy retry lives here.

- [ ] **Step 1: Replace the old provider tests with RED transport tests**

The fake interaction client must capture model/thinking per call:

```ts
const result = await transport.execute(prepared, {
  attemptId: 'a1',
  decisionId: 'd1',
  configGeneration: 3,
  projectKey: 'pool-b',
  credentialHandle: 'cred-3-b',
  model: 'gemini-3.8-flash',
  thinking: 'medium',
  budgetClass: 'normal',
  reservationId: 'a1'
}, new AbortController().signal)

assert.equal(fake.requests[0]?.request.model, 'gemini-3.8-flash')
assert.equal(fake.requests[0]?.request.generation_config.thinking_level, 'medium')
assert.equal(fake.requests[0]?.request.store, false)
assert.equal(fake.requests[0]?.options.retryAttempts, 1)
```

Add success usage:

```ts
usage: {
  total_input_tokens: 120,
  total_output_tokens: 20,
  total_thought_tokens: 60,
  total_tool_use_tokens: 10,
  total_tokens: 210
}
```

and assert normalized values are numbers in the result without any thought text.

- [ ] **Step 2: Add RED tests for safe error facts**

Test fake SDK errors with safe structural fields only:

```text
status=401 code=authentication -> api_error
status=403 code=permission_denied -> api_error
status=429 code=quota_exceeded -> api_error
status=503 -> api_error
TimeoutError -> timeout
AbortError with signal.aborted -> cancelled
content_blocked -> content_blocked
malformed function call -> generation_error
```

Raw `error.message` must never appear in the normalized result.

- [ ] **Step 3: Run RED**

```powershell
npx tsx --test tests/agent/providers/gemini.test.ts
```

- [ ] **Step 4: Define prepared payload and result types**

The prepared payload contains immutable prompt semantics only:

```ts
export interface PreparedGeminiPayload {
  readonly input: string
  readonly systemInstruction: string
  readonly tools: readonly GeminiFunctionTool[]
  readonly utf8Bytes: number
}
```

Build it from the V2 DecisionOutcome tool schema and bounded DecisionContext. The function remains exactly one forced `submit_decision` call. `thinking_summaries` remains `'none'`.

- [ ] **Step 5: Implement single-attempt SDK call**

Keep a client cache keyed by opaque credential handle. Resolve the raw key only inside the transport boundary. Configure the pinned SDK for one attempt (`retryOptions.attempts = 1`) and the existing timeout. Pass the caller AbortSignal through the SDK-supported request abort path; treat local abort as `cancelled` even though provider-side usage may still occur.

The production wrapper should expose a tiny injected client interface in tests:

```ts
export interface GeminiInteractionClient {
  create(
    request: GeminiInteractionRequest,
    options: { readonly timeout: number; readonly retryAttempts: 1; readonly signal: AbortSignal }
  ): Promise<GeminiInteractionResponse>
}
```

Translate that interface to the exact @google/genai 2.21.0 call shape in the real adapter, with no retries beyond the initial attempt.

- [ ] **Step 6: Normalize usage and provider facts**

Return only bounded fields:

```ts
export interface GeminiUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly thoughtTokens: number
  readonly toolTokens: number
  readonly totalTokens: number
}
```

No thought step text or summaries may cross the transport boundary.

- [ ] **Step 7: Run tests and commit**

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
- Produces `classifyAttemptResult()` and `RoutedDecisionExecutor.execute()`.
- Coordinator receives only `LogicalDecisionResult`: `success | safety_blocked | unavailable | invalid_response | configuration_error | cancelled`.
- API-attempt cap is `configuredProjectCount + 4`.

- [ ] **Step 1: Write RED error-policy matrix tests**

Use a table that asserts the exact action for each provider fact:

```text
401 authentication          credential_fatal / failover
403 permission_denied       credential_fatal / failover
429 quota_exceeded          quota_unavailable / failover
429 rate_limit_exceeded     transient / cooldown / failover
429 too_many_requests       transient / cooldown / failover
unknown 429                 transient / cooldown / failover
408 timeout                 transient
409 aborted                 transient
500/502/503/504             transient
400 invalid_request         configuration_error / stop
404 model_not_found         configuration_error / stop
content_blocked             safety_terminal / stop
local cancelled             cancelled / stop
generation_error            generation_retry_once
```

Safety/content classification must run before generic HTTP-family classification.

- [ ] **Step 2: Run RED error tests**

```powershell
npx tsx --test tests/agent/routing/error-policy.test.ts
```

- [ ] **Step 3: Implement pure error classification**

Return a closed union such as:

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

Use provider day reset for `quota_exceeded` when no later safe retry/reset time is supplied.

- [ ] **Step 4: Write RED executor tests using fake pool/ledger/transport**

Required scenarios:

```text
same immutable RoutePlan survives all attempts
A transient -> ledger cooldown -> B success
A 401 -> credential disabled -> B success
A content_blocked -> no B attempt
invalid generation -> one clean retry, second invalid -> invalid_response
all candidates unavailable -> unavailable with earliest retryAt
all credentials process-disabled -> unavailable retryAt=null
local cancellation -> no retry/no health penalty
actual attempt count never exceeds projects + 4
settlement occurs for every dispatched attempt before next lease
```

- [ ] **Step 5: Implement the sequential executor loop**

Pseudo-code must become literal control flow:

```ts
for (let attempts = 0; attempts < maxAttempts; attempts += 1) {
  if (signal.aborted) return { kind: 'cancelled' }
  const leaseResult = this.pool.nextLease(plan, prepared)
  if (leaseResult.kind === 'unavailable') return leaseResult

  this.ledger.markDispatched(leaseResult.lease.reservationId, this.now())
  const attempt = await this.transport.execute(prepared, leaseResult.lease, signal)
  const policy = classifyAttemptResult(attempt, this.now())
  await this.settleAndRecord(leaseResult.lease, attempt, policy)

  // success/terminal/retry/failover branches here; never recalculate RoutePlan
}
return { kind: 'unavailable', retryAt: this.pool.nextRetryAt() }
```

For transient policy, immediately ask the JIT pool for another eligible Project; sleep only when all candidates are temporarily unavailable, and sleep only until the earliest retry time while honoring AbortSignal.

- [ ] **Step 6: Run executor tests and commit**

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
- Modify: `tests/agent/provider-capabilities.test.ts` only if required by the final provider-neutral interface

**Interfaces:**
- Produces `GatedOutcome = action | complete | blocked | rejected`.
- `DecisionGate.accept(result, latestState, skillAvailable)` validates provider envelope/schema and SafetyPolicy for action only.
- Removes `DecisionPipeline` direct submission path so Coordinator owns stale-result checks and final GoalManager submission.

- [ ] **Step 1: Write RED gate tests**

Add:

```ts
assert.deepEqual(await gate.accept(structured({ version: 2, outcome: 'complete' }), state, () => true), {
  kind: 'complete',
  provider: 'fake',
  mode: 'function_call'
})

assert.deepEqual(await gate.accept(structured({
  version: 2,
  outcome: 'blocked',
  reason: 'missing_information'
}), state, () => true), {
  kind: 'blocked',
  provider: 'fake',
  mode: 'function_call',
  reason: 'missing_information'
})
```

For an action whose skill is not registered, assert `rejected` code `skill_not_registered`. Keep existing tests for malformed provider results, SafetyPolicy denial/preemption, and no reasoning text leakage.

- [ ] **Step 2: Run RED**

```powershell
npx tsx --test tests/agent/decision-gate.test.ts tests/agent/provider-capabilities.test.ts
```

- [ ] **Step 3: Replace V1 parsing with V2 outcome parsing and remove direct submit**

`decisionToGoal()` remains a pure mapping for `outcome:'action'`. `complete` and `blocked` produce no GoalRequest. Delete or deprecate the old `DecisionPipeline` class so no path can submit a Goal without Coordinator stale-generation checks.

- [ ] **Step 4: Run tests and commit**

```powershell
npx tsx --test tests/agent/decision-gate.test.ts tests/agent/provider-capabilities.test.ts
npm run typecheck
git add src/agent/decision-gate.ts src/agent/provider.ts tests/agent/decision-gate.test.ts tests/agent/provider-capabilities.test.ts
git commit -m "refactor: gate task outcomes before coordinator execution"
```

---

### Task 12: Add volatile AiTask, one-shot ManualRouteGrant, and deterministic trigger classification

**Files:**
- Create: `src/runtime/ai-task.ts`
- Create: `src/runtime/trigger-classifier.ts`
- Create: `tests/runtime/ai-task.test.ts`
- Create: `tests/runtime/trigger-classifier.test.ts`

**Interfaces:**
- Produces `AiTask`, `ManualRouteGrant`, `AiTaskQueue`, `DecisionDemand`, and `TriggerClassifier`.
- Task queue policy: one active plus at most eight pending explicit tasks; reject newest at capacity.
- Deep-current grant is bound to active task ID/generation and never arms an unspecified future task.

- [ ] **Step 1: Write RED task/grant tests**

Required cases:

```text
new task stores bounded objective/source/principal/generation
queue accepts 8 pending then rejects 9th with task_queue_full
pending grant -> consumed once
pending grant invalidates on task generation change
pending grant invalidates on Minecraft session generation change
process-level object reconstruction does not restore prior tasks/grants
successful action resets consecutive_replan_count but preserves total_replan_count
true failure increments both counters
cancel/supersede does not increment counters
```

- [ ] **Step 2: Write RED trigger tests**

State-only events return `state_only`; `stuck` and `skill_failed` attach evidence to `causeKey='goal:<id>'`; `goal_failed` creates one replan boundary; `goal_cancelled` does not. `goal_completed` creates continuation only for the active task goal. Different addressed player instructions create different explicit demands.

The deterministic addressing rule for V1 is:

```text
special command: !moxue ...
normal addressed prefix: "墨雪" or "moxue" (case-insensitive) or the configured Minecraft bot username
```

Strip one leading punctuation/comma/colon after the address; reject an empty instruction.

- [ ] **Step 3: Run RED**

```powershell
npx tsx --test tests/runtime/ai-task.test.ts tests/runtime/trigger-classifier.test.ts
```

- [ ] **Step 4: Implement bounded volatile task objects**

Use generated opaque IDs injected for deterministic tests. Do not persist objectives or grants. Cap objective/directive length at 1000 characters before storing them in volatile runtime structures.

- [ ] **Step 5: Implement causal evidence coalescing in `DecisionDemand`**

A demand stores reason/evidence, not a WorldState snapshot:

```ts
export interface DecisionDemand {
  readonly demandId: string
  readonly taskId: string
  readonly causeKeys: ReadonlySet<string>
  readonly reasons: ReadonlySet<string>
  readonly createdAt: number
}
```

When dispatching later, Coordinator always calls `state.snapshot()` fresh.

- [ ] **Step 6: Run tests and commit**

```powershell
npx tsx --test tests/runtime/ai-task.test.ts tests/runtime/trigger-classifier.test.ts
npm run typecheck
git add src/runtime/ai-task.ts src/runtime/trigger-classifier.ts tests/runtime/ai-task.test.ts tests/runtime/trigger-classifier.test.ts
git commit -m "feat: add AI task and decision demand primitives"
```

---

### Task 13: Implement the actor/mailbox DecisionCoordinator state machine

**Files:**
- Create: `src/runtime/decision-coordinator.ts`
- Create: `tests/runtime/decision-coordinator.test.ts`

**Interfaces:**
- Consumes RuntimeEvent source, WorldState, GoalManager port, memory, skill catalog, identity registry, RoutingConfig snapshot access, complexity policy, DecisionGate, and a provider-neutral logical decision executor.
- Produces `DecisionCoordinator` methods: `start()`, `dispose()`, `status()`, `submitAdminDeepThink()`, `invalidateManualGrants()`, `clearAiWork(reason)`.
- Event listener must enqueue and return; it never awaits Gemini.

- [ ] **Step 1: Write the RED mailbox/non-blocking test first**

Use a fake logical executor whose Promise does not resolve:

```ts
await events.publish({ type: 'player_chat', at: 1, player: 'Boss', message: '墨雪跟我來' })
// publish must complete even while coordinator decision promise is unresolved
assert.equal(fakeExecutor.calls.length, 1)
```

Then publish inventory and emergency-stop events and prove the mailbox consumes them while the fake decision remains pending.

- [ ] **Step 2: Add RED single-flight and stale-generation tests**

Required scenarios:

```text
only one logical decision in flight
state updates during flight do not spawn a second decision
emergency_stop increments task generation/invalidates result
player direct-control goal supersedes active AI task and stale AI result is discarded
ordinary position/inventory update does not stale a valid in-flight result
latest WorldState is used at final DecisionGate/Goal submission
```

- [ ] **Step 3: Add RED multi-step and failure-replan tests**

Simulate:

```text
explicit task -> action gather_resource -> goal_completed
continuation -> action go_to/return_home only if registered
continuation -> action deposit only if registered
continuation -> complete -> task closes
```

Also:

```text
stuck + skill_failed + goal_failed for one goal -> one replan decision
first failure uses assessed Flash-medium when score reaches 4
second consecutive failed planning cycle -> next decision Flash-high but reserveAuthorized=false
successful action resets consecutive failures
```

- [ ] **Step 4: Add RED queue / continuous-action tests**

```text
bounded skill running + new task -> new task queued, skill not aborted
follow_player or stay + new explicit task -> continuous goal safely superseded/cancelled
8 pending tasks allowed, 9th rejected
different players' instructions remain separate tasks
```

- [ ] **Step 5: Add RED AI-unavailable / recovery / reconnect tests**

```text
AI unavailable while skill runs -> skill completes normally, one decision remains pending
retryAt schedules exactly one wake-up
recovery creates one fresh decision using latest state, not replayed old request
retryAt=null creates no polling timer
Minecraft disconnect suspends ordinary task and invalidates in-flight decision
reconnect/spawn resumes ordinary task with one fresh decision
ManualRouteGrant is invalid after disconnect and is never silently downgraded
```

- [ ] **Step 6: Implement mailbox ownership and orthogonal state**

Internally maintain:

```ts
coordinator: 'running' | 'stopped'
activeTask: AiTask | null
pendingTasks: AiTaskQueue
execution: 'idle' | 'decision_pending' | 'decision_in_flight' | 'goal_running'
aiAvailability: 'available' | 'unavailable'
minecraftReady: boolean
```

Use a Promise tail or explicit queue to serialize mailbox transitions. The RuntimeEvent callback only clones/enqueues the event and returns immediately.

- [ ] **Step 7: Implement logical decision dispatch**

At safe boundary:

```text
read active task
build current DecisionContext from latest state/memory/registered skill catalog
combine base evidence + causal failure evidence + current one-shot grant
assess balanced-v1
build immutable RoutePlan
start one logical executor call with AbortController
enqueue completion back into mailbox
```

Consume a ManualRouteGrant only when its target decision is actually dispatched.

- [ ] **Step 8: Implement final outcome handling**

On logical success: verify decision/task/session generation, call DecisionGate with latest WorldState and current `registry.has()`, then:

```text
action   -> GoalManager.submit(goal, 'ai')
complete -> close active task, start next queued task
blocked  -> close active task with safe blocked reason
rejected safety -> close task blocked; never re-prompt to bypass
```

- [ ] **Step 9: Run coordinator tests and commit**

```powershell
npx tsx --test tests/runtime/decision-coordinator.test.ts
npm run typecheck
git add src/runtime/decision-coordinator.ts tests/runtime/decision-coordinator.test.ts
git commit -m "feat: add production AI decision coordinator"
```

---

### Task 14: Add loopback-only Admin API, atomic reload command, and local deep-think entrypoint

**Files:**
- Create: `src/api/admin-server.ts`
- Create: `tests/api/admin-server.test.ts`

**Interfaces:**
- Consumes `RoutingConfigManager`, QuotaLedger admin snapshot, and DecisionCoordinator admin port.
- Produces `AdminServer` with `GET /v1/admin/ai-quota`, `POST /v1/admin/ai-routing/reload`, and `POST /v1/admin/ai/deep-think`.
- Host is structurally fixed to `127.0.0.1`; token authentication is constant-time.

- [ ] **Step 1: Write RED authentication/bind tests**

```text
server constructor/start has no configurable non-loopback host
missing/incorrect Authorization -> 401
correct Bearer MC_ADMIN_TOKEN -> allowed
Control token cannot authenticate Admin server
token never appears in error JSON
```

- [ ] **Step 2: Write RED endpoint tests**

Quota endpoint returns anonymous project keys and bounded fields only. Reload success returns new generation; invalid candidate returns safe error and old generation remains active. Deep-think requires a non-empty instruction, generates local-admin task authority, and supports an `Idempotency-Key` header:

```text
same key + same body -> original response
same key + different body -> 409
```

Idempotency cache is process-local and bounded (for example max 256 entries, oldest-first eviction).

- [ ] **Step 3: Run RED**

```powershell
npx tsx --test tests/api/admin-server.test.ts
```

- [ ] **Step 4: Implement the server with explicit ports**

Use interfaces:

```ts
export interface AdminQuotaPort { snapshot(): unknown }
export interface AdminRoutingPort { reload(): Promise<RoutingReloadResult> }
export interface AdminDecisionPort { submitDeepThink(instruction: string): Promise<{ taskId: string }> }
```

On a successful reload with `authorizationChanged`, call the Coordinator port to invalidate pending privileged grants before returning success.

- [ ] **Step 5: Run tests and commit**

```powershell
npx tsx --test tests/api/admin-server.test.ts
npm run typecheck
git add src/api/admin-server.ts tests/api/admin-server.test.ts
git commit -m "feat: add protected AI admin API"
```

---

### Task 15: Add safe routing/coordinator telemetry and extend `/v1/status`

**Files:**
- Modify: `src/contracts/events.ts`
- Modify: `src/api/control-server.ts`
- Modify: `tests/api/control-server.test.ts`
- Create/modify: `tests/contracts/events.test.ts`
- Modify: `src/agent/routing/routed-executor.ts`
- Modify: `src/runtime/decision-coordinator.ts`

**Interfaces:**
- Adds safe telemetry only: `complexity_assessment`, `model_route`, `attempt_result`, `ai_availability_changed`, `task_started`, `task_completed`, `task_blocked`, `task_superseded`.
- Adds a `ControlAiStatusPort` to `ControlServerOptions` without exposing objectives or secrets.

- [ ] **Step 1: Write RED event-schema tests for allowed fields and secret rejection**

Example route event:

```ts
{
  type: 'model_route',
  at: 1,
  decisionId: 'd1',
  model: 'gemini-3.8-flash',
  thinking: 'medium',
  project: 'backup-1',
  reasons: ['multi_step', 'multi_skill'],
  reserveAuthorized: false,
  reserveUsed: false
}
```

Do not include raw `projectKey` if the public event uses ordered anonymous label; never include API key, prompt, objective, UUID, or raw provider message.

- [ ] **Step 2: Write RED `/v1/status` tests**

Add a fake `aiStatus` port and assert:

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

No objective, UUID, real Project ID, or detailed reserve diagnostics are present.

- [ ] **Step 3: Run RED**

```powershell
npx tsx --test tests/contracts/events.test.ts tests/api/control-server.test.ts
```

- [ ] **Step 4: Publish safe telemetry at ownership boundaries**

Complexity policy/Coordinator publishes assessment once per logical decision. ProjectPool/RoutedExecutor publishes route/attempt results after admission/settlement. Coordinator publishes task and availability transitions. Never pass raw provider errors to the event bus.

- [ ] **Step 5: Extend ControlServer status composition**

Add optional/required `aiStatus` dependency once main wiring is ready; clone only safe bounded fields into status payload. Keep existing Minecraft/goal status unchanged.

- [ ] **Step 6: Run tests and commit**

```powershell
npx tsx --test tests/contracts/events.test.ts tests/api/control-server.test.ts
npm run typecheck
git add src/contracts/events.ts src/api/control-server.ts src/agent/routing/routed-executor.ts src/runtime/decision-coordinator.ts tests/contracts tests/api/control-server.test.ts
git commit -m "feat: expose safe AI routing observability"
```

---

### Task 16: Wire fake and Gemini modes into the composition root without changing deterministic gameplay ownership

**Files:**
- Modify: `src/main.ts`
- Modify: `tests/main.test.ts`
- Modify: `tests/main-storage-bootstrap.test.ts` if path/bootstrap assertions require it

**Interfaces:**
- Fake mode builds the Coordinator around a direct fake logical executor and does not open QuotaLedger/ConfigManager/Admin server unless explicitly injected by a test.
- Gemini mode builds QuotaLedger -> RoutingConfigManager -> ProjectPool -> GeminiTransport -> RoutedDecisionExecutor -> Coordinator -> AdminServer.
- `McAiPlayerApplication.close()` shuts down Admin/Control exposure before runtime resources and waits for recorder/adapter tails.

- [ ] **Step 1: Update the main harness to inject logical executor/coordinator routing dependencies**

Replace the old `createDecisionProvider` seam with a provider-neutral logical execution seam suitable for both fake and routed modes. Preserve dependency injection for runtime, memory, recorder, ControlServer, and add AdminServer/QuotaLedger factories.

Add a RED test proving fake mode does not try to read `data/ai-routing.json` or create `data/ai-quota.sqlite3`.

- [ ] **Step 2: Add RED Gemini composition tests with temporary config + fake transports**

Use a temp routing config referencing test credential env names. Assert composition order:

```text
load/activate routing config before exposing APIs
recover quota ledger before first admission
Minecraft adapter connect before Control/Admin listeners report started
Admin listener opens only when MC_ADMIN_TOKEN exists
shutdown closes Admin then Control, clears AI work, aborts goal/runtime, closes quota DB and memory
```

- [ ] **Step 3: Run RED**

```powershell
npx tsx --test tests/main.test.ts tests/main-storage-bootstrap.test.ts
```

- [ ] **Step 4: Implement the composition root in focused factory helpers**

Keep `main.ts` readable by extracting private factory functions, not a new broad utility module:

```ts
function createFakeDecisionStack(...): LogicalDecisionExecutor
function createGeminiDecisionStack(...): GeminiDecisionStack
function registerProductionSkills(...): void
```

Use constants:

```ts
const DEFAULT_MEMORY_PATH = 'data/mc_memory.sqlite3'
const DEFAULT_QUOTA_PATH = 'data/ai-quota.sqlite3'
```

Ensure parent directories before opening SQLite files.

- [ ] **Step 5: Wire Coordinator to event bus and latest runtime dependencies**

Start its subscription before Minecraft emits player events. `events.subscribe()` handler from Coordinator must return immediately after mailbox enqueue. Feed `registeredDecisionSkills(registry)`, memory search, state snapshot, goals, identity mode, identity registry, and active routing/manual-access snapshots through narrow ports.

- [ ] **Step 6: Wire `/v1/stop` semantics via existing emergency-stop event**

GoalManager emergency stop remains the deterministic actuator stop. Coordinator consumes `emergency_stop`, clears active/pending AI work and grants, invalidates in-flight decision generation, then remains `running + idle` for future commands.

- [ ] **Step 7: Run app tests, full test suite, typecheck**

```powershell
npx tsx --test tests/main.test.ts tests/main-storage-bootstrap.test.ts
npm test
npm run typecheck
```

Expected: all PASS.

- [ ] **Step 8: Commit Task 16**

```powershell
git add src/main.ts tests/main.test.ts tests/main-storage-bootstrap.test.ts
git commit -m "feat: wire multi-model routing into MC_AI_Player"
```

---

### Task 17: Add end-to-end routing/coordinator scenarios, live Gemini validation, and final documentation gates

**Files:**
- Create: `tests/scenarios/gemini-routing-coordinator.test.ts`
- Create: `scripts/validate-gemini-routing-live.ts`
- Modify: `README.md`
- Modify: `.env.example` only if Task 1 documentation needs final correction
- Modify: `docs/superpowers/specs/2026-09-12-gemini-multi-model-routing-design.md` status line only after implementation verification
- Modify: Draft PR #4 body/status only after all checks pass

**Interfaces:**
- Scenario tests exercise the real Coordinator + real QuotaLedger + real ProjectPool with fake transport, not isolated mocks for every component.
- Live script uses real Gemini only when explicit environment gate is enabled and never prints keys/prompts/raw provider bodies.

- [ ] **Step 1: Write the end-to-end fake-transport scenario**

One scenario must prove all of these in one flow:

```text
addressed simple task -> Lite/low on pool-a
pool-a Lite transient -> pool-b Lite succeeds
multi-step instruction -> Flash/medium directly, no wasted Lite request
stuck + skill_failed + goal_failed coalesce -> one Flash replan
second consecutive planning failure -> Flash/high, reserveAuthorized=false
trusted online !moxue deep -> Flash/high, all normal Projects checked before reserve
provider content_blocked -> terminal, no Project failover
AI unavailable -> deterministic active skill finishes; one recovery decision uses latest state
```

Use a temporary SQLite quota DB and deterministic clock/IDs.

- [ ] **Step 2: Run scenario RED/GREEN as required until the entire integration passes**

```powershell
npx tsx --test tests/scenarios/gemini-routing-coordinator.test.ts
```

Do not weaken unit invariants to make the scenario pass; fix the owning component.

- [ ] **Step 3: Add live-validation script with an explicit opt-in gate**

The script exits skipped unless:

```text
MC_AI_LIVE_VALIDATION=1
MC_AI_PROVIDER=gemini
MC_AI_ROUTING_CONFIG=<private file>
```

It must run at least:

```text
routine request -> expected Lite + low
complex multi-step request -> expected Flash + medium
trusted local-admin deep request -> expected Flash + high
response usage -> actual input/output/thought/total captured in quota ledger
```

It prints only anonymous `projectKey`, model, thinking, safe route reason, usage counts, and PASS/FAIL. It must not print the instruction/prompt, API key, raw error body, or real Google Project ID.

Add an npm script only if needed:

```json
"validate:gemini-live": "tsx scripts/validate-gemini-routing-live.ts"
```

- [ ] **Step 4: Update README operations section**

Document:

```text
copy config/ai-routing.example.json -> data/ai-routing.json
set MC_AI_KEY_* environment secrets outside JSON
set provider limits from the deployment's current AI Studio limits
why missing quota config fails closed
online vs offline identity trust
!moxue deep and !moxue deep current
Admin API loopback + MC_ADMIN_TOKEN
GET /v1/admin/ai-quota
POST /v1/admin/ai-routing/reload
POST /v1/admin/ai/deep-think
70/30 normal/reserve semantics
quota DB path and privacy guarantees
```

Keep the existing release-gate list truthful; do not mark 30-minute human, Pi measurement, 4-8h soak, missing skill wiring, or DC_BOT integration complete without evidence.

- [ ] **Step 5: Run final automated verification**

```powershell
npm test
npm run typecheck
npm run probe
git diff --check
git status --short
```

Expected: all automated tests/typecheck/probe PASS; `git diff --check` clean; only intentional uncommitted documentation/status changes remain before the final commit.

- [ ] **Step 6: Run the real Gemini gate only with private deployment credentials**

```powershell
$env:MC_AI_LIVE_VALIDATION='1'
npm run validate:gemini-live
```

Expected: explicit PASS records for Lite-low, Flash-medium, Flash-high, and actual usage settlement. If quota/config prevents the test, record the safe failure and keep the release gate pending; never substitute fake-provider evidence for this gate.

- [ ] **Step 7: Final security review commands**

Search committed diff for obvious secret/prompt leakage:

```powershell
git diff main...HEAD -- . ':!package-lock.json'
git grep -n "MC_AI_KEY_" -- ':!config/ai-routing.example.json' ':!.env.example' ':!docs/**'
git grep -n -E "AIza[0-9A-Za-z_-]+" -- .
```

Expected: no real secret values, no prompt/objective persistence in quota DB/telemetry, no Admin listener non-loopback bind, no raw provider error logging.

- [ ] **Step 8: Mark the design spec implemented only after evidence is real**

Change the spec status from planning/review language to an implementation status that explicitly lists any remaining release gates. Do not claim those gates passed unless their evidence exists.

- [ ] **Step 9: Commit final implementation/docs**

```powershell
git add tests/scenarios/gemini-routing-coordinator.test.ts scripts/validate-gemini-routing-live.ts package.json package-lock.json README.md .env.example docs/superpowers/specs/2026-09-12-gemini-multi-model-routing-design.md
git commit -m "test: validate Gemini multi-model routing"
```

- [ ] **Step 10: Re-run branch-wide verification after the commit**

```powershell
npm test
npm run typecheck
npm run probe
git diff --check main...HEAD
git status --short
```

Expected: PASS and clean worktree.

- [ ] **Step 11: Update Draft PR #4 for implementation review, but do not merge automatically**

PR body must summarize implemented routing, tests, live-validation evidence, and still-pending release gates. Mark ready for review only after required CI checks pass on the implementation head. Protected `main` remains PR-only; do not bypass required checks, required up-to-date status, conversation resolution, or linear-history rules.

---

## Plan self-check mapping

The implementation tasks map to the approved spec as follows:

```text
Config / fake-vs-gemini migration             Task 1, Task 7, Task 16
Cancellation semantics / identity evidence    Task 2
DecisionOutcome + task-aware context           Task 3, Task 11
balanced-v1 complexity                         Task 4
Online/offline identity + manual deep          Task 5, Task 12, Task 13
Durable quota / crash consistency              Task 6
Atomic reload + config generations             Task 7, Task 14
Primary-first pool + 70/30 admission           Task 8
One-attempt Gemini + usage/error facts         Task 9
Retry/failover taxonomy                        Task 10
AiTask / coalescing / task queue               Task 12
Production mailbox Coordinator                 Task 13
Admin trust boundary                           Task 14
Telemetry + /v1/status                         Task 15
Composition root / fake seam                   Task 16
E2E + real Gemini release gate                 Task 17
```

No implementation task may silently broaden DC_BOT integration, proxy UUID trust, concurrent autonomous tasks, speculative parallel calls, server-side Gemini conversation state, or arbitrary complexity-weight hot reload. Those remain separate future architecture changes.
