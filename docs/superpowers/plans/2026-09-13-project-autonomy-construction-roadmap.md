# Project Autonomy and Construction Implementation Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement these plans task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved durable project/autonomy/construction design in independently reviewable stages, each of which leaves MC_AI_Player in a working, testable state.

**Architecture:** Preserve the existing action pipeline and SafetyPolicy while adding durable project orchestration above it. The implementation is split so chat/tooling, project state, game knowledge/supply, construction/survival, and final orchestration/planning can be reviewed and validated independently.

**Tech Stack:** TypeScript 7, Node.js 24, Mineflayer 4.39, mineflayer-pathfinder 2.4.5, Zod 4.5.4, better-sqlite3 12.11.1, @google/genai 2.21.0, node:test via `tsx --test`.

**Spec:** `docs/superpowers/specs/2026-09-13-project-autonomy-construction-design.md`

## Global Constraints

- AI never directly calls Mineflayer world-mutation APIs.
- Generic navigation keeps `canDig=false` and cannot place blocks.
- PvP remains hard-disabled.
- Persistent project identity is UUID-bound in trusted online-mode sessions.
- `fully_autonomous` never bypasses hard safety, server ceilings, ACL, approval envelopes, or circuit breakers.
- World state is the physical truth; persisted project state must reconcile before resume.
- Arbitrary nearby containers are never material sources without explicit storage authorization.
- Raw provider reasoning, prompts, API keys, and secrets never enter Minecraft chat or project persistence.
- Existing `mc_memory.sqlite3` and `ai-quota.sqlite3` remain separate from project state.
- Every stage uses RED -> GREEN TDD and ends with full `npm test` + `npm run typecheck` before merge/rebase to the next stage.

---

## Plan sequence

1. **Phase 1 — Chat Feedback and Automatic Tool Use**  
   `docs/superpowers/plans/2026-09-13-project-autonomy-phase1-chat-tools.md`  
   Immediate live UX improvement: wire lifecycle chat feedback and make existing gathering equip a suitable tool deterministically.

2. **Phase 2 — Project State, Identity, ACL, Drafts, and Storage**  
   `docs/superpowers/plans/2026-09-13-project-autonomy-phase2-state-conversation.md`  
   Introduce `project-state.sqlite3`, per-user autonomy defaults, owner/manager/helper ACL, project resolution, durable conversational drafts, and explicit storage registration/access.

3. **Phase 3 — Versioned Game Knowledge and Supply Planning**  
   `docs/superpowers/plans/2026-09-13-project-autonomy-phase3-knowledge-supply.md`  
   Add reviewable game-data sources, recipe/workstation/fuel expansion, material reservations, crafting/smelting/stonecutting execution, and deterministic supply planning.

4. **Phase 4 — Blueprint, Terrain, Construction, and Survival Runtime**  
   `docs/superpowers/plans/2026-09-13-project-autonomy-phase4-construction-survival.md`  
   Build the survival-valid construction engine: blueprint compilation, site survey, terrain permits, scaffolding/reachability, placement recovery, provenance cleanup, hostile-mob interruption, health/hunger/death recovery.

5. **Phase 5 — Durable Project DAG, AI Project Planning, Recovery, and Multiplayer Integration**  
   `docs/superpowers/plans/2026-09-13-project-autonomy-phase5-orchestration-planning.md`  
   Add the durable Task Graph, constrained architectural Gemini contract, replan budgets/circuit breakers, same-role conflicts, offline-owner continuation, restart reconciliation, and end-to-end live validation.

## Dependency rule

Each phase depends on the previous phase's public interfaces, but later phases must not be partially backported into earlier phases. If an implementation discovers that a required interface changes, update the earliest owning phase first, run its tests, then continue forward.

## Branch/worktree rule

Execution starts from `feature/project-autonomy-construction`. At implementation time, create an isolated worktree for the active phase before editing. Keep the current `feature/gemini-multi-model-routing` PR independent; do not merge either branch without explicit user approval.

## Review checkpoints

After each phase:

```powershell
npm test
npm run typecheck
git status --short
git log -1 --oneline
```

Record live evidence only for the behaviors introduced by that phase. A later phase must not retroactively redefine an earlier phase as PASS without rerunning the affected tests.
