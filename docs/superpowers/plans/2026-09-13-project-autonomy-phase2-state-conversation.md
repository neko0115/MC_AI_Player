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

- Create `src/projects/contracts.ts` — Zod schemas/domain types for autonomy, projects, roles, drafts, storage.
- Create `src/projects/repository.ts` — persistence interface.
- Create `src/projects/sqlite-repository.ts` — SQLite schema/migrations and implementation.
- Create `src/projects/access-policy.ts` — owner/manager/helper permissions and autonomy ceiling checks.
- Create `src/projects/project-resolver.ts` — deterministic explicit/context/nearby/recent resolution.
- Create `src/projects/draft-service.ts` — durable slot state and deterministic short-answer parsing.
- Create `src/projects/storage-service.ts` — storage registration/access checks.
- Modify `src/minecraft/identity-registry.ts` — expose persistent current-session player identity without elevating capabilities.
- Modify `src/minecraft/adapter.ts`, `src/minecraft/mineflayer-adapter.ts`, `src/minecraft/fake-adapter.ts` — add looked-at container query used only for registration/disambiguation.
- Modify `src/main.ts` — bootstrap/close project repository and expose services for later phases without changing normal one-action behavior.
- Tests under `tests/projects/` and identity/adapter regression tests.

---

### Task 1: Define project contracts and invariants

**Files:**
- Create: `src/projects/contracts.ts`
- Test: `tests/projects/contracts.test.ts`

**Interfaces:**
- Produces exact shared types for all later Phase 2 tasks.

- [ ] **Step 1: Write RED schema tests**

Cover normalization/validation for:

```ts
export const AutonomyModeSchema = z.enum(['safe', 'aggressive', 'fully_autonomous'])
export const ProjectRoleSchema = z.enum(['owner', 'manager', 'helper'])
export const ProjectStatusSchema = z.enum([
  'draft',
  'planning',
  'awaiting_approval',
  'running',
  'paused',
  'paused_waiting_player',
  'paused_safety',
  'recovering',
  'completed',
  'failed',
  'cancelled'
])
export const DraftSlotStateSchema = z.enum(['unknown', 'explicit', 'inferred', 'delegated'])
```

Define/validate normalized UUIDs as lowercase 32-hex strings and project/storage identifiers as non-empty <=128-character safe identifiers.

Test that invalid autonomy/role/status/UUID is rejected.

- [ ] **Step 2: Run RED**

```powershell
npm test -- tests/projects/contracts.test.ts
```

Expected: module missing.

- [ ] **Step 3: Implement domain types**

Include:

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
```

Draft field wrapper:

```ts
export interface DraftField<T> {
  readonly state: DraftSlotState
  readonly value: T | null
}
```

Storage:

```ts
export type StorageSubjectType = 'player' | 'project' | 'server_public'
export type StorageAccessLevel = 'use'
```

- [ ] **Step 4: Run tests/typecheck**

```powershell
npm test -- tests/projects/contracts.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

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
- Modify: `.gitignore` only if `data/` is no longer already ignored; do not weaken existing ignore coverage.

**Interfaces:**
- Consumes: Task 1 types.
- Produces `ProjectRepository` and `SqliteProjectRepository`.

- [ ] **Step 1: Write RED persistence tests**

Use `:memory:` and cover:

- get/set user preference by `(worldKey, playerUuid)`;
- create project copies supplied autonomy and owner membership atomically;
- add/update/remove member respecting unique `(projectId, playerUuid)`;
- store/load build draft JSON + `pendingSlot`;
- register storage and grant/revoke access;
- append/read audit entries;
- close rejects later calls;
- foreign-key deletion behavior is explicit and tested.

Repository interface:

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
  grantStorageAccess(input: StorageAccessRecord): StorageAccessRecord
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

Expected: modules missing.

- [ ] **Step 3: Implement SQLite configuration and schema**

Create schema version key `project_schema_version=1` and tables:

```sql
CREATE TABLE IF NOT EXISTS players (
  player_uuid TEXT PRIMARY KEY,
  last_known_name TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS player_preferences (
  world_key TEXT NOT NULL,
  player_uuid TEXT NOT NULL,
  default_autonomy TEXT NOT NULL,
  chat_verbosity TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (world_key, player_uuid),
  FOREIGN KEY (player_uuid) REFERENCES players(player_uuid)
);

CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  world_key TEXT NOT NULL,
  owner_uuid TEXT NOT NULL,
  name TEXT NOT NULL,
  project_type TEXT NOT NULL,
  status TEXT NOT NULL,
  autonomy_mode TEXT NOT NULL,
  dimension TEXT,
  anchor_x REAL,
  anchor_y REAL,
  anchor_z REAL,
  approval_envelope_json TEXT NOT NULL,
  active_plan_version INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_checkpoint_at INTEGER,
  FOREIGN KEY (owner_uuid) REFERENCES players(player_uuid)
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL,
  player_uuid TEXT NOT NULL,
  role TEXT NOT NULL,
  added_by_uuid TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, player_uuid),
  FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE,
  FOREIGN KEY (player_uuid) REFERENCES players(player_uuid)
);
```

