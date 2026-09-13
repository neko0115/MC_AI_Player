# Project Autonomy Phase 4: Blueprint, Terrain, Construction, and Survival Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a survival-valid deterministic construction runtime that compiles constrained plans into exact blocks, prepares terrain, reaches high placements with tracked temporary access, mutates the world only through purpose-specific permits, survives ordinary hazards, and safely cleans up/reconciles project mutations.

**Architecture:** Introduce pure blueprint/site/terrain/reachability planners above a narrow Mineflayer construction runtime. Every break/place operation carries a purpose-specific permit issued by `SafetyPolicy`; provenance/checkpoints are written to Project DB. A separate Survival Supervisor may suspend and resume construction for hunger, health, hostile mobs, inventory/tool pressure, or death without allowing AI to micromanage combat or placement.

**Tech Stack:** TypeScript 7, Node.js 24, Mineflayer 4.39, mineflayer-pathfinder 2.4.5, better-sqlite3 12.11.1, Zod 4.5.4, node:test/tsx.

**Spec:** `docs/superpowers/specs/2026-09-13-project-autonomy-construction-design.md`

## Global Constraints

- Generic navigation remains unable to dig/place.
- Build/terrain mutation requires unforgeable purpose-specific permits issued by `SafetyPolicy`.
- Suspected player content is protected by default.
- Construction behaves like a Survival player: legal reach, support, orientation, inventory, and path access matter.
- Temporary access blocks are provenance-tracked and verified against live world state before cleanup.
- Local placement/path/material failures use deterministic recovery before any later AI replan.
- PvP stays hard-disabled; hostile-mob handling never targets players.
- `fully_autonomous` changes policy tolerance, not hard safety or retry/death caps.
- World is authoritative during recovery; persisted provenance never authorizes blind deletion.

---

## File structure

- Create `src/construction/contracts.ts` — architectural primitives, exact blueprint, mutation purposes.
- Create `src/construction/blueprint-compiler.ts` — pure constrained primitive -> exact block compiler + BOM.
- Create `src/construction/site-survey.ts` — classify live positions against blueprint/project provenance.
- Create `src/construction/terrain-planner.ts` — CUT/FILL/SHAPE operations.
- Create `src/construction/reachability.ts` — legal stance/access/scaffold planning.
- Create `src/construction/scaffold-policy.ts` — deterministic scaffold candidate ranking, including leaves+shears policy.
- Create `src/construction/executor.ts` — batch execution/local recovery/checkpointing/cleanup.
- Create `src/minecraft/construction.ts` — construction runtime interfaces.
- Create `src/minecraft/mineflayer-construction.ts` — actual observe/place/break/hostile query implementation.
- Modify `src/minecraft/runtime-bundle.ts` — expose construction runtime.
- Modify `src/safety/policy.ts` — build/terrain permits and project hard boundaries.
- Extend `src/projects/repository.ts`/`sqlite-repository.ts` — plan versions, infrastructure, mutation journal, checkpoints.
- Create `src/safety/survival-supervisor.ts` — suspension/resume decisions.
- Create `src/safety/combat-policy.ts` — deterministic hostile-mob response and weapon ranking.
- Create `src/minecraft/combat.ts` and `src/minecraft/mineflayer-combat.ts` — bounded combat/retreat runtime.
- Tests under `tests/construction/`, `tests/safety/`, `tests/minecraft/`, `tests/projects/`.

---

### Task 1: Define constrained blueprint contracts and compile exact blocks/BOM

**Files:**
- Create: `src/construction/contracts.ts`
- Create: `src/construction/blueprint-compiler.ts`
- Test: `tests/construction/blueprint-compiler.test.ts`

**Interfaces:**
- Produces:

```ts
export interface BlueprintBlock {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly block: string
  readonly state: Readonly<Record<string, string | number | boolean>>
  readonly purpose: 'structural' | 'functional' | 'decorative'
}

export interface ExactBlueprint {
  readonly version: 1
  readonly origin: Position
  readonly blocks: readonly BlueprintBlock[]
  readonly bounds: { min: Position; max: Position }
  readonly bom: Readonly<Record<string, number>>
}
```

Architectural primitives include `foundation`, `floor`, `wall`, `opening`, `window`, `door`, `pillar`, `beam`, `roof`, `stairs`, `interior_zone`, `workstation_zone`, `storage_zone`.

