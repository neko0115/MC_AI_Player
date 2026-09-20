# Workspace / Area Planner Implementation Plan

**Date:** 2026-09-20  
**Branch:** `feature/workspace-planner`  
**Base:** `b75cb48`  
**Spec:** `docs/superpowers/specs/2026-09-20-workspace-area-planner-design.md`

## W0 — Domain contracts and geometry

Create:

- `src/workspace/contracts.ts`
- `src/workspace/geometry.ts`
- `tests/workspace/geometry.test.ts`

Requirements:

- normalize two selected points into inclusive cuboid bounds;
- compute X/Y/Z size, volume and chunk coverage;
- containment/intersection queries;
- strict bounded identifiers/labels/tags;
- world + dimension required;
- no world mutation.

## W1 — Durable repository

Create:

- `src/workspace/repository.ts`
- `src/workspace/sqlite-repository.ts`
- `tests/workspace/sqlite-repository.test.ts`

Requirements:

- durable create/update/delete/query;
- world isolation;
- dimension isolation;
- exact geometry round-trip;
- owner/provenance;
- deterministic ordering;
- bounded result limits.

## W2 — Setting-wand selection source

Create MC_AI_Player-side observation contract:

- `WorkspaceSelectionSource`;
- current/latest selection lookup;
- bounded selection event schema;
- stale/unavailable handling.

Add MoxueBridge client adapter only after its Paper API shape is confirmed.

Paper-side observation requirements:

- exact setting wand identity;
- trusted player UUID/name;
- point A / point B;
- world/dimension;
- selection generation/id;
- timestamps;
- no arbitrary mutation.

## W3 — Paper/Bridge selection transport

- implement MoxueBridge setting-wand observation;
- expose authenticated read-only selection snapshot;
- consume it through fail-closed MC_AI selection source;
- expose read-only Control API probe;
- live verify Paper and MC_AI agree on the same selection.

Gate:

```powershell
npm test -- tests/workspace/selection-source.test.ts tests/minecraft/moxuebridge-workspace-selections.test.ts tests/api/control-server.test.ts tests/main.test.ts
npm run typecheck
npm test
```

## W4 — Workspace lifecycle management

Create/modify:

- `src/workspace/contracts.ts`
- `src/workspace/repository.ts`
- `src/workspace/sqlite-repository.ts`
- `src/workspace/lifecycle-service.ts`
- `src/workspace/resolver.ts`
- tests under `tests/workspace/`

Requirements:

- add `active | archived` workspace status;
- ordinary delete becomes archive;
- restore archived workspace;
- create from trusted selection;
- rename;
- replace bounds from a new trusted selection;
- change purpose;
- replace/add/remove tags;
- update reviewed constraints;
- append audit transactionally for every successful mutation;
- resolver precedence: explicit -> conversation -> selection/intersection -> nearby -> recent -> ambiguous/none;
- same-name ambiguity never uses last-write-wins;
- archived workspaces excluded from ordinary resolution/execution;
- hard purge remains separate maintenance-only behavior.

## W5 — Chat/context binding

- expose bounded latest-selection/workspace summaries to decision context;
- resolve `這裡 / 剛才那區 / <workspace name>`;
- map management intent to deterministic lifecycle operations;
- ask one short clarification when resolver returns ambiguous;
- metadata mutation does not imply world mutation.

## W6 — Lighting plan

Create pure planner tests first.

Inputs:

- bounds;
- spacing;
- lighting target;
- terrain/light observations.

Outputs:

- candidate placements;
- bounded batches;
- uncovered/risky cells;
- suggested spacing;
- `ready | requires_confirmation | blocked`.

## W7 — Lighting execution

Prerequisites:

- typed lighting/placement runtime port;
- SafetyPolicy scoped placement permit;
- torch/source inventory resolution.

Execution:

- bounded placement batches;
- verify observed light;
- checkpoint;
- cancel/resume safely;
- never place outside workspace/permit scope.

## W8 — Live/project integration

Required scenarios:

- 9 x 9 farm label persistence;
- 5 x 10 x 10 production label persistence;
- rename/resize/purpose/tag/constraint update;
- archive/restore with audit history;
- same-name ambiguity;
- large multi-chunk selection;
- safe spacing lighting;
- unsafe spacing confirmation gate;
- restart persistence;
- protected-area conflict fail-closed;
- later Project DAG references workspace id rather than copying untracked coordinates.
