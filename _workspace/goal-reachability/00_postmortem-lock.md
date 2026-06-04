# Goal Reachability Postmortem Lock

## Blunt Failure Reflection

We repeatedly specified a goal, divided it, and executed stages, yet missed the destination because the closure rule was wrong. The process optimized for sub-goal completion, artifact presence, and test success while the repository's own final authority still reported blocked completion.

## Root Causes Converted to Invariants

1. **Checkpoint completion is not goal completion.**
   - Invariant: ultragoal/checkpoint status can only be supporting evidence.
2. **Tests passing is not Product Gate passing.**
   - Invariant: if Product Gate is the authority, final status follows Product Gate.
3. **Critique without stop power is theater.**
   - Invariant: CRITICAL/HIGH critique findings block stage closure.
4. **A stage that does not move a final-gate condition is not progress.**
   - Invariant: every stage declares a final-authority delta before execution.
5. **Trust roots cannot be caller-controlled.**
   - Invariant: custody and review issuers must be pinned or externally attested.
6. **Verifier evidence cannot be executable or mutable by the claimant.**
   - Invariant: no untrusted command execution, symlink evidence, or digestless HARD artifact proof.
7. **Stale local evidence must fail structured, not crash or be ignored.**
   - Invariant: legacy/invalid ledgers are quarantined and reported as blockers.

## Forbidden Completion Phrase

Do not say "complete", "reached", "done", or "95%" for a Product Gate goal until the final authority report is PASS and no CRITICAL/HIGH blocker remains.

## Allowed Partial Phrase

Use `PROGRESS_WITH_BLOCKERS` or `BLOCKED_BY_<authority>` with the exact blocker list.
