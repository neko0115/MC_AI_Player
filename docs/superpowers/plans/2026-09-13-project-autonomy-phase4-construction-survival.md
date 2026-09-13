# Project Autonomy Phase 4: Blueprint, Terrain, Construction, and Survival Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a survival-valid deterministic construction runtime that compiles constrained plans into exact blocks, prepares terrain, reaches high placements with tracked temporary access, mutates the world only through purpose-specific permits, survives ordinary hazards, and safely cleans up/reconciles project mutations.

**Architecture:** Introduce pure blueprint/site/terrain/reachability planners above a narrow Mineflayer construction runtime. Every break/place operation carries a purpose-specific permit issued by `SafetyPolicy`; provenance/checkpoints are written to Project DB. A separate Survival Supervisor suspends/resumes construction for hunger, health, hostile mobs, inventory/tool pressure, or death without allowing AI to micromanage combat or placement.

**Tech Stack:** TypeScript 7, Node.js 24, Mineflayer 4.39, mineflayer-pathfinder 2.4.5, better-sqlite3 12.11.1, Zod 4.5.4, node:test/tsx.

**Spec:** `docs/superpowers/specs/2026-09-13-project-autonomy-construction-design.md`

## Global Constraints

- Generic navigation remains unable to dig/place.
- Build/terrain mutation requires unforgeable purpose-specific permits issued by `SafetyPolicy`.
- Suspected player content is protected by default.
- Construction uses legal Survival reach/support/orientation/inventory/path access.
- Temporary access blocks are provenance-tracked and live-verified before cleanup.
- Local placement/path/material failures use deterministic recovery before any later AI replan.
- PvP stays hard-disabled; hostile-mob handling never targets players.
- `fully_autonomous` changes policy tolerance, not hard safety or retry/death caps.
- World state is authoritative during recovery.

---

## File structure

- Create `src/construction/contracts.ts`, `blueprint-compiler.ts`, `site-survey.ts`, `terrain-planner.ts`, `scaffold-policy.ts`, `reachability.ts`, `executor.ts`.
- Create `src/minecraft/construction.ts`, `mineflayer-construction.ts`, `combat.ts`, `mineflayer-combat.ts`.
- Modify `src/minecraft/runtime-bundle.ts`.
- Modify `src/safety/policy.ts`; create `src/safety/survival-supervisor.ts`, `combat-policy.ts`.
- Extend `src/projects/repository.ts`/`sqlite-repository.ts` for plan versions, infrastructure, mutation journal, checkpoints.
- Tests under `tests/construction/`, `tests/safety/`, `tests/minecraft/`, `tests/projects/`.

---

### Task 1: Define constrained architectural primitives and compile an exact blueprint/BOM

**Files:**
- Create: `src/construction/contracts.ts`
- Create: `src/construction/blueprint-compiler.ts`
- Test: `tests/construction/blueprint-compiler.test.ts`

**Interfaces:**

```ts
export type ArchitecturalPrimitive =
  | { readonly kind: 'foundation'; readonly x: number; readonly z: number; readonly width: number; readonly depth: number; readonly y: number; readonly block: string }
  | { readonly kind: 'floor'; readonly x: number; readonly z: number; readonly width: number; readonly depth: number; readonly y: number; readonly block: string }
  | { readonly kind: 'wall'; readonly from: Position; readonly to: Position; readonly height: number; readonly block: string }
  | { readonly kind: 'opening'; readonly x: number; readonly y: number; readonly z: number; readonly width: number; readonly height: number; readonly facing: 'north' | 'south' | 'east' | 'west' }
  | { readonly kind: 'window'; readonly x: number; readonly y: number; readonly z: number; readonly width: number; readonly height: number; readonly facing: 'north' | 'south' | 'east' | 'west'; readonly block: string }
  | { readonly kind: 'door'; readonly x: number; readonly y: number; readonly z: number; readonly facing: 'north' | 'south' | 'east' | 'west'; readonly block: string }
  | { readonly kind: 'pillar'; readonly x: number; readonly y: number; readonly z: number; readonly height: number; readonly block: string }
  | { readonly kind: 'beam'; readonly from: Position; readonly to: Position; readonly block: string }
  | { readonly kind: 'roof'; readonly x: number; readonly z: number; readonly y: number; readonly width: number; readonly depth: number; readonly roofType: 'flat' | 'gable'; readonly block: string }
  | { readonly kind: 'stairs'; readonly from: Position; readonly to: Position; readonly block: string }
  | { readonly kind: 'interior_zone'; readonly min: Position; readonly max: Position; readonly purpose: string }
  | { readonly kind: 'workstation_zone'; readonly min: Position; readonly max: Position; readonly purpose: string }
  | { readonly kind: 'storage_zone'; readonly min: Position; readonly max: Position; readonly purpose: string }

export const ArchitecturalPrimitiveSchema: z.ZodType<ArchitecturalPrimitive>

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
  readonly bounds: { readonly min: Position; readonly max: Position }
  readonly bom: Readonly<Record<string, number>>
}

export function compileBlueprint(input: {
  readonly origin: Position
  readonly primitives: readonly ArchitecturalPrimitive[]
}): ExactBlueprint
```

