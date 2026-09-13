# Project Autonomy Phase 5: Durable Project DAG, AI Planning, Recovery, and Multiplayer Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate durable multi-step Project orchestration with constrained Gemini project planning, multiplayer ownership/conflict rules, restart/offline continuation, circuit breakers, and full end-to-end conversational construction.

**Architecture:** Add a durable task-DAG scheduler above existing Goal/Skill executors. Project planning uses a separate schema/transport contract but reuses existing routing/project-pool/quota/accounting. Conversation resolves player/project/draft first; only ambiguous semantics or creative/structural planning reaches Gemini. Deterministic tasks continue while AI is unavailable when an approved plan remains executable.

**Tech Stack:** TypeScript 7, Node.js 24, Mineflayer 4.39, @google/genai 2.21.0, better-sqlite3 12.11.1, Zod 4.5.4, node:test/tsx.

**Spec:** `docs/superpowers/specs/2026-09-13-project-autonomy-construction-design.md`

## Global Constraints

- Preserve current exact action-tool contract for stay/follow/gather; Project planning is separate.
- Reuse ProjectPool/quota/credential/failover accounting; no unaccounted direct Gemini path.
- Level-0 mechanics never call AI.
- Initial architectural planning uses complex/medium; repeated structural replanning >=2 may use existing high policy.
- Project soft budgets and circuit breakers stop unbounded semantic/planning/retry/death loops.
- AI output cannot directly invoke Mineflayer mutation.
- ACL, storage ACL, approval envelope, hard safety, and server ceiling are checked before scheduling/mutation.
- Same-role conflicts block only affected branches and wait for owner resolution.
- Restart enters recovering and reconciles live world before resume.
- Owner-offline continuation only runs already-approved branches needing no new owner authority.
- Routine chat stays deterministic and low-noise.

---

## File structure

- Create `src/projects/task-contracts.ts`, `task-graph.ts`, `orchestrator.ts`, `conflict-service.ts`, `recovery.ts`, `conversation-controller.ts`, `project-planner.ts`.
- Extend `src/projects/repository.ts`/`sqlite-repository.ts` with tasks/dependencies/conflicts/AI usage.
- Create `src/agent/project-planning/contracts.ts`, `gemini.ts`, `executor.ts`.
- Create `src/agent/routing/generic-routed-executor.ts`; refactor `routed-executor.ts` without behavior change.
- Modify `src/runtime/decision-coordinator.ts`, `src/contracts/events.ts`, `src/agent/chat-feedback.ts`, `src/main.ts`, `src/api/control-server.ts`.
- Tests under `tests/projects/`, `tests/agent/project-planning/`, `tests/agent/routing/`, `tests/scenarios/`.

---

### Task 1: Add durable task/conflict contracts and repository tables

**Files:**
- Create: `src/projects/task-contracts.ts`
- Modify: `src/projects/repository.ts`
- Modify: `src/projects/sqlite-repository.ts`
- Test: `tests/projects/task-persistence.test.ts`

**Interfaces:**

```ts
export const ProjectTaskStatusSchema = z.enum([
  'pending', 'runnable', 'running', 'suspended', 'blocked_by_conflict',
  'dependency_blocked', 'paused_waiting_player', 'paused_safety',
  'completed', 'failed', 'cancelled'
])
export type ProjectTaskStatus = z.infer<typeof ProjectTaskStatusSchema>

export interface ProjectTaskRecord {
  readonly taskId: string
  readonly projectId: string
  readonly kind: string
  readonly scope: string
  readonly status: ProjectTaskStatus
  readonly payload: Readonly<Record<string, unknown>>
  readonly progress: Readonly<Record<string, unknown>>
  readonly priority: number
  readonly attemptCount: number
  readonly recoveryCount: number
  readonly lastFailureClass: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

export interface ProjectTaskDependency {
  readonly taskId: string
  readonly dependsOnTaskId: string
  readonly dependencyType: 'success'
}

export interface ProjectConflictRecord {
  readonly conflictId: string
  readonly projectId: string
  readonly scope: string
  readonly status: 'open' | 'resolved'
  readonly createdAt: number
  readonly resolvedAt: number | null
  readonly resolvedByUuid: string | null
  readonly resolution: Readonly<Record<string, unknown>> | null
}

export interface ProjectConflictOptionRecord {
  readonly conflictId: string
  readonly actorUuid: string
  readonly actorRole: ProjectRole
  readonly proposal: Readonly<Record<string, unknown>>
  readonly createdAt: number
}

export interface ProjectAiUsageRecord {
  readonly projectId: string
  readonly semanticCalls: number
  readonly architecturalCalls: number
  readonly structuralReplanCalls: number
  readonly updatedAt: number
}
```

