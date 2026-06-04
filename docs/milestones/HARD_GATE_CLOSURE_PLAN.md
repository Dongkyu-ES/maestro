# Hard Gate Closure Plan: Why It Still Fails and What Actually Closes It

**Date:** 2026-06-02
**Current verdict:** FAIL / completion ceiling 60
**Allowed claim until this plan is implemented:** Prototype / control-plane scaffold with hard blockers; 90/95 claims forbidden.

## Bottom line

The product does **not** fail because of missing prose. It fails because the current evidence can still be produced by a mostly deterministic control plane with role/process scaffolding and self-owned review artifacts. A real closure requires executable role behavior, a review-derived promotion loop, and reviewer/CI custody that the implementer cannot self-certify.

## Current failing gates

Latest local product gate artifact must be resolved at verification time with `ls -t .agent/product-gates/product-gate-*.json | head -1`; hardcoding a stale report path is not acceptable. The latest rerun observed during this update is FAIL / ceiling 60.

| Gate | Current state | Why it fails | Real closure condition |
| --- | --- | --- | --- |
| Product Completeness Gate | FAIL | `FULL_PRODUCT_ROADMAP.md` still admits current blockers: disputed/scaffolded status, v1 role behavior PARTIAL, promotion lifecycle PARTIAL, anti-self-deception FAIL-CLOSED. | Roadmap blockers may be removed only after executable tests and live artifacts prove the v1 role loop and promotion loop are real product behavior. |
| Hard Completion Ceiling Gate | FAIL | hard-gate table still has one FAIL row and independent-review provenance is absent or not custody-attested. | `agent quality gate --write` returns PASS with ceiling 95 only after product completeness passes and a reviewer/CI-owned custody signature validates current review artifacts. |

## Root causes, not symptoms

### R1. v1 role execution is process evidence, not differentiated role behavior

Current anchor: `src/core.ts` `runRoles(...)` runs the same operator command three times with `ROLE=manager`, `ROLE=worker`, and `ROLE=reviewer`, then appends exit evidence to `manager-plan.md`, `worker-outputs/worker-001.md`, and `review.md`.

That proves subprocess execution. It does **not** prove that:

- manager decomposed the task into a validated work order;
- worker consumed that work order and produced scoped output;
- reviewer evaluated the manager plan, worker output, diff, logs, and policy artifacts;
- the three roles had different schemas, inputs, outputs, or decision responsibilities.

### R2. promotion plumbing exists, but the learning loop is not proven

Current anchor: `classifyRunPromotions(...)`, `proposeApply(...)`, and `applyApprovedProposal(...)` can create and apply deterministic promotion records or patch bundles. That proves lifecycle plumbing. It does **not** prove a PRD-level loop where review findings produce a promotion, approval applies it, and a later run changes behavior because of that applied learning.

### R3. independent review can be mechanically signed, but independence is operational

Current anchor: `docs/milestones/REVIEW_PROVENANCE.md` and `agent runtime sign-review --custody ...` require artifact and custody HMACs. This blocks hand-authored fixtures, but it still cannot prove independence if the implementer owns the keys. Completion needs a reviewer/CI-owned signing path outside the implementer write path.

### R4. historical reports inflated completion and must remain subordinate to the gate

Historical PASS wording in milestone reports can confuse future agents. The current gate correctly treats roadmap blockers and forbidden high-completion claims as fail-closed. The closure path must not remove those blockers until behavior is proven by tests and live artifacts.

## Non-negotiable implementation plan

### P0. Keep the current fail-closed guardrails

**Do not** raise `CURRENT_COMPLETION_CEILING` or remove `DISPUTED`, `PARTIAL`, or `FAIL-CLOSED` wording before P1-P4 pass.

Required checks:

- fake/string-only roadmap cannot pass;
- roadmap current blockers block Product Completeness;
- unsigned/forged/no-custody independent review cannot lift the ceiling;
- forbidden 90/95 claims are scanned when hard gate lift is blocked.

### P1. Make Manager/Worker/Reviewer real product roles

Implement a role artifact contract:

| Role | Required artifact | Required content |
| --- | --- | --- |
| Manager | `manager-plan.json` | task hash, context hash, acceptance criteria, work orders, risk/policy hints, schema version |
| Worker | `worker-outputs/<id>.json` | consumed work order hash, command/process refs, touched files/diff hash, result summary, refusal/blocker fields |
| Reviewer | `review.json` | manager plan hash, worker output hashes, diff/process refs, decision, findings, promotion candidates |

Gate/test requirements:

1. `ROLE`-env-only execution must fail the v1 role gate.
2. manager/worker/reviewer artifacts must be schema-distinct.
3. worker output must reference a manager work-order hash.
4. reviewer output must reference manager and worker hashes plus process/diff evidence.
5. reviewer decision must fail if referenced evidence is missing, stale, or mismatched.
6. web run detail must expose these role artifacts, not just markdown placeholders.

Why this closes R1: it turns role execution from “three commands ran” into a verifiable role graph with typed inputs/outputs and evidence bindings.

### P2. Prove review-derived promotion and learning loop

Implement a promotion proof artifact:

- `promotion-candidates.json` generated from `review.json` findings;
- `promotion-approval.json` linked to candidate hashes;
- `promotion-apply.json` with applied target, before/after hash, and policy boundary;
- `promotion-effect.json` from a later run, but only as an index to recomputable evidence; the gate must not trust the file by itself.

Gate/test requirements:

