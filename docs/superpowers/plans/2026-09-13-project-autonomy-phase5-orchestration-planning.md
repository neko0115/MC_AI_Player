# Project Autonomy Phase 5: Durable Project DAG, AI Planning, Recovery, and Multiplayer Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate durable multi-step Project orchestration with constrained Gemini project planning, multiplayer ownership/conflict rules, restart/offline continuation, circuit breakers, and full end-to-end conversational construction.

**Architecture:** Add a durable task-DAG scheduler above the existing Goal/Skill executors. Project planning uses a separate schema/transport contract but reuses the existing routing/project-pool/quota/accounting machinery. Conversation state resolves the player/project/draft first; only ambiguous semantics or creative/structural planning reaches Gemini. Deterministic tasks continue when AI is unavailable as long as an already-approved plan remains executable.

**Tech Stack:** TypeScript 7, Node.js 24, Mineflayer 4.39, @google/genai 2.21.0, better-sqlite3 12.11.1, Zod 4.5.4, node:test/tsx.

**Spec:** `docs/superpowers/specs/2026-09-13-project-autonomy-construction-design.md`

## Global Constraints

- Preserve current exact action-tool Gemini contract for `stay`, `follow_player`, `gather_resource`, etc.; Project planning is a separate contract.
- Reuse existing ProjectPool/quota/credential/failover accounting; do not create an unaccounted direct Gemini client path.
- Level 0 mechanics never call AI.
- First architectural planning uses complex/medium; repeated structural replanning >=2 may use existing high-thinking policy.
- Project soft budgets and hard circuit breakers prevent unbounded semantic/planning/retry/death loops.
- AI output is schema-constrained and cannot directly invoke Mineflayer mutation.
- Owner/manager/helper ACL, storage ACL, approval envelope, hard safety, and server ceiling are checked before task scheduling/mutation.
- Same-role conflicting commands block only affected DAG branches and wait for owner resolution.
- Restart enters `recovering`; live world reconciliation happens before resuming.
- Owner-offline continuation is allowed only for already-approved branches that require no new owner authority.
- Chat remains concise and deterministic by default.

---

## File structure

- Create `src/projects/task-contracts.ts` — durable task kinds/status/dependencies/results.
- Extend `src/projects/repository.ts`/`sqlite-repository.ts` — tasks, dependencies, conflicts/options, project AI budgets.
- Create `src/projects/task-graph.ts` — pure DAG validation/runnable calculation/branch blocking.
- Create `src/projects/orchestrator.ts` — single-body scheduler, locks, task dispatch, suspend/resume.
- Create `src/projects/conflict-service.ts` — same-role conflict creation/resolution.
- Create `src/projects/recovery.ts` — restart/world reconciliation and runnable reconstruction.
- Create `src/projects/conversation-controller.ts` — player/project/draft resolution, one-question flow, project commands.
- Create `src/agent/project-planning/contracts.ts` — semantic and architectural output schemas.
- Create `src/agent/project-planning/gemini.ts` — project-specific Gemini payload/tool schema and strict parsing.
- Create `src/agent/routing/generic-routed-executor.ts` — generic quota/failover attempt loop extracted from existing action executor.
- Refactor `src/agent/routing/routed-executor.ts` to adapt current action transport through generic routed executor without semantic changes.
- Create `src/agent/project-planning/executor.ts` — semantic/architectural/replan route requests.
- Modify `src/main.ts` — production composition and lifecycle.
- Extend `src/contracts/events.ts` with sanitized project lifecycle events.
- Extend `src/agent/chat-feedback.ts` with project categories while retaining noise controls.
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
  'pending',
  'runnable',
  'running',
  'suspended',
  'blocked_by_conflict',
  'dependency_blocked',
  'paused_waiting_player',
  'paused_safety',
  'completed',
  'failed',
  'cancelled'
])