- [ ] **Step 1: Write RED persistence tests**

Cover task CRUD/progress/attempts, dependency foreign keys, restart reload, open conflict with two options, owner resolution, and project AI counters. Reject self-dependency and duplicate edges.

- [ ] **Step 2: Run RED**

```powershell
npm test -- tests/projects/task-persistence.test.ts
```

- [ ] **Step 3: Add schema/repository API**

Create `project_tasks`, `project_task_dependencies`, `project_conflicts`, `project_conflict_options`, `project_ai_usage`. Add transactional `createTaskGraph`, `updateTaskState`, `incrementTaskAttempt`, `createConflict`, `resolveConflict`, `getProjectAiUsage`, `incrementProjectAiUsage`.

- [ ] **Step 4: Verify and commit**

```powershell
npm test -- tests/projects/task-persistence.test.ts tests/projects/sqlite-repository.test.ts
npm run typecheck
```

```bash
git add src/projects/task-contracts.ts src/projects/repository.ts src/projects/sqlite-repository.ts tests/projects/task-persistence.test.ts
git commit -m "feat: persist durable project task graphs"
```

---

### Task 2: Implement pure DAG state calculation and same-role conflict blocking

**Files:**
- Create: `src/projects/task-graph.ts`
- Create: `src/projects/conflict-service.ts`
- Test: `tests/projects/task-graph.test.ts`
- Test: `tests/projects/conflict-service.test.ts`

**Interfaces:**

```ts
export function validateTaskGraph(
  tasks: readonly ProjectTaskRecord[],
  dependencies: readonly ProjectTaskDependency[]
): void

export function runnableTaskIds(
  tasks: readonly ProjectTaskRecord[],
  dependencies: readonly ProjectTaskDependency[]
): readonly string[]

export function dependencyBlockedTaskIds(
  tasks: readonly ProjectTaskRecord[],
  dependencies: readonly ProjectTaskDependency[]
): readonly string[]

export type ConflictInstructionResult =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'conflict'; readonly conflict: ProjectConflictRecord }

export function registerInstruction(input: {
  readonly project: ProjectRecord
  readonly actorUuid: string
  readonly actorRole: ProjectRole
  readonly scope: string
  readonly proposal: Readonly<Record<string, unknown>>
}): ConflictInstructionResult
```

- [ ] **Step 1: Write RED DAG tests**

Cycle rejection, prerequisite unlock, failed/cancelled prerequisite downstream blocking, independent branch continuation, stable priority `priority DESC, createdAt ASC, taskId ASC`.

- [ ] **Step 2: Write RED conflict tests**

Authorized owner supersedes manager/helper; manager supersedes helper. Same-role contradictory proposals on same scope create one conflict and block only tasks with that scope. Identical canonical proposal is idempotent.

- [ ] **Step 3: Implement canonical proposal comparison**

Canonicalize validated proposal objects by recursively sorting keys; do not compare raw chat strings.

- [ ] **Step 4: Verify and commit**

```powershell
npm test -- tests/projects/task-graph.test.ts tests/projects/conflict-service.test.ts
npm run typecheck
```

