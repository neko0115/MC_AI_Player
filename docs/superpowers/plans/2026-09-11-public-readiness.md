# MC_AI_Player Public Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare `neko0115/MC_AI_Player` for a public MIT-licensed portfolio/open-source release without changing gameplay runtime behavior or overstating validation status.

**Architecture:** Keep the current Phase 0 pre-release runtime untouched and make repository-level changes around it: license, public-facing documentation, canonical CI, consolidated manual validation workflows, repository hygiene, and release verification. Preserve the existing RED/GREEN and review history; do not rewrite Git history or mix in DC_BOT work.

**Tech Stack:** GitHub Actions, Node.js 24.x, TypeScript 7.0.2, tsx 4.23.13, Mineflayer 4.39.0, SQLite/better-sqlite3 12.11.1, Markdown, MIT License.

**Spec:** `docs/superpowers/specs/2026-09-11-public-readiness-design.md`

## Global Constraints

- Start from `main` baseline `0b6866610dba32060f63cf807d1802f463f6d1d4` on branch `chore/public-readiness`.
- Do not change Minecraft gameplay behavior.
- Do not change AI decision/safety semantics.
- Do not modify `DC_BOT`.
- Do not rewrite Git history.
- Keep `package.json` with `"private": true`.
- Keep all current pending release gates explicit: real Gemini compatibility, production autonomous coordinator, 30-minute human session, production `return_home` / `deposit_item` / `withdraw_item`, ARM64/Pi/mini-PC measurements, 4–8 hour soak, and DC_BOT integration.
- Public-facing prose should be concise, technical, and natural. RewriteLy Humanizer may be used only as a final prose pass; it must not change technical claims, command examples, validation counts, or pending-gate semantics.
- Fresh verification on the cleanup head is required before merge. Historical test results are context only.

---

## File map

### Create
- `LICENSE` — standard MIT license for `neko0115`.
- `.github/workflows/ci.yml` — canonical Windows/Linux repository health gate for `push` and `pull_request` targeting `main`.
- `.github/workflows/live-validation.yml` — manual (`workflow_dispatch`) local-Minecraft-server validation for observation, bounded navigation smoke, inventory/survival, and deterministic gathering.
- `.github/workflows/release-harness.yml` — manual (`workflow_dispatch`) chaos/short-soak harness that explicitly remains incomplete hardware evidence.

### Modify
- `README.md` — portfolio-oriented structure while preserving exact current/pending status.
- `docs/superpowers/specs/2026-09-11-public-readiness-design.md` — only if implementation reveals a contradiction; otherwise leave unchanged.

### Remove from current tree after replacement coverage exists
- `.github/workflows/phase0.yml`
- `.github/workflows/live-gather-fix.yml`
- `.github/workflows/task8-navigation-live.yml`
- `.github/workflows/task9-inventory-live.yml`
- `.github/workflows/task10-gathering-live.yml`
- `.github/workflows/task11-sqlite-probe.yml`
- `.github/workflows/task12-reasoning-isolation.yml`
- `.github/workflows/task13-gemini-provider.yml`
- `.github/workflows/task14-control-api.yml`
- `.github/workflows/task15-cooperative-e2e.yml`
- `.github/workflows/task16-soak-chaos.yml`

The test files and runtime files referenced by those workflows remain in the repository.

---

### Task 1: Add MIT licensing and portfolio README structure

**Files:**
- Create: `LICENSE`
- Modify: `README.md`

**Interfaces:**
- Consumes: current README validation/pending-gate wording.
- Produces: public-facing project overview and explicit MIT license reference used by later metadata/release steps.

- [ ] **Step 1: Record pre-change structural checks**

Run:

```bash
node -e "const fs=require('node:fs'); if(fs.existsSync('LICENSE')) process.exit(1); const r=fs.readFileSync('README.md','utf8'); for(const s of ['Real Gemini API compatibility','Production event-driven AI coordinator','30-minute private-server cooperative session','Task 16 real deployment evidence']) if(!r.includes(s)) throw new Error('missing existing gate: '+s); console.log('pre-change README gates present; LICENSE absent as expected')"
```

Expected: prints the confirmation line and exits 0.

- [ ] **Step 2: Create the standard MIT license**