- [ ] **Step 1: Write RED compiler tests**

Cover a 5x5 one-room fixture: walls respect door/window openings, roof/floor coordinates are deterministic, duplicate coordinate writes are rejected unless explicitly identical, BOM exactly matches compiled blocks, stair/door state is explicit, bounds are correct, and impossible negative/zero dimensions are rejected.

- [ ] **Step 2: Run RED**

```powershell
npm test -- tests/construction/blueprint-compiler.test.ts
```

- [ ] **Step 3: Implement pure compiler**

No Mineflayer access. Sort output blocks by deterministic `(y, x, z, block)` for stable tests, but do not use this ordering as construction sequence.

- [ ] **Step 4: Run tests/typecheck and commit**

```powershell
npm test -- tests/construction/blueprint-compiler.test.ts
npm run typecheck
```

```bash
git add src/construction/contracts.ts src/construction/blueprint-compiler.ts tests/construction/blueprint-compiler.test.ts
git commit -m "feat: compile constrained building blueprints"
```

---

### Task 2: Add build/terrain permits to SafetyPolicy

**Files:**
- Modify: `src/safety/policy.ts`
- Test: `tests/safety/construction-permits.test.ts`
- Test: `tests/safety/policy.test.ts`

**Interfaces:**
- Produces opaque permit types:

```ts
export interface BuildMutationPermit {
  readonly mutateBlocks: true
  readonly projectId: string
  readonly planVersion: number
  readonly allowedRegion: { readonly min: Position; readonly max: Position }
  readonly allowedPlaceBlocks: readonly string[]
}

export interface TerrainMutationPermit {
  readonly mutateBlocks: true
  readonly projectId: string
  readonly allowedRegion: { readonly min: Position; readonly max: Position }
  readonly allowedBreakBlocks: readonly string[]
  readonly allowedFillBlocks: readonly string[]
}
```

And guards `isBuildMutationPermit()` / `isTerrainMutationPermit()` backed by private WeakSets like existing resource permits.

- [ ] **Step 1: Write RED permit tests**

Assert forged structural lookalikes fail guard; invalid region/order/wildcard block names fail closed; disconnected/unspawned state denies; generic gathering skill cannot obtain build permit; PvP remains denied.

- [ ] **Step 2: Implement issue methods**

Add:

```ts
issueBuildMutationPermit(...): BuildMutationDecision
issueTerrainMutationPermit(...): TerrainMutationDecision
```

Require explicit internal skill names `construct_project` and `prepare_project_terrain` with declared `place_blocks`/`break_blocks` capabilities. Preserve current navigation/resource permit behavior.

- [ ] **Step 3: Run tests/full safety regressions and commit**

```powershell
npm test -- tests/safety/construction-permits.test.ts tests/safety/policy.test.ts tests/safety/resource-permit.test.ts
npm run typecheck
```

```bash
git add src/safety/policy.ts tests/safety/construction-permits.test.ts tests/safety/policy.test.ts
git commit -m "feat: authorize bounded project world mutation"
```

---

### Task 3: Add construction observation/place/break runtime

**Files:**
- Create: `src/minecraft/construction.ts`
- Create: `src/minecraft/mineflayer-construction.ts`
- Modify: `src/minecraft/runtime-bundle.ts`
- Test: `tests/minecraft/mineflayer-construction.test.ts`

**Interfaces:**

```ts
export interface ObservedBlock {
  readonly position: Position
  readonly name: string
  readonly state: Readonly<Record<string, string | number | boolean>>
}

export interface ConstructionRuntime {
  observeRegion(min: Position, max: Position): Promise<readonly ObservedBlock[]>
  currentPosition(): Position | null
  placeBlock(request: {
    target: Position
    block: string
    state: Readonly<Record<string, string | number | boolean>>
    reference: Position
    face: { x: number; y: number; z: number }
    permit: BuildMutationPermit
  }, signal: AbortSignal): Promise<SkillResult>
  breakBlock(request: {
    target: Position
    expectedBlock: string
    permit: TerrainMutationPermit | BuildMutationPermit
  }, signal: AbortSignal): Promise<SkillResult>
  isStandable(position: Position): Promise<boolean>
}
```

- [ ] **Step 1: Write RED runtime tests**

