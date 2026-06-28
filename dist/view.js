import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { listApprovals, listFilesRecursive, listProjects, loadIndex, runtimeTruthForRun } from './core.js';
import { listSkillRunSummaries, projectSkillRun, readSkillLaunchMarker, skillRunStatus, } from './harness/orchestrator-skill.js';
import { AGENT_DIR, isSecretPath, projectRoot, readYaml, redact, safeJoin } from './util.js';
const SKILL_STATUS_PILL = {
    final: { css: 'done', label: 'has report — open to verify' },
    running: { css: 'running', label: 'running — no verdict yet' },
    'exited-without-verdict': { css: 'blocked', label: 'exited without verdict' },
};
export function renderHtml(cwd = process.cwd(), csrfToken = '', authToken = '', skillSpecs = []) {
    const index = loadIndex(cwd);
    const csrf = csrfToken ? `<input type="hidden" name="csrf" value="${attr(csrfToken)}">` : '';
    const auth = authToken ? `<input type="hidden" name="auth" value="${attr(authToken)}">` : '';
    const hidden = csrf + auth;
    const activeRoot = projectRoot(cwd);
    const skillRuns = listSkillRunSummaries(activeRoot);
    const skillRunLane = skillRuns.length
        ? skillRuns
            .map((s) => {
            const pill = SKILL_STATUS_PILL[s.status];
            return `<article class="run-card"><header><a href="/skill/${attr(s.runId)}">${esc(s.runId)}</a><span class="pill">${esc(s.skillId)}</span><span class="pill ${pill.css}">${esc(pill.label)}</span></header><small>Open to recompute the authoritative completion from the ledger + execute evidence.</small></article>`;
        })
            .join('')
        : '<p class="empty">No skill runs yet. Launch one from the operator zone, or run <code>maestro skill run &lt;spec.json&gt; --what "…"</code>.</p>';
    const skillLaunchPanel = skillSpecs.length
        ? `<div class="panel"><h3>Run a skill (orchestrator-as-skill)</h3><form class="stack" method="POST" action="/api/skill-runs">${hidden}<input name="what" placeholder="작은 목표를 한 줄로 (e.g. a slugify helper)" required><select name="specId" title="skill spec">${skillSpecs.map((s) => `<option value="${attr(s.id)}">${esc(s.id)}</option>`).join('')}</select><button class="primary">Launch skill run</button></form><small>Runs research → execute → review through real executors. Completion is recomputed from the ledger — a launch is never a green.</small></div>`
        : '';
    const projects = listProjects();
    const projectPanel = projects.length
        ? projects
            .map((p) => `<div class="task-line"><div><strong>${esc(p.name)}</strong>${p.root_path === activeRoot ? ' <span class="pill ok">active</span>' : ''}<small>${esc(p.root_path)}</small></div></div>`)
            .join('')
        : '<p class="empty">No project registered yet. Add one below.</p>';
    const requestedApprovals = index.approvals.filter((a) => a.status === 'requested');
    const openTasks = index.tasks.filter((t) => !['done', 'cancelled', 'abandoned'].includes(t.status));
    const activeStatuses = ['planning', 'dispatching', 'workers_running', 'collecting', 'reviewing', 'applying'];
    const waitingRuns = index.runs.filter((r) => ['created', 'awaiting_approval', 'changes_requested'].includes(String(r.status)) ||
        String(r.decision || '') === 'changes_requested');
    const activeRuns = index.runs.filter((r) => activeStatuses.includes(String(r.status)) && !r.ended_at);
    const completedRuns = index.runs
        .filter((r) => ['completed', 'failed', 'cancelled', 'timed_out'].includes(String(r.status)) ||
        (activeStatuses.includes(String(r.status)) && Boolean(r.ended_at)))
        .slice(-8)
        .reverse();
    const approvalPanel = requestedApprovals.length
        ? requestedApprovals
            .map((a) => `<div class="decision-item"><div><strong>${esc(a.type)}</strong><p>${esc(a.summary)}</p>${a.command_preview ? `<small>Command waiting: ${esc(a.command_preview)}</small>` : ''}<small>${esc(a.risk)} risk · ${esc(a.id)}</small></div><div class="actions"><form method="POST" action="/api/approvals/${attr(a.id)}/approve">${hidden}<button class="primary">Approve</button></form><form method="POST" action="/api/approvals/${attr(a.id)}/reject">${hidden}<button>Reject</button></form>${a.type === 'apply_proposal' && a.status === 'approved' ? `<form method="POST" action="/api/approvals/${attr(a.id)}/apply">${hidden}<button>Apply Approved</button></form>` : ''}</div></div>`)
            .join('')
        : '<p class="empty">No approval waiting for you.</p>';
    const taskPanel = openTasks.length
        ? openTasks
            .map((t) => `<div class="task-line"><div><strong>${attr(t.title)}</strong><small>${esc(t.status)} · ${esc(t.id)}</small></div><form method="POST" action="/api/runs">${hidden}<input type="hidden" name="taskId" value="${attr(t.id)}"><select name="executor" title="executor"><option>codex</option><option>command</option><option>omx</option><option>agy</option></select><select name="mode" title="mode"><option>basic</option><option>roles</option><option>multi</option></select><button class="primary">Create run</button></form><details><summary>Edit</summary><form method="POST" action="/api/tasks/${attr(t.id)}/update">${hidden}<input name="title" value="${attr(t.title)}"><select name="status"><option>${esc(t.status)}</option><option>ready</option><option>running</option><option>done</option><option>blocked</option><option>cancelled</option></select><button>Update Task</button></form><form method="POST" action="/api/tasks/${attr(t.id)}/archive">${hidden}<button>Archive</button></form></details></div>`)
            .join('')
        : '<p class="empty">No open task. Create one above.</p>';
    const runCard = (r) => {
        const truth = runtimeTruthForRun(projectRoot(cwd), r);
        const needsApproval = requestedApprovals.some((a) => a.run_id === r.id);
        const awaitingCopy = needsApproval
            ? 'Waiting for your approval above; this is not a completed result.'
            : 'Not a completed result; approval may already be handled, so start with a real command, collect, or cancel.';
        const commandExecutor = r.executor === 'command';
        const noExecutorCopy = commandExecutor && r.status === 'created'
            ? 'Draft only: command executor needs an explicit command before Start.'
            : '';
        const readyExecutorCopy = !commandExecutor && r.status === 'created'
            ? `${String(r.executor).toUpperCase()} executor selected. Start will run that executor; command is not required.`
            : '';
        const commandDetails = commandExecutor
            ? `<details open><summary>Command required</summary><input name="command" placeholder="예: npm test 또는 node scripts/job.js"><label class="check"><input type="checkbox" name="confirmCommand" value="yes"> Run this exact shell command</label><small>Unchecked or empty command means nothing executes and Collect cannot complete.</small></details>`
            : `<details><summary>Command override is not used for ${esc(String(r.executor))}</summary><small>This run starts the selected executor with the task prompt.</small></details>`;
        return `<article class="run-card"><header><a href="/run/${attr(r.id)}">${esc(r.id)}</a><span class="pill">${esc(String(r.executor))}</span><span class="pill">${esc(String(r.mode))}</span><span class="pill ${esc(String(r.status))}">${esc(String(r.status))}</span><span class="pill ${esc(truth.css)}">${esc(truth.label)}</span></header><p>${esc(r.task_id)}</p><small>Runtime truth: ${esc(truth.evidence)}</small>${noExecutorCopy ? `<p class="warning">${esc(noExecutorCopy)}</p>` : ''}${readyExecutorCopy ? `<p class="ok">${esc(readyExecutorCopy)}</p>` : ''}${r.status === 'awaiting_approval' ? `<p class="warning">${esc(awaitingCopy)}</p>` : ''}<div class="actions"><form method="POST" action="/api/runs/${attr(r.id)}/start">${hidden}<button class="primary">${commandExecutor ? 'Start explicit command' : `Start ${esc(String(r.executor))} executor`}</button>${commandDetails}</form><form method="POST" action="/api/runs/${attr(r.id)}/collect">${hidden}<button>Collect after execution</button></form><form method="POST" action="/api/runs/${attr(r.id)}/cancel">${hidden}<button>Cancel</button></form><form method="POST" action="/api/runs/${attr(r.id)}/apply-proposal">${hidden}<button>Propose Apply</button></form></div></article>`;
    };
    return page('maestro', `<header class="topbar"><div class="brand"><span class="dot"></span><div><h1>maestro</h1><span class="tag">orchestration control · ${esc(activeRoot.split('/').filter(Boolean).pop() || 'project')}</span></div></div><div class="livechips"><span class="chip run">${activeRuns.length} running</span><span class="chip wait">${waitingRuns.length} waiting</span>${requestedApprovals.length ? `<span class="chip alert">${requestedApprovals.length} approval${requestedApprovals.length > 1 ? 's' : ''}</span>` : ''}<span class="chip done">${completedRuns.length} recent</span></div><nav class="nav-tabs"><a href="#top">overview</a><a href="#operator">operator</a><a href="#runs">runs</a><a class="ghost" href="/review-gate">review gate</a><button id="live-toggle" class="livebtn" type="button">live</button><a class="ghost" href="/">↻</a></nav></header><section class="overview" id="top"><div class="metrics"><div class="metric run"><span class="m-k">running</span><span class="m-v">${activeRuns.length}</span><span class="m-s">executors live now</span></div><div class="metric wait"><span class="m-k">waiting</span><span class="m-v">${waitingRuns.length}</span><span class="m-s">${requestedApprovals.length} need approval</span></div><div class="metric done"><span class="m-k">completed</span><span class="m-v">${index.runs.filter((r) => ['completed', 'failed', 'cancelled', 'timed_out'].includes(String(r.status))).length}</span><span class="m-s">recomputed from ledger</span></div><div class="metric skill"><span class="m-k">skill runs</span><span class="m-v">${skillRuns.length}</span><span class="m-s">research→execute→review</span></div></div><div class="showcase"><div class="sc-row"><span class="sc-h">patterns</span><span class="badge">build→review</span><span class="badge">fan-out</span><span class="badge">panel</span><span class="badge">scout→plan→build→verify</span></div><div class="sc-row"><span class="sc-h">executors</span><span class="badge x">codex</span><span class="badge x">claude</span><span class="badge x">agy</span><span class="badge x">+ byo</span></div><div class="sc-trust">${(() => {
        const n = completedRuns.filter((r) => ['failed', 'blocked', 'unproven', 'native_assisted', 'stale', 'primitive_shell', 'awaiting_approval'].includes(runtimeTruthForRun(projectRoot(cwd), r).css)).length;
        return n
            ? `<span class="warn">⚠ ${n} run${n > 1 ? 's' : ''} need a look</span>`
            : '<span class="ok">✓ evidence consistent</span>';
    })()}<small>completion is recomputed from the hash-chained ledger — a launch or a status label is never a green.</small></div></div></section><main><section class="operator-zone" id="operator"><div class="section-title"><span>01</span><div><h2>Your input / permissions</h2><p>여기는 네가 입력하거나 승인해야 진행되는 것만 둔다.</p></div></div><div class="operator-grid"><div class="panel urgent"><h3>Approval Queue${requestedApprovals.length ? ` <span class="pill alert">${requestedApprovals.length}</span>` : ''}</h3>${approvalPanel}</div><div class="panel"><h3>Create Task</h3><form class="stack" method="POST" action="/api/tasks">${hidden}<input name="title" placeholder="해야 할 일을 한 줄로 적어라" required><button class="primary">Create Task</button></form></div>${skillLaunchPanel}<div class="panel"><h3>Projects</h3><div class="scroll-list">${projectPanel}</div><form class="stack" method="POST" action="/api/projects">${hidden}<input name="path" placeholder="/absolute/path/to/project" required><button class="primary">Add / register project</button></form><small>The active project is where you launched <code>maestro web</code>. Registering adds a project to the registry and initializes its <code>.agent/</code>.</small></div><div class="panel"><h3>Tool / permission boundary</h3><p><strong>Allowed without approval:</strong> git status/diff/log/show, ls/cat safe paths, task adapter execution.</p><p><strong>Approval required:</strong> shell mutation, package install, git commit/push, apply/merge proposal, network/unsafe host.</p><p><strong>Blocked by design:</strong> secret paths, path traversal, natural-language replies as shell commands.</p></div></div><div class="panel"><h3>Task Board — choose what should run</h3>${taskPanel}</div></section><section class="agent-zone" id="runs"><div class="section-title"><span>02</span><div><h2>Agent / LLM work</h2><p>에이전트가 수행 중인 것, 다음에 수행할 것, 끝난 증거를 아래에서 본다.</p></div></div><div class="lane"><h3>Running now</h3>${activeRuns.length ? activeRuns.map(runCard).join('') : '<p class="empty">Nothing running.</p>'}</div><div class="lane"><h3>Ready / waiting to run</h3>${waitingRuns.length ? waitingRuns.map(runCard).join('') : '<p class="empty">No run waiting. Create a run from a task above.</p>'}</div><div class="lane"><h3>Recent results</h3>${completedRuns.length ? completedRuns.map(runCard).join('') : '<p class="empty">No completed runs yet.</p>'}</div><div class="lane"><h3>Skill runs (orchestrator-as-skill)</h3>${skillRunLane}</div></section></main>`);
}
function readNotificationAgent(root, relPath) {
    const full = join(root, relPath);
    if (!existsSync(full))
        return '';
    try {
        const parsed = JSON.parse(readFileSync(full, 'utf8'));
        return typeof parsed.agent_path === 'string' && parsed.agent_path.trim() ? parsed.agent_path.trim() : '';
    }
    catch {
        return '';
    }
}
function statusRow(s) {
    return `<tr><td>${s.present ? '<span class="ok">있음</span>' : '<span class="missing">없음</span>'}</td><td><code>${esc(s.path)}</code></td><td>${esc(s.label)}</td><td>${esc(s.note)}</td></tr>`;
}
function reviewGateStatus(root) {
    const paths = [
        ['code-reviewer 산출물', '.agent/review-gates/code-reviewer.md', '외부 code-reviewer가 작성한 APPROVE 리뷰'],
        ['architect 산출물', '.agent/review-gates/architect.md', '외부 architect가 작성한 CLEAR 리뷰'],
        [
            'code-reviewer 알림 JSON',
            '.agent/review-gates/subagent-notifications/code-reviewer.json',
            'agent_path와 completed 원문 검증용 JSON',
        ],
        [
            'architect 알림 JSON',
            '.agent/review-gates/subagent-notifications/architect.json',
            'agent_path와 completed 원문 검증용 JSON',
        ],
        ['준비된 review gate', '.agent/independent-review-gate.json', 'prepare-review-gate가 생성하는 로컬 gate'],
    ];
    return paths.map(([label, relPath, note]) => ({
        label,
        path: relPath,
        note,
        present: existsSync(join(root, relPath)),
    }));
}
function commandBlock(reviewerAgentId, architectAgentId) {
    const reviewer = reviewerAgentId || 'PASTE_CODE_REVIEWER_AGENT_ID';
    const architect = architectAgentId || 'PASTE_ARCHITECT_AGENT_ID';
    return [
        'node dist/cli.js runtime prepare-review-gate \\',
        '  --code-reviewer-artifact .agent/review-gates/code-reviewer.md \\',
        '  --architect-artifact .agent/review-gates/architect.md \\',
        '  --code-reviewer-notification .agent/review-gates/subagent-notifications/code-reviewer.json \\',
        '  --architect-notification .agent/review-gates/subagent-notifications/architect.json \\',
        `  --code-reviewer-agent ${reviewer} \\`,
        `  --architect-agent ${architect}`,
    ].join('\n');
}
function oneLineCommand(reviewerAgentId, architectAgentId) {
    return commandBlock(reviewerAgentId, architectAgentId).replaceAll(' \\\n  ', ' ');
}
export function renderReviewGate(cwd = process.cwd()) {
    const root = projectRoot(cwd);
    const reviewerAgentId = readNotificationAgent(root, '.agent/review-gates/subagent-notifications/code-reviewer.json');
    const architectAgentId = readNotificationAgent(root, '.agent/review-gates/subagent-notifications/architect.json');
    const statuses = reviewGateStatus(root);
    const readyForPrepare = statuses.slice(0, 4).every((s) => s.present) && reviewerAgentId && architectAgentId;
    const prepared = statuses[4].present;
    const nextAction = prepared
        ? '로컬 준비는 끝났다. 이제 CI/외부 reviewer custody 서명까지 있어야 full PASS가 열린다.'
        : readyForPrepare
            ? '아래 명령을 그대로 복붙해서 independent-review-gate.json을 만든다.'
            : '먼저 외부 code-reviewer/architect 산출물과 알림 JSON 4개를 채워야 한다.';
    return page('Review Gate 사용법', `<header class="topbar"><div><h1>Review Gate 사용법</h1><p>깨지는 멀티라인/꺾쇠 괄호 없이, 사람이 그대로 복붙하는 화면.</p></div><nav class="top-actions"><a class="ghost" href="/">대시보드</a><a class="ghost" href="/review-gate">새로고침</a></nav></header><main class="guide"><section class="panel hero"><h2>현재 상태: ${prepared ? '<span class="ok">로컬 준비됨</span>' : readyForPrepare ? '<span class="warn">준비 명령 실행 가능</span>' : '<span class="missing">재료 부족</span>'}</h2><p>${esc(nextAction)}</p><p><strong>중요:</strong> 로컬에서 만든 gate만으로는 hard completion이 PASS가 아니다. trusted GitHub Actions reviewer-ci custody 서명이 들어간 <code>runtime sign-review</code>까지 필요하다.</p></section><section class="panel"><h2>1. 필요한 파일</h2><table><thead><tr><th>상태</th><th>파일</th><th>역할</th><th>설명</th></tr></thead><tbody>${statuses.map(statusRow).join('')}</tbody></table></section><section class="panel"><h2>2. 감지된 Agent ID</h2><div class="cards"><div><strong>code-reviewer</strong><pre>${esc(reviewerAgentId || '아직 못 찾음: PASTE_CODE_REVIEWER_AGENT_ID 로 교체')}</pre></div><div><strong>architect</strong><pre>${esc(architectAgentId || '아직 못 찾음: PASTE_ARCHITECT_AGENT_ID 로 교체')}</pre></div></div></section><section class="panel"><h2>3. 복붙 명령</h2><p>zsh에서 줄바꿈하려면 각 중간 줄 끝의 백슬래시를 그대로 둔다. 꺾쇠 괄호는 쓰지 않는다.</p><pre>${esc(commandBlock(reviewerAgentId, architectAgentId))}</pre><details><summary>한 줄 버전</summary><pre>${esc(oneLineCommand(reviewerAgentId, architectAgentId))}</pre></details></section><section class="panel"><h2>4. 진짜 full PASS까지</h2><ol><li>위 명령으로 <code>.agent/independent-review-gate.json</code> 생성</li><li>보호된 GitHub Actions <code>trusted-reviewer-custody</code> 환경에서 <code>AGENT_REVIEW_HMAC_KEY</code>, <code>AGENT_REVIEW_CUSTODY_HMAC_KEY</code>, <code>AGENT_TRUSTED_REVIEW_CUSTODY_ISSUERS</code> 설정</li><li><code>node dist/cli.js runtime sign-review --custody reviewer-ci</code></li><li><code>node dist/cli.js quality gate --write</code> 재실행</li></ol><p>즉, 이 화면은 “어떻게 쓰는지”와 “뭐가 빠졌는지”를 보여준다. hard gate 자체는 로컬 셀프서명으로 속이지 않는다.</p></section></main>`);
}
function readJsonArtifact(runDir, file) {
    const path = join(runDir, file);
    if (!existsSync(path))
        return undefined;
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return { parse_error: file };
    }
}
function isPositiveTrustArtifact(file, artifact, value) {
    if (artifact.parse_error)
        return false;
    if (file === 'skill-contracts-verification.json') {
        const checks = Array.isArray(artifact.checks) ? artifact.checks : [];
        return checks.some((check) => {
            if (!check || typeof check !== 'object')
                return false;
            const item = check;
            return item.hardness === 'HARD' && item.status === 'PASS';
        });
    }
    return /PASS|supported/i.test(value);
}
function evidenceTrustFindings(runDir) {
    const red = [];
    const yellow = [];
    const refs = [];
    const positiveRefs = [];
    for (const file of [
        'full-target-gate.json',
        'full-target-verification.json',
        'native-evidence-verification.json',
        'context-provenance-verification.json',
        'skill-contracts-verification.json',
        'promotion-differential-verification.json',
        'multi-executor-verification.json',
    ]) {
        const artifact = readJsonArtifact(runDir, file);
        if (!artifact)
            continue;
        refs.push(file);
        const value = String(artifact.status || artifact.decision || artifact.overall || '');
        if (/FAIL|BLOCKED|failed|blocked/i.test(value))
            red.push(`${file}: ${value}`);
        if (file === 'full-target-gate.json' && value && !/PASS/i.test(value))
            red.push(`${file}: ${value}`);
        if (artifact.parse_error)
            red.push(`${file}: parse_error`);
        if (isPositiveTrustArtifact(file, artifact, value))
            positiveRefs.push(file);
    }
    const native = readJsonArtifact(runDir, 'native-evidence.json');
    if (native) {
        refs.push('native-evidence.json');
        if (native.status === 'native-harness-assisted') {
            const surfaces = Array.isArray(native.unowned_surfaces)
                ? native.unowned_surfaces.map(String).join('; ')
                : 'unowned surfaces not listed';
            yellow.push(`native-harness-assisted: ${surfaces}`);
        }
    }
    return { red, yellow, refs: [...new Set(refs)], positiveRefs: [...new Set(positiveRefs)] };
}
function renderEvidenceTrustPanel(runDir, meta) {
    const findings = evidenceTrustFindings(runDir);
    const claimsComplete = meta.status === 'completed' || meta.decision === 'pass';
    const trusted = claimsComplete && findings.red.length === 0 && findings.positiveRefs.length > 0;
    const css = findings.red.length ? 'trust-red' : findings.yellow.length ? 'trust-yellow' : 'hero';
    const verdict = findings.red.length
        ? 'NOT TRUSTED — evidence contradiction'
        : trusted
            ? 'trusted by current evidence'
            : 'not yet trusted';
    const redBlock = findings.red.length
        ? `<h3>Red evidence</h3><ul>${findings.red.map((item) => `<li class="missing">${esc(item)}</li>`).join('')}</ul>`
        : '';
    const yellowBlock = findings.yellow.length
        ? `<h3>Native-assisted / unowned surfaces</h3><ul>${findings.yellow.map((item) => `<li class="warn">${esc(item)}</li>`).join('')}</ul>`
        : '';
    const refs = findings.refs.length ? findings.refs.join(', ') : 'no verifier artifacts found';
    return `<section class="panel ${css}"><h2>Evidence-derived trust</h2><p><strong>${esc(verdict)}</strong></p><p>Status/decision alone cannot make this green. Red verifier artifacts override completed/pass labels.</p>${redBlock}${yellowBlock}<small>Evidence refs: ${esc(refs)}</small></section>`;
}
export function renderRun(runId, cwd = process.cwd()) {
    if (!/^run-[A-Za-z0-9가-힣-]+$/.test(runId))
        throw new Error(`invalid run id: ${runId}`);
    const root = projectRoot(cwd);
    const runsDir = safeJoin(root, AGENT_DIR, 'runs');
    const runDir = safeJoin(runsDir, runId);
    const relToRuns = relative(realpathSync(runsDir), realpathSync(runDir)).replaceAll('\\', '/');
    if (relToRuns === '..' || relToRuns.startsWith('../'))
        throw new Error(`invalid run path: ${runId}`);
    const names = listFilesRecursive(runDir)
        .filter((f) => {
        if (f.includes('/.git/') || isSecretPath(f))
            return false;
        const full = join(runDir, f);
        const real = realpathSync(full);
        const rel = relative(realpathSync(runDir), real).replaceAll('\\', '/');
        return !(rel === '..' || rel.startsWith('../') || isSecretPath(relative(root, real).replaceAll('\\', '/')));
    })
        .sort();
    const meta = readYaml(join(runDir, 'run.yaml'));
    const relatedApprovals = listApprovals(root).filter((a) => a.run_id === runId);
    const requestedApproval = relatedApprovals.some((a) => a.status === 'requested');
    const processFiles = names.filter((n) => n.endsWith('.process.json'));
    const processSummary = processFiles
        .map((n) => {
        try {
            const p = JSON.parse(readFileSync(join(runDir, n), 'utf8'));
            return `${n}: exit ${p.exit_code}${p.stderr ? ` · ${String(p.stderr).trim().split('\n')[0]}` : ''}`;
        }
        catch {
            return n;
        }
    })
        .join('\n') || 'No process evidence yet.';
    const staleActiveNotice = ['planning', 'dispatching', 'workers_running', 'collecting', 'reviewing', 'applying'].includes(String(meta.status)) && meta.ended_at
        ? '<div class="notice danger"><strong>Not running.</strong><p>This run has terminal process evidence but stale active metadata. Treat the process log, ended_at, and cancel marker as truth.</p></div>'
        : '';
    const approvalNotice = meta.status === 'awaiting_approval'
        ? `<div class="notice danger"><strong>Not a result yet.</strong><p>${requestedApproval ? 'This run is waiting for operator approval. Review the approval queue before treating it as work output.' : 'This run is in an awaiting-approval state, but no requested approval remains. It is stale or already approved without a valid completed execution; start with a real command, collect failure evidence, or cancel.'}</p></div>`
        : '';
    const rawArtifacts = names
        .map((n) => `<details><summary>${esc(n)}</summary><pre>${esc(redact(readFileSync(join(runDir, n), 'utf8')))}</pre></details>`)
        .join('');
    const closedLoopPath = join(runDir, 'closed-loop-report.md');
    const evidenceTrust = renderEvidenceTrustPanel(runDir, meta);
    const operatorOutputs = renderOperatorOutputs(runDir);
    const closedLoop = existsSync(closedLoopPath)
        ? `<section class="panel hero"><h2>Closed loop: 실행 / 막힘 / 산출물 / 개선</h2><pre>${esc(redact(readFileSync(closedLoopPath, 'utf8')))}</pre></section>`
        : `<section class="panel"><h2>Closed loop</h2><p>아직 Collect가 돌지 않았다. Start가 실제 실행을 만든 뒤 Collect하면 여기에 실행 여부, 막힌 지점, 산출물, 다음 개선 액션이 표시된다.</p></section>`;
    return page(runId, `<a href="/">← back</a><h1>${esc(runId)}</h1><section class="panel"><h2>Run result</h2><p>Status: <strong>${esc(String(meta.status))}</strong> · Decision: <strong>${esc(String(meta.decision || 'not collected'))}</strong> · Mode: ${esc(String(meta.mode))} · Task: ${esc(String(meta.task_id))}</p><p><a href="/api/runs/${attr(runId)}/events">Event stream (SSE)</a></p><h3>Execution evidence</h3><pre>${esc(processSummary)}</pre></section>${staleActiveNotice}${approvalNotice}${evidenceTrust}${operatorOutputs}${closedLoop}<section class="panel"><h2>Raw artifacts</h2><p>내부 파일은 접어 둔다. 먼저 위의 실행 결과를 본다.</p>${rawArtifacts}</section>`);
}
export function renderSkillRun(runId, cwd = process.cwd()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(runId) || runId.includes('..'))
        throw new Error(`invalid skill run id: ${runId}`);
    const root = projectRoot(cwd);
    const status = skillRunStatus(root, runId);
    if (status !== 'final') {
        const marker = readSkillLaunchMarker(root, runId);
        const running = status === 'running';
        return page(`skill ${runId}`, `<a href="/">← back</a><h1>${esc(marker?.skillId ?? 'skill')} <small>${esc(runId)}</small></h1>` +
            `<section class="panel hero"><h2>${running ? 'Running — no verdict yet' : 'Exited without a verdict'}</h2>` +
            (running
                ? `<p>The skill run was launched and is still executing (research → execute → review). There is <strong>no completion claim</strong> yet — refresh; the authoritative verdict appears only once the child writes its report and the ledger can be recomputed.</p>`
                : `<p class="warning">The launched child exited before producing a report, so there is <strong>no recomputable evidence</strong>. This is a stuck launch, not a completion. Re-launch the skill, and check <code>.agent/skill-runs/${esc(runId)}/launch.log</code>.</p>`) +
            (marker
                ? `<small>Goal: ${esc(marker.what)} · launched ${esc(marker.startedAt)} · pid ${esc(String(marker.pid))}</small>`
                : '') +
            `</section><section class="panel"><a class="ghost" href="/">Refresh</a></section>`);
    }
    const p = projectSkillRun({ root, runId });
    const authClass = p.authoritativeCompletion === 'passed' ? 'ok' : 'warning';
    const contradiction = p.contradiction
        ? `<div class="notice danger"><strong>CONTRADICTION — do not trust the stored report.</strong><p>The stored report claims completion <code>${esc(p.reportCompletion)}</code>, but the authoritative recompute from the hash-chained ledger + content-addressed execute evidence says <code>${esc(p.authoritativeCompletion)}</code>${p.ledgerValid ? '' : ' (lifecycle ledger FAILED validation)'}. Trust the recompute. Reason: ${esc(p.reason)}</p></div>`
        : '';
    const phaseRows = p.phases
        .map((ph) => `<tr><td><code>${esc(ph.phase)}</code></td><td><span class="pill ${esc(ph.nodeState)}">${esc(ph.label)}</span></td></tr>`)
        .join('');
    return page(`skill ${runId}`, `<a href="/">← back</a><h1>${esc(p.skillId)} <small>${esc(runId)}</small></h1>${contradiction}` +
        `<section class="panel hero"><h2>Authoritative completion</h2>` +
        `<p>Recomputed from the hash-chained ledger + content-addressed execute evidence — never the stored report field.</p>` +
        `<p>Completion: <strong class="${authClass}">${esc(p.authoritativeCompletion)}</strong> · Ledger: <strong class="${p.ledgerValid ? 'ok' : 'warning'}">${p.ledgerValid ? 'valid' : 'INVALID'}</strong></p>` +
        `<small>Stored report field (display-only, non-authoritative): ${esc(p.reportCompletion)} · review node state: ${esc(p.displayCompletion)}</small></section>` +
        `<section class="panel"><h2>Phases</h2><table><thead><tr><th>phase</th><th>node state</th></tr></thead><tbody>${phaseRows}</tbody></table></section>`);
}
function readClosedLoopJson(runDir) {
    const path = join(runDir, 'closed-loop-report.json');
    if (!existsSync(path))
        return undefined;
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return undefined;
    }
}
function extractVerificationLines(runDir) {
    const lines = [];
    for (const file of ['codex-last-message.txt', 'executor.stdout.log', 'review.md']) {
        const path = join(runDir, file);
        if (!existsSync(path))
            continue;
        for (const line of readFileSync(path, 'utf8').split('\n')) {
            if (/PPTX_OPENABLE_(?:PASS|FAIL)|PPTX verifier failed/.test(line))
                lines.push(line.trim());
        }
    }
    return [...new Set(lines.filter(Boolean))].slice(0, 8);
}
function renderOperatorOutputs(runDir) {
    const report = readClosedLoopJson(runDir);
    const outputs = (report?.outputs || []).filter((o) => o.kind === 'reported_output' && o.path);
    const verification = extractVerificationLines(runDir);
    if (!outputs.length && !verification.length)
        return '';
    const outputList = outputs.length
        ? `<ul>${outputs
            .slice(0, 20)
            .map((o) => `<li><code>${esc(String(o.path))}</code>${String(o.path).endsWith('.pptx') ? ' <span class="pill ok">PPTX</span>' : ''}</li>`)
            .join('')}</ul>`
        : '<p class="empty">No operator-visible output paths recorded.</p>';
    const verificationBlock = verification.length
        ? `<h3>Verification</h3><pre>${esc(redact(verification.join('\n')))}</pre>`
        : '';
    return `<section class="panel hero"><h2>Operator-visible outputs</h2><p>사용자가 실제로 열어볼 산출물 경로와 하드 검증 결과.</p>${outputList}${verificationBlock}</section>`;
}
function page(title, body) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>:root{color-scheme:dark;--bg:#0a0e13;--bg2:#0e141c;--panel:#121a24;--panel2:#0f161f;--line:#202c3a;--line2:#2c3d4f;--ink:#e6edf3;--muted:#8da2b5;--faint:#5a6b7b;--accent:#2dd4bf;--accent2:#58a6ff;--danger:#f85149;--ok:#3fb950;--warn:#e3b341;--mono:ui-monospace,SFMono-Regular,Menlo,"JetBrains Mono",monospace}*{box-sizing:border-box}body{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;color:var(--ink);background:var(--bg);background-image:radial-gradient(900px 420px at 100% -5%,rgba(45,212,191,.07),transparent),radial-gradient(820px 380px at -5% 0,rgba(88,166,255,.06),transparent);min-height:100vh}a{color:inherit;text-decoration:none}h1{font-size:19px;margin:0;letter-spacing:.01em}h2{font-size:15px;margin:0}h3{font-size:12px;margin:0;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}p{color:var(--muted);margin:.35rem 0;font-size:13px}small{display:block;color:var(--faint);font-size:11.5px;margin-top:4px;line-height:1.55}code{font-family:var(--mono)}.topbar{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:12px 22px;border-bottom:1px solid var(--line);background:rgba(10,14,19,.82);position:sticky;top:0;z-index:5;backdrop-filter:blur(12px);flex-wrap:wrap}.top-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}.brand{display:flex;align-items:center;gap:10px}.brand .dot{width:9px;height:9px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 4px rgba(45,212,191,.14);animation:pulse 2.4s ease-in-out infinite}.brand .tag{display:block;color:var(--faint);font-size:11px;font-family:var(--mono)}.livechips{display:flex;gap:8px;flex-wrap:wrap}.chip{font-family:var(--mono);font-size:11.5px;border:1px solid var(--line2);border-radius:999px;padding:4px 10px;color:var(--muted);background:var(--panel2);display:inline-flex;align-items:center;gap:6px}.chip::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}.chip.run{color:var(--accent)}.chip.wait{color:var(--warn)}.chip.alert{color:var(--danger);border-color:rgba(248,81,73,.5)}.chip.done{color:var(--ok)}.nav-tabs{display:flex;align-items:center;gap:4px;flex-wrap:wrap}.nav-tabs a{font-size:12px;color:var(--muted);padding:7px 11px;border-radius:8px;letter-spacing:.02em}.nav-tabs a:hover{background:var(--panel);color:var(--ink)}.ghost{border:1px solid var(--line2);border-radius:8px;padding:7px 11px;background:var(--panel2);color:var(--muted)}.livebtn{font:inherit;font-size:12px;color:var(--faint);border:1px solid var(--line2);background:var(--panel2);border-radius:8px;padding:6px 11px;cursor:pointer;display:inline-flex;align-items:center;gap:6px}.livebtn::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--faint)}.livebtn.on{color:var(--accent);border-color:rgba(45,212,191,.4)}.livebtn.on::before{background:var(--accent);box-shadow:0 0 6px var(--accent);animation:pulse 1.6s infinite}.overview{padding:18px 22px;border-bottom:1px solid var(--line);display:grid;gap:14px}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.metric{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px 16px;position:relative;overflow:hidden}.metric::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--faint)}.metric.run::before{background:var(--accent)}.metric.wait::before{background:var(--warn)}.metric.done::before{background:var(--ok)}.metric.skill::before{background:var(--accent2)}.m-k{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}.m-v{display:block;font-size:30px;font-weight:800;font-family:var(--mono);line-height:1.1;margin:2px 0}.m-s{font-size:11px;color:var(--faint)}.showcase{display:flex;flex-wrap:wrap;gap:10px 22px;align-items:center}.sc-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.sc-h{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--faint);margin-right:2px}.badge{font-family:var(--mono);font-size:11px;border:1px solid var(--line2);border-radius:6px;padding:3px 8px;color:var(--muted);background:var(--panel2)}.badge.x{color:var(--accent2);border-color:rgba(88,166,255,.35)}.sc-trust{margin-left:auto;text-align:right}main{display:grid;grid-template-columns:minmax(340px,38%) 1fr;align-items:start}main.guide{display:block;max-width:1040px;margin:0 auto;padding:24px 26px}.operator-zone{padding:20px 22px;border-right:1px solid var(--line);background:var(--bg2)}.agent-zone{padding:20px 22px}.section-title{display:flex;gap:12px;align-items:center;margin-bottom:16px}.section-title span{font-family:var(--mono);font-size:11px;font-weight:700;color:#04201c;background:var(--accent);border-radius:6px;padding:4px 7px}.section-title h2{font-size:14px}.operator-grid{display:grid;grid-template-columns:1fr;gap:12px}.scroll-list{max-height:230px;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:2px 12px;margin-bottom:10px}.scroll-list::-webkit-scrollbar{width:8px}.scroll-list::-webkit-scrollbar-thumb{background:var(--line2);border-radius:8px}.panel,.lane{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:15px;margin-bottom:14px}.panel>h3,.lane>h3{margin-bottom:10px}.hero{border-color:rgba(45,212,191,.35);background:linear-gradient(180deg,rgba(45,212,191,.05),transparent)}.urgent{border-color:rgba(248,81,73,.4)}.trust-red{border-color:rgba(248,81,73,.5);background:rgba(248,81,73,.06)}.trust-yellow{border-color:rgba(227,179,65,.5);background:rgba(227,179,65,.06)}.stack{display:grid;gap:9px}.decision-item,.task-line,.run-card{display:grid;gap:10px;border-top:1px solid var(--line);padding:13px 0}.decision-item:first-of-type,.task-line:first-of-type,.run-card:first-of-type{border-top:0}.task-line{grid-template-columns:1fr auto auto;align-items:center}.run-card{border:1px solid var(--line);border-radius:12px;padding:13px;margin-bottom:10px;background:var(--panel2)}.run-card header{display:flex;gap:7px;align-items:center;flex-wrap:wrap}.run-card header a{font-family:var(--mono);font-size:12.5px;color:var(--accent2)}.run-card p{font-family:var(--mono);font-size:11.5px;color:var(--muted)}.actions{display:flex;gap:7px;flex-wrap:wrap;align-items:center}.check{display:block;color:var(--muted);font-size:12px;margin-top:8px}input,select,button,textarea{font:inherit;font-size:13px;border:1px solid var(--line2);border-radius:8px;padding:8px 10px;background:var(--panel2);color:var(--ink)}input::placeholder{color:var(--faint)}button{cursor:pointer;color:var(--ink)}button:hover{background:var(--panel)}button.primary{background:var(--accent);border-color:var(--accent);color:#04201c;font-weight:700}button.primary:hover{filter:brightness(1.08)}.pill{font-family:var(--mono);font-size:11px;border:1px solid var(--line2);border-radius:999px;padding:2px 8px;color:var(--muted);background:var(--panel2)}.pill.completed,.pill.done{color:var(--ok);border-color:rgba(63,185,80,.4)}.pill.running,.pill.workers_running,.pill.collecting,.pill.reviewing,.pill.applying,.pill.planning,.pill.dispatching{color:var(--accent);border-color:rgba(45,212,191,.4)}.pill.failed,.pill.blocked,.pill.awaiting_approval,.pill.primitive_shell,.pill.stale,.pill.unproven,.pill.native_assisted,.pill.cancelled,.pill.timed_out,.pill.alert{color:var(--danger);border-color:rgba(248,81,73,.45)}.warning,.missing{color:var(--danger);font-weight:700}.ok{color:var(--ok);font-weight:700}.warn{color:var(--warn);font-weight:700}.notice{border:1px solid var(--line);border-radius:12px;padding:13px;margin:12px 0;background:var(--panel2)}.notice.danger{border-color:rgba(248,81,73,.45);background:rgba(248,81,73,.06)}.empty{padding:16px;border:1px dashed var(--line2);border-radius:12px;text-align:center;color:var(--faint);font-size:12.5px}details summary{cursor:pointer;color:var(--muted);font-size:12px}pre{background:#070b10;color:#cbd5e1;padding:14px;overflow:auto;white-space:pre-wrap;border-radius:12px;border:1px solid var(--line);font-size:12px;font-family:var(--mono)}table{width:100%;border-collapse:collapse;margin-top:10px}th,td{text-align:left;border-bottom:1px solid var(--line);padding:9px;vertical-align:top;font-size:12.5px}th{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}.cards{display:grid;grid-template-columns:1fr 1fr;gap:12px}.cards pre{margin:.5rem 0 0}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.45}}@media(max-width:980px){main{grid-template-columns:1fr}.operator-zone{border-right:0;border-bottom:1px solid var(--line)}.metrics{grid-template-columns:repeat(2,1fr)}.task-line,.cards{grid-template-columns:1fr}.topbar{position:static}.sc-trust{margin-left:0;text-align:left}}</style></head><body>${body}<script>(function(){var t=document.getElementById('live-toggle');if(!t)return;var on=localStorage.getItem('maestro-live')!=='0';function paint(){t.classList.toggle('on',on);}t.addEventListener('click',function(){on=!on;localStorage.setItem('maestro-live',on?'1':'0');paint();});paint();function busy(){var a=document.activeElement;if(a&&/^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName))return true;return !!document.querySelector('details[open]');}setInterval(function(){if(on&&!busy()&&document.visibilityState==='visible')location.reload();},7000);})();</script></body></html>`;
}
function esc(s) {
    return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}
function attr(s) {
    return esc(s).replace(/[\s"']/g, (c) => ({ '"': '&quot;', "'": '&#39;', ' ': '&#32;', '\t': '&#9;', '\n': '&#10;', '\r': '&#13;' })[c] || '&#32;');
}
