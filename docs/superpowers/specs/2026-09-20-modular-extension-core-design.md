# MC_AI_Player Modular Extension Core Design

**Date:** 2026-09-20  
**Repository:** `neko0115/MC_AI_Player`  
**Design branch:** `feature/modular-extension-core`  
**Base:** `feature/moxuebridge-capabilities` at `c61d389`  
**Status:** Active design / implementation gate

## 1. Goal

Refactor MC_AI_Player so new generic gameplay capabilities can be implemented as isolated modules while new modded content can usually be added as data/capability descriptors instead of per-mod control-flow branches.

The target is not unrestricted runtime plugins. The target is a reviewable, fail-closed extension architecture with stable seams for:

- skills;
- AI-visible action metadata;
- goal/action schemas;
- safety authority;
- Minecraft runtime adapters;
- versioned game knowledge;
- server/plugin capability providers.

The architecture must make later parallel work on Production, Combat, Construction, and Project Orchestration safer by reducing shared wiring hotspots.

## 2. Non-negotiable rules

- Do not add one `if`/switch branch per mod/item/ore/weapon when the underlying mechanic already fits an existing generic capability.
- Namespaced IDs are data.
- Unknown/inferred content is not mutation-authoritative.
- AI never receives direct world-mutation authority.
- Generic navigation remains no-dig/no-place.
- Safety permits remain bounded and purpose-specific.
- Existing gameplay behavior must remain unchanged during modularization unless a separately reproduced bug is being fixed.
- Every migration step uses characterization tests and preserves current external contracts until the replacement seam is proven.
- A new generic mechanic may require a new capability contract; a new content item using an existing mechanic should not require a new skill.

## 3. Current coupling hotspots

Current branch analysis identifies these shared hotspots:

1. `src/contracts/skills.ts`
   - central `SkillNameSchema` enum.
2. `src/contracts/goals.ts`
   - central discriminated union for every goal.
3. `src/contracts/decision.ts`
   - duplicates the action list for V1 and V2 provider contracts.
4. `src/agent/skill-catalog.ts`
   - separate hard-coded AI-visible skill list/descriptions.
5. `src/main.ts`
   - constructs and registers navigation, survival, resource exploration, excavation, gathering, and acquisition skills in one function.
6. `src/safety/policy.ts`
   - resource mutation authority includes hard-coded skill-name checks.
7. `src/minecraft/runtime-bundle.ts`
   - every new runtime family would currently require editing one shared bundle interface/factory.

The execution bridge itself is already relatively modular:
`GoalExecutionLoop -> SkillExecutor -> SkillRegistry` does not switch on individual skill behavior.

## 4. Target layers

```text
High-level Goal / Project Task
             |
             v
      Goal/Action Catalog
             |
             v
        Skill Registry
             |
             v
       Skill Module
             |
     +-------+--------+
     |                |
     v                v
Knowledge Provider  Capability Provider
     |                |
     +-------+--------+
             |
             v
       Safety Authority
             |
       scoped permit
             |
             v
       Runtime Adapter
             |
             v
          Minecraft
```

## 5. Extension categories

### 5.1 Content extension

Examples: a new ore, log, food, recipe, ammunition item, or weapon with already-known mechanics.

Preferred implementation:

- versioned knowledge;
- authoritative server descriptor;
- capability/profile provider;
- no new control-flow branch in high-level skill code.

### 5.2 Mechanic extension

Examples: a genuinely new reload mechanic, powered mining tool, machine GUI protocol, or construction operation.

Preferred implementation:

- introduce/review one generic capability/runtime contract;
- implement a narrow adapter;
- reuse it for all content with that mechanic.

### 5.3 Behavior extension

Examples: hostile combat, production planning, construction execution.

Preferred implementation:

- one isolated module/workstream;
- typed skill contracts;
- bounded deterministic executor;
- explicit safety metadata/permit requirements;
- optional AI exposure through a catalog descriptor.

## 6. Skill module composition seam

The first migration creates a behavior-neutral module installer:

```ts
export interface SkillModule {
  readonly id: string
  install(registry: SkillRegistry): void
}
```

Dependencies are captured by module factories rather than exposed through a global service locator.

Examples:

```text
navigation module
survival module
resource module
future production module
future hostile-combat module
future construction module
```

The installer must reject duplicate module IDs and existing `SkillRegistry` duplicate-skill protection remains authoritative.

This first seam deliberately does not weaken the current closed schemas.

## 7. Catalog migration

After module composition is stable, introduce one trusted action/skill contract catalog containing:

- canonical action/skill name;
- argument schema;
- AI exposure flag and description;
- safety capability requirements;
- mutation authority class, if any.

Migrate duplicated lists incrementally:

1. AI skill catalog;
2. goal validation;
3. decision validation;
4. safety skill authority.

The catalog is application-owned/trusted. Provider/model output cannot register or modify it.

## 8. Runtime adapter migration

Do not turn `MineflayerRuntimeBundle` into an untyped service locator.

Preferred direction:

- small typed runtime ports;
- module factories request only the ports they need;
- composition root owns construction of concrete Mineflayer runtimes;
- future module-specific runtimes can live beside their module and be assembled through narrow typed extension points.

## 9. Mod/resource knowledge direction

The existing `ResourceProfileSource` is a valid extension seam and should be preserved.

Long term it should compose with the approved project-autonomy Phase 3 versioned knowledge pack so that a resource profile may be resolved from trusted sources without adding per-resource branches.

A resource profile may describe:

- requested resource ID / aliases;
- source blocks;
- collected items;
- minimum-drop semantics;
- tool kind/tier;
- forbidden enchantments;
- bounded acceleration capability;
- related cleanup semantics;
- provenance/authority.

## 10. Combat direction

Combat must be capability-driven, not gun-mod-driven.

A future generic weapon descriptor may include:

- melee/ranged role;
- effective range;
- use action;
- cadence/cooldown;
- ammunition/energy requirement;
- reload/use constraints;
- safety restrictions.

Hostile combat remains deterministic below the planner. PvP remains disabled unless a future explicit design changes that hard policy.

## 11. Parallelization gate

Do not open multiple coding conversations for Production/Combat/Construction until all of these are true:

- module installer/composition seam is live in production wiring;
- AI exposure metadata has a single trusted source;
- adding a generic skill no longer requires editing multiple duplicated action lists;
- safety authority can be extended without per-skill string branches;
- runtime composition has a documented typed extension path;
- full tests/typecheck pass;
- one representative existing module (resource acquisition) has migrated without behavior regression.

At that point `PROJECT_CONTINUITY.md` may mark **SAFE PARALLELIZATION POINT**.

## 12. Relationship to existing project-autonomy roadmap

This design does not replace:

- `docs/superpowers/specs/2026-09-13-project-autonomy-construction-design.md`
- its Phase 1-5 implementation plans.

Instead, this modularization gate becomes a prerequisite before independently implementing the later Production, Combat, Construction, and orchestration workstreams.
