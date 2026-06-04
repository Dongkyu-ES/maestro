# Stage 30 Evidence — Product Gate Structured Legacy Ledger Failure

## Stage Objective

Fix legacy runtime ledger crashes so Product Gate quarantines/reports invalid ledgers as structured blockers instead of aborting. Add regression tests with old-schema events.

## Changed Files

- `src/core.ts`
- `src/product-gate.ts`
- `src/runtime-architecture.test.ts`

## What Improved Toward Final Authority

Before this stage, the final authority command failed with process exit `1` and stderr:

```text
runtime event missing required envelope fields
```

After this stage:

- `rebuildRuntimeProjectionStore()` validates ledgers per run;
- invalid/legacy ledgers are excluded from projection instead of throwing;
- quarantine details are written to `.agent/projection/runtime-projection-errors.json`;
- Product Gate includes projection errors in the Artifact reconciliation hard gate;
- `node dist/cli.js quality gate --write` now completes and writes a Product Gate report;
- `node scripts/goal-reachability-harness.mjs --run-authority` now blocks with structured Product Gate evidence instead of crashing.

## Regression Evidence

Commands:

```bash
npm run build
node --test dist/runtime-architecture.test.js --test-name-pattern="G003|Phase 2"
node scripts/goal-reachability-harness.mjs --run-authority
```

Results:

- targeted runtime architecture tests: PASS, 50/50 under `G003|Phase 2` pattern
- authority command: still BLOCKED, but now `authority_result.exit_code` is `2`, not crash exit `1`
- latest Product Gate report: `.agent/product-gates/product-gate-20260604045811.json`
- projection quarantine artifact: `.agent/projection/runtime-projection-errors.json`

## Current Product Completion Status

Still `BLOCKED`. The exact next blockers are now visible in Product Gate output:

- Product Completeness Gate FAIL;
- Promotion Learning Gate FAIL;
- Artifact reconciliation false because runtime projection errors exist;
- Hard Completion Ceiling Gate FAIL;
- independent review false / no signing key.

## Why This Stage Can Pass While Product Gate Still Fails

The stage objective was to make the authority observable and fail-closed, not to make all hard gates pass. Product Gate now fails in the correct direction: with durable JSON evidence rather than an unhandled exception.