Create `LICENSE` with exactly:

```text
MIT License

Copyright (c) 2026 neko0115

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 3: Restructure the README first screen**

Keep the existing factual sections, but make the top of `README.md` follow this information hierarchy:

```markdown
# MC_AI_Player

Headless Minecraft Java cooperative-agent runtime for the Moxue project.

`MC_AI_Player` runs without the Minecraft Launcher or rendered client. Mineflayer performs deterministic game actions behind structured goal, safety, memory, and telemetry boundaries. The project is currently a pre-release runtime; the README distinguishes verified behavior from release gates that still need evidence.

## What it does today

- observes players, chat, health, inventory, and bounded self-position changes;
- executes allowlisted navigation, follow, survival, inventory, and scoped gather skills;
- stores world-scoped SQLite memory and emits validated runtime telemetry;
- exposes a local Control API / SSE surface for external orchestration;
- supports fake and Gemini decision-provider adapters behind structured decision validation;
- includes deterministic replay, regression, live-server, soak-contract, and chaos-harness tests.

## Safety model

- model output is parsed into strict structured decisions before gameplay execution;
- raw model text and hidden reasoning have no direct actuator path;
- navigation defaults to `canDig=false`; block mutation is limited to scoped gather flows;
- PvP is disabled by policy;
- non-loopback Control API binding requires bearer-token authentication.
```

Then retain/reorder the existing detailed sections so they appear in this order:

```text
Development status
Architecture / project boundary
Runtime baseline
Quick validation
Runtime configuration
Control API
Automated validation status
Pending release gates
Supported validation targets
Operations / design references
License
```

Add a final license section:

```markdown
## License

MIT — see [`LICENSE`](LICENSE).
```

Do not add a live DC_BOT repository link yet.

- [ ] **Step 4: Run README/license semantic checks**

Run:

```bash
node -e "const fs=require('node:fs'); const l=fs.readFileSync('LICENSE','utf8'); const r=fs.readFileSync('README.md','utf8'); for(const s of ['MIT License','Copyright (c) 2026 neko0115']) if(!l.includes(s)) throw new Error('license mismatch: '+s); for(const s of ['pre-release runtime','Real Gemini API compatibility','Production event-driven AI coordinator','30-minute private-server cooperative session','return_home','deposit_item','withdraw_item','Task 16 real deployment evidence','Linux ARM64 runtime measurements','4–8 hour soak','## License']) if(!r.includes(s)) throw new Error('README lost required statement: '+s); console.log('README/license semantic checks passed')"
```

Expected: `README/license semantic checks passed`.

- [ ] **Step 5: Commit**

```bash
git add LICENSE README.md
git commit -m "docs: prepare public project overview and MIT license"
```

---

### Task 2: Add canonical main/PR CI

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: existing npm scripts `probe`, `test`, `typecheck` and Node 24 lockfile.
- Produces: stable public CI check names for later branch protection.

- [ ] **Step 1: Verify no canonical workflow already exists**

Run:

```bash
node -e "const fs=require('node:fs'); if(fs.existsSync('.github/workflows/ci.yml')) throw new Error('ci.yml already exists'); console.log('ci.yml absent as expected')"
```

Expected: `ci.yml absent as expected`.

- [ ] **Step 2: Create `.github/workflows/ci.yml`**

Use exactly this workflow structure:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test:
    name: ${{ matrix.os }} / Node 24
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-24.04, windows-2025]
    runs-on: ${{ matrix.os }}
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: npm
          cache-dependency-path: package-lock.json
      - name: Install locked dependencies
        run: npm ci
      - name: Audit production dependencies
        run: npm audit --omit=dev --audit-level=high
      - name: Probe platform runtime
        run: npm run probe
      - name: Run test suite
        run: npm test
      - name: Typecheck
        run: npm run typecheck
```

- [ ] **Step 3: Verify canonical trigger and commands**

Run:

```bash
node -e "const fs=require('node:fs'); const y=fs.readFileSync('.github/workflows/ci.yml','utf8'); for(const s of ['name: CI','branches: [main]','ubuntu-24.04','windows-2025','npm ci','npm audit --omit=dev --audit-level=high','npm run probe','npm test','npm run typecheck']) if(!y.includes(s)) throw new Error('missing CI contract: '+s); console.log('canonical CI contract present')"
```

