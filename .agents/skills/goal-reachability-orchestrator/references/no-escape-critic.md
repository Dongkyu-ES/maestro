# No-Escape Critic

Use this reference for the critic pass after every stage.

## Critic Questions

1. Does this stage cite the goal contract's final authority, or only local work?
2. Did it reduce a known Product Gate/review blocker, or just add another artifact?
3. Is any CRITICAL/HIGH issue unresolved?
4. Could the stage pass while the final Product Gate still fails? If yes, why is that acceptable and where is it declared?
5. Are there mutable or caller-controlled trust roots?
6. Is any verifier executing untrusted input, following symlinks, accepting digestless HARD evidence, or trusting prose?
7. Is the evidence current, or stale from a previous run?

## Verdicts

- `PASS`: final-gate delta proven, no unresolved CRITICAL/HIGH blocker.
- `FIX`: small repair needed before the stage can count.
- `BLOCK`: stage cannot count without changing scope, authority, custody, or cross-stage proof.

## Required Output Shape

```markdown
# Stage {NN} Critique

Verdict: PASS|FIX|BLOCK

## Final-Authority Delta
- claimed delta:
- verified evidence:

## Blocking Findings
- severity:
- file/artifact:
- reason:
- smallest fix:

## Non-Blocking Follow-ups
- item:
```
