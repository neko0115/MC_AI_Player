# Public Readiness ARM64 Validation Amendment

Status: Approved during final review on 2026-09-11.

This amendment clarifies the manual-validation portion of `2026-09-11-public-readiness-design.md`.

The original cleanup removed branch-era task workflows in favor of a smaller public workflow surface. Final review found that the old Task 11 workflow contained one validation dimension that is not duplicated by the canonical Windows/Linux x64 CI: native SQLite compatibility on Linux ARM64.

Keep that distinct evidence as a manual-only workflow:

```text
.github/workflows/arm64-validation.yml
```

It must:

- use `workflow_dispatch` only;
- run on `ubuntu-24.04-arm`;
- install the locked Node 24 dependencies;
- run `node scripts/probe-sqlite-driver.mjs` with `EXPECTED_ARCH=arm64`;
- run `tests/memory/repository.test.ts` and `tests/memory/restart.test.ts`;
- run `npm run typecheck`;
- remain separate from the automatic `main` / pull-request CI.

The public workflow surface is therefore four workflows:

```text
ci.yml                 automatic Windows/Linux x64 repository health
live-validation.yml    manual Minecraft live-server validation
arm64-validation.yml   manual Linux ARM64 native SQLite/memory validation
release-harness.yml    manual chaos and process-only soak contract
```

This amendment does not claim Raspberry Pi, intended mini-PC, long-soak, or general ARM64 deployment evidence as PASS. It preserves only the native ARM64 compatibility check that existed before workflow consolidation.