Expected: `canonical CI contract present`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add canonical main validation workflow"
```

---

### Task 3: Consolidate distinct live/release workflows and remove branch-era duplicates

**Files:**
- Create: `.github/workflows/live-validation.yml`
- Create: `.github/workflows/release-harness.yml`
- Remove: `.github/workflows/phase0.yml`
- Remove: `.github/workflows/live-gather-fix.yml`
- Remove: `.github/workflows/task8-navigation-live.yml`
- Remove: `.github/workflows/task9-inventory-live.yml`
- Remove: `.github/workflows/task10-gathering-live.yml`
- Remove: `.github/workflows/task11-sqlite-probe.yml`
- Remove: `.github/workflows/task12-reasoning-isolation.yml`
- Remove: `.github/workflows/task13-gemini-provider.yml`
- Remove: `.github/workflows/task14-control-api.yml`
- Remove: `.github/workflows/task15-cooperative-e2e.yml`
- Remove: `.github/workflows/task16-soak-chaos.yml`

**Interfaces:**
- Consumes: live E2E tests and `scripts/fetch-test-server.ts`, `scripts/soak.ts`, `tests/scenarios/chaos.test.ts`.
- Produces: two manual validation surfaces that are distinct from normal CI and do not imply human/hardware gates passed.

- [ ] **Step 1: Capture old workflow inventory before deletion**

Run:

```bash
node -e "const fs=require('node:fs'); const names=fs.readdirSync('.github/workflows').sort(); console.log(names.join('\n'))"
```

Expected: includes the branch-era workflow files listed in this task plus the new `ci.yml`.

- [ ] **Step 2: Create manual live-server validation workflow**

Create `.github/workflows/live-validation.yml`:

```yaml
name: Manual Live Server Validation

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  observation:
    runs-on: ubuntu-24.04
    timeout-minutes: 8
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: npm
      - uses: actions/setup-java@v5
        with:
          distribution: temurin
          java-version: '21'
      - run: npm ci
      - run: npm run fetch:test-server
        env:
          MC_TEST_VERSION: '1.21.1'
      - run: npm test -- tests/minecraft/observation-live.e2e.test.ts
        env:
          MC_LIVE_E2E: '1'
          MC_TEST_VERSION: '1.21.1'
          MC_TEST_PORT: '25570'

  navigation-smoke:
    runs-on: ubuntu-24.04
    timeout-minutes: 8
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: npm
      - uses: actions/setup-java@v5
        with:
          distribution: temurin
          java-version: '21'
      - run: npm ci
      - run: npm run fetch:test-server
        env:
          MC_TEST_VERSION: '1.21.1'
      - run: npm test -- tests/minecraft/navigation-live.e2e.test.ts
        env:
          MC_NAV_LIVE_E2E: '1'
          MC_TEST_VERSION: '1.21.1'
          MC_NAV_TEST_PORT: '25571'
          MC_NAV_DURATION_SCALE: '0.02'
          MC_NAV_MIN_SEQUENCE_MS: '30000'

  inventory:
    runs-on: ubuntu-24.04
    timeout-minutes: 8
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: npm
      - uses: actions/setup-java@v5
        with:
          distribution: temurin
          java-version: '21'
      - run: npm ci
      - run: npm run fetch:test-server
        env:
          MC_TEST_VERSION: '1.21.1'
      - run: npm test -- tests/minecraft/inventory-live.e2e.test.ts
        env:
          MC_INV_LIVE_E2E: '1'
          MC_TEST_VERSION: '1.21.1'
          MC_INV_TEST_PORT: '25573'

  gathering:
    runs-on: ubuntu-24.04
    timeout-minutes: 8
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: npm
      - uses: actions/setup-java@v5
        with:
          distribution: temurin
          java-version: '21'
      - run: npm ci
      - run: npm run fetch:test-server
        env:
          MC_TEST_VERSION: '1.21.1'
      - run: npm test -- tests/minecraft/gathering-live.e2e.test.ts
        env:
          MC_GATHER_LIVE_E2E: '1'
          MC_TEST_VERSION: '1.21.1'
          MC_GATHER_TEST_PORT: '25574'