```bash
git add src/projects/task-graph.ts src/projects/conflict-service.ts tests/projects/task-graph.test.ts tests/projects/conflict-service.test.ts
git commit -m "feat: schedule independent project branches safely"
```

---

### Task 3: Extract a generic routed attempt engine without changing action behavior

**Files:**
- Create: `src/agent/routing/generic-routed-executor.ts`
- Modify: `src/agent/routing/routed-executor.ts`
- Modify: `src/agent/routing/contracts.ts`
- Test: `tests/agent/routing/generic-routed-executor.test.ts`
- Test: `tests/agent/routing/routed-executor.test.ts`
- Test: `tests/scenarios/gemini-routing-coordinator.test.ts`

**Interfaces:**

```ts
export interface GenericUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly thoughtTokens: number
  readonly toolTokens: number
  readonly totalTokens: number
}

export type GenericAttemptResult<TResult> =
  | { readonly kind: 'success'; readonly value: TResult; readonly usage: GenericUsage }
  | { readonly kind: 'api_error'; readonly httpStatus: number; readonly providerCode?: string; readonly retryAfterMs?: number; readonly usage?: GenericUsage }
  | { readonly kind: 'content_blocked'; readonly usage?: GenericUsage }
  | { readonly kind: 'generation_error'; readonly safeCode: string; readonly usage?: GenericUsage }
  | { readonly kind: 'configuration_error'; readonly safeCode: string }
  | { readonly kind: 'cancelled' }

export type GenericRoutedResult<TResult> =
  | { readonly kind: 'success'; readonly value: TResult }
  | { readonly kind: 'safety_blocked'; readonly code: 'content_blocked' }
  | { readonly kind: 'unavailable'; readonly retryAt: number | null }
  | { readonly kind: 'invalid_response'; readonly code: string }
  | { readonly kind: 'configuration_error'; readonly code: string }
  | { readonly kind: 'cancelled' }

export interface RoutedPreparedPayload<TPrepared> {
  readonly prepared: TPrepared
  readonly utf8Bytes: number
}

export interface GenericRoutedTransport<TInput, TPrepared, TResult> {
  prepare(input: TInput): RoutedPreparedPayload<TPrepared>
  execute(prepared: TPrepared, lease: AttemptLease, signal: AbortSignal): Promise<GenericAttemptResult<TResult>>
}

export class GenericRoutedExecutor<TInput, TPrepared, TResult> {
  execute(input: TInput, routePlan: RoutePlan, signal: AbortSignal): Promise<GenericRoutedResult<TResult>>
}
```

- [ ] **Step 1: Lock existing behavior with characterization tests**

Confirm failover, quota unavailable, credential fatal, transient backoff, one generation retry, content block terminal, cancellation, telemetry, and settlement usage all pass against pre-refactor action executor.

- [ ] **Step 2: Move routing/accounting loop into generic executor**

Current `RoutedDecisionExecutor` becomes a thin adapter mapping current `GeminiAttemptResult`/`ProviderResult` to/from generic union. No action semantics change.

- [ ] **Step 3: Verify all routing/provider/scenario tests**

```powershell
npm test -- tests/agent/routing tests/scenarios/gemini-routing-coordinator.test.ts tests/agent/providers
npm run typecheck
```

- [ ] **Step 4: Commit**

```bash
git add src/agent/routing/generic-routed-executor.ts src/agent/routing/routed-executor.ts src/agent/routing/contracts.ts tests/agent/routing/generic-routed-executor.test.ts tests/agent/routing/routed-executor.test.ts tests/scenarios/gemini-routing-coordinator.test.ts
git commit -m "refactor: generalize routed Gemini attempt execution"
```

---

### Task 4: Define strict Project Planning Gemini contracts and transport