export interface ProjectTaskRecord {
  readonly taskId: string
  readonly projectId: string
  readonly kind: string
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
```

Conflict:

```ts
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
```

- [ ] **Step 1: Write RED persistence tests**

Cover task CRUD/status/progress attempt counters, dependency foreign keys, project restart reload, open conflict + two options, owner resolution, and active project AI soft-budget counters. Ensure a task cannot depend on itself and duplicate dependency edges are rejected.

- [ ] **Step 2: Run RED**

```powershell
npm test -- tests/projects/task-persistence.test.ts
```

- [ ] **Step 3: Add schema and repository API**

Add tables:

```text
project_tasks
project_task_dependencies
project_conflicts
project_conflict_options
project_ai_usage
```

Repository methods include transactional `createTaskGraph(projectId, tasks, dependencies)`, `updateTaskState`, `incrementTaskAttempt`, `createConflict`, `resolveConflict`, and `getProjectAiUsage`/`incrementProjectAiUsage`.

- [ ] **Step 4: Run tests/typecheck and commit**

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

export function dependencyBlockedTaskIds(...): readonly string[]
```

Conflict service:

```ts
registerInstruction(input: {
  project: ProjectRecord
  actorUuid: string
  actorRole: ProjectRole
  scope: string
  proposal: Readonly<Record<string, unknown>>
}): { kind: 'accepted' } | { kind: 'conflict'; conflict: ProjectConflictRecord }
```

- [ ] **Step 1: Write RED DAG tests**

Cover cycle rejection, completed prerequisite unlock, failed/cancelled prerequisite blocks downstream, independent branch stays runnable, priority ordering stable by `priority DESC, createdAt ASC, taskId ASC`.

- [ ] **Step 2: Write RED conflict tests**

Owner instruction supersedes manager/helper when authorized; manager supersedes helper. Same-role contradictory proposals on same scope create one durable conflict, mark only tasks tagged with that scope `blocked_by_conflict`, and leave unrelated tasks runnable. Same proposal repeated is idempotent and does not create a conflict.

- [ ] **Step 3: Implement pure graph/conflict logic**

Conflict equivalence uses canonical JSON of validated proposal records with sorted keys; do not compare raw chat text.

- [ ] **Step 4: Run tests/typecheck and commit**

```powershell
npm test -- tests/projects/task-graph.test.ts tests/projects/conflict-service.test.ts
npm run typecheck
```

```bash
git add src/projects/task-graph.ts src/projects/conflict-service.ts tests/projects/task-graph.test.ts tests/projects/conflict-service.test.ts
git commit -m "feat: schedule independent project branches safely"
```

---

### Task 3: Extract a generic routed attempt engine without changing current action behavior

**Files:**
- Create: `src/agent/routing/generic-routed-executor.ts`
- Modify: `src/agent/routing/routed-executor.ts`
- Modify: `src/agent/routing/contracts.ts`
- Test: `tests/agent/routing/generic-routed-executor.test.ts`
- Test: `tests/agent/routing/routed-executor.test.ts`
- Test: `tests/scenarios/gemini-routing-coordinator.test.ts`

**Interfaces:**

```ts
export interface RoutedPreparedPayload<TPrepared> {
  readonly prepared: TPrepared
  readonly utf8Bytes: number
}

export interface GenericRoutedTransport<TInput, TPrepared, TResult> {
  prepare(input: TInput): RoutedPreparedPayload<TPrepared>
  execute(
    prepared: TPrepared,
    lease: AttemptLease,
    signal: AbortSignal
  ): Promise<GenericAttemptResult<TResult>>
}

export class GenericRoutedExecutor<TInput, TPrepared, TResult> {
  execute(input: TInput, routePlan: RoutePlan, signal: AbortSignal): Promise<GenericRoutedResult<TResult>>
}
```

- [ ] **Step 1: Characterize current action executor behavior with RED/locking tests before refactor**

Add/confirm tests for project failover, quota-unavailable, credential fatal, transient backoff, one generation retry, content block terminal, cancellation, telemetry, settlement usage accounting. These must pass against current code before extraction.

- [ ] **Step 2: Implement generic executor by moving policy loop, not changing it**

The generic executor owns lease/settlement/failover/telemetry mechanics. Current `RoutedDecisionExecutor` becomes a thin adapter that maps existing `GeminiAttemptResult`/`ProviderResult` to/from generic result types.

- [ ] **Step 3: Run all routing/scenario tests**

```powershell
npm test -- tests/agent/routing tests/scenarios/gemini-routing-coordinator.test.ts tests/agent/providers
npm run typecheck
```

Expected: all existing action-routing behavior remains unchanged.

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

Semantic parse result:

```ts
export const SemanticSlotResultSchema = z.object({
  slot: z.enum(['site', 'materials', 'scale', 'style', 'storage', 'protected_area']),
  state: z.enum(['explicit', 'inferred', 'delegated']),
  value: z.unknown().nullable(),
  userFacingSummary: z.string().trim().max(180).optional()
}).strict()
```

Architectural plan result uses bounded primitives from Phase 4:

```ts
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
```

- [ ] **Step 1: Write RED schema/normalization tests**

Reject arbitrary extra fields, raw block coordinate arrays, oversize plans, unknown primitive kinds, invalid material identifiers, and missing summaries. Accept constrained fixture plan.

- [ ] **Step 2: Write RED Gemini exact-tool tests**

Use separate project-planning function declarations, not current action tools:

```text
submit_semantic_slot
submit_architectural_plan
submit_structural_replan
```

Each call has object-root schema with required fields. Strict parser maps the selected function to one contract result; unknown/multiple tool calls fail closed as `project_planning_schema_invalid`.

- [ ] **Step 3: Implement `ProjectPlanningGeminiTransport`**

It resolves credentials through the same boundary as current Gemini transport and returns sanitized generic attempt results. Do not emit raw model reasoning or provider payload to telemetry.

- [ ] **Step 4: Run tests/typecheck and commit**

```powershell
npm test -- tests/agent/project-planning
npm run typecheck
```

```bash
git add src/agent/project-planning/contracts.ts src/agent/project-planning/gemini.ts tests/agent/project-planning
git commit -m "feat: add constrained Gemini project planning"
```

---

### Task 5: Add Project Planning executor, route policy, and per-project AI soft budgets

**Files:**
- Create: `src/agent/project-planning/executor.ts`
- Modify: `src/agent/routing/complexity.ts` only by adding reusable evidence construction helpers if necessary; do not change existing balanced-v1 weights.
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
```

- [ ] **Step 1: Write RED route tests**

Assert:

- semantic -> routine/low;
- initial architecture -> complex/medium;
- structural replan #1 -> complex/medium;
- replan count >=2 -> existing repeated-replanning high reason;
- physical blueprint size alone does not select high;
- project soft budget exhaustion returns `planner_exhausted` before provider call;
- provider unavailable returns bounded unavailable result without corrupting project state.

- [ ] **Step 2: Implement executor on `GenericRoutedExecutor`**

Increment project AI usage only after an admitted dispatch/settlement according to existing accounting semantics. Suggested initial soft limits, encoded as named policy constants and covered by tests:

```ts
small/normal default semantic = 8
architectural = 3
structuralReplan = 3
```

These are project soft guards, not provider quota claims.

- [ ] **Step 3: Run tests/typecheck and commit**

```powershell
npm test -- tests/agent/project-planning/executor.test.ts tests/agent/routing/complexity.test.ts
npm run typecheck
```

```bash
git add src/agent/project-planning/executor.ts src/agent/routing/complexity.ts tests/agent/project-planning/executor.test.ts tests/agent/routing/complexity.test.ts
git commit -m "feat: route bounded project planning calls"
```

---

### Task 6: Implement Project Orchestrator, locks, task dispatch, suspension, and circuit breakers

**Files:**
- Create: `src/projects/orchestrator.ts`
- Test: `tests/projects/orchestrator.test.ts`

**Interfaces:**

```ts
export interface ProjectTaskHandler {
  readonly kind: string
  execute(task: ProjectTaskRecord, signal: AbortSignal): Promise<{
    status: 'completed' | 'progress' | 'suspended' | 'blocked' | 'failed'
    progress?: Readonly<Record<string, unknown>>
    code?: string
  }>
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

Cover:

- one physical task executes at a time even when multiple DAG branches are runnable;
- stable priority selects next runnable task;
- completion unlocks dependent task;
- conflict branch stays blocked while unrelated branch executes;
- survival directive suspends current task and later resumes from persisted progress;
- shutdown aborts handler, persists suspended state, releases runtime locks;
- three identical local failures -> task blocked/circuit breaker rather than infinite retry;
- provider unavailable affects only planner task; deterministic construction/gather/craft branch can continue;
- resource/container/movement/world-region locks prevent overlapping incompatible handlers.

- [ ] **Step 2: Implement lock manager inside orchestrator module**

Use named exclusive locks:

```text
movement
inventory
container:<storageId>
world-region:<dimension>:<bounded-region-key>
workstation:<infrastructureId>
```

Handlers declare required locks before execution. Lock acquisition is deterministic and deadlock-free by lexical ordering.

- [ ] **Step 3: Map bounded task kinds to existing/new executors**

Handlers include at minimum:

```text
gather_resource
craft_item
process_item
prepare_project_terrain
construct_project_batch
cleanup_project
verify_project
```

Each handler delegates to Phase 1-4 deterministic code; orchestrator does not reproduce Minecraft mechanics.

- [ ] **Step 4: Run tests/typecheck and commit**

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

Cover:

- restart moves running tasks to recoverable/suspended before world scan;
- correct live blocks mark construction progress verified;
- missing expected project block becomes incomplete, not blindly re-placed before policy/reachability checks;
- temporary provenance now containing chest -> divergence/block, never cleanup break;
- authorized storage stock re-read invalidates stale reservations and triggers supply recalculation;
- owner offline + approved/risk-free branch -> resumable;
- owner offline + new approval required -> `paused_waiting_player` for affected branch only;
- unresolved same-role conflict remains blocked across restart.

- [ ] **Step 2: Implement reconciliation using Phase 4 survey/runtime**

Do not store/restore Mineflayer objects or in-flight AbortControllers. Persist intent/progress, rebuild runtime state from live observations.

- [ ] **Step 3: Run tests/typecheck and commit**

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
- Modify: `src/runtime/decision-coordinator.ts` only at the input-routing boundary needed to hand recognized project conversation to this controller; preserve ordinary action commands.
- Modify: `src/contracts/events.ts`
- Modify: `src/agent/chat-feedback.ts`
- Test: `tests/projects/conversation-controller.test.ts`
- Test: `tests/runtime/decision-coordinator.test.ts`
- Test: `tests/agent/chat-feedback.test.ts`

**Interfaces:**
- Consumes: trusted session identity, ProjectRepository, DraftService, ProjectResolver, ProjectPlanningExecutor, chat output.
- Produces conversational dispositions:

```ts
export type ProjectConversationResult =
  | { readonly kind: 'not_project_command' }
  | { readonly kind: 'handled'; readonly projectId: string }
  | { readonly kind: 'asked_question'; readonly projectId: string; readonly slot: BuildDraftSlot }
  | { readonly kind: 'blocked'; readonly code: string }
```

- [ ] **Step 1: Write RED conversation tests**

Scenario:

```text
Player: 墨雪幫我蓋個房子
Bot: 好呀～要蓋在哪？
Player: 就這裡
Bot: 大概要多大？
Player: 兩個人住，不要太大
```

Assert first answer stores site deterministically; ambiguous scale invokes exactly one semantic planning call; only one question is emitted per turn; `你自己決定` marks pending slot delegated and advances; restart reload continues from next unresolved slot.

Also cover project commands:

```text
把這個工程改成激進模式
讓 PlayerB 當這個工程的 helper
繼續蓋
暫停這個工程
```

Authorization must use project ACL and UUID identity, not player name equality.

- [ ] **Step 2: Implement project-command recognition before ordinary action AI**

Use deterministic trigger patterns for create/manage/continue/pause project forms. If a message is not confidently a project command/draft answer, return `not_project_command` so existing DecisionCoordinator path handles it unchanged.

- [ ] **Step 3: Wire lifecycle chat categories**

Extend ChatFeedback with project events such as:

```text
project_question
project_progress_important
project_waiting
project_safety_pause
project_completed
project_failed
```

Keep routine tool/craft/combat/scaffold details silent.

- [ ] **Step 4: Run tests/full regressions and commit**

```powershell
npm test -- tests/projects/conversation-controller.test.ts tests/runtime/decision-coordinator.test.ts tests/agent/chat-feedback.test.ts
npm run typecheck
```

```bash
git add src/projects/conversation-controller.ts src/runtime/decision-coordinator.ts src/contracts/events.ts src/agent/chat-feedback.ts tests/projects/conversation-controller.test.ts tests/runtime/decision-coordinator.test.ts tests/agent/chat-feedback.test.ts
git commit -m "feat: create and manage projects through chat"
```

---

### Task 9: Turn approved ArchitecturalPlan into Project DAG and start work

**Files:**
- Create: `src/projects/project-planner.ts`
- Test: `tests/projects/project-planner.test.ts`

**Interfaces:**
- Consumes: completed `BuildIntentDraft`, site survey summary, authorized storage/infrastructure summary, ProjectPlanningExecutor.
- Produces approved plan version + compiled blueprint/BOM + supply plan + durable task graph.

- [ ] **Step 1: Write RED planning tests**

Assert:

- small build inside safe envelope can proceed without second approval when policy says ordinary;
- destructive/large plan goes `awaiting_approval` and no mutation task becomes runnable;
- AI architectural result compiles; invalid compiler output/unsupported material fails closed before task creation;
- BOM/supply expansion produces task branches for gather/craft/process/workstation/terrain/build/cleanup/verify;
- independent resource branches do not depend on each other unnecessarily;
- approved plan snapshot is immutable/versioned.

- [ ] **Step 2: Implement planner composition**

Do not place blocks or execute tasks. This service only creates authoritative plan/task records transactionally after validation/approval decision.

- [ ] **Step 3: Run tests/typecheck and commit**

```powershell
npm test -- tests/projects/project-planner.test.ts tests/construction/blueprint-compiler.test.ts tests/supply/planner.test.ts
npm run typecheck
```

```bash
git add src/projects/project-planner.ts tests/projects/project-planner.test.ts
git commit -m "feat: expand approved build plans into project tasks"
```

---

### Task 10: Production composition, startup recovery, and status surfaces

**Files:**
- Modify: `src/main.ts`
- Modify: `src/api/control-server.ts`
- Test: `tests/main-project-orchestration.test.ts`
- Test: `tests/api/control-server-project-status.test.ts`

**Interfaces:**
- Application creates/starts Project conversation controller, planner, orchestrator, recovery service, and project planning executor after existing runtime/routing services exist.
- `/v1/status` gains a bounded `projects` summary without private UUIDs/coordinates unless already authorized by local control design.

- [ ] **Step 1: Write RED composition tests**

Assert startup order:

```text
runtime connect -> project recovery -> orchestrator start -> control ready
```

and shutdown order aborts project work before runtime disconnect/repository close.

Status includes safe counts/status only, for example:

```ts
projects: {
  activeCount: number,
  waitingPlayerCount: number,
  recoveringCount: number,
  runningProjectId: string | null
}
```

- [ ] **Step 2: Implement startup recovery and lifecycle**

On spawn/start, scan nonterminal projects in this `worldKey`; set them recovering, reconcile, then wake resumable projects. Do not resume before Minecraft is spawned and world observations are available.

- [ ] **Step 3: Run full automated verification**

```powershell
npm test
npm run typecheck
```

Expected: PASS with no regression to current exact-tool action routing.

- [ ] **Step 4: Commit**

```bash
git add src/main.ts src/api/control-server.ts tests/main-project-orchestration.test.ts tests/api/control-server-project-status.test.ts
git commit -m "feat: run durable autonomous projects"
```

---

### Task 11: End-to-end private-server acceptance and soak

**Files:**
- Modify: this plan to append measured evidence.
- Add scenario fixtures/tests only if a discovered live regression needs a permanent reproduction.

- [ ] **Step 1: Validate short conversational house request**

Use a fresh safe test area and say a request equivalent to:

```text
墨雪，幫我蓋個房子
```

Verify one-question-at-a-time flow, deterministic answers do not call AI, ambiguous style/scale calls are bounded, owner UUID/default autonomy are correct, and the Project reaches an approved plan.

- [ ] **Step 2: Validate supply/tool/production chain**

Require at least one material that must be gathered, one that uses crafting, and one that uses processing/workstation/fuel. Give Moxue an appropriate tool and verify automatic equip. Confirm unauthorized nearby chest is not opened.

- [ ] **Step 3: Validate terrain/scaffold/construction**

Use a build needing limited CUT/FILL and at least one high placement. With shears + legal leaves + no explicit scaffold, verify leaves can be selected. Confirm temporary access is removed and useful infrastructure follows lifecycle policy.

- [ ] **Step 4: Validate multiplayer ACL/conflict**

With two human players:

- owner creates project;
- owner adds one manager/helper according to test case;
- unauthorized third-party command cannot mutate project;
- same-role contradictory instruction blocks only the affected scope;
- owner resolves conflict and branch resumes.

- [ ] **Step 5: Validate restart/offline-owner continuation**

Stop MC_AI_Player mid-build after a checkpoint, restart, verify `recovering` reconciles live blocks and resumes without duplicate destructive work. Then disconnect owner while an approved branch continues. Trigger a condition requiring new owner approval and confirm only affected branch waits.

- [ ] **Step 6: Validate safety interruption**

Observe at least one controlled hostile-mob/hunger interruption followed by task resume. Verify player is never targeted by combat runtime. Verify circuit breaker behavior via automated harness for repeated failure/death rather than risking an uncontrolled survival-world loop.

- [ ] **Step 7: Run required soak**

Run the existing/private-server soak harness for the release duration required by the project release gates (4-8 hours). During soak track disconnects, unbounded retry, AI call count, task queue growth, DB growth, memory/resource leaks, and unintended world mutation. Any discovered failure gets a deterministic regression test before re-running the affected validation.

- [ ] **Step 8: Final verification and evidence commit**

```powershell
npm test
npm run typecheck
git status --short
git log -10 --oneline
```

Append a table of PASS/FAIL evidence for every acceptance scenario, including commit SHA and Minecraft version, but no secrets/raw model reasoning/private API keys.

```bash
git add docs/superpowers/plans/2026-09-13-project-autonomy-phase5-orchestration-planning.md tests fixtures
git commit -m "docs: record autonomous project acceptance evidence"
```

Phase 5—and therefore the complete architecture—is release-ready only when automated tests/typecheck, short-dialog build, production chain, construction/scaffold cleanup, multiplayer ACL/conflict, restart recovery, offline-owner continuation, survival interruption/resume, and soak all pass. This does not authorize merging; merge still requires explicit user approval.
