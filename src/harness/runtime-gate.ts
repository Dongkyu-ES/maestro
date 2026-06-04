import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, normalize, relative, resolve } from 'node:path';
import type { RuntimeEventEnvelope } from '../events/ledger.js';
import { validateRuntimeLedger } from '../events/ledger.js';
import type { RuntimeCapabilities } from '../runtime/types.js';

export interface RuntimeHardGateInput {
  events: RuntimeEventEnvelope[];
  capabilities: RuntimeCapabilities[];
  milestoneClaim?: string;
  artifactRefs?: string[];
  artifactRoot?: string;
}
export interface RuntimeHardGateCheck {
  name: string;
  status: 'PASS' | 'FAIL';
  evidence: string;
}
export interface RuntimeHardGateReport {
  schema_version: 1;
  decision: 'PASS' | 'FAIL';
  slice_label: 'compatibility_slice' | 'capability_slice' | 'full_target_gate';
  false_completion_result: 'PASS' | 'FAIL';
  checks: RuntimeHardGateCheck[];
  current_target_gaps: string[];
}

function check(name: string, ok: boolean, evidence: string): RuntimeHardGateCheck {
  return { name, status: ok ? 'PASS' : 'FAIL', evidence };
}

function artifactExists(root: string | undefined, ref: string): boolean {
  if (!root || !ref || normalize(ref).startsWith('..')) return false;
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, ref);
  const rel = relative(resolvedRoot, target);
  return rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && existsSync(target);
}

function artifactDigestMatches(root: string | undefined, ref: string, expected: unknown): boolean {
  if (typeof expected !== 'string' || !artifactExists(root, ref)) return false;
  const digest = createHash('sha256')
    .update(readFileSync(join(resolve(root!), ref)))
    .digest('hex');
  return digest === expected;
}

function fullTargetArtifactPasses(root: string | undefined, ref: string): boolean {
  if (!artifactExists(root, ref)) return false;
  try {
    const artifact = JSON.parse(readFileSync(join(resolve(root!), ref), 'utf8')) as {
      decision?: unknown;
      requirements?: unknown;
      source_event_ids?: unknown;
      ledger_head_sha256?: unknown;
      ledger_event_count?: unknown;
    };
    const requirements = Array.isArray(artifact.requirements)
      ? (artifact.requirements as Array<{ status?: unknown }>)
      : [];
    const names = new Set(requirements.map((item: any) => String(item.name || '')));
    const requiredNames = [
      'web goal input',
      'sandbox context',
      'composition',
      'codex launch attach stream',
      'approval top lane',
      'interrupt',
      'resume',
      'fork',
      'parallel blackboard',
      'sequential handoff',
      'hard gate',
      'learning memory',
      'review boundary',
      'commit approval boundary',
      'push deploy approval boundary',
      'ledger projection UI render agreement',
    ];
    return (
      artifact.decision === 'PASS' &&
      requiredNames.every((name) => names.has(name)) &&
      requirements.every((item) => item.status === 'PASS') &&
      Array.isArray(artifact.source_event_ids) &&
      artifact.source_event_ids.length > 0 &&
      typeof artifact.ledger_head_sha256 === 'string' &&
      Number.isInteger(artifact.ledger_event_count)
    );
  } catch {
    return false;
  }
}

export function runRuntimeHardGate(input: RuntimeHardGateInput): RuntimeHardGateReport {
  let ledgerValid = true;
  try {
    validateRuntimeLedger(input.events);
  } catch {
    ledgerValid = false;
  }
  const labels = new Set(
    input.events.flatMap((event) => [
      String(event.payload.runtime_label || ''),
      String(event.payload.adapter_kind || ''),
    ]),
  );
  const hasOnlyShell =
    labels.size > 0 &&
    [...labels]
      .filter(Boolean)
      .every((label) => ['primitive_shell', 'diagnostic_shell', 'compatibility_shell', 'shell'].includes(label));
  const hasCodexLabelEvidence = input.events.some(
    (event) =>
      event.source === 'codex-adapter' ||
      event.payload.adapter_kind === 'codex' ||
      event.payload.requested_adapter_kind === 'codex',
  );
  const codex = input.capabilities.find((cap) => cap.kind === 'codex');
  const codexCapabilitySupported = Boolean(
    codex && codex.lifecycle.launch === 'supported' && codex.lifecycle.stream === 'supported',
  );
  const hasProvenCodexSession = input.events.some(
    (event) =>
      event.source === 'codex-adapter' &&
      event.type === 'runtime.session.started' &&
      event.payload.evidence_status === 'supported' &&
      event.artifact_refs.length > 0 &&
      event.artifact_refs.every((ref) => artifactExists(input.artifactRoot, ref)),
  );
  const authoritativeFullGate = input.events.some(
    (event) =>
      event.type === 'gate.full_target.verified' &&
      event.source === 'harness' &&
      event.artifact_refs.length > 0 &&
      event.artifact_refs.every((ref) => artifactExists(input.artifactRoot, ref)) &&
      event.payload.ledger_head_sha256 === event.prev_event_sha256 &&
      event.payload.ledger_event_count === event.sequence - 1 &&
      (event.payload.artifact_sha256
        ? event.artifact_refs.some(
            (ref) =>
              artifactDigestMatches(input.artifactRoot, ref, event.payload.artifact_sha256) &&
              fullTargetArtifactPasses(input.artifactRoot, ref),
          )
        : false),
  );
  const completionClaim = input.milestoneClaim || '';
  const claimsFullCompletion = /95%|complete|완성|full target/i.test(completionClaim);
  const checks = [
    check(
      'Ledger Validation Gate',
      ledgerValid,
      'runtime hard gate only trusts canonical ordered events with valid payload hashes',
    ),
    check(
      'Adapter Contract Gate',
      input.capabilities.some((cap) => cap.kind === 'shell') && input.capabilities.some((cap) => cap.kind === 'codex'),
      'shell primitive and Codex capability records must both exist for first-slice comparison',
    ),
    check(
      'Shell False Completion Gate',
      !(hasOnlyShell && claimsFullCompletion),
      'shell-only evidence cannot satisfy full product/runtime completion claim',
    ),
    check(
      'Codex Evidence Label Gate',
      Boolean(codex) && hasCodexLabelEvidence,
      'Codex lifecycle must be labeled supported/unproven/unsupported without pretending unproven is complete',
    ),
    check(
      'Full Target Runtime Proof Gate',
      !claimsFullCompletion || (codexCapabilitySupported && hasProvenCodexSession),
      'full runtime completion requires supported Codex lifecycle capability plus real session artifacts; unsupported/unproven is a gap',
    ),
    check(
      'Milestone Claim Language Gate',
      !claimsFullCompletion || (codexCapabilitySupported && hasProvenCodexSession && authoritativeFullGate),
      'M0-M7 must remain compatibility/capability slices unless a verified full target gate artifact exists',
    ),
  ];
  const decision = checks.every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL';
  return {
    schema_version: 1,
    decision,
    slice_label: input.events.some((e) => e.type.startsWith('runtime.')) ? 'capability_slice' : 'compatibility_slice',
    false_completion_result: checks.find((c) => c.name === 'Shell False Completion Gate')?.status || 'FAIL',
    checks,
    current_target_gaps:
      decision === 'PASS'
        ? ['OMX adapter missing', 'agy adapter missing', 'full M8 E2E not yet passed']
        : ['real Codex session bridge still unproven', 'full M8 E2E not yet passed'],
  };
}
