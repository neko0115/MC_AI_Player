# Project Autonomy Phase 2: Project State, Identity, ACL, Drafts, and Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add authoritative durable project state with per-user autonomy defaults, UUID-bound ownership/collaboration, deterministic project resolution, durable conversational drafts, and explicit storage authorization.

**Architecture:** Create a dedicated `project-state.sqlite3` repository with narrow domain services above it. Keep privilege (`minecraft_owner`/`minecraft_operator`) separate from persistent player identity: an online-mode session UUID may own projects without receiving admin capabilities. Project selection and ACL are deterministic and happen before future AI planning.

**Tech Stack:** TypeScript 7, Node.js 24, Zod 4.5.4, better-sqlite3 12.11.1, node:test/tsx.

**Spec:** `docs/superpowers/specs/2026-09-13-project-autonomy-construction-design.md`

## Global Constraints

- Project state is stored in `data/project-state.sqlite3`, not memory/quota databases.
- Persistent user/project identity uses normalized UUID only in trusted online-mode sessions.
- Names are display snapshots, never authorization keys.
- User autonomy defaults are per world/server and copied into a project at creation time; later default changes do not mutate existing projects.
- Only project owner may change project autonomy.
- ACL filtering precedes proximity/recency project ranking.
- Nearby containers are unusable until explicitly registered and authorized.
- All repository writes that update more than one table run in a SQLite transaction.
- Database uses foreign keys, WAL for file-backed DBs, `busy_timeout=5000`, and `synchronous=NORMAL`, matching existing repository conventions.

---

## File structure

- Create `src/projects/contracts.ts` — shared schemas/domain types.
- Create `src/projects/repository.ts` — persistence interface.
- Create `src/projects/sqlite-repository.ts` — SQLite schema and implementation.
- Create `src/projects/access-policy.ts` — role/autonomy authorization.
- Create `src/projects/project-resolver.ts` — deterministic project selection.
- Create `src/projects/draft-service.ts` — durable one-question slot filling.
- Create `src/projects/storage-service.ts` — storage registration/access checks.
- Modify `src/minecraft/identity-registry.ts` — expose stable session identity without privilege elevation.
- Modify `src/minecraft/adapter.ts`, `src/minecraft/mineflayer-adapter.ts`, `src/minecraft/fake-adapter.ts` — looked-at container query.
- Modify `src/main.ts` — repository lifecycle only; no Project chat activation yet.
- Tests under `tests/projects/` plus identity/adapter/main regressions.

---

### Task 1: Define project contracts and invariants

**Files:**
- Create: `src/projects/contracts.ts`
- Test: `tests/projects/contracts.test.ts`

**Interfaces:**
- Produces every Phase 2 domain type used by later tasks.

- [ ] **Step 1: Write RED schema tests**

Create these schemas/types:

```ts
export const AutonomyModeSchema = z.enum(['safe', 'aggressive', 'fully_autonomous'])
export type AutonomyMode = z.infer<typeof AutonomyModeSchema>

export const ProjectRoleSchema = z.enum(['owner', 'manager', 'helper'])
export type ProjectRole = z.infer<typeof ProjectRoleSchema>

export const ProjectStatusSchema = z.enum([
  'draft', 'planning', 'awaiting_approval', 'running', 'paused',
  'paused_waiting_player', 'paused_safety', 'recovering',
  'completed', 'failed', 'cancelled'
])
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>

export const DraftSlotStateSchema = z.enum(['unknown', 'explicit', 'inferred', 'delegated'])
export type DraftSlotState = z.infer<typeof DraftSlotStateSchema>

export type BuildDraftSlot = 'site' | 'materials' | 'scale' | 'style' | 'storage' | 'protected_area'
```

Define/validate normalized UUIDs as lowercase 32-hex strings and project/storage identifiers as non-empty <=128-character safe identifiers.

- [ ] **Step 2: Implement the shared records**

