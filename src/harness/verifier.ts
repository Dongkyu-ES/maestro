import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import {
  assertEvidenceBoundToLedgerHead,
  type RuntimeEventEnvelope,
  type RuntimeLedgerHeadBinding,
  validateRuntimeLedger,
} from '../events/ledger.js';
import type { ContractStatus } from './evidence-contract.js';

export type VerifierType = 'artifact' | 'test' | 'ledger' | 'diff' | 'review_custody';

export interface VerifierInput {
  type: VerifierType;
  root: string;
  artifactRef?: string;
  expectedSha256?: string;
  events?: RuntimeEventEnvelope[];
  ledgerBinding?: RuntimeLedgerHeadBinding;
  command?: string[];
  mustInclude?: string[];
  forbiddenChangedPaths?: string[];
  diffStatusArtifactRef?: string;
  diffStatusExpectedSha256?: string;
  reviewCustody?: { signed: boolean; custodyAttested: boolean; issuerTrusted: boolean };
}

export interface VerifierResult {
  type: VerifierType;
  status: ContractStatus;
  evidenceInputs: string[];
  reason: string;
}

function insideRoot(root: string, ref: string): string | null {
  if (!ref || ref.startsWith('/') || ref.includes('..')) return null;
  try {
    const resolvedRoot = realpathSync(resolve(root));
    const lexicalTarget = resolve(resolvedRoot, ref);
    const lexicalRel = relative(resolvedRoot, lexicalTarget);
    if (lexicalRel === '..' || lexicalRel.startsWith('../') || lexicalRel.startsWith('..\\')) return null;
    if (!existsSync(lexicalTarget)) return null;
    if (lstatSync(lexicalTarget).isSymbolicLink()) return null;
    const target = realpathSync(lexicalTarget);
    const rel = relative(resolvedRoot, target);
    if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) return null;
    return target;
  } catch {
    return null;
  }
}

export function runVerifier(input: VerifierInput): VerifierResult {
  if (input.type === 'artifact') {
    const target = input.artifactRef ? insideRoot(input.root, input.artifactRef) : null;
    if (!target || !existsSync(target)) {
      return { type: input.type, status: 'unproven', evidenceInputs: [], reason: 'artifact missing, symlinked, or outside root' };
    }
    if (!input.expectedSha256) {
      return {
        type: input.type,
        status: 'unproven',
        evidenceInputs: [input.artifactRef || ''],
        reason: 'artifact verifier requires expectedSha256',
      };
    }
    const actual = createHash('sha256').update(readFileSync(target)).digest('hex');
    if (actual !== input.expectedSha256) {
      return {
        type: input.type,
        status: 'blocked',
        evidenceInputs: [input.artifactRef || ''],
        reason: 'artifact digest mismatch',
      };
    }
    return {
      type: input.type,
      status: 'supported',
      evidenceInputs: [input.artifactRef || ''],
      reason: 'artifact exists inside root, is not a symlink, and digest matches',
    };
  }

  if (input.type === 'ledger') {
    try {
      const events = input.events || [];
      validateRuntimeLedger(events);
      if (input.ledgerBinding) assertEvidenceBoundToLedgerHead(input.ledgerBinding, events);
      return {
        type: input.type,
        status: 'supported',
        evidenceInputs: ['events'],
        reason: 'ledger validates and matches head binding when provided',
      };
    } catch (error) {
      return {
        type: input.type,
        status: 'blocked',
        evidenceInputs: ['events'],
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (input.type === 'test') {
    return {
      type: input.type,
      status: 'unproven',
      evidenceInputs: input.command?.length ? [input.command.join(' ')] : [],
      reason: 'test verifier is non-executing; provide a digest-bound artifact or ledger proof instead',
    };
  }

  if (input.type === 'diff') {
    const target = input.diffStatusArtifactRef ? insideRoot(input.root, input.diffStatusArtifactRef) : null;
    if (!target || !input.diffStatusExpectedSha256) {
      return {
        type: input.type,
        status: 'unproven',
        evidenceInputs: input.diffStatusArtifactRef ? [input.diffStatusArtifactRef] : [],
        reason: 'diff verifier is non-executing; provide digest-bound git status artifact evidence',
      };
    }
    const evidenceRef = input.diffStatusArtifactRef;
    if (!evidenceRef) {
      return { type: input.type, status: 'unproven', evidenceInputs: [], reason: 'missing diff status artifact reference' };
    }
    const statusText = readFileSync(target, 'utf8');
    const actual = createHash('sha256').update(statusText).digest('hex');
    if (actual !== input.diffStatusExpectedSha256) {
      return {
        type: input.type,
        status: 'blocked',
        evidenceInputs: [evidenceRef],
        reason: 'diff status artifact digest mismatch',
      };
    }
    const changed = statusText
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(3));
    const forbidden = input.forbiddenChangedPaths || [];
    const hit = changed.find((file) => forbidden.includes(file));
    return {
      type: input.type,
      status: hit ? 'blocked' : 'supported',
      evidenceInputs: [evidenceRef],
      reason: hit ? `forbidden changed path: ${hit}` : 'digest-bound diff artifact contains no forbidden paths',
    };
  }

  const custody = input.reviewCustody;
  if (!custody) {
    return { type: input.type, status: 'unproven', evidenceInputs: [], reason: 'missing review custody evidence' };
  }
  const ok = custody.signed && custody.custodyAttested && custody.issuerTrusted;
  return {
    type: input.type,
    status: ok ? 'supported' : 'blocked',
    evidenceInputs: ['review custody'],
    reason: ok ? 'custody attested by trusted issuer' : 'review is not independently custody-attested',
  };
}

export function assertVerifierInputSensitive(good: VerifierInput, forged: VerifierInput): void {
  const goodStatus = runVerifier(good).status;
  const forgedStatus = runVerifier(forged).status;
  if (goodStatus === forgedStatus) throw new Error(`verifier is constant with respect to input: ${goodStatus}`);
}