Assert permit guards, region bounds, expected-before block match, inventory block presence, legal reference/face, abort/disconnect cleanup, and no mutation on mismatched/forged permit. Record exact `bot.placeBlock` / `bot.dig` calls.

- [ ] **Step 2: Implement narrow Mineflayer runtime**

Runtime validates exact target/reference/permit and performs one world mutation only. It does not choose target, material, stance, route, or retry policy.

- [ ] **Step 3: Expose in runtime bundle and verify**

```powershell
npm test -- tests/minecraft/mineflayer-construction.test.ts
npm run typecheck
```

- [ ] **Step 4: Commit**

```bash
git add src/minecraft/construction.ts src/minecraft/mineflayer-construction.ts src/minecraft/runtime-bundle.ts tests/minecraft/mineflayer-construction.test.ts
git commit -m "feat: add bounded Mineflayer construction runtime"
```

---

### Task 4: Persist plans, infrastructure, block provenance, and checkpoints

**Files:**
- Modify: `src/projects/repository.ts`
- Modify: `src/projects/sqlite-repository.ts`
- Test: `tests/projects/construction-state.test.ts`
- Test: `tests/projects/sqlite-repository.test.ts`

**Interfaces:**
- Adds repository methods for `project_plan_versions`, `project_infrastructure`, `block_mutations`, `project_checkpoints`.

- [ ] **Step 1: Write RED persistence tests**

Cover immutable plan version numbering, active plan version update, temporary/persistent infrastructure lifecycle, mutation records with operation/purpose/expected/result, checkpoint append/read, and restart reload.

Mutation record contract:

```ts
export interface BlockMutationRecord {
  readonly mutationId: string
  readonly projectId: string
  readonly taskId: string
  readonly planVersion: number
  readonly dimension: string
  readonly position: Position
  readonly operation: 'place' | 'break' | 'replace'
  readonly expectedBefore: string | null
  readonly resultAfter: string | null
  readonly purpose: 'build' | 'terrain' | 'scaffold' | 'temporary_bridge' | 'work_platform' | 'temporary_lighting'
  readonly temporary: boolean
  readonly createdAt: number
}
```

- [ ] **Step 2: Add schema/indexes and repository methods**

Index mutations by `(project_id, dimension, x, y, z)` and infrastructure by project/lifecycle. Do not cascade-delete completed audit/provenance accidentally; test chosen retention semantics.

- [ ] **Step 3: Run tests/typecheck and commit**

```powershell
npm test -- tests/projects/construction-state.test.ts tests/projects/sqlite-repository.test.ts
npm run typecheck
```

```bash
git add src/projects/repository.ts src/projects/sqlite-repository.ts tests/projects/construction-state.test.ts tests/projects/sqlite-repository.test.ts
git commit -m "feat: persist project construction provenance"
```

---

### Task 5: Implement site survey and natural/player-content classification

**Files:**
- Create: `src/construction/site-survey.ts`
- Test: `tests/construction/site-survey.test.ts`

**Interfaces:**

```ts
export type SiteCellClass =
  | 'air'
  | 'replaceable'
  | 'natural_terrain'
  | 'liquid'
  | 'known_project_block'
  | 'temporary_project_block'
  | 'suspected_player_content'
  | 'protected'
  | 'unknown'

export interface SiteSurveyCell {
  readonly position: Position
  readonly observedBlock: string
  readonly classification: SiteCellClass
}
```

- [ ] **Step 1: Write RED classification tests**

Given live observation + project mutation provenance + explicit protected region + game facts, assert:

- matching project placement -> `known_project_block`;
- matching temporary provenance -> `temporary_project_block`;
- explicit protected position -> `protected`;
- container/redstone/door/glass/decorative pattern without project provenance -> `suspected_player_content`;
- ordinary dirt/stone/log natural candidates -> `natural_terrain` only when not attributed to a project/player structure;
- unknown/unsupported block -> `unknown`, never natural by default.

- [ ] **Step 2: Implement conservative classifier**

Do not infer ownership from block name alone. Provenance/protection wins before generic game-fact classification.

- [ ] **Step 3: Run tests/typecheck and commit**

```powershell
npm test -- tests/construction/site-survey.test.ts
npm run typecheck
```

```bash
git add src/construction/site-survey.ts tests/construction/site-survey.test.ts
git commit -m "feat: classify project construction sites"
```

---

### Task 6: Implement terrain planning and scaffold/reachability policy

