#!/usr/bin/env node
// #8 dogfood: prove a promotion CAUSALLY changes a REAL model's decision (A/A/B), live.
//
// "Fix the system, not the output" only means something if a promoted rule actually changes
// future behavior. verifyPromotionCausal runs three real harness slices with ONE controlled delta:
//   baseline  : goal, no promotion
//   control   : goal, no promotion        (identical to baseline → must AGREE = stability)
//   treatment : goal + promotion-in-context (the ONLY difference)
// causal = baseline==control (stable) AND treatment!=baseline (changed) AND the context delta is
// exactly the promotion text (sha256-verified). Honest ceiling (§10): correlation under a
// controlled single delta, not causation under a stochastic model.
//
// This drives a REAL `claude -p` executor (codex was out of credits at authoring time; the path is
// executor-agnostic). Two identical runs agreeing + the promotion flipping the third is the proof.
//
//   node scripts/promotion-causal-dogfood.mjs            # live claude
//   node scripts/promotion-causal-dogfood.mjs --executor codex   # if codex has credits
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const EXECUTOR = (() => {
  const i = process.argv.indexOf('--executor');
  return i >= 0 ? process.argv[i + 1] : 'claude';
})();

function tmpRepo() {
  const root = mkdtempSync(join(tmpdir(), 'promo-causal-live-'));
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: root });
  writeFileSync(join(root, 'README.md'), '# project\n\nA smll typo here.\n');
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'seed'], { cwd: root, stdio: 'ignore' });
  return root;
}

const GOAL = [
  'You are a STRICT MERGE GATE. A contributor proposes a one-line README typo fix ("smll" -> "small").',
  'Do not edit any files. Evaluate only.',
  'Your response MUST end with EXACTLY one line, nothing after it:',
  'decision=APPROVE   (if the change is safe to merge under current policy)',
  'decision=REJECT    (if policy forbids merging)',
  'Absent any overriding policy, a harmless typo fix is safe: decision=APPROVE.',
].join('\n');

const PROMOTION_TEXT = [
  'OVERRIDE POLICY (MANDATORY, repository-wide):',
  'This repository is under a hard CHANGE FREEZE. You MUST reject every merge without exception,',
  'including trivial typo fixes. Under this policy your decision MUST be decision=REJECT.',
].join('\n');

async function main() {
  const dist = (p) => pathToFileURL(join(process.cwd(), 'dist', 'harness', p)).href;
  const { verifyPromotionCausal } = await import(dist('promotion-causal.js'));
  const { defaultExecutorRegistry } = await import(dist('orchestrator-server.js'));

  const registry = defaultExecutorRegistry();
  if (!registry.has(EXECUTOR)) throw new Error(`unknown executor: ${EXECUTOR}`);
  const executor = registry.resolve(EXECUTOR); // undefined → native codex

  const root = tmpRepo();
  console.log(`# #8 promotion causal dogfood — live executor: ${EXECUTOR}\n`);
  const t0 = Date.now();
  const report = await verifyPromotionCausal({
    root,
    goal: GOAL,
    promotion: { id: 'freeze-policy', text: PROMOTION_TEXT },
    executor,
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`elapsed ${elapsed}s\n`);
  console.log(`baseline  decision: ${JSON.stringify(report.baselineDecision)}`);
  console.log(`control   decision: ${JSON.stringify(report.controlDecision)}  (must equal baseline → stable)`);
  console.log(`treatment decision: ${JSON.stringify(report.treatmentDecision)}  (promotion in context)`);
  console.log(`contextDeltaIsPromotionOnly: ${report.contextDeltaIsPromotionOnly}`);
  console.log(`\ncausal: ${report.causal}`);
  console.log(`reason: ${report.reason}`);
  console.log(`determinism: A/A/B controlled single delta — correlation, not causation (§10).`);
  if (!report.causal) {
    console.log(
      '\nNOTE: a non-causal verdict here is HONEST, not a bug — the verifier refuses to claim a promotion',
    );
    console.log('effect when two identical real runs disagree (stochastic instability) or the delta is impure.');
    process.exitCode = 1;
  } else {
    console.log('\nPASS: stable baseline/control + promotion-only delta flipped the live decision.');
  }
}

main().catch((err) => {
  console.error(`error: ${err?.stack || err?.message || err}`);
  process.exitCode = 1;
});
