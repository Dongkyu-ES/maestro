import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export type PhaseId = 'research' | 'execute' | 'review';

export interface EvidenceRef {
  phase: PhaseId;
  relativePath: string;
  sha256: string;
  storePath: string;
}

function sha256Hex(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export function storePhaseArtifact(opts: {
  root: string;
  skillRunId: string;
  phase: PhaseId;
  sourceFile: string;
  relativePath?: string;
}): EvidenceRef {
  const content = readFileSync(opts.sourceFile);
  const relativePath = opts.relativePath ?? basename(opts.sourceFile);
  const storePath = join(
    opts.root,
    '.agent',
    'skill-runs',
    opts.skillRunId,
    'artifacts',
    opts.phase,
    basename(relativePath),
  );
  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(storePath, content);

  return {
    phase: opts.phase,
    relativePath,
    sha256: sha256Hex(content),
    storePath,
  };
}

export function resolveEvidenceArtifact(ref: EvidenceRef): { content: Buffer; verified: boolean } {
  const content = readFileSync(ref.storePath);
  return { content, verified: sha256Hex(content) === ref.sha256 };
}

export function materializeEvidenceInto(ref: EvidenceRef, destDir: string): string {
  const { content, verified } = resolveEvidenceArtifact(ref);
  if (!verified) {
    throw new Error(`sha256 mismatch for evidence artifact ${ref.storePath}; possible tamper`);
  }

  const destPath = join(destDir, ref.relativePath);
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, content);
  return destPath;
}