```ts
export interface PlayerIdentity {
  readonly playerUuid: string
  readonly playerName: string
}

export interface PlayerPreferenceRecord {
  readonly worldKey: string
  readonly playerUuid: string
  readonly defaultAutonomy: AutonomyMode
  readonly chatVerbosity: 'quiet' | 'normal'
  readonly updatedAt: number
}

export interface ProjectRecord {
  readonly projectId: string
  readonly worldKey: string
  readonly ownerUuid: string
  readonly name: string
  readonly projectType: string
  readonly status: ProjectStatus
  readonly autonomyMode: AutonomyMode
  readonly dimension: string | null
  readonly anchor: { readonly x: number; readonly y: number; readonly z: number } | null
  readonly approvalEnvelope: Readonly<Record<string, unknown>>
  readonly activePlanVersion: number | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastCheckpointAt: number | null
}

export interface ProjectMemberRecord {
  readonly projectId: string
  readonly playerUuid: string
  readonly role: ProjectRole
  readonly addedByUuid: string
  readonly createdAt: number
}

export interface DraftField<T> {
  readonly state: DraftSlotState
  readonly value: T | null
}

export interface BuildDraftState {
  readonly site: DraftField<{ x: number; y: number; z: number; dimension?: string }>
  readonly materials: DraftField<readonly string[]>
  readonly scale: DraftField<{ width?: number; depth?: number; height?: number; occupancy?: number; sizePreference?: string }>
  readonly style: DraftField<readonly string[]>
  readonly storage: DraftField<readonly string[]>
  readonly protected_area: DraftField<readonly string[]>
}

export interface BuildDraftRecord {
  readonly projectId: string
  readonly ownerUuid: string
  readonly state: BuildDraftState
  readonly pendingSlot: BuildDraftSlot | null
  readonly lastQuestionKind: BuildDraftSlot | null
  readonly status: 'collecting' | 'ready' | 'cancelled'
  readonly updatedAt: number
}

export type StorageSubjectType = 'player' | 'project' | 'server_public'
export type StorageAccessLevel = 'use'

export interface StorageRecord {
  readonly storageId: string
  readonly worldKey: string
  readonly ownerUuid: string
  readonly name: string
  readonly dimension: string
  readonly position: { readonly x: number; readonly y: number; readonly z: number }
  readonly containerKind: string
  readonly createdAt: number
  readonly updatedAt: number
}

export interface RegisterStorageInput {
  readonly worldKey: string
  readonly owner: PlayerIdentity
  readonly name: string
  readonly dimension: string
  readonly position: { readonly x: number; readonly y: number; readonly z: number }
  readonly containerKind: string
}

export interface StorageAccessRecord {
  readonly storageId: string
  readonly subjectType: StorageSubjectType
  readonly subjectId: string
  readonly accessLevel: StorageAccessLevel
  readonly grantedByUuid: string
  readonly createdAt: number
}

export interface ProjectAuditInput {
  readonly projectId: string
  readonly actorUuid: string
  readonly actorRole: ProjectRole
  readonly action: string
  readonly safeSummary: string
}

export interface ProjectAuditRecord extends ProjectAuditInput {
  readonly eventId: string
  readonly createdAt: number
}
```

- [ ] **Step 3: Run RED/GREEN verification**

```powershell
npm test -- tests/projects/contracts.test.ts
npm run typecheck
```

Expected after implementation: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/projects/contracts.ts tests/projects/contracts.test.ts
git commit -m "feat: define durable project contracts"
```

---

### Task 2: Create the dedicated SQLite project repository

**Files:**
- Create: `src/projects/repository.ts`
- Create: `src/projects/sqlite-repository.ts`
- Test: `tests/projects/sqlite-repository.test.ts`

**Interfaces:**
- Consumes Task 1 types.
- Produces `ProjectRepository`/`SqliteProjectRepository`.

- [ ] **Step 1: Write RED persistence tests**

Use `:memory:` and cover preferences, project+owner-membership transaction, members, drafts, storage ACL, audit, restart reload, close behavior, and foreign-key behavior.

Repository contract:

```ts
export interface CreateProjectInput {
  readonly worldKey: string
  readonly owner: PlayerIdentity
  readonly name: string
  readonly projectType: string
  readonly autonomyMode: AutonomyMode
  readonly dimension?: string
  readonly anchor?: { x: number; y: number; z: number }
}