```

Do not include the old ten-minute navigation run in the default manual workflow; the documented long-duration/hardware release gate remains separate and pending.

- [ ] **Step 3: Create manual release harness**

Create `.github/workflows/release-harness.yml`:

```yaml
name: Manual Release Harness

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  chaos-and-soak-contract:
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: npm
      - run: npm ci
      - run: npm test -- tests/scenarios/chaos.test.ts
      - name: Run short process-only soak smoke
        env:
          MC_SOAK_DURATION_MS: '50'
          MC_SOAK_INTERVAL_MS: '10'
        run: npx tsx scripts/soak.ts > soak-smoke.json
      - name: Confirm smoke remains incomplete evidence
        run: >-
          node -e "const fs=require('node:fs'); const d=JSON.parse(fs.readFileSync('soak-smoke.json','utf8')); if(d.summary.evidenceComplete!==false) throw new Error('process-only smoke must remain incomplete'); for(const s of ['pathfinderPlanningDurationMs','activeGoalAgeMs','eventQueueDepth','memoryRowCount','aiDecisionLatencyMs']) if(!d.summary.missingMetrics.includes(s)) throw new Error('missing explicit metric: '+s)"
```

- [ ] **Step 4: Remove superseded branch-era workflow files**

Delete exactly the ten files listed at the start of this task. Do not delete test files, scripts, fixtures, or operations docs.

- [ ] **Step 5: Verify the public workflow surface is intentionally small**

Run:

```bash
node -e "const fs=require('node:fs'); const names=fs.readdirSync('.github/workflows').sort(); const expected=['ci.yml','live-validation.yml','release-harness.yml']; if(JSON.stringify(names)!==JSON.stringify(expected)) throw new Error('unexpected workflows: '+JSON.stringify(names)); for(const f of ['live-validation.yml','release-harness.yml']) { const y=fs.readFileSync('.github/workflows/'+f,'utf8'); if(!y.includes('workflow_dispatch:')) throw new Error(f+' is not manual-only'); if(/feature\/phase0-platform-bootstrap|fix\/live-gather-recovery/.test(y)) throw new Error(f+' retains obsolete branch trigger'); } console.log('workflow surface consolidated')"
```

Expected: `workflow surface consolidated`.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows
git commit -m "ci: consolidate public validation workflows"
```

---

### Task 4: Run repository privacy/hygiene audit and document release metadata

**Files:**
- Modify: `README.md` only if audit reveals wording that exposes a private endpoint/path.
- No production source change expected.

**Interfaces:**
- Consumes: reachable Git tree/history and repository metadata.
- Produces: an auditable go/no-go decision for opening the repository.

- [ ] **Step 1: Check tracked files for runtime/private artifacts**

Run:

```bash
git ls-files | node -e "let s=''; process.stdin.on('data',d=>s+=d).on('end',()=>{const bad=s.split(/\r?\n/).filter(Boolean).filter(p=>/(^|\/)(\.env(\.|$)|data\/|logs\/|artifacts\/)|\.sqlite3?$|\.log$/i.test(p)); if(bad.length){console.error(bad.join('\n')); process.exit(1)} console.log('no tracked runtime/private artifact paths')})"
```

Expected: `no tracked runtime/private artifact paths`.

- [ ] **Step 2: Search tracked text for credential-shaped assignments and private filesystem paths**

Run:

```bash
node -e "const {execFileSync}=require('node:child_process'); const fs=require('node:fs'); const files=execFileSync('git',['ls-files','-z']).toString('utf8').split('\0').filter(Boolean); const suspicious=[]; const patterns=[/MC_AI_API_KEY\s*=\s*[^\s#]+/i,/MC_CONTROL_TOKEN\s*=\s*[^\s#]+/i,/AIza[0-9A-Za-z_-]{20,}/,/sk-[0-9A-Za-z_-]{20,}/,/C:\\\\Users\\\\[^\\\s]+/i,/\/home\/[^\/\s]+\//]; for(const f of files){let t; try{t=fs.readFileSync(f,'utf8')}catch{continue} for(const p of patterns){const m=t.match(p); if(m && !/=\s*$/.test(m[0]) && !m[0].includes('<secret>') && !m[0].includes('<explicit model>')) suspicious.push(f+': '+m[0].slice(0,120));}} if(suspicious.length){console.error(suspicious.join('\n')); process.exit(1)} console.log('tracked-text credential/path scan clear')"
```

