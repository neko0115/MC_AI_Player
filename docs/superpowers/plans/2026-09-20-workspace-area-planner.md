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

## W3 — Workspace module and AI context

- add workspace summaries to decision context;
- resolve “這裡 / 剛才那區 / <workspace name>”;
- create/update workspace metadata through bounded deterministic action;
- do not execute build/light mutations merely because a label is stored.

## W4 — Lighting plan

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

## W5 — Lighting execution

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

## W6 — Live validation

Required scenarios:

- 9 x 9 farm label persistence;
- 5 x 10 x 10 production label persistence;
- large multi-chunk selection;
- safe spacing lighting;
- unsafe spacing confirmation gate;
- restart persistence;
- protected-area conflict fail-closed.