export interface ProjectRepository {
  getPlayerPreference(worldKey: string, playerUuid: string): PlayerPreferenceRecord | null
  setPlayerPreference(input: Omit<PlayerPreferenceRecord, 'updatedAt'>): PlayerPreferenceRecord
  createProject(input: CreateProjectInput): ProjectRecord
  getProject(projectId: string): ProjectRecord | null
  listProjectsForPlayer(worldKey: string, playerUuid: string): ProjectRecord[]
  updateProjectAutonomy(projectId: string, autonomyMode: AutonomyMode, actorUuid: string): ProjectRecord
  setProjectStatus(projectId: string, status: ProjectStatus): ProjectRecord
  listMembers(projectId: string): ProjectMemberRecord[]
  upsertMember(projectId: string, playerUuid: string, role: Exclude<ProjectRole, 'owner'>, addedByUuid: string): ProjectMemberRecord
  removeMember(projectId: string, playerUuid: string): boolean
  saveDraft(record: BuildDraftRecord): BuildDraftRecord
  getDraft(projectId: string): BuildDraftRecord | null
  registerStorage(input: RegisterStorageInput): StorageRecord
  getStorage(storageId: string): StorageRecord | null
  grantStorageAccess(input: Omit<StorageAccessRecord, 'createdAt'>): StorageAccessRecord
  revokeStorageAccess(storageId: string, subjectType: StorageSubjectType, subjectId: string): boolean
  listStorageAccess(storageId: string): StorageAccessRecord[]
  appendAudit(input: ProjectAuditInput): ProjectAuditRecord
  close(): void
}
```

- [ ] **Step 2: Run RED**

```powershell
npm test -- tests/projects/sqlite-repository.test.ts
```

- [ ] **Step 3: Implement database configuration/schema**

Use schema key `project_schema_version=1`. Create `players`, `player_preferences`, `projects`, `project_members`, `build_drafts`, `storages`, `storage_access`, `project_audit_log`. Configure `foreign_keys=ON`, `busy_timeout=5000`, `synchronous=NORMAL`, file-backed `journal_mode=WAL`.

`createProject()` transactionally upserts the player snapshot, inserts the project, and inserts the owner membership. JSON fields are parsed through Zod/domain normalizers when loaded.

- [ ] **Step 4: Verify and commit**

```powershell
npm test -- tests/projects/sqlite-repository.test.ts
npm run typecheck
```

```bash
git add src/projects/repository.ts src/projects/sqlite-repository.ts tests/projects/sqlite-repository.test.ts
git commit -m "feat: persist project ownership and preferences"
```

---

### Task 3: Expose persistent session identity without granting admin privilege

**Files:**
- Modify: `src/minecraft/identity-registry.ts`
- Test: `tests/minecraft/identity-registry.test.ts`

**Interfaces:**

```ts
resolveSessionPlayer(input: {
  mode: MinecraftServerIdentityMode
  player: string
  playerId?: string
}): PlayerIdentity | null
```

- [ ] **Step 1: Write RED tests**

Online/current cached UUID match returns normalized identity; offline mode, stale UUID, or unseen player returns null. Assert this does not grant manual-deep/reserve capabilities.

- [ ] **Step 2: Implement using the existing session cache**

Do not change `resolveChat()` privilege semantics. Return a frozen `{ playerUuid, playerName }` only after current-session online-mode verification.

- [ ] **Step 3: Verify and commit**

```powershell
npm test -- tests/minecraft/identity-registry.test.ts
npm run typecheck
```

```bash
git add src/minecraft/identity-registry.ts tests/minecraft/identity-registry.test.ts
git commit -m "feat: resolve persistent Minecraft player identity"
```

---

### Task 4: Implement project ACL and autonomy policy

**Files:**
- Create: `src/projects/access-policy.ts`
- Test: `tests/projects/access-policy.test.ts`

**Interfaces:**

```ts
export type ProjectAction =
  | 'view' | 'execute_task' | 'pause_resume' | 'edit_design'
  | 'manage_helpers' | 'manage_managers' | 'change_autonomy'
  | 'approve_high_risk' | 'transfer_owner' | 'cancel_project'