Expected: `tracked-text credential/path scan clear`.

If this produces a real credential, stop the release process and rotate/revoke it before continuing.

- [ ] **Step 3: Check commit author/committer emails in reachable history**

Run:

```bash
git log --all --format='%H%x09%an%x09%ae%x09%cn%x09%ce' | node -e "let s=''; process.stdin.on('data',d=>s+=d).on('end',()=>{const rows=s.trim().split(/\r?\n/).filter(Boolean); const bad=rows.filter(r=>/@gmail\.com|@yahoo\.|@outlook\.|@hotmail\./i.test(r)); if(bad.length){console.error(bad.join('\n')); process.exit(1)} console.log('commit email audit clear')})"
```

Expected: `commit email audit clear`.

- [ ] **Step 4: Record repository metadata values for the post-merge settings step**

Use these exact values after the cleanup PR is merged:

```text
Description:
Headless Minecraft cooperative AI-agent runtime for Moxue, built with TypeScript, Mineflayer, structured safety gates, replayable tests, and SQLite memory.

Topics:
minecraft
mineflayer
typescript
ai-agent
llm
sqlite
raspberry-pi
automation

Homepage:
leave unset
```

This repository connection does not expose a safe repository-settings mutation for description/topics/visibility, so these values are an explicit post-merge GitHub Settings checkpoint rather than a hidden automated write.

- [ ] **Step 5: Commit only if audit-driven README changes were necessary**

If no tracked file changes were needed, do not create an empty commit.

If README changes were required:

```bash
git add README.md
git commit -m "docs: remove private release details"
```

---

### Task 5: Full cleanup-head verification and PR

**Files:**
- No new production files expected.
- Review all changed files against the public-readiness spec.

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: merge-ready `chore/public-readiness` PR evidence.

- [ ] **Step 1: Run the fresh full local verification**

Run:

```bash
npm test
npm run typecheck
git diff --check main...HEAD
git status --short
```

Expected:
- `npm test`: zero failures; live-environment skips are allowed only if they are the existing intentional skips.
- `npm run typecheck`: exit 0.
- `git diff --check main...HEAD`: no output.
- `git status --short`: no output.

Record the exact test/pass/fail/skip counts; do not reuse the historical 179/175/0/4 numbers unless the fresh output matches them.

- [ ] **Step 2: Verify cleanup scope**

Run:

```bash
git diff --name-only main...HEAD
```

Expected changed paths are limited to:

```text
.github/workflows/*
LICENSE
README.md
docs/superpowers/specs/2026-09-11-public-readiness-design.md
docs/superpowers/plans/2026-09-11-public-readiness.md
```

If `src/`, `tests/`, runtime fixtures, or package dependency files changed unexpectedly, stop and review before PR creation.

- [ ] **Step 3: Create the public-readiness PR**

Title:

```text
Prepare MC_AI_Player for public release
```

PR body must include:

```markdown
## Summary

Repository-only public-readiness cleanup for the existing Phase 0 pre-release runtime.

- adds MIT licensing;
- restructures the README for portfolio/public readers while preserving explicit pending gates;
- replaces branch-era CI clutter with one canonical Windows/Linux CI workflow;
- keeps distinct live-server and soak/chaos checks as manual validation workflows;
- performs a final secret/privacy/history audit;
- does not change gameplay runtime behavior or claim unfinished release gates as PASS.

## Validation

- `npm test`: <fresh exact counts>
- `npm run typecheck`: PASS
- `git diff --check main...HEAD`: clean
- working tree: clean
- tracked runtime/private artifact scan: clear
- tracked credential/private-path scan: clear
- commit email audit: clear

## Still pending / not claimed as PASS

- real Gemini API/model/schema compatibility
- production event-driven autonomous coordinator
- 30-minute human cooperative session
- production `return_home` / `deposit_item` / `withdraw_item` wiring
- Linux ARM64 / Raspberry Pi / intended mini-PC measurements
- 4–8 hour soak evidence
- DC_BOT integration

## Post-merge release steps

Repository metadata, obsolete merged-branch deletion, visibility change to Public, public CI observation, and branch protection happen only after this PR is merged.
```