- [ ] **Step 1: Write RED compiler tests**

Use a 5x5 one-room fixture. Assert wall openings, deterministic roof/floor coordinates, explicit stair/door state, duplicate-coordinate rejection unless identical, exact BOM, correct bounds, and invalid dimensions rejected.

- [ ] **Step 2: Run RED**

```powershell
npm test -- tests/construction/blueprint-compiler.test.ts
```

- [ ] **Step 3: Implement pure compiler**

No Mineflayer access. Sort blocks by `(y,x,z,block)` only for stable representation, not build order.

- [ ] **Step 4: Verify and commit**

```powershell
npm test -- tests/construction/blueprint-compiler.test.ts
npm run typecheck
```

```bash
git add src/construction/contracts.ts src/construction/blueprint-compiler.ts tests/construction/blueprint-compiler.test.ts
git commit -m "feat: compile constrained building blueprints"
```

---

### Task 2: Add unforgeable build/terrain permits to SafetyPolicy

**Files:**
- Modify: `src/safety/policy.ts`
- Test: `tests/safety/construction-permits.test.ts`
- Test: `tests/safety/policy.test.ts`

**Interfaces:**

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

export type BuildMutationDecision =
  | { readonly kind: 'allow'; readonly code: 'allowed'; readonly permit: BuildMutationPermit }
  | { readonly kind: 'deny'; readonly code: string }

export type TerrainMutationDecision =
  | { readonly kind: 'allow'; readonly code: 'allowed'; readonly permit: TerrainMutationPermit }
  | { readonly kind: 'deny'; readonly code: string }
```

Add exact methods:

```ts
issueBuildMutationPermit(
  skillName: string,
  projectId: string,
  planVersion: number,
  allowedRegion: { min: Position; max: Position },
  allowedPlaceBlocks: readonly string[],
  metadata: SkillSafetyMetadata,
  state: WorldStateSnapshot
): BuildMutationDecision

issueTerrainMutationPermit(
  skillName: string,
  projectId: string,
  allowedRegion: { min: Position; max: Position },
  allowedBreakBlocks: readonly string[],
  allowedFillBlocks: readonly string[],
  metadata: SkillSafetyMetadata,
  state: WorldStateSnapshot
): TerrainMutationDecision
```

- [ ] **Step 1: Write RED permit tests**

Forged objects fail `isBuildMutationPermit`/`isTerrainMutationPermit`; invalid regions/wildcards/disconnected state fail; only `construct_project` with `place_blocks` gets build permit and `prepare_project_terrain` with declared break/place capabilities gets terrain permit; PvP remains denied.

- [ ] **Step 2: Implement with private WeakSets and existing validation style**

Preserve current resource mutation permit behavior.

- [ ] **Step 3: Verify and commit**

```powershell
npm test -- tests/safety/construction-permits.test.ts tests/safety/policy.test.ts tests/safety/resource-permit.test.ts
npm run typecheck
```

```bash
git add src/safety/policy.ts tests/safety/construction-permits.test.ts tests/safety/policy.test.ts
git commit -m "feat: authorize bounded project world mutation"
```

---

### Task 3: Add narrow construction observation/place/break runtime

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
    readonly target: Position
    readonly block: string
    readonly state: Readonly<Record<string, string | number | boolean>>
    readonly reference: Position
    readonly face: { x: number; y: number; z: number }
    readonly permit: BuildMutationPermit
  }, signal: AbortSignal): Promise<SkillResult>
  breakBlock(request: {
    readonly target: Position
    readonly expectedBlock: string
    readonly permit: TerrainMutationPermit | BuildMutationPermit
  }, signal: AbortSignal): Promise<SkillResult>
  isStandable(position: Position): Promise<boolean>
}
```

