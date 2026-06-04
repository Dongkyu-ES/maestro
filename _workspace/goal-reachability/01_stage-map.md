# Goal Reachability Stage Map

| Stage | Owner | Write Surface | Final-Gate Delta | Checks | Stop Condition |
| --- | --- | --- | --- | --- | --- |
| 01 Harness Spec | Contract Owner | `docs/harness/goal-reachability/*`, `_workspace/goal-reachability/*` | Makes final authority explicit before work starts. | artifact existence, self-test | contract missing or vague authority |
| 02 Orchestrator Skill | Divider | `.agents/skills/goal-reachability-orchestrator/*` | Makes the workflow reusable and discoverable. | YAML frontmatter, reference links | missing output/failure policy |
| 03 Deterministic Gate Script | Gatekeeper | `scripts/goal-reachability-harness.mjs`, `package.json` | Converts false completion into machine-readable BLOCKED/PASS. | self-test, script run | cannot detect Product Gate/review blockers |
| 04 Harness Validation | Critic/Gatekeeper | `_workspace/goal-reachability/final/*` | Proves the harness itself works and reports current product blockers honestly. | self-test, typecheck, test, lint | any command fails |

## Critic Prompt For Every Stage

Read `_workspace/goal-reachability/00_goal-contract.md`, this stage row, the stage evidence, and `.agents/skills/goal-reachability-orchestrator/references/no-escape-critic.md`. Return PASS/FIX/BLOCK. Do not allow the stage to count if it can pass while hiding a final-authority blocker not declared in the contract.
