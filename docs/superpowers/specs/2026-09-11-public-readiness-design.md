# MC_AI_Player Public Readiness Design

Status: Approved in chat for design direction; implementation has not started.

## Goal

Prepare `neko0115/MC_AI_Player` for public portfolio/open-source release without changing gameplay runtime behavior or overstating validation status.

The cleanup should make the repository easy for a new reader to understand, give `main` a canonical CI path, add an explicit MIT license, remove stale branch-era repository clutter, and preserve the existing development/TDD history as evidence.

## Non-goals

This work does not:

- change Minecraft gameplay behavior;
- add or complete the autonomous AI coordinator;
- claim real Gemini API compatibility;
- claim the 30-minute human cooperative gate has passed;
- claim ARM64, Raspberry Pi, mini-PC, or 4-8 hour soak evidence;
- wire `return_home`, `deposit_item`, or `withdraw_item` into production;
- modify `DC_BOT`;
- claim MC_AI_Player and DC_BOT are already production-integrated;
- rewrite Git history.

## Starting point

Public-readiness work starts from the merged Phase 0 pre-release baseline on `main`:

```text
0b6866610dba32060f63cf807d1802f463f6d1d4
```

The cleanup branch is:

```text
chore/public-readiness
```

The current runtime is a tested pre-release baseline, not a finished v1 release.

## 1. License

Add a standard MIT `LICENSE` file using:

```text
Copyright (c) 2026 neko0115
```

Keep `package.json` with `"private": true` so the package cannot be published to npm accidentally. GitHub repository visibility and npm package publishability are independent concerns.

## 2. README portfolio structure

Keep the current technical truthfulness but improve the first-screen reading experience.

The README should open with a concise project description that explains:

- this is a headless Minecraft Java cooperative-agent runtime;
- it is the Minecraft-side runtime for the Moxue project;
- it uses deterministic Mineflayer actions behind structured AI/safety boundaries;
- it is currently pre-release.

Recommended top-level information order:

1. Project summary.
2. What the runtime can do today.
3. Architecture and safety boundary.
4. Quick validation / local setup.
5. Control API surface.
6. Current validation evidence.
7. Explicit pending release gates.
8. Deployment/operations references.
9. Relationship to DC_BOT once DC_BOT is public.
10. License.

Do not convert pending gates into decorative green badges or completion claims.

Until DC_BOT is public, mention the broader Moxue system only generically. Add the final bidirectional repository link in a later cross-link change after both repositories are public-ready.

## 3. Canonical CI

The current workflows were accumulated by implementation phase and many still listen to historical feature branches. They are useful development history but are not a clean long-term public CI surface.

Create one canonical workflow for normal repository health, for example:

```text
.github/workflows/ci.yml
```

Triggers:

```text
push -> main
pull_request -> main
```

Run a Windows/Linux matrix and perform at minimum:

```text
npm ci
npm audit --omit=dev --audit-level=high
npm run probe
npm test
npm run typecheck
```

The canonical workflow is the default public repository health gate.

Historical task workflows should not all be mechanically changed to `push: main`, because that would create overlapping duplicate CI for normal commits.

Instead, classify them into two groups:

### Historical implementation gates

Workflows whose value was tied to a completed implementation branch should be removed from the current tree once the equivalent regression coverage is already part of the full suite. Their old definitions and runs remain preserved in Git history.

Examples include branch-specific gather recovery or Phase 0 task gates that duplicate the canonical suite.

### Explicit/manual release validation

A small number of workflows may remain if they provide genuinely distinct evidence that should be manually invoked or used for release validation. They must not imply that unavailable live/hardware evidence has passed.

No workflow cleanup may weaken or delete regression tests themselves.

## 4. Repository metadata

Prepare public-facing GitHub metadata.

Recommended description:

```text
Headless Minecraft cooperative AI-agent runtime for Moxue, built with TypeScript, Mineflayer, structured safety gates, replayable tests, and SQLite memory.
```

