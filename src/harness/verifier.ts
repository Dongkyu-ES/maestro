import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
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
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, ref);
  const rel = relative(resolvedRoot, target);
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) return null;
  return target;
}

export function runVerifier(input: VerifierInput): VerifierResult {
  if (input.type === 'artifact') {
    const target = input.artifactRef ? insideRoot(input.root, input.artifactRef) : null;
    if (!target || !existsSync(target)) {
      return { type: input.type, status: 'unproven', evidenceInputs: [], reason: 'artifact missing or outside root' };
    }
    if (input.expectedSha256) {
      const actual = createHash('sha256').update(readFileSync(target)).digest('hex');
      if (actual !== input.expectedSha256) {
        return {
          type: input.type,
          status: 'blocked',
          evidenceInputs: [input.artifactRef || ''],
          reason: 'artifact digest mismatch',
        };
      }
    }
    return {
      type: input.type,
      status: 'supported',
      evidenceInputs: [input.artifactRef || ''],
      reason: 'artifact exists and digest matches when provided',
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
    if (!input.command?.length) return { type: input.type, status: 'unproven', evidenceInputs: [], reason: 'missing command' };
    try {
      const [cmd, ...args] = input.command;
      const out = execFileSync(cmd, args, {
        cwd: input.root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30000,
      });
      const ok = (input.mustInclude || []).every((needle) => out.includes(needle));
      return {
        type: input.type,
        status: ok ? 'supported' : 'blocked',
        evidenceInputs: [input.command.join(' ')],
        reason: ok ? 'command output matched' : 'command output missing required text',
      };
    } catch (error) {
      return {
        type: input.type,
        status: 'blocked',
        evidenceInputs: [input.command.join(' ')],
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (input.type === 'diff') {
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: input.root, encoding: 'utf8' });
    const changed = status
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(3));
    const forbidden = input.forbiddenChangedPaths || [];
    const hit = changed.find((file) => forbidden.includes(file));
    return {
      type: input.type,
      status: hit ? 'blocked' : 'supported',
      evidenceInputs: ['git status --porcelain'],
      reason: hit ? `forbidden changed path: ${hit}` : 'no forbidden diff paths',
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
