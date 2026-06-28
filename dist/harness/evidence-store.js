import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
function sha256Hex(content) {
    return createHash('sha256').update(content).digest('hex');
}
export function storePhaseArtifact(opts) {
    const content = readFileSync(opts.sourceFile);
    const relativePath = opts.relativePath ?? basename(opts.sourceFile);
    const storePath = join(opts.root, '.agent', 'skill-runs', opts.skillRunId, 'artifacts', opts.phase, basename(relativePath));
    mkdirSync(dirname(storePath), { recursive: true });
    writeFileSync(storePath, content);
    return {
        phase: opts.phase,
        relativePath,
        sha256: sha256Hex(content),
        storePath,
    };
}
export function resolveEvidenceArtifact(ref) {
    const content = readFileSync(ref.storePath);
    return { content, verified: sha256Hex(content) === ref.sha256 };
}
export function materializeEvidenceInto(ref, destDir) {
    const { content, verified } = resolveEvidenceArtifact(ref);
    if (!verified) {
        throw new Error(`sha256 mismatch for evidence artifact ${ref.storePath}; possible tamper`);
    }
    const destPath = join(destDir, ref.relativePath);
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, content);
    return destPath;
}