- [ ] **Step 1: Write RED runtime tests**

Verify permit/region/expected-before/inventory/reference/face checks, abort/disconnect cleanup, and zero mutation on forged/mismatched permit.

- [ ] **Step 2: Implement one-operation-only runtime**

No strategy/retry/path choice inside this runtime.

- [ ] **Step 3: Expose through runtime bundle, verify, commit**

```powershell
npm test -- tests/minecraft/mineflayer-construction.test.ts
npm run typecheck
```

```bash
git add src/minecraft/construction.ts src/minecraft/mineflayer-construction.ts src/minecraft/runtime-bundle.ts tests/minecraft/mineflayer-construction.test.ts
git commit -m "feat: add bounded Mineflayer construction runtime"
```

---

### Task 4: Persist plan versions, infrastructure, provenance, and checkpoints

**Files:**
- Modify: `src/projects/repository.ts`
- Modify: `src/projects/sqlite-repository.ts`
- Test: `tests/projects/construction-state.test.ts`

**Interfaces:**

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

export interface ProjectInfrastructureRecord {
  readonly infrastructureId: string
  readonly projectId: string
  readonly kind: string
  readonly dimension: string
  readonly position: Position
  readonly lifecycle: 'temporary' | 'project_persistent' | 'shared'
}
```

- [ ] **Step 1: Write RED persistence/restart tests**

Cover immutable plan numbering, active-version update, infrastructure lifecycle, mutation journal, checkpoints, and reload.

- [ ] **Step 2: Add tables/indexes/repository methods**

Create `project_plan_versions`, `project_infrastructure`, `block_mutations`, `project_checkpoints`; index mutations by project/dimension/position.

- [ ] **Step 3: Verify and commit**

```powershell
npm test -- tests/projects/construction-state.test.ts tests/projects/sqlite-repository.test.ts
npm run typecheck
```

```bash
git add src/projects/repository.ts src/projects/sqlite-repository.ts tests/projects/construction-state.test.ts
git commit -m "feat: persist project construction provenance"
```

---

### Task 5: Implement conservative site survey

**Files:**
- Create: `src/construction/site-survey.ts`
- Test: `tests/construction/site-survey.test.ts`

**Interfaces:**

```ts
export type SiteCellClass =
  | 'air' | 'replaceable' | 'natural_terrain' | 'liquid'
  | 'known_project_block' | 'temporary_project_block'
  | 'suspected_player_content' | 'protected' | 'unknown'

export interface SiteSurveyCell {
  readonly position: Position
  readonly observedBlock: string
  readonly classification: SiteCellClass
}
```

- [ ] **Step 1: Write RED classification tests**

Provenance and explicit protection win first. Unknown/unsupported blocks default to `unknown`. Unattributed containers/redstone/doors/glass/decorative patterns become `suspected_player_content`; ordinary dirt/stone/log only become natural terrain when facts/provenance support that classification.

- [ ] **Step 2: Implement, verify, commit**

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

export interface AccessPlan {
  readonly stance: Position
  readonly temporaryPlacements: readonly {
    readonly position: Position
    readonly block: string
    readonly purpose: 'scaffold' | 'work_platform' | 'temporary_bridge'
  }[]
  readonly cleanupPositions: readonly Position[]
}
```

- [ ] **Step 1: Write RED terrain tests**

CUT/FILL/SHAPE never mutate protected/player cells; user fill material wins when legal; otherwise choose lowest-cost legal fill; reject unsupported gravity fill.

- [ ] **Step 2: Write RED scaffold tests**

Priority: user material, reusable low-value material, legal leaves when no explicit scaffold + shears available, then other safe candidates. Leaves without shears are not preferred.

- [ ] **Step 3: Write RED reachability tests**

Cover direct reach, one-column scaffold, 2x2 work platform for high-risk edge, and rejection when protected cells/budget would be crossed.

- [ ] **Step 4: Implement, verify, commit**

```powershell
npm test -- tests/construction/terrain-planner.test.ts tests/construction/scaffold-policy.test.ts tests/construction/reachability.test.ts
npm run typecheck
```

```bash
git add src/construction/terrain-planner.ts src/construction/scaffold-policy.ts src/construction/reachability.ts tests/construction
git commit -m "feat: plan terrain and temporary construction access"
```

---

### Task 7: Implement checkpointed Construction Executor and safe cleanup