Recommended topics:

```text
minecraft
mineflayer
typescript
ai-agent
llm
sqlite
raspberry-pi
automation
```

Homepage may remain unset until there is a stable project page or portfolio landing page.

## 5. Branch cleanup

After the public-readiness PR is merged and verified, remove obsolete remote branches that are fully contained in `main`, including:

```text
feature/phase0-platform-bootstrap
fix/live-gather-recovery
```

Do not delete `chore/public-readiness` until its merge is complete.

Do not rewrite or squash old history solely for aesthetic cleanup; the existing RED/GREEN and review history is valuable portfolio evidence.

## 6. Secret and privacy audit

Before changing visibility, run a final read-only audit of the current tree and reachable history for:

- real `.env` files;
- API keys/tokens;
- Microsoft/Minecraft authentication material;
- private server addresses that should not be public;
- runtime SQLite databases;
- logs and generated artifacts;
- personal filesystem paths;
- private email addresses in commit metadata.

The existing ignore policy for `.env`, `data/`, `logs/`, and `artifacts/` should remain.

If a real credential is discovered, stop the public-release process and rotate/revoke it before any visibility change.

## 7. Validation before merge

Because this cleanup should not alter production runtime behavior, validation focuses on proving repository cleanup did not break the project.

Before merging the public-readiness PR, require:

```text
npm test
npm run typecheck
git diff --check
```

Also review the PR diff to ensure only documentation, workflow, license, and repository-hygiene changes are present unless a separately approved bug fix becomes necessary.

The last known pre-cleanup local baseline is:

```text
179 tests
175 passed
0 failed
4 skipped live-environment tests
npm run typecheck PASS
```

Fresh results on the cleanup head are required before merge; the historical result is not a substitute.

## 8. Visibility transition

Do not switch the repository to Public until the public-readiness PR is merged and the final audit is clear.

Recommended sequence:

1. Merge the public-readiness PR into `main`.
2. Confirm `main` contains the intended LICENSE/README/CI state.
3. Delete obsolete merged branches.
4. Perform one last secret/privacy audit.
5. Change repository visibility to Public.
6. Run/observe the canonical public GitHub Actions workflow on `main`.
7. Treat public CI as new Windows/Linux evidence for the published baseline.
8. Add branch protection/rules for `main` after the canonical checks have stable names.

Public CI success does not satisfy real Gemini, human-session, ARM64, Raspberry Pi, mini-PC, or long-soak gates.

## 9. DC_BOT boundary

`DC_BOT` is being completed and sanitized independently.

This cleanup must not modify DC_BOT refs, branches, history, files, PRs, or metadata.

Once both repositories are public-ready, add a separate cross-link change that describes them as two runtimes in the same Moxue system:

```text
DC_BOT       -> Discord, social/memory/tool runtime
MC_AI_Player -> Minecraft cooperative-agent runtime
```

Do not claim completed production integration until that integration has separate implementation and validation evidence.

## 10. Writing style

Public-facing prose should be concise, technical, and natural rather than promotional or AI-generated sounding.

When an approved writing/humanizer plugin is connected, it may be used as a final prose-editing pass for README/PR/portfolio text. It must not alter technical claims, validation counts, safety boundaries, command examples, or pending-gate semantics.

## Acceptance criteria

The public-readiness work is complete only when:

- MIT license is present;
- README gives a clear portfolio-quality overview while preserving pending gates;
- one canonical `main`/PR CI workflow exists;
- redundant branch-specific workflow clutter is removed or intentionally retained as manual release validation;
- no production runtime behavior is changed by the cleanup;
- fresh full tests and typecheck pass on the cleanup head;
- secret/privacy audit finds no blocker;
- obsolete merged branches are removed after merge;
- repository metadata is prepared;
- repository can be switched to Public without hidden completion claims;
- post-public canonical CI result is recorded separately from unvalidated live/hardware gates.
