# Stage 10 Evidence — Gap Baseline and Priority Map

## Stage Objective

Read the goal contract, team spec, latest review findings, and current reachability report. Produce a prioritized final-authority gap map before implementation.

## Final Authority Snapshot

Command:

```bash
node scripts/goal-reachability-harness.mjs --run-authority
```

Current result: `BLOCKED`, exit `1`.

Current machine evidence:

- latest Product Gate artifact: `.agent/product-gates/product-gate-20260603231855.json`
- latest Product Gate decision: `FAIL`
- completion ceiling: `60`
- authority command failure: `node dist/cli.js quality gate --write`
- authority stderr: `runtime event missing required envelope fields`

## Why Prior Divide-and-Conquer Failed

The prior run completed subgoals and tests, but it did not make the final authority executable and green. The current final authority still fails before it can produce a fresh Product Gate PASS because legacy runtime ledger data aborts projection/reconciliation. Separately, the latest independent review identified security/proof-boundary blockers that would make any PASS untrustworthy until fixed.

## Prioritized Gap Map

| Priority | Blocker | Why this order | Required improvement toward final authority |
| --- | --- | --- | --- |
| P0 | Product Gate crashes on legacy runtime ledgers | The authority command cannot even finish, so no later PASS can be trusted or observed. | Product Gate must quarantine/report invalid ledgers as structured blockers instead of throwing. |
| P1 | Verifier evidence boundary: command execution + symlink/digestless HARD artifact proof | Even if Product Gate runs, HARD evidence can be claimant-controlled or executable. | Verifier must be non-executing for untrusted contract inputs, realpath-safe, symlink rejecting, and digest-required for HARD artifacts. |
| P2 | Independent review custody workflow caller-controlled issuer | Final hard-completion review proof can be self-selected by workflow caller. | Trusted issuer must be pinned outside user input; review artifacts must be CI/reviewer-owned. |
| P3 | CI `npm ci || npm install` fallback | Review can pass under a dependency graph not represented by lockfile. | CI must use `npm ci` only. |
| P4 | Integrated authority and final review | After fixes, prove direction by rerunning harness authority and independent review. | `--run-authority` PASS plus clean final review gate. |

## What Improved In This Stage

No production code changed in this stage. What improved is the control loop: the next stages are ordered by final-authority dependency, not by convenience. The first implementation target is Product Gate crash-to-structured-failure because it blocks observing any real Product Gate PASS.

## What Remains Blocked

Everything remains blocked until implementation stages fix P0-P3 and the final authority passes. This stage is allowed to pass while Product Gate still fails because its contract is a baseline/priority artifact, not a product-completion claim.

## Commands Run

```bash
node scripts/goal-reachability-harness.mjs
node scripts/goal-reachability-harness.mjs --run-authority
```
