import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
const artifactRefPrefix = 'artifact://';
const artifactRunBase = '.agent/runs';
function isSafeRunId(runId) {
    return runId.length > 0 && runId !== '.' && runId !== '..' && !runId.includes('/') && !runId.includes('\\');
}
function isSafeRelPath(relPath) {
    if (relPath.length === 0 || relPath.startsWith('/') || relPath.includes('\\')) {
        return false;
    }
    const parts = relPath.split('/');
    return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}
function artifactStoredRelPath(runId, relPath) {
    return path.posix.join(artifactRunBase, runId, relPath);
}
function artifactAbsPath(root, runId, relPath) {
    return path.join(root, artifactStoredRelPath(runId, relPath));
}
function sha256File(absPath) {
    return createHash('sha256').update(readFileSync(absPath)).digest('hex');
}
export function parseArtifactRef(ref) {
    if (!ref.startsWith(artifactRefPrefix)) {
        return null;
    }
    const rest = ref.slice(artifactRefPrefix.length);
    const separatorIndex = rest.indexOf('/');
    if (separatorIndex <= 0) {
        return null;
    }
    const runId = rest.slice(0, separatorIndex);
    const relPath = rest.slice(separatorIndex + 1);
    if (!isSafeRunId(runId) || !isSafeRelPath(relPath)) {
        return null;
    }
    return { runId, relPath };
}
export function recordArtifact(root, runId, relPath, kind) {
    if (!isSafeRunId(runId) || !isSafeRelPath(relPath)) {
        throw new Error(`invalid artifact path: artifact://${runId}/${relPath}`);
    }
    const storedRelPath = artifactStoredRelPath(runId, relPath);
    return {
        ref: `artifact://${runId}/${relPath}`,
        kind,
        sha256: sha256File(path.join(root, storedRelPath)),
        storedRelPath,
    };
}
export function resolveArtifact(root, artifact) {
    const parsed = parseArtifactRef(artifact.ref);
    if (!parsed) {
        return false;
    }
    const absPath = artifactAbsPath(root, parsed.runId, parsed.relPath);
    if (!existsSync(absPath)) {
        return false;
    }
    return sha256File(absPath) === artifact.sha256;
}
export function assertEvidenceRefsResolve(root, artifacts) {
    for (const artifact of artifacts) {
        if (!resolveArtifact(root, artifact)) {
            throw new Error(`artifact evidence ref does not resolve: ${artifact.ref}`);
        }
    }
}