**Files:**
- Create: `src/construction/terrain-planner.ts`
- Create: `src/construction/scaffold-policy.ts`
- Create: `src/construction/reachability.ts`
- Test: `tests/construction/terrain-planner.test.ts`
- Test: `tests/construction/scaffold-policy.test.ts`
- Test: `tests/construction/reachability.test.ts`

**Interfaces:**

```ts
export type TerrainOperation =
  | { readonly kind: 'cut'; readonly position: Position; readonly expectedBlock: string }
  | { readonly kind: 'fill'; readonly position: Position; readonly block: string }

export interface ScaffoldCandidate {
  readonly block: string
  readonly available: number
  readonly reusable: boolean
  readonly gravityAffected: boolean
  readonly acquisitionCost: number
  readonly cleanupCost: number
  readonly requiresShears: boolean
}
```

- [ ] **Step 1: Write RED terrain tests**

Cover CUT/FILL/SHAPE policy: protected/player cells never become operations; user-specified fill material wins when allowed; otherwise lowest policy cost legal material is chosen; gravity block over unsupported void is rejected.

- [ ] **Step 2: Write RED scaffold policy tests**

Assert priority:

1. explicit user material;
2. reusable low-value available material;
3. leaves when no explicit material + shears + legal source;
4. other safe candidates.

Leaves without shears are not preferred. Protected-source leaves are not candidates.

- [ ] **Step 3: Write RED reachability tests**

Given target block, current completed blueprint cells, standability callback, and available scaffold candidate, return a bounded access plan:

```ts
export interface AccessPlan {
  readonly stance: Position
  readonly temporaryPlacements: readonly { position: Position; block: string; purpose: 'scaffold' | 'work_platform' | 'temporary_bridge' }[]
  readonly cleanupPositions: readonly Position[]
}
```

Test direct reach, one-column scaffold, 2x2 work platform for high-risk edge, and no plan when required access would cross protected cells/budget.

- [ ] **Step 4: Implement pure planners and verify**

```powershell
npm test -- tests/construction/terrain-planner.test.ts tests/construction/scaffold-policy.test.ts tests/construction/reachability.test.ts
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/construction/terrain-planner.ts src/construction/scaffold-policy.ts src/construction/reachability.ts tests/construction
git commit -m "feat: plan terrain and temporary construction access"
```

---

### Task 7: Implement Construction Executor with local recovery/checkpoints/cleanup

**Files:**
- Create: `src/construction/executor.ts`
- Test: `tests/construction/executor.test.ts`

**Interfaces:**
- Consumes: exact blueprint, site survey, terrain/access plans, construction runtime, navigation, project repository, permits.
- Produces bounded batch results:

```ts
export type ConstructionBatchResult =
  | { readonly kind: 'progress'; readonly completed: number; readonly remaining: number }
  | { readonly kind: 'blocked'; readonly code: string; readonly affectedPositions: readonly Position[] }
  | { readonly kind: 'completed' }
```

- [ ] **Step 1: Write RED execution tests**

Cover:

- already-correct blocks are verified/marked complete without re-place;
- missing material blocks branch with `resource_shortage`;
- one placement failure triggers re-observe + alternate stance before blocking;
- temporary scaffold placements are journaled before/after mutation;
- checkpoint written after each bounded region/segment, not only project end;
- cleanup removes only live blocks still matching temporary provenance;
- if a recorded scaffold position now contains a chest, cleanup returns `world_divergence` and does not break it;
- interruption/AbortSignal returns suspended progress without losing completed count.

- [ ] **Step 2: Run RED**

```powershell
npm test -- tests/construction/executor.test.ts
```

- [ ] **Step 3: Implement bounded executor**

Use a small batch cap (for example 32 verified/mutated positions per `executeBatch` call) so future Task Graph orchestration can checkpoint/yield frequently. Retry each local placement at most three deterministic attempts before returning blocked; do not call AI here.

- [ ] **Step 4: Run focused/full tests and commit**

```powershell
npm test -- tests/construction/executor.test.ts tests/construction/site-survey.test.ts tests/construction/reachability.test.ts
npm run typecheck
```

```bash
git add src/construction/executor.ts tests/construction/executor.test.ts
git commit -m "feat: execute checkpointed project construction"
```

---

### Task 8: Add Survival Supervisor, deterministic hostile-mob policy, and death loop guard

