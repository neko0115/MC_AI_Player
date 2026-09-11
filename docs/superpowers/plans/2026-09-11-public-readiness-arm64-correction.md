# Public Readiness ARM64 Validation Correction

This correction supplements `2026-09-11-public-readiness.md` after final PR review.

## Reason

The original plan consolidated the current workflow tree to three files. During review, the removed Task 11 workflow was found to carry one non-duplicated check: `better-sqlite3` / SQLite memory compatibility on a real Linux ARM64 GitHub-hosted runner.

The canonical `ci.yml` covers Windows and Linux x64 only, so deleting Task 11 without a replacement would silently reduce cross-architecture validation.

## Corrected workflow surface

Keep exactly these four current workflows:

```text
.github/workflows/ci.yml
.github/workflows/live-validation.yml
.github/workflows/arm64-validation.yml
.github/workflows/release-harness.yml
```

`arm64-validation.yml` is manual-only and runs:

```text
npm ci
npm audit --omit=dev --audit-level=high
EXPECTED_ARCH=arm64 node scripts/probe-sqlite-driver.mjs
npm test -- tests/memory/repository.test.ts tests/memory/restart.test.ts
npm run typecheck
```

It uses `ubuntu-24.04-arm` and does not replace the still-pending Raspberry Pi, mini-PC, or long-duration deployment gates.

## Verification

Before merge, verify:

```bash
node -e "const fs=require('node:fs'); const names=fs.readdirSync('.github/workflows').sort(); const expected=['arm64-validation.yml','ci.yml','live-validation.yml','release-harness.yml']; if(JSON.stringify(names)!==JSON.stringify(expected)) throw new Error('unexpected workflows: '+JSON.stringify(names)); const y=fs.readFileSync('.github/workflows/arm64-validation.yml','utf8'); for(const s of ['workflow_dispatch:','ubuntu-24.04-arm','EXPECTED_ARCH: arm64','scripts/probe-sqlite-driver.mjs','tests/memory/repository.test.ts','tests/memory/restart.test.ts','npm run typecheck']) if(!y.includes(s)) throw new Error('missing ARM64 contract: '+s); console.log('ARM64 workflow correction present')"
```

Expected: `ARM64 workflow correction present`.