**Files:**
- Create: `src/agent/project-planning/contracts.ts`
- Create: `src/agent/project-planning/gemini.ts`
- Test: `tests/agent/project-planning/contracts.test.ts`
- Test: `tests/agent/project-planning/gemini.test.ts`

**Interfaces:**

```ts
export const SemanticSlotResultSchema = z.object({
  slot: z.enum(['site', 'materials', 'scale', 'style', 'storage', 'protected_area']),
  state: z.enum(['explicit', 'inferred', 'delegated']),
  value: z.unknown().nullable(),
  userFacingSummary: z.string().trim().max(180).optional()
}).strict()

export const ArchitecturalPlanSchema = z.object({
  version: z.literal(1),
  name: z.string().trim().min(1).max(128),
  footprint: z.object({ width: z.number().int().min(3).max(64), depth: z.number().int().min(3).max(64) }).strict(),
  maxHeight: z.number().int().min(3).max(32),
  styleTags: z.array(z.string().trim().min(1).max(64)).max(12),
  palette: z.array(z.object({ role: z.string().trim().min(1).max(64), block: z.string().trim().min(1).max(128) }).strict()).max(32),
  primitives: z.array(ArchitecturalPrimitiveSchema).min(1).max(512),
  userFacingSummary: z.string().trim().min(1).max(300)
}).strict()

export type ArchitecturalPlan = z.infer<typeof ArchitecturalPlanSchema>
```

- [ ] **Step 1: Write RED schema tests**

Reject extra fields, raw coordinate arrays as a plan substitute, oversize plans, unknown primitives, invalid material IDs, missing summary; accept constrained fixture.

- [ ] **Step 2: Write RED exact-tool transport tests**

Functions are exactly `submit_semantic_slot`, `submit_architectural_plan`, `submit_structural_replan`, each object-root with required fields. Unknown/multiple calls -> `project_planning_schema_invalid`.

- [ ] **Step 3: Implement `ProjectPlanningGeminiTransport`**

Reuse credential boundary; return sanitized `GenericAttemptResult`. No raw reasoning/provider payload in telemetry.

- [ ] **Step 4: Verify and commit**

```powershell
npm test -- tests/agent/project-planning
npm run typecheck
```

```bash
git add src/agent/project-planning/contracts.ts src/agent/project-planning/gemini.ts tests/agent/project-planning
git commit -m "feat: add constrained Gemini project planning"
```

---

### Task 5: Add Project Planning executor, route policy, and project AI soft budgets

**Files:**
- Create: `src/agent/project-planning/executor.ts`
- Modify: `src/agent/routing/complexity.ts` only for reusable evidence helpers; keep balanced-v1 weights unchanged.
- Test: `tests/agent/project-planning/executor.test.ts`
- Test: `tests/agent/routing/complexity.test.ts`

**Interfaces:**

```ts
export type ProjectPlanningKind = 'semantic' | 'architectural' | 'structural_replan'

export interface ProjectPlanningRequest<T> {
  readonly projectId: string
  readonly decisionId: string
  readonly kind: ProjectPlanningKind
  readonly input: T
  readonly replanCount: number
  readonly reserveAuthorized: boolean
}

export const PROJECT_AI_SOFT_LIMITS = Object.freeze({
  semantic: 8,
  architectural: 3,
  structural_replan: 3
} as const)
```

- [ ] **Step 1: Write RED route/budget tests**

Semantic -> routine/low; first architecture -> complex/medium; first structural replan -> complex/medium; replan >=2 -> existing repeated-replanning high reason; blueprint size alone never selects high; soft budget exhaustion returns `planner_exhausted` before provider call.

- [ ] **Step 2: Implement on GenericRoutedExecutor**

Increment project AI usage according to admitted dispatch/settlement semantics. Provider unavailable returns bounded unavailable without corrupting Project state.

- [ ] **Step 3: Verify and commit**

```powershell
npm test -- tests/agent/project-planning/executor.test.ts tests/agent/routing/complexity.test.ts
npm run typecheck
```

