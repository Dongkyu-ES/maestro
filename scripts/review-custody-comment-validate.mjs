#!/usr/bin/env node
import { readFileSync } from 'node:fs';

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const agentIdRe = /^019[a-fA-F0-9]{5}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/;

function validateComment({ path, role, expectedAgent, expectedHead, expectedInputHash, trustedActors }) {
  const issues = [];
  const requiredVerdict = role === 'code-reviewer' ? /Recommendation\s*:\s*APPROVE/i : /Architectural Status\s*:\s*CLEAR/i;
  const bodyRole = role === 'code-reviewer' ? /code-reviewer/i : /architect/i;
  let comment;
  try {
    comment = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return [`${role}: cannot parse GitHub comment JSON: ${error instanceof Error ? error.message : String(error)}`];
  }
  const author = comment?.user?.login;
  if (!trustedActors.has(author)) issues.push(`${role}: comment author is not trusted`);
  if (comment?.author_association === 'NONE') issues.push(`${role}: comment author association is NONE`);
  const body = String(comment?.body || '').trim();
  if (!body.startsWith('{')) return [...issues, `${role}: comment body must be notification JSON, not prose`];
  let notification;
  try {
    notification = JSON.parse(body);
  } catch (error) {
    return [...issues, `${role}: cannot parse notification JSON: ${error instanceof Error ? error.message : String(error)}`];
  }
  if (notification?.agent_path !== expectedAgent) issues.push(`${role}: agent_path mismatch`);
  const status = notification?.status || {};
  if (status.reviewed_head_sha !== expectedHead) issues.push(`${role}: reviewed_head_sha mismatch`);
  if (status.reviewed_input_sha256 !== expectedInputHash) issues.push(`${role}: reviewed_input_sha256 mismatch`);
  const completed = String(status.completed || '');
  if (completed.length < 50) issues.push(`${role}: completed review text too short`);
  if (!bodyRole.test(completed)) issues.push(`${role}: completed text does not name role`);
  if (!requiredVerdict.test(completed)) issues.push(`${role}: completed text missing required verdict`);
  return issues;
}

function fixture({ role, agent, head, hash, actor = 'trusted-reviewer' }) {
  const verdict = role === 'code-reviewer' ? 'Recommendation: APPROVE' : 'Architectural Status: CLEAR';
  return {
    user: { login: actor },
    author_association: 'MEMBER',
    body: JSON.stringify({
      agent_path: agent,
      status: {
        reviewed_head_sha: head,
        reviewed_input_sha256: hash,
        completed: `${role} independent review for ${head} and ${hash}.\n\n${verdict}\n\nThis fixture contains enough review body text to pass local shape validation.`,
      },
    }),
  };
}

async function selfTest() {
  const head = 'a'.repeat(40);
  const hash = 'b'.repeat(64);
  const codeAgent = '019abcde-1234-5678-9abc-def012345678';
  const trustedActors = new Set(['trusted-reviewer']);
  const temp = `/tmp/review-comment-${process.pid}.json`;
  const { writeFileSync, rmSync } = await import('node:fs');
  {
    writeFileSync(temp, JSON.stringify(fixture({ role: 'code-reviewer', agent: codeAgent, head, hash })));
    const ok = validateComment({ path: temp, role: 'code-reviewer', expectedAgent: codeAgent, expectedHead: head, expectedInputHash: hash, trustedActors });
    if (ok.length) throw new Error(`expected valid fixture: ${ok.join('; ')}`);
    writeFileSync(temp, JSON.stringify(fixture({ role: 'code-reviewer', agent: codeAgent, head: 'c'.repeat(40), hash })));
    const bad = validateComment({ path: temp, role: 'code-reviewer', expectedAgent: codeAgent, expectedHead: head, expectedInputHash: hash, trustedActors });
    if (!bad.some((issue) => issue.includes('reviewed_head_sha mismatch'))) throw new Error('must reject stale head sha');
    rmSync(temp, { force: true });
  }
  return { decision: 'PASS' };
}

if (process.argv.includes('--self-test')) {
  console.log(JSON.stringify(await selfTest(), null, 2));
} else {
  const trustedActors = new Set(String(arg('--trusted-actors') || '').split(',').map((item) => item.trim()).filter(Boolean));
  const expectedHead = arg('--reviewed-head-sha');
  const expectedInputHash = arg('--reviewed-input-sha256');
  const codeReviewerAgent = arg('--code-reviewer-agent');
  const architectAgent = arg('--architect-agent');
  const codeReviewerComment = arg('--code-reviewer-comment-json');
  const architectComment = arg('--architect-comment-json');
  const issues = [];
  if (!trustedActors.size) issues.push('trusted actors required');
  if (!expectedHead) issues.push('reviewed head sha required');
  if (!expectedInputHash) issues.push('reviewed input sha256 required');
  if (!agentIdRe.test(codeReviewerAgent || '')) issues.push('valid code reviewer agent id required');
  if (!agentIdRe.test(architectAgent || '')) issues.push('valid architect agent id required');
  if (codeReviewerAgent && architectAgent && codeReviewerAgent === architectAgent) issues.push('reviewer and architect agent ids must differ');
  if (!codeReviewerComment) issues.push('code reviewer comment JSON path required');
  if (!architectComment) issues.push('architect comment JSON path required');
  if (!issues.length) {
    issues.push(...validateComment({ path: codeReviewerComment, role: 'code-reviewer', expectedAgent: codeReviewerAgent, expectedHead, expectedInputHash, trustedActors }));
    issues.push(...validateComment({ path: architectComment, role: 'architect', expectedAgent: architectAgent, expectedHead, expectedInputHash, trustedActors }));
  }
  const report = { schema_version: 1, decision: issues.length ? 'FAIL' : 'PASS', issues };
  console.log(JSON.stringify(report, null, 2));
  process.exit(issues.length ? 2 : 0);
}