export interface ProjectAccessDecision {
  readonly allowed: boolean
  readonly role: ProjectRole | null
  readonly code: string
}

export function authorizeProjectAction(
  project: ProjectRecord,
  members: readonly ProjectMemberRecord[],
  actorUuid: string,
  action: ProjectAction
): ProjectAccessDecision

export function clampAutonomyToServerCeiling(
  requested: AutonomyMode,
  ceiling: AutonomyMode
): AutonomyMode
```

- [ ] **Step 1: Write the permission matrix RED tests**

Owner: all actions. Manager: view/execute/pause/edit/manage_helpers; deny manager management/autonomy/high-risk approval/ownership transfer/cancel. Helper: view/execute only at project level. Non-member: deny project-private access/mutation. Test ordering `safe < aggressive < fully_autonomous`.

- [ ] **Step 2: Implement explicit role action sets**

Use explicit sets, not numeric privilege comparison.

- [ ] **Step 3: Verify and commit**

```powershell
npm test -- tests/projects/access-policy.test.ts
npm run typecheck
```

```bash
git add src/projects/access-policy.ts tests/projects/access-policy.test.ts
git commit -m "feat: enforce project collaboration roles"
```

---

### Task 5: Implement deterministic project resolution

**Files:**
- Create: `src/projects/project-resolver.ts`
- Test: `tests/projects/project-resolver.test.ts`

**Interfaces:**

```ts
export type ProjectResolution =
  | { readonly kind: 'resolved'; readonly project: ProjectRecord; readonly reason: 'explicit' | 'conversation' | 'nearby' | 'recent' }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly ProjectRecord[] }
  | { readonly kind: 'none' }

export function resolveProject(input: {
  readonly projects: readonly ProjectRecord[]
  readonly explicitName?: string
  readonly conversationProjectId?: string
  readonly playerPosition?: { x: number; y: number; z: number }
  readonly recentProjectId?: string
  readonly nearbyRadius?: number
}): ProjectResolution
```

- [ ] **Step 1: Write RED precedence tests**

Explicit > conversation > unique nearby > unique recent > ambiguous/none. Duplicate explicit names are ambiguous, never last-write-wins. Caller supplies ACL-authorized projects only.

- [ ] **Step 2: Implement**

Default `nearbyRadius=32`; squared Euclidean distance; projects without anchors are excluded from proximity ranking.

- [ ] **Step 3: Verify and commit**

```powershell
npm test -- tests/projects/project-resolver.test.ts
npm run typecheck
```

```bash
git add src/projects/project-resolver.ts tests/projects/project-resolver.test.ts
git commit -m "feat: resolve authorized projects deterministically"
```

---

### Task 6: Add durable BuildIntentDraft slot filling

**Files:**
- Create: `src/projects/draft-service.ts`
- Test: `tests/projects/draft-service.test.ts`

**Interfaces:**

```ts
export interface DraftParseContext {
  readonly playerPosition?: { x: number; y: number; z: number }
  readonly pendingSlot: BuildDraftSlot
}

export type DraftAnswerResult =
  | { readonly kind: 'updated'; readonly draft: BuildDraftRecord }
  | { readonly kind: 'needs_semantic_ai'; readonly slot: BuildDraftSlot; readonly answer: string }
  | { readonly kind: 'invalid'; readonly code: string }