```bash
git add src/agent/project-planning/executor.ts src/agent/routing/complexity.ts tests/agent/project-planning/executor.test.ts tests/agent/routing/complexity.test.ts
git commit -m "feat: route bounded project planning calls"
```

---

### Task 6: Implement Project Orchestrator, locks, task dispatch, and circuit breakers

**Files:**
- Create: `src/projects/orchestrator.ts`
- Test: `tests/projects/orchestrator.test.ts`

**Interfaces:**

```ts
export interface ProjectTaskHandlerResult {
  readonly status: 'completed' | 'progress' | 'suspended' | 'blocked' | 'failed'
  readonly progress?: Readonly<Record<string, unknown>>
  readonly code?: string
}

export interface ProjectTaskHandler {
  readonly kind: string
  requiredLocks(task: ProjectTaskRecord): readonly string[]
  execute(task: ProjectTaskRecord, signal: AbortSignal): Promise<ProjectTaskHandlerResult>
}

export interface ProjectRuntimeStatus {
  readonly projectId: string
  readonly runningTaskId: string | null
  readonly runnableCount: number
  readonly blockedCount: number
  readonly state: 'idle' | 'running' | 'paused' | 'recovering'
}

export class ProjectOrchestrator {
  start(): void
  dispose(): void
  wakeProject(projectId: string): Promise<void>
  pauseProject(projectId: string, reason: string): Promise<void>
  status(projectId: string): ProjectRuntimeStatus
}
```

- [ ] **Step 1: Write RED scheduler tests**

One physical task at a time; stable priority; completion unlocks dependencies; conflict branch blocked while unrelated branch runs; survival suspend/resume; shutdown persists suspension/releases locks; three identical local failures trip breaker; AI/provider failure affects only planner task; incompatible locks never overlap.

- [ ] **Step 2: Implement lexical deadlock-free lock manager**

Lock keys are concrete strings produced by helpers:

```ts
const movementLock = 'movement'
const inventoryLock = 'inventory'
const containerLock = (storageId: string) => `container:${storageId}`
const regionLock = (dimension: string, regionKey: string) => `world-region:${dimension}:${regionKey}`
const workstationLock = (infrastructureId: string) => `workstation:${infrastructureId}`
```

Acquire sorted unique keys and release in reverse order.

- [ ] **Step 3: Register deterministic task handlers**

At minimum `gather_resource`, `craft_item`, `process_item`, `prepare_project_terrain`, `construct_project_batch`, `cleanup_project`, `verify_project`. Delegate to Phase 1-4 systems; do not duplicate mechanics.

- [ ] **Step 4: Verify and commit**

```powershell
npm test -- tests/projects/orchestrator.test.ts tests/projects/task-graph.test.ts
npm run typecheck
```

```bash
git add src/projects/orchestrator.ts tests/projects/orchestrator.test.ts
git commit -m "feat: orchestrate durable project task graphs"
```

---

### Task 7: Implement restart recovery and offline-owner continuation

**Files:**
- Create: `src/projects/recovery.ts`
- Test: `tests/projects/recovery.test.ts`

**Interfaces:**

```ts
export interface ProjectRecoveryResult {
  readonly projectId: string
  readonly status: 'resumable' | 'waiting_player' | 'paused_safety' | 'failed'
  readonly reconciledTaskIds: readonly string[]
  readonly blockedTaskIds: readonly string[]
}
```

- [ ] **Step 1: Write RED recovery tests**

Running tasks become suspended before scan; correct live blocks verify progress; missing block becomes incomplete rather than blindly re-placed; chest replacing scaffold blocks cleanup; storage stock refresh invalidates stale reservations; owner offline allows approved branch but pauses new-approval branch; unresolved conflict survives restart.

- [ ] **Step 2: Implement using live survey/runtime**