Also create `build_drafts`, `storages`, `storage_access`, `project_audit_log` with foreign keys and JSON text fields. Parse every row back through Zod/domain normalizers rather than trusting SQLite strings.

- [ ] **Step 4: Make project creation transactional**

`createProject()` must upsert the player snapshot, insert the project, and insert the owner membership in one transaction. Reject duplicate project IDs/names within the same owner/world only according to explicitly tested uniqueness rules; do not impose global name uniqueness.

- [ ] **Step 5: Run tests/typecheck**

```powershell
npm test -- tests/projects/sqlite-repository.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

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
- Consumes: current online-mode session player cache.
- Produces:

```ts
resolveSessionPlayer(input: {
  mode: MinecraftServerIdentityMode
  player: string
  playerId?: string
}): PlayerIdentity | null
```

- [ ] **Step 1: Write RED tests**

Test:

- online mode + current cached UUID match -> returns normalized UUID/name;
- offline mode -> `null`;
- stale/mismatched UUID -> `null`;
- player not observed in current session -> `null`;
- returned identity does not gain `manual_deep_think` or `flash_reserve_access` merely because it is valid.

- [ ] **Step 2: Run RED**

```powershell
npm test -- tests/minecraft/identity-registry.test.ts
```

Expected: method missing.

- [ ] **Step 3: Implement using existing normalization/cache rules**

Do not change `resolveChat()` semantics. `resolveSessionPlayer()` validates only persistent identity, returning a frozen object:

```ts
return Object.freeze({ playerUuid: currentId, playerName: player })
```

- [ ] **Step 4: Run tests/typecheck and commit**

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
- Consumes: `ProjectRecord`, membership list, actor UUID.
- Produces:

```ts
export type ProjectAction =
  | 'view'
  | 'execute_task'
  | 'pause_resume'
  | 'edit_design'
  | 'manage_helpers'
  | 'manage_managers'
  | 'change_autonomy'
  | 'approve_high_risk'
  | 'transfer_owner'
  | 'cancel_project'

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
```

- [ ] **Step 1: Write the permission-matrix RED tests**

Assert:

- owner: all actions;
- manager: view/execute/pause/edit/manage_helpers; deny manage_managers/change_autonomy/approve_high_risk/transfer_owner/cancel unless spec says owner only;
- helper: view/execute; can pause only their active work at orchestration layer, so generic project pause is denied here;
- non-member: deny all mutation and project-private view.

Add autonomy ceiling helper:

```ts
export function clampAutonomyToServerCeiling(
  requested: AutonomyMode,
  ceiling: AutonomyMode
): AutonomyMode
```

with ordering `safe < aggressive < fully_autonomous`.

- [ ] **Step 2: Run RED**

```powershell
npm test -- tests/projects/access-policy.test.ts
```

- [ ] **Step 3: Implement exact matrix and ceiling function**

Use explicit sets per role rather than numeric role comparison so privilege changes stay reviewable.

- [ ] **Step 4: Run tests/typecheck and commit**

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
- Consumes: authorized projects, explicit alias/name, conversation-bound project ID, player position, recent project ID.
- Produces:

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

Cover explicit > conversation > unique nearby > unique recent > ambiguous/none. Ensure caller supplies only ACL-authorized projects; add a guard test that duplicate name aliases produce `ambiguous`, never last-write-wins.

- [ ] **Step 2: Run RED**

```powershell
npm test -- tests/projects/project-resolver.test.ts
```

- [ ] **Step 3: Implement deterministic distance/name normalization**

Default `nearbyRadius = 32`. Distance is squared Euclidean distance from project anchor. Projects without anchors are excluded from proximity selection.

- [ ] **Step 4: Run tests/typecheck and commit**

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
- Consumes: repository draft persistence, current pending slot, player answer, deterministic context.
- Produces:

```ts
export type BuildDraftSlot = 'site' | 'materials' | 'scale' | 'style' | 'storage' | 'protected_area'

export interface DraftParseContext {
  readonly playerPosition?: { x: number; y: number; z: number }
  readonly pendingSlot: BuildDraftSlot
}

export type DraftAnswerResult =
  | { readonly kind: 'updated'; readonly draft: BuildDraftRecord }
  | { readonly kind: 'needs_semantic_ai'; readonly slot: BuildDraftSlot; readonly answer: string }
  | { readonly kind: 'invalid'; readonly code: string }