```

- [ ] **Step 1: Write RED answer tests**

`就在這裡` -> explicit current position; `10x8，高6格` -> explicit scale; `附近好取得的就好` -> delegated material sourcing; `你自己決定` -> current slot delegated/null; material token list -> explicit tokens; ambiguous prose -> `needs_semantic_ai`; delegated slots stay skipped after reload.

- [ ] **Step 2: Implement deterministic parser and order**

```ts
const BUILD_SLOT_ORDER: readonly BuildDraftSlot[] = [
  'site', 'scale', 'materials', 'style', 'storage', 'protected_area'
]
```

Do not call Gemini in Phase 2.

- [ ] **Step 3: Verify and commit**

```powershell
npm test -- tests/projects/draft-service.test.ts tests/projects/sqlite-repository.test.ts
npm run typecheck
```

```bash
git add src/projects/draft-service.ts tests/projects/draft-service.test.ts
git commit -m "feat: persist conversational build drafts"
```

---

### Task 7: Add looked-at container resolution and storage ACL service

**Files:**
- Modify: `src/minecraft/adapter.ts`
- Modify: `src/minecraft/mineflayer-adapter.ts`
- Modify: `src/minecraft/fake-adapter.ts`
- Create: `src/projects/storage-service.ts`
- Test: `tests/minecraft/mineflayer-adapter.test.ts`
- Test: `tests/projects/storage-service.test.ts`

**Interfaces:**

```ts
export interface LookedAtContainer {
  readonly dimension: string
  readonly position: Position
  readonly blockName: string
}

lookedAtContainer(maxDistance: number): Promise<LookedAtContainer | null>

export class StorageService {
  register(input: RegisterStorageInput, projectId?: string): StorageRecord
  canUseStorage(storageId: string, actorUuid: string, projectId?: string): boolean
}
```

- [ ] **Step 1: Write RED raycast tests**

`bot.blockAtCursor(maxDistance)` returning chest/barrel/furnace becomes a candidate; ordinary blocks return null. Distance must be 1..8; no ready bot returns null.

- [ ] **Step 2: Implement adapter query**

Query identifies only; it does not authorize.

- [ ] **Step 3: Write RED storage ACL tests**

Player grant, project grant, server-public grant allow access; unregistered/nearby-only storage denies; revocation denies immediately; world/dimension coordinates do not alias.

- [ ] **Step 4: Implement StorageService**

Registration persists owner/position/kind and optional project grant. `canUseStorage()` reads explicit ACL records only.

- [ ] **Step 5: Verify and commit**

```powershell
npm test -- tests/minecraft/mineflayer-adapter.test.ts tests/projects/storage-service.test.ts tests/projects/sqlite-repository.test.ts
npm test
npm run typecheck
```

```bash
git add src/minecraft/adapter.ts src/minecraft/mineflayer-adapter.ts src/minecraft/fake-adapter.ts src/projects/storage-service.ts tests/minecraft/mineflayer-adapter.test.ts tests/projects/storage-service.test.ts
git commit -m "feat: register and authorize project storage"
```

---

### Task 8: Bootstrap project state without changing current action semantics

**Files:**
- Modify: `src/main.ts`
- Test: `tests/main-project-state.test.ts`

**Interfaces:**

```ts
const DEFAULT_PROJECT_STATE_PATH = 'data/project-state.sqlite3'
```

Extend `ApplicationDependencies` with:

```ts
readonly createProjectRepository?: (filename: string) => ProjectRepository
```

- [ ] **Step 1: Write RED lifecycle tests**

Repository created once, uses default filename, closes once including repeated close, startup failure closes it, and current stay/follow/gather path remains unchanged.

- [ ] **Step 2: Implement lifecycle wiring only**

Do not route chat into project creation yet; Phase 5 owns that integration.

- [ ] **Step 3: Run full verification**

```powershell
npm test
npm run typecheck
git status --short
```

- [ ] **Step 4: Commit**

```bash
git add src/main.ts tests/main-project-state.test.ts
git commit -m "feat: bootstrap durable project state"
```

Phase 2 is complete when per-user autonomy isolation, project ACL, durable drafts, deterministic resolution, explicit storage authorization, repository restart tests, full suite, and typecheck all pass.
