# Stage 20 Evidence — Harden Verifier Evidence Boundary

## Stage Objective

Fix skill-contract verifier untrusted command execution plus artifact verifier symlink escape and digest-optional HARD proof. Add regression tests proving command execution does not happen, symlink evidence is rejected, and HARD artifact bindings require expectedSha256.

## Changed Files

- `src/harness/verifier.ts`
- `src/harness/verifier.test.ts`
- `src/harness/skill-contracts.ts`
- `src/runtime-architecture.test.ts`

## What Improved Toward Final Authority

This stage closes the proof-boundary blocker that could make a future Product Gate PASS untrustworthy:

1. `artifact` verifier now requires `expectedSha256` instead of accepting mutable presence-only evidence.
2. `artifact` verifier resolves real paths, rejects symlink evidence, and ensures the final target remains inside the repo root.
3. `test` verifier no longer executes contract-provided commands. It returns `unproven` and instructs callers to use digest-bound artifacts or ledger proof.
4. HARD skill contracts explicitly reject digestless artifact bindings and `test` verifier bindings.

## Regression Evidence

Commands:

```bash
npm run build
node --test dist/harness/verifier.test.js
node --test dist/runtime-architecture.test.js --test-name-pattern="G002|G009"
npm run typecheck -- --pretty false
```

Results:

- verifier tests: PASS, 5/5
- runtime architecture targeted tests: PASS, 49/49 under `G002|G009` pattern
- typecheck: PASS

New regression coverage:

- symlink artifact pointing outside root returns `unproven` and cannot satisfy evidence;
- `test` verifier command that would write `verifier-rce.txt` is not executed;
- HARD skill contracts reject digestless artifact bindings;
- HARD skill contracts reject non-executing `test` bindings and produce no command side effect.

## Current Product Completion Status

Still `BLOCKED`. `node scripts/goal-reachability-harness.mjs --run-authority` still exits `1` because Product Gate crashes on legacy runtime events with `runtime event missing required envelope fields`.

## Why This Stage Can Pass While Product Gate Still Fails

This stage was scoped to make future evidence trustworthy, not to make Product Gate executable. The next blocker remains P0/Priority G003: Product Gate must quarantine/report legacy ledgers instead of aborting.