Never restore Mineflayer objects or AbortControllers. Rebuild runtime state from persisted intent + current world.

- [ ] **Step 3: Verify and commit**

```powershell
npm test -- tests/projects/recovery.test.ts
npm run typecheck
```

```bash
git add src/projects/recovery.ts tests/projects/recovery.test.ts
git commit -m "feat: reconcile projects safely after restart"
```

---

### Task 8: Integrate conversational project creation and one-question flow

**Files:**
- Create: `src/projects/conversation-controller.ts`
- Modify: `src/runtime/decision-coordinator.ts` only at the chat input-routing boundary.
- Modify: `src/contracts/events.ts`
- Modify: `src/agent/chat-feedback.ts`
- Test: `tests/projects/conversation-controller.test.ts`
- Test: `tests/runtime/decision-coordinator.test.ts`
- Test: `tests/agent/chat-feedback.test.ts`

**Interfaces:**

```ts
export type ProjectConversationResult =
  | { readonly kind: 'not_project_command' }
  | { readonly kind: 'handled'; readonly projectId: string }
  | { readonly kind: 'asked_question'; readonly projectId: string; readonly slot: BuildDraftSlot }
  | { readonly kind: 'blocked'; readonly code: string }
```

- [ ] **Step 1: Write RED short-dialog tests**

`墨雪幫我蓋個房子` asks site only; `就這裡` stores site deterministically and asks next slot; ambiguous `兩個人住，不要太大` causes exactly one semantic call; `你自己決定` delegates slot; reload resumes next unresolved slot.

Also test autonomy/ACL project commands (`激進模式`, add helper, continue, pause) by UUID authorization.

- [ ] **Step 2: Implement deterministic project-command recognition before ordinary action AI**

If not confidently project/draft input, return `not_project_command` and preserve existing DecisionCoordinator path.

- [ ] **Step 3: Add sanitized project chat events**

Use `project_question`, `project_progress_important`, `project_waiting`, `project_safety_pause`, `project_completed`, `project_failed`. Routine tool/craft/combat/scaffold details stay silent.

- [ ] **Step 4: Verify and commit**

```powershell
npm test -- tests/projects/conversation-controller.test.ts tests/runtime/decision-coordinator.test.ts tests/agent/chat-feedback.test.ts
npm run typecheck
```

```bash
git add src/projects/conversation-controller.ts src/runtime/decision-coordinator.ts src/contracts/events.ts src/agent/chat-feedback.ts tests/projects/conversation-controller.test.ts tests/runtime/decision-coordinator.test.ts tests/agent/chat-feedback.test.ts
git commit -m "feat: create and manage projects through chat"
```

---

### Task 9: Turn a ready draft into an approved plan/BOM/supply plan/DAG

**Files:**
- Create: `src/projects/project-planner.ts`
- Test: `tests/projects/project-planner.test.ts`

**Interfaces:**

```ts
export interface ProjectPlanBuildResult {
  readonly projectId: string
  readonly planVersion: number
  readonly approval: 'approved' | 'awaiting_owner'
  readonly taskIds: readonly string[]
}
```

- [ ] **Step 1: Write RED plan-composition tests**

Ready `BuildDraftRecord` + site/storage/infrastructure summary -> one architectural call -> strict plan -> compiled blueprint/BOM -> supply plan -> durable task graph. Small ordinary build may auto-approve inside envelope; destructive/large build -> awaiting approval with no runnable mutation task. Invalid material/compiler result fails before task creation. Plan snapshot is immutable/versioned.

- [ ] **Step 2: Implement transaction boundary**

This service creates plan/task records only; it never executes Minecraft actions.

- [ ] **Step 3: Verify and commit**

```powershell
npm test -- tests/projects/project-planner.test.ts tests/construction/blueprint-compiler.test.ts tests/supply/planner.test.ts
npm run typecheck
```

```bash
git add src/projects/project-planner.ts tests/projects/project-planner.test.ts
git commit -m "feat: expand approved build plans into project tasks"
```