**Files:**
- Create: `src/safety/survival-supervisor.ts`
- Create: `src/safety/combat-policy.ts`
- Create: `src/minecraft/combat.ts`
- Create: `src/minecraft/mineflayer-combat.ts`
- Modify: `src/minecraft/runtime-bundle.ts`
- Modify: `src/contracts/events.ts` only for sanitized mob/death/runtime signals required by supervisor.
- Test: `tests/safety/survival-supervisor.test.ts`
- Test: `tests/safety/combat-policy.test.ts`
- Test: `tests/minecraft/mineflayer-combat.test.ts`

**Interfaces:**

```ts
export type SurvivalDirective =
  | { readonly kind: 'continue' }
  | { readonly kind: 'eat' }
  | { readonly kind: 'retreat'; readonly reason: string }
  | { readonly kind: 'engage_hostile'; readonly entityId: number; readonly weapon: string | null }
  | { readonly kind: 'pause_safety'; readonly reason: string }
  | { readonly kind: 'recover_death'; readonly deathSequence: number }
```

- [ ] **Step 1: Write RED priority tests**

Assert emergency/low-health/active hostile outrank routine hunger/project work. High-altitude work uses a higher resume-health threshold than ground work. Safe/aggressive/full can vary ordinary engage/retreat preference but never allow player targets.

- [ ] **Step 2: Write RED weapon/threat tests**

Use game knowledge facts to rank usable weapon DPS/range/durability. Bow with zero arrows is unusable; sword/axe/tool fallback is deterministic; creeper near project prefers distance/reposition policy over close melee when ranged/escape option exists.

- [ ] **Step 3: Implement Mineflayer combat runtime**

Expose only bounded operations:

```ts
attackHostile(entityId: number, signal: AbortSignal): Promise<SkillResult>
retreatTo(position: Position, signal: AbortSignal): Promise<SkillResult>
```

Validate entity is currently hostile/non-player before attack. Abort/disconnect stops attack/path state.

- [ ] **Step 4: Add death/repeated-death state machine**

Track deaths per project/region in supervisor memory with durable checkpoint hooks later consumed by Phase 5. Three repeated deaths in the same bounded region within one recovery episode returns `pause_safety`; never loop indefinitely.

- [ ] **Step 5: Run tests/typecheck and commit**

```powershell
npm test -- tests/safety/survival-supervisor.test.ts tests/safety/combat-policy.test.ts tests/minecraft/mineflayer-combat.test.ts tests/safety/policy.test.ts
npm run typecheck
```

```bash
git add src/safety/survival-supervisor.ts src/safety/combat-policy.ts src/minecraft/combat.ts src/minecraft/mineflayer-combat.ts src/minecraft/runtime-bundle.ts src/contracts/events.ts tests/safety tests/minecraft/mineflayer-combat.test.ts
git commit -m "feat: supervise construction survival and hostile mobs"
```

---

### Task 9: Phase 4 private-server construction validation

**Files:**
- Modify: this plan only to append safe evidence.

- [ ] **Step 1: Run full automated verification**

```powershell
npm test
npm run typecheck
```

- [ ] **Step 2: Run a deterministic test blueprint on the private server**

Use a small approved fixture structure rather than AI planning. Validate:

- site survey does not overwrite a deliberately placed protected chest;
- small CUT/FILL terrain prep works;
- high block requires scaffold/work platform and succeeds;
- with shears + available legal leaves + no specified scaffold, leaves are selected as temporary access;
- temporary access is removed after build;
- useful explicitly marked workstation can remain as infrastructure;
- restart mid-build reconciles completed blocks instead of restarting blindly.

- [ ] **Step 3: Validate hostile interruption/resume and death safety**

In a controlled survival test, allow one ordinary hostile interruption and confirm current construction progress resumes after safety handling. Do not intentionally create an uncontrolled death loop; use a controlled harness/test world for repeated-death breaker if needed.

- [ ] **Step 4: Record evidence and commit**

```bash
git add docs/superpowers/plans/2026-09-13-project-autonomy-phase4-construction-survival.md
git commit -m "docs: record phase 4 construction validation"
```

Phase 4 is complete only when construction/terrain/scaffold/provenance/survival automated tests pass, full CI/typecheck passes, and the private-server deterministic blueprint demonstrates safe terrain prep, high-place access, cleanup, interruption/resume, and restart reconciliation.