```

- [ ] **Step 1: Write RED deterministic-answer tests**

Cover:

- `就在這裡` while pending `site` -> explicit current position;
- `10x8，高6格` while pending `scale` -> explicit dimensions;
- `附近好取得的就好` for materials -> delegated sourcing;
- `你自己決定` -> current slot state `delegated` with `value=null`;
- `木頭、玻璃、原木、地毯` -> explicit normalized token list without inventing block IDs;
- ambiguous prose such as `兩個人住舒服一點，不要太大` -> `needs_semantic_ai`;
- delegated slots are skipped by `nextQuestionSlot()` after reload.

- [ ] **Step 2: Run RED**

```powershell
npm test -- tests/projects/draft-service.test.ts
```

- [ ] **Step 3: Implement parser and next-slot order**

Use deterministic question order:

```ts
const BUILD_SLOT_ORDER: readonly BuildDraftSlot[] = [
  'site',
  'scale',
  'materials',
  'style',
  'storage',
  'protected_area'
]
```

`nextQuestionSlot()` returns the first `unknown` material slot and ignores `explicit`, `inferred`, and `delegated`.

Do not call Gemini in Phase 2; return `needs_semantic_ai` for Phase 5 integration.

- [ ] **Step 4: Run tests/typecheck and commit**

```powershell
npm test -- tests/projects/draft-service.test.ts tests/projects/sqlite-repository.test.ts
npm run typecheck
```

```bash
git add src/projects/draft-service.ts tests/projects/draft-service.test.ts
git commit -m "feat: persist conversational build drafts"
```

---

### Task 7: Add looked-at container resolution and explicit storage ACL service

**Files:**
- Modify: `src/minecraft/adapter.ts`
- Modify: `src/minecraft/mineflayer-adapter.ts`
- Modify: `src/minecraft/fake-adapter.ts`
- Create: `src/projects/storage-service.ts`
- Test: `tests/minecraft/mineflayer-adapter.test.ts`
- Test: `tests/projects/storage-service.test.ts`

**Interfaces:**
- Produces adapter query:

```ts
export interface LookedAtContainer {
  readonly dimension: string
  readonly position: Position
  readonly blockName: string
}

lookedAtContainer(maxDistance: number): Promise<LookedAtContainer | null>
```

- Produces storage policy:

```ts
canUseStorage(storageId: string, actorUuid: string, projectId?: string): boolean
```

- [ ] **Step 1: Write RED raycast tests**

Fake `bot.blockAtCursor(maxDistance)` returns a chest/barrel/furnace versus ordinary block. Assert only recognized container blocks are returned, coordinates are finite, distance must be `1..8`, and no ready bot returns `null`.

- [ ] **Step 2: Implement adapter query**

Use `bot.blockAtCursor(maxDistance)` and an explicit allowed container block set for registration. The method only identifies a candidate; it does not authorize access.

- [ ] **Step 3: Write RED storage ACL tests**

Cover:

- owner player grant -> allowed;
- project grant -> any authorized executor acting for that project may use it;
- `server_public` -> allowed under that record;
- nearby/unregistered storage -> denied;
- revocation immediately denies;
- same coordinates in different world/dimension do not alias.

- [ ] **Step 4: Implement `StorageService`**

Registration requires actor identity and looked-at/selected position. `StorageService.register()` persists owner UUID/name and can optionally grant the creating project. `canUseStorage()` reads explicit ACL records only; it never infers permission from proximity.

- [ ] **Step 5: Run focused/full tests and commit**

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

### Task 8: Bootstrap project state in the application without changing normal action semantics

**Files:**
- Modify: `src/main.ts`
- Test: `tests/main-project-state.test.ts`

**Interfaces:**
- Consumes: `SqliteProjectRepository` and Phase 2 services.
- Produces: application-owned repository lifetime and future dependency injection seam.

- [ ] **Step 1: Write RED bootstrap tests**

Inject a fake `createProjectRepository(filename)` dependency and assert:

- default filename is `data/project-state.sqlite3`;
- repository is constructed exactly once;
- it closes exactly once on application close, including repeated close;
- startup failure closes project repository along with existing resources;
- normal stay/follow/gather action path remains unchanged.

- [ ] **Step 2: Run RED**

```powershell
npm test -- tests/main-project-state.test.ts
```

- [ ] **Step 3: Add dependency/lifecycle wiring**

Add:

```ts
const DEFAULT_PROJECT_STATE_PATH = 'data/project-state.sqlite3'
```

Extend `ApplicationDependencies` with:

```ts
readonly createProjectRepository?: (filename: string) => ProjectRepository
```

Create the repository after memory/runtime bootstrap, close it during application shutdown, and do not yet route chat into project creation. This keeps Phase 2 behavior inert until Phase 5 orchestration is connected.

- [ ] **Step 4: Run full verification**

```powershell
npm test
npm run typecheck
git status --short
```

Expected: PASS, with existing live action behavior unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts tests/main-project-state.test.ts
git commit -m "feat: bootstrap durable project state"
```

Phase 2 is complete when per-user autonomy isolation, project ACL, durable drafts, deterministic resolution, explicit storage authorization, repository restart tests, full suite, and typecheck all pass.