**Files:**
- Create: `src/construction/executor.ts`
- Test: `tests/construction/executor.test.ts`

**Interfaces:**

```ts
export type ConstructionBatchResult =
  | { readonly kind: 'progress'; readonly completed: number; readonly remaining: number }
  | { readonly kind: 'blocked'; readonly code: string; readonly affectedPositions: readonly Position[] }
  | { readonly kind: 'completed' }

export interface ConstructionExecutor {
  executeBatch(input: {
    readonly projectId: string
    readonly taskId: string
    readonly planVersion: number
    readonly blueprint: ExactBlueprint
  }, signal: AbortSignal): Promise<ConstructionBatchResult>
}
```

- [ ] **Step 1: Write RED execution tests**

Already-correct blocks skip mutation; missing material blocks with `resource_shortage`; placement failure re-observes/changes stance before block; temporary placements journaled; checkpoint per bounded segment; cleanup breaks only matching live temporary blocks; chest replacing old scaffold produces `world_divergence`; abort returns progress safely.

- [ ] **Step 2: Implement bounded executor**

Process at most 32 verified/mutated positions per call. Retry one local placement at most three deterministic attempts before blocking. No AI call.

- [ ] **Step 3: Verify and commit**

```powershell
npm test -- tests/construction/executor.test.ts tests/construction/site-survey.test.ts tests/construction/reachability.test.ts
npm run typecheck
```

```bash
git add src/construction/executor.ts tests/construction/executor.test.ts
git commit -m "feat: execute checkpointed project construction"
```

---

### Task 8: Add Survival Supervisor, hostile-mob policy, and death circuit breaker

**Files:**
- Create: `src/safety/survival-supervisor.ts`
- Create: `src/safety/combat-policy.ts`
- Create: `src/minecraft/combat.ts`
- Create: `src/minecraft/mineflayer-combat.ts`
- Modify: `src/minecraft/runtime-bundle.ts`
- Modify: `src/contracts/events.ts`
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

export interface CombatRuntime {
  attackHostile(entityId: number, signal: AbortSignal): Promise<SkillResult>
  retreatTo(position: Position, signal: AbortSignal): Promise<SkillResult>
}
```

- [ ] **Step 1: Write RED priority/weapon tests**

Emergency/low-health/hostile outrank hunger/project work; high-altitude resume threshold is higher; safe/aggressive/full may vary ordinary response but never player targeting. Bow without ammo is unusable; sword/axe/tool fallback deterministic; creeper near build prefers distance/reposition where possible.

- [ ] **Step 2: Implement combat runtime and supervisor**

Validate target entity remains hostile/non-player at attack time. Abort/disconnect stops combat/path state. Three deaths in the same bounded recovery region during one episode trigger `pause_safety`.

- [ ] **Step 3: Verify and commit**

```powershell
npm test -- tests/safety/survival-supervisor.test.ts tests/safety/combat-policy.test.ts tests/minecraft/mineflayer-combat.test.ts tests/safety/policy.test.ts
npm run typecheck
```

```bash
git add src/safety/survival-supervisor.ts src/safety/combat-policy.ts src/minecraft/combat.ts src/minecraft/mineflayer-combat.ts src/minecraft/runtime-bundle.ts src/contracts/events.ts tests/safety tests/minecraft/mineflayer-combat.test.ts
git commit -m "feat: supervise construction survival and hostile mobs"
```

---

### Task 9: Phase 4 private-server validation

**Files:**
- Modify: this plan only to append safe evidence.

- [ ] **Step 1: Run full automated verification**

```powershell
npm test
npm run typecheck
```

- [ ] **Step 2: Run deterministic fixture build**

Validate protected chest preservation, small CUT/FILL, high placement with access plan, leaves+shears scaffold selection when eligible, cleanup, infrastructure retention, and restart mid-build reconciliation.

- [ ] **Step 3: Validate ordinary hostile interruption/resume**

Use a controlled survival test and automated harness for repeated-death breaker; do not create an uncontrolled death loop.

- [ ] **Step 4: Record evidence and commit**

```bash
git add docs/superpowers/plans/2026-09-13-project-autonomy-phase4-construction-survival.md
git commit -m "docs: record phase 4 construction validation"
```

Phase 4 is complete only when construction/terrain/scaffold/provenance/survival tests pass, full suite/typecheck passes, and the private-server fixture demonstrates safe terrain prep, high-place access, cleanup, interruption/resume, and restart reconciliation.
