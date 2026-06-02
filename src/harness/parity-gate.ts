import type { RuntimeCapabilities } from '../runtime/types.js';

export interface RuntimeParityReport {
  schema_version: 1;
  decision: 'PASS' | 'FAIL';
  checked_at: string;
  runtime_count: number;
  checks: { name: string; status: 'PASS' | 'FAIL'; evidence: string }[];
}

export function runRuntimeParityGate(capabilities: RuntimeCapabilities[]): RuntimeParityReport {
  const runtimeKinds = new Set(capabilities.map((cap) => cap.kind));
  const requiredKinds = ['codex', 'omx', 'agy', 'shell'];
  const allKindsPresent = requiredKinds.every((kind) => runtimeKinds.has(kind as any));
  const shellCannotBypass = capabilities
    .filter((cap) => cap.kind === 'shell')
    .every((cap) => cap.firstClass === false && cap.label === 'primitive_shell');
  const nonShellHonest = capabilities
    .filter((cap) => cap.kind !== 'shell')
    .every((cap) => !cap.firstClass || Object.values(cap.lifecycle).every((status) => status === 'supported'));
  const noUnsupportedPass = capabilities.every((cap) =>
    Object.entries(cap.lifecycle).every(([, status]) => ['supported', 'unsupported', 'unproven'].includes(status)),
  );
  const checks = [
    {
      name: 'Runtime Coverage Gate',
      status: allKindsPresent ? ('PASS' as const) : ('FAIL' as const),
      evidence: `required=${requiredKinds.join(',')} present=${[...runtimeKinds].join(',')}`,
    },
    {
      name: 'Primitive Shell Non-Bypass Gate',
      status: shellCannotBypass ? ('PASS' as const) : ('FAIL' as const),
      evidence: 'shell must remain primitive_shell and firstClass=false',
    },
    {
      name: 'First-Class Honesty Gate',
      status: nonShellHonest ? ('PASS' as const) : ('FAIL' as const),
      evidence: 'non-shell adapters cannot be firstClass unless all lifecycle verbs are supported',
    },
    {
      name: 'Lifecycle Vocabulary Gate',
      status: noUnsupportedPass ? ('PASS' as const) : ('FAIL' as const),
      evidence: 'lifecycle states are supported/unsupported/unproven only',
    },
  ];
  return {
    schema_version: 1,
    decision: checks.every((check) => check.status === 'PASS') ? 'PASS' : 'FAIL',
    checked_at: new Date().toISOString(),
    runtime_count: capabilities.length,
    checks,
  };
}