Run RewriteLy Humanizer on the prose portions only, then manually compare its output against this source and restore any altered technical terms/counts before submitting.

- [ ] **Step 4: Review PR diff and CI status**

Confirm:
- canonical `CI` checks are the only automatic normal health checks;
- manual validation workflows do not auto-run on normal pushes;
- PR changed paths remain repository-level only;
- no pending gate disappeared from README or PR body.

Do not merge until the repository owner explicitly approves.

---

### Task 6: Post-merge repository release operations

**Files:**
- No source changes required unless a public-CI defect is discovered.

**Interfaces:**
- Consumes: merged public-readiness PR.
- Produces: public repository baseline with stable CI evidence.

- [ ] **Step 1: Confirm the merge result on `main`**

Verify the merge commit contains:

```text
LICENSE
.github/workflows/ci.yml
.github/workflows/live-validation.yml
.github/workflows/release-harness.yml
portfolio README
```

and does not contain the removed branch-era workflow files.

- [ ] **Step 2: Delete obsolete remote branches after containment check**

Before deletion, verify:

```bash
git fetch origin
git merge-base --is-ancestor origin/feature/phase0-platform-bootstrap origin/main
git merge-base --is-ancestor origin/fix/live-gather-recovery origin/main
```

Expected: both commands exit 0.

Then delete only:

```text
feature/phase0-platform-bootstrap
fix/live-gather-recovery
```

Do not delete `main`. Delete `chore/public-readiness` only after its merge is confirmed and no follow-up work remains on it.

- [ ] **Step 3: Apply GitHub repository metadata in Settings**

Set the description/topics exactly to the values recorded in Task 4. Leave homepage unset.

- [ ] **Step 4: Run one final read-only secret/privacy check on merged `main`**

Repeat Task 4 Steps 1–3 against updated `main`. Any newly discovered real credential blocks the visibility change until rotation/removal is complete.

- [ ] **Step 5: Change repository visibility to Public in GitHub Settings**

Confirm the repository is `neko0115/MC_AI_Player` before accepting GitHub's visibility-change confirmation.

- [ ] **Step 6: Observe canonical public CI on `main`**

Wait for the `CI` workflow on the public `main` baseline and record both matrix results:

```text
ubuntu-24.04 / Node 24
windows-2025 / Node 24
```

A successful public CI run is evidence only for install/audit/probe/full-tests/typecheck on those runners. It does not satisfy the explicitly pending Gemini/human/hardware/long-soak gates.

- [ ] **Step 7: Configure basic `main` protection after stable check names exist**

In GitHub branch/rules settings, require pull requests for future changes and require the stable canonical `CI` checks. Do not require manual live/release workflows for every pull request.

- [ ] **Step 8: Defer DC_BOT cross-link to the joint-public checkpoint**

Once `DC_BOT` is independently public-ready, make a separate documentation-only change that links the two repositories and describes them as separate runtimes in the same Moxue system. Do not claim production integration until separate implementation/validation exists.

---

## Plan self-review

### Spec coverage

- MIT License: Task 1.
- Portfolio README without hidden PASS claims: Task 1.
- Canonical main/PR CI: Task 2.
- Branch-era workflow cleanup without deleting regression tests: Task 3.
- Distinct manual live/release evidence preserved: Task 3.
- Secret/privacy/history audit: Task 4.
- Repository metadata: Task 4 + Task 6.
- Fresh cleanup-head validation: Task 5.
- PR review/explicit merge approval: Task 5.
- Obsolete branch cleanup: Task 6.
- Public visibility + public CI + protection: Task 6.
- DC_BOT isolation/cross-link deferral: Global Constraints + Task 6.

No production runtime change is required by this plan.

### Placeholder scan

No `TBD`, `TODO`, or unspecified implementation step remains. Commands, filenames, workflow contents, metadata values, and PR body requirements are explicit.

### Consistency check

The three final workflow filenames are consistently:

```text
.github/workflows/ci.yml
.github/workflows/live-validation.yml
.github/workflows/release-harness.yml
```

The canonical CI matrix is consistently Node 24 on `ubuntu-24.04` and `windows-2025`.
