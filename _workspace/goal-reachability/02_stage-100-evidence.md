# Stage 100 Evidence — Runtime Projection Quarantine Resolution

## Stage Objective

Resolve runtime projection quarantine without silently ignoring legacy ledgers: safely migrate valid old-schema events with deterministic hash-chain backfill or keep invalid ledgers quarantined; add regression tests; make Product Gate reconciliation true only when projection errors are cleared.

## Changed Files

- `src/core.ts`
- `src/runtime-architecture.test.ts`

## What Improved Toward Final Authority

Before this stage:

- Product Gate hard ceiling evidence included `reconciliation=false`.
- `.agent/projection/runtime-projection-errors.json` listed legacy runs missing `prev_event_sha256`.

After this stage:

- valid old-schema events are normalized for projection only by backfilling `prev_event_sha256` from the previous normalized event or genesis hash;
- migration requires non-missing core fields, valid sequence, object payload, artifact_refs array, and matching payload hash;
- non-migratable legacy events remain quarantined;
- `.agent/projection/runtime-projection-migrations.json` records every projection-only migration;
- `.agent/projection/runtime-projection-errors.json` now reports `status: PASS` with `errors: []` on the current repo;
- latest Product Gate hard ceiling evidence now says `reconciliation=true`.

## Regression Evidence

Commands:

```bash
npm run build
node --test dist/runtime-architecture.test.js --test-name-pattern="G010|Phase 2"
node scripts/goal-reachability-harness.mjs --run-authority
```

Results:

- targeted tests: PASS, 51/51 under `G010|Phase 2` pattern
- authority: still BLOCKED, but reconciliation improved from false to true
- latest Product Gate: `.agent/product-gates/product-gate-20260604050511.json`
- projection errors: `.agent/projection/runtime-projection-errors.json` status PASS, errors []
- projection migrations: `.agent/projection/runtime-projection-migrations.json` status MIGRATED

## Current Product Completion Status

`BLOCKED`. Remaining Product Gate blockers are now narrower:

- Product Completeness Gate FAIL;
- Promotion Learning Gate FAIL;
- Hard Completion Ceiling Gate FAIL because hard gate docs still declare one FAIL row and independent review is false/no-signing-key.

## Why This Stage Can Pass While Product Gate Still Fails

This stage removed the reconciliation blocker. It does not claim to repair promotion learning proof or independent review provenance. The next exact blocker is G011: Promotion Learning Gate FAIL.