---

### Task 10: Production composition, startup recovery, and status

**Files:**
- Modify: `src/main.ts`
- Modify: `src/api/control-server.ts`
- Test: `tests/main-project-orchestration.test.ts`
- Test: `tests/api/control-server-project-status.test.ts`

**Interfaces:**

```ts
export interface ProjectStatusSummary {
  readonly activeCount: number
  readonly waitingPlayerCount: number
  readonly recoveringCount: number
  readonly runningProjectId: string | null
}
```

- [ ] **Step 1: Write RED lifecycle tests**

Startup order is runtime connect/spawn -> project recovery -> orchestrator start -> control ready. Shutdown aborts project work before adapter disconnect/repository close. `/v1/status` exposes only safe aggregate project summary, not private UUIDs/coordinates.

- [ ] **Step 2: Implement startup recovery/lifecycle**

Scan nonterminal projects for current `worldKey`, set recovering, reconcile, wake resumable only after Minecraft is spawned.

- [ ] **Step 3: Run full automated verification**

```powershell
npm test
npm run typecheck
```

- [ ] **Step 4: Commit**

```bash
git add src/main.ts src/api/control-server.ts tests/main-project-orchestration.test.ts tests/api/control-server-project-status.test.ts
git commit -m "feat: run durable autonomous projects"
```

---

### Task 11: End-to-end private-server acceptance and soak

**Files:**
- Modify: this plan to append measured evidence.
- Add scenario fixtures/tests only when a live regression needs a permanent reproduction.

- [ ] **Step 1: Validate short conversational house request**

Fresh safe test area: `墨雪，幫我蓋個房子`. Verify one-question flow, deterministic answers do not call AI, ambiguous style/scale calls are bounded, owner UUID/default autonomy are correct, and project reaches approved plan.

- [ ] **Step 2: Validate supply/tool/production chain**

Require gathering + crafting + processing/workstation/fuel. Give an appropriate tool and observe automatic equip. Confirm unauthorized nearby chest stays unopened.

- [ ] **Step 3: Validate terrain/scaffold/construction**

Require limited CUT/FILL + high placement. With shears + legal leaves + no explicit scaffold, verify leaf scaffold eligibility, cleanup, and infrastructure lifecycle.

- [ ] **Step 4: Validate multiplayer ACL/conflict**

Owner creates Project, adds collaborator, unauthorized third party cannot mutate, same-role contradiction blocks only affected scope, owner resolves and branch resumes.

- [ ] **Step 5: Validate restart and owner-offline continuation**

Restart mid-build after checkpoint; recovering reconciles and resumes without duplicate destructive work. Disconnect owner; approved branch continues. Trigger new approval requirement and confirm affected branch waits.

- [ ] **Step 6: Validate safety interruption**

Controlled hostile/hunger interruption resumes work; player is never combat target; repeated failure/death breaker is verified through automated harness.

- [ ] **Step 7: Run 4-8 hour release soak**

Track disconnects, unbounded retries, AI call counts, queue/DB growth, resource leaks, and unintended world mutation. Any failure gets a deterministic regression before re-run.

- [ ] **Step 8: Final verification/evidence commit**

```powershell
npm test
npm run typecheck
git status --short
git log -10 --oneline
```

Append PASS/FAIL table with commit SHA + Minecraft version and no secrets/reasoning.

```bash
git add docs/superpowers/plans/2026-09-13-project-autonomy-phase5-orchestration-planning.md tests fixtures
git commit -m "docs: record autonomous project acceptance evidence"
```

Phase 5 and the complete architecture are release-ready only when automated tests/typecheck, short-dialog build, production chain, construction/scaffold cleanup, multiplayer ACL/conflict, restart recovery, owner-offline continuation, survival interruption/resume, and soak all pass. This does not authorize merging; merge still requires explicit user approval.
