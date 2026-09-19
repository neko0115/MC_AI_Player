# Modular Extension Core Implementation Plan

**Date:** 2026-09-20  
**Branch:** `feature/modular-extension-core`  
**Base:** `c61d389`  
**Spec:** `docs/superpowers/specs/2026-09-20-modular-extension-core-design.md`

## Global rule

Every step must preserve current external behavior unless the step explicitly says otherwise. Use RED/characterization -> GREEN, run focused tests, then full `npm test` and `npm run typecheck` before declaring a phase complete.

## M0 — Lock design and baseline

- [x] Identify current coupling hotspots.
- [x] Define content/mechanic/behavior extension rules.
- [x] Define parallelization gate.
- [ ] Create isolated branch/worktree locally.
- [ ] Confirm base full suite in the new worktree.

## M1 — Extract behavior-neutral skill module composition

Create:

- `src/modules/skill-module.ts`
- `src/modules/builtin-skills.ts`
- `tests/modules/skill-module.test.ts`

Modify:

- `src/main.ts`

Requirements:

- introduce `SkillModule { id, install(registry) }`;
- duplicate module IDs fail closed before partial duplicate installation;
- navigation/survival/resource registration leaves `main.ts`;
- existing skill names and schemas do not change;
- existing ordering/AI exposure/gameplay behavior does not change.

Gate:

```powershell
npm test -- tests/modules/skill-module.test.ts tests/main.test.ts
npm run typecheck
npm test
```

## M2 — Trusted skill/action metadata catalog

Create a single trusted catalog abstraction for:

- args schema;
- AI description/exposure;
- safety metadata;
- mutation authority class.

First migrate `src/agent/skill-catalog.ts` to use catalog data while preserving its output exactly.

Do not yet make schemas runtime-extensible.

## M3 — Remove duplicated goal/decision action lists

Derive goal/decision validation from the trusted catalog while preserving:

- strict unknown-field rejection;
- bounded argument schemas;
- provider reasoning isolation;
- fail-closed unknown action behavior;
- current static TypeScript ergonomics where practical.

Characterization tests must lock V1 and V2 payload compatibility before refactor.

## M4 — Safety authority migration

Replace hard-coded mutation-skill string checks with trusted catalog safety authority.

Requirements:

- model/provider output cannot self-authorize;
- unregistered skills fail closed;
- forged safety metadata cannot produce a permit;
- current gather/excavate permits behave identically.

## M5 — Typed runtime extension seam

Reduce pressure on `runtime-bundle.ts` without introducing an untyped service locator.

Migrate one existing runtime family as proof and document the pattern for future Production/Combat/Construction runtimes.

## M6 — Resource module proof

Migrate the existing resource acquisition stack as the representative full module:

- find;
- explore;
- excavate;
- gather;
- acquire;
- resource profile provider;
- server capability integration.

Run existing resource live validations that are affected by wiring.

## M7 — Parallelization acceptance

PASS requires:

- full tests/typecheck green;
- no behavior regression in resource acquisition;
- new generic module can be added with isolated files plus a minimal composition entry;
- modded resource/content extension does not require a new high-level skill;
- safety remains fail closed;
- `PROJECT_CONTINUITY.md` updated with **SAFE PARALLELIZATION POINT** and branch/worktree instructions.

Only after M7 begin independent Production / Combat / Construction coding workstreams.
