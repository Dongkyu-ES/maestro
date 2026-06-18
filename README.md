# Warden

Local, file-backed agent orchestration control plane for creating tasks, running bounded executors, collecting evidence, reviewing results, and approval-gating apply proposals.

## Install / local run

```bash
npm install
npm run build
npm link
warden --version
```

Without linking, run the built CLI directly:

```bash
node dist/cli.js --help
```

## Core operator flow

```bash
warden init
warden project add "$PWD"
warden task add "Investigate and fix a bounded issue"
warden run create <task-id> --mode basic --command "npm test"
warden run start <run-id>
warden run collect <run-id>
warden review latest
warden index show
```

## Role and multi-worker modes

```bash
warden run create <task-id> --mode roles --command 'node -e "console.log(process.env.ROLE || \"role\")"'
warden run create <task-id> --mode multi --max-workers 2 --command 'node -e "require(\"fs\").writeFileSync(process.env.WORKER_ID + \".txt\", \"ok\")"'
# Mutating commands create a shell_mutation approval on first start. Approve, then start again.
```

Multi-worker mode creates isolated git worktrees, runs workers in bounded parallel, captures per-worker process logs, compares actual git status/diff with declared output, and blocks unsafe synthesis on conflicts, denied paths, missing worktrees, or evidence mismatch.

## Approval-gated apply

```bash
warden apply propose <run-id>
warden approvals
warden approval approve <approval-id>
warden apply approved <approval-id>
```

Apply proposals write patch bundles under `.agent/runs/<run-id>/apply-proposal/`. Applying requires an approved approval record and performs `git apply --check` before mutating the main workspace.

## Web UI

```bash
warden web --port 4317
# open http://127.0.0.1:4317
```

The server binds loopback only by default. `--unsafe-host` exposes remote command/control, not just read-only evidence, and is rejected unless `--auth-token` or `AGENT_WEB_TOKEN` is set.

## Evidence and safety model

- Project state lives under `.agent/` and can be rebuilt into `.agent/index.json`.
- Process output is captured as `*.process.json`, `*.stdout.log`, and `*.stderr.log`; rendered command/output artifacts redact common API tokens.
- Mutating shell commands create a `shell_mutation` approval and do not execute until approved.
- Risky apply is approval-gated and never auto-pushes.
- Worktree cleanup is explicit: `warden worktrees cleanup`.

## Product quality gate

Run the PRD-scoped anti-self-deception product gate before claiming milestone completion:

```bash
warden quality gate --write
```

The gate rejects scaffold/MVP/docs-only/self-certified completion, verifies that the claimed scope is traceable to `dominic_orchestration_PRD.md`, and writes a durable report under `.agent/product-gates/`. Passing this gate means PRD-scoped local v0-v2 behavior passed; it is not a claim that every future hosted/v3/SaaS feature is complete.
