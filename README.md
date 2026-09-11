# MC_AI_Player

Standalone Minecraft Java cooperative-player runtime for Moxue experiments.

## Project boundary

- `MC_AI_Player` owns Minecraft connectivity, deterministic gameplay, safety, Minecraft-specific memory, telemetry, control API, replay fixtures, and AI decision-provider adapters.
- `neko0115/DC_BOT` remains read-only until the standalone and mock-integration gates pass.
- Normal gameplay is headless: no Minecraft Launcher, rendered Java client, OCR, screenshot loop, or GUI is required on the runtime host.
- AI may choose only allowlisted high-level structured decisions. Deterministic runtime code performs Minecraft actions.
- Raw/mixed model text and hidden reasoning have no gameplay actuator path.

## Runtime baseline

Exact versions are locked in `package-lock.json`:

- Node.js: `24.x` LTS (`>=24 <25`)
- TypeScript: `7.0.2`
- tsx: `4.23.13`
- Zod: `4.5.4`
- Mineflayer: `4.39.0`
- mineflayer-pathfinder: `2.4.5`
- better-sqlite3: `12.11.1`
- `@google/genai`: `2.21.0`

## Quick validation

```bash
npm ci
npm run probe
npm test
npm run typecheck
```

`npm run probe` loads Mineflayer and mineflayer-pathfinder without opening a Minecraft connection and reports the host runtime information.

## Runtime configuration

Minecraft connection settings are explicit:

```text
MC_HOST
MC_PORT
MC_USERNAME
MC_AUTH=offline|microsoft
MC_VERSION              optional
MC_LOG_LEVEL            optional
```

The safe AI default is:

```text
MC_AI_PROVIDER=fake
```

Gemini requires both an explicit model and API key:

```text
MC_AI_PROVIDER=gemini
MC_AI_MODEL=<explicit model>
MC_AI_API_KEY=<secret>
```

A real key must never be committed. The Gemini adapter is contract-tested with separated thought/function-call responses, but live Google API/model/schema compatibility is still a separate gate and is **not yet claimed as PASS**.

The Control API defaults to loopback. Binding to a non-loopback interface requires a bearer token at startup.

```text
MC_CONTROL_HOST=127.0.0.1
MC_CONTROL_PORT=8766
MC_CONTROL_TOKEN=        required for non-loopback bind
MC_CONTROL_MAX_BODY_BYTES=16384
```

## Control API

Current standalone surface:

```text
GET  /health
GET  /v1/status
POST /v1/goals
POST /v1/stop
GET  /v1/memory/search
GET  /v1/events          SSE
```

Long-running goals return an accepted `goal_id`; HTTP requests do not remain open for gameplay completion. SSE carries validated `RuntimeEvent` objects only.

## Current automated validation status

The automated suite currently covers:

- strict decision / goal / event contracts;
- reasoning isolation and zero raw-text actuator reachability;
- deterministic GoalManager + SkillExecutor lifecycle and emergency cancellation;
- hardened Mineflayer navigation with generic `canDig=false`;
- scoped gather-resource block mutation;
- survival and bounded inventory/container primitives;
- SQLite Minecraft memory, deduplication, world isolation, and restart persistence;
- local Control API authentication, body limits, async goal submission, memory search, and SSE lifecycle;
- composition-root startup/shutdown and fresh-clone persistence directory bootstrap;
- replay-backed component-integrated cooperative acceptance: player appears, follow, gather 16 oak logs, return to base, handoff surrogate, write base/resource/task memories, then resume follow;
- invalid raw-text decision rejection inside that cooperative flow;
- Gemini high-reasoning provider-adapter variation producing the same allowlisted gather GoalRequest while discarding thought content;
- Task 16 soak telemetry contracts for RSS, heap, event-loop lag and explicit missing runtime metrics;
- Task 16 chaos-harness contracts covering disconnect/restart/stuck/target loss/inventory full/death/AI failures/memory failure/SSE disconnect storms with bounded timeouts.

The cooperative acceptance fixture is `fixtures/replay/cooperative-session.jsonl`. Its deterministic scenario lives in `tests/scenarios/cooperative-session.test.ts`; the Gemini adapter variation lives in `tests/scenarios/cooperative-provider.test.ts`.

Task 16 measurement tooling lives in `scripts/soak.ts` and `scripts/chaos.ts`. Deployment and real-hardware measurement procedure is documented in `docs/operations/pi-deployment.md`. Missing runtime probes are represented as `null` plus `missingMetrics`; the tooling must not invent deployment measurements.

## Gates that are still pending

Do not treat the following as validated yet:

- **Real Gemini API compatibility:** live Google API/model/function-schema call has not been approved as PASS. The safe runtime default remains `fake`.
- **Production event-driven AI coordinator:** `src/main.ts` currently constructs and capability-checks the selected DecisionProvider, but it does not yet wire player chat/runtime decision points into an automatic ContextBuilder → DecisionProvider → DecisionGate/GoalManager loop. The Task 15 automated scenario invokes that pipeline explicitly, so autonomous cooperative-agent behavior is not yet claimed as PASS.
- **30-minute private-server cooperative session:** still requires real server/human validation with the Task 15 checklist.
- **Production wiring for `return_home`, `deposit_item`, and `withdraw_item`:** the underlying deterministic skill implementations exist, but the current production composition root does not yet register/resolve these three intents. The automated Task 15 scenario therefore uses explicit `go_to` plus a test-only handoff surrogate. This remains a release blocker, not a hidden PASS.
- **Task 16 real deployment evidence:** Linux ARM64 runtime measurements, Pi 3B benchmark, intended mini-PC benchmark, runtime-probe integration, and the required 4–8 hour soak have not been captured. Automated x64 harness tests are not substitutes for these hardware/long-duration gates.
- **Mock Moxue integration and any DC_BOT changes:** not started; DC_BOT remains untouched.

For the 30-minute private-server gate, required evidence is:

```text
uncommanded block destruction: 0
PVP attempts: 0
raw-text decisions executed: 0
reasoning leakage: 0
stuck loops > retry budget: 0
emergency stop failures: 0
goal lifecycle inconsistencies: 0
```

For the Task 16 release evidence, record real p50/p95/max measurements where applicable and retain the Git SHA, hardware/OS/Node details, power/throttling state, soak summary, and PASS/FAIL/BLOCKED decision. Do not copy CI x64 values into ARM64/Pi evidence.

## Supported validation targets

- Windows x64: primary development and interactive E2E target.
- Linux x64: CI/release validation target.
- Linux ARM64: required release validation target.
- Raspberry Pi 3 Model B / 1 GB: constrained minimum-hardware experiment target; validation occurs later and does not require Minecraft GUI rendering.

Architecture, implementation, platform-validation, and deployment plans live under `docs/superpowers/` and `docs/operations/`.