1. hardcoded/default promotion candidates must not pass.
2. a promotion candidate must cite a specific review finding hash.
3. approval must bind to the exact candidate hash.
4. apply must update only approved target paths and record before/after hashes.
5. the gate must recompute a same-task/context before-run vs after-run pair;
6. the after-run must contain runtime evidence that the applied promotion artifact was loaded into input/context/policy/prompt;
7. the changed recommendation/guard/workflow/instruction must be a stable field, not freeform prose;
8. before/after hashes, review finding hash, candidate hash, approval hash, apply hash, and effect hash must form one chain;
9. a hand-written `promotion-effect.json` without recomputable runtime evidence must fail;
10. product gate requires this loop before the roadmap `Promotion proposals` row can become PASS.

Why this closes R2: it proves the PRD learning loop, not only proposal/apply mechanics.

### P3. Move independent review signing outside implementer custody

Implement one of these paths:

- CI job with reviewer-owned secrets `AGENT_REVIEW_HMAC_KEY` and `AGENT_REVIEW_CUSTODY_HMAC_KEY`;
- reviewer-owned local signer run outside the implementer workspace;
- dedicated review service emitting `.agent/independent-review-gate.json`;
- `.github/workflows/independent-review-gate.yml` with reviewer-owned HMAC secrets and workflow-dispatch inputs for reviewer/architect artifacts.

Required signer behavior:

1. signer recomputes current review-input hash;
2. signer validates referenced reviewer and architect artifacts;
3. signer writes artifact signature and custody signature;
4. signer records custody label such as `reviewer-ci`;
5. signer records non-self custody evidence, for example `custody_issuer`, `ci_run_id`/`review_session_id`, `reviewer_agent_id`, and signed artifact paths;
6. product gate accepts only configured trusted custody labels plus required issuer/session metadata;
7. product gate rejects test fixture labels, missing issuer/session metadata, committed key material, project-tree key paths, and implementer-owned local custody for completion claims.

Why this closes R3: it separates mechanical artifact integrity from reviewer custody and makes self-review unable to lift the ceiling. The gate must not pretend to mechanically know human independence; it must require a trusted custody boundary and fail closed when that boundary is absent.

### P4. Add mandatory browser/operator E2E for any 95/v0-v2 completion claim

The live smoke already proves CLI + local web + `.agent` integration, but the roadmap currently marks Web UI as PASS. Therefore a 95/v0-v2 completion claim requires a browser-like E2E path, not API-only smoke:

1. open `/`;
2. create task;
3. create/start/collect run;
4. inspect run detail evidence;
5. trigger approval boundary path;
6. verify SSE/status lanes update without contradictory status;
7. add a real `npm run e2e` script that emits the browser artifact consumed by `Operator Browser E2E Gate`.

Why this closes UI risk: it prevents API-only success from being mislabeled as operator UI completion.


## Required product-gate additions

The plan is not complete unless `src/product-gate.ts` gains these machine checks:

1. `V1 Role Contract Gate`: validates manager/work-order/worker/reviewer JSON schemas and their hash links.
2. `Promotion Learning Gate`: validates review finding hash -> promotion candidate hash -> approval hash -> apply hash -> later-run effect hash.
3. `Trusted Review Custody Gate`: validates artifact signature, custody signature, trusted custody label, trusted issuer allowlist, issuer/session metadata, reviewer id, artifact paths/hashes, and absence of project-tree key material.
4. `Operator Browser E2E Gate`: validates a browser artifact/schema rather than API-only smoke; absent artifact means FAIL for 95/v0-v2 completion.

The roadmap blocker scanner must keep blocking `DISPUTED`, `PARTIAL`, `FAIL-CLOSED`, `stubbed`, `scaffolded`, and `30-35%` wording until those gates pass. Documentation edits alone are not an allowed closure mechanism.

## Hard completion acceptance test

A completion claim is allowed only when this exact sequence passes from a clean checkout or documented clean fixture:

```bash
npm run build
npm test
node dist/cli.js quality gate --write
scripts/live-integration-smoke.mjs
npm run e2e
# in reviewer/CI custody, not implementer custody:
agent runtime prepare-review-gate --code-reviewer-artifact <path> --architect-artifact <path> --code-reviewer-notification <path> --architect-notification <path> --code-reviewer-agent <id> --architect-agent <id>
agent runtime sign-review --custody reviewer-ci --custody-issuer <trusted-reviewer-ci> --review-session <ci-run-or-review-session-id>
node dist/cli.js quality gate --write
```

Expected final state:

- latest product gate path is resolved at run time, not hardcoded;
- product gate `decision: PASS`;
- `completion_ceiling: 95`;
- `Product Completeness Gate: PASS`;
- `Hard Completion Ceiling Gate: PASS`;
- no roadmap current blockers;
- no forbidden high-completion claims while gates fail;
- independent critic/verifier explicitly attacks and accepts the 90/95 claim.

## Kill criteria

If any of these remain true, the gap is **not** closed:

- role gate can pass with only `ROLE=manager|worker|reviewer` process evidence;
- promotion can pass without citing a review finding and proving a later-run behavior change;
- implementer-owned keys, unallowlisted custody issuers, or test/fixture custody without explicit test-only env can lift the hard ceiling;
- roadmap blockers are removed before tests/artifacts prove closure;
- product gate can pass while `FULL_PRODUCT_ROADMAP.md` still says `DISPUTED`, `PARTIAL`, `FAIL-CLOSED`, `stubbed`, `scaffolded`, or `30–35%` for current scope;
- UI completion is claimed without mandatory browser operator-path evidence;
- `npm run e2e` is missing while Web UI remains a PASS row.

## What this still does not claim

Even after this plan passes, the product still does not claim hosted SaaS, remote daemon operation, broad MCP integration, custom Agents SDK runtime replacement, or automatic push-to-production. Those are outside the current PRD and require a separate milestone.
