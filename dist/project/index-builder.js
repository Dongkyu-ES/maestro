import { existsSync, lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { envelopeHash, GENESIS_EVENT_HASH, payloadHash, readRuntimeEvents, validateRuntimeLedger, } from '../events/ledger.js';
import { rebuildRuntimeProjection } from '../projection/projection.js';
import { writeProjectionSqlite } from '../projection/sqlite-store.js';
import { normalizeRunMeta } from '../run/run-utils.js';
import { AGENT_DIR, ensureDir, nowIso, parseFrontmatter, projectRoot, readYaml, safeJoin, } from '../util.js';
// ---------------------------------------------------------------------------
// listFilesRecursive
// ---------------------------------------------------------------------------
export function listFilesRecursive(rootDir, prefix = '') {
    const out = [];
    for (const name of readdirSync(join(rootDir, prefix)).sort()) {
        const rel = prefix ? join(prefix, name) : name;
        const full = join(rootDir, rel);
        const st = lstatSync(full);
        if (st.isSymbolicLink())
            continue;
        if (st.isDirectory())
            out.push(...listFilesRecursive(rootDir, rel));
        else
            out.push(rel);
    }
    return out;
}
// ---------------------------------------------------------------------------
// Thin list-readers used by rebuildIndex (no side-effects, no rebuildIndex calls)
// ---------------------------------------------------------------------------
function listTasksForIndex(root) {
    const dir = safeJoin(root, AGENT_DIR, 'tasks');
    if (!existsSync(dir))
        return [];
    return readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => {
        const meta = parseFrontmatter(readFileSync(join(dir, f), 'utf8'));
        return {
            schema_version: Number(meta.schema_version || 1),
            id: meta.id || f.replace(/\.md$/, ''),
            title: meta.title || meta.id || f,
            status: (meta.status || 'ready'),
            priority: (meta.priority || 'normal'),
            created_at: meta.created_at || '',
            updated_at: meta.updated_at || '',
        };
    })
        .sort((a, b) => a.id.localeCompare(b.id));
}
function listApprovalsForIndex(root) {
    const dir = safeJoin(root, AGENT_DIR, 'approvals');
    if (!existsSync(dir))
        return [];
    return readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}
function listPromotionsForIndex(root) {
    const dir = safeJoin(root, AGENT_DIR, 'promotions');
    if (!existsSync(dir))
        return [];
    return readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}
// ---------------------------------------------------------------------------
// normalizeLegacyRuntimeEventsForProjection (private to this module)
// ---------------------------------------------------------------------------
function normalizeLegacyRuntimeEventsForProjection(runId, events) {
    let migrated = 0;
    const normalized = [];
    for (const event of events) {
        const previous = normalized.at(-1);
        if (event.run_id !== runId)
            throw new Error(`runtime event run_id mismatch: expected ${runId}, got ${event.run_id}`);
        if (typeof event.prev_event_sha256 === 'string') {
            normalized.push(event);
            continue;
        }
        if (event.schema_version !== 1 ||
            !event.event_id ||
            !event.correlation_id ||
            !event.timestamp ||
            !event.source ||
            !event.type)
            throw new Error('legacy runtime event is missing non-migratable envelope fields');
        if (!Number.isInteger(event.sequence) || event.sequence < 1)
            throw new Error('legacy runtime event has invalid sequence');
        if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload))
            throw new Error('legacy runtime event has invalid payload');
        if (!Array.isArray(event.artifact_refs))
            throw new Error('legacy runtime event has invalid artifact_refs');
        if (event.payload_sha256 !== payloadHash(event.payload))
            throw new Error('legacy runtime event payload hash mismatch');
        const expectedSequence = previous ? previous.sequence + 1 : 1;
        if (event.sequence !== expectedSequence)
            throw new Error(`legacy runtime event has non-contiguous sequence: ${event.sequence}`);
        normalized.push({
            ...event,
            prev_event_sha256: previous ? envelopeHash(previous) : GENESIS_EVENT_HASH,
        });
        migrated++;
    }
    return { events: normalized, migrated };
}
// ---------------------------------------------------------------------------
// rebuildRuntimeProjectionStore
// ---------------------------------------------------------------------------
export function rebuildRuntimeProjectionStore(cwd = process.cwd()) {
    const root = projectRoot(cwd);
    const runsDir = safeJoin(root, AGENT_DIR, 'runs');
    const events = [];
    const errors = [];
    const migrations = [];
    if (existsSync(runsDir)) {
        for (const runId of readdirSync(runsDir).sort()) {
            const dir = join(runsDir, runId);
            if (!statSync(dir).isDirectory())
                continue;
            try {
                const normalized = normalizeLegacyRuntimeEventsForProjection(runId, readRuntimeEvents(dir));
                validateRuntimeLedger(normalized.events);
                if (normalized.migrated > 0)
                    migrations.push({
                        run_id: runId,
                        migrated_events: normalized.migrated,
                        reason: 'backfilled missing prev_event_sha256 for projection-only legacy ledger compatibility',
                    });
                events.push(...normalized.events);
            }
            catch (err) {
                errors.push({ run_id: runId, reason: String(err.message || err) });
            }
        }
    }
    const projection = rebuildRuntimeProjection(events);
    const projectionDir = safeJoin(root, AGENT_DIR, 'projection');
    ensureDir(projectionDir);
    writeFileSync(join(projectionDir, 'runtime-projection.json'), JSON.stringify(projection, null, 2));
    writeFileSync(join(projectionDir, 'runtime-projection-errors.json'), JSON.stringify({
        status: errors.length ? 'FAIL' : 'PASS',
        generated_at: nowIso(),
        errors,
    }, null, 2));
    writeFileSync(join(projectionDir, 'runtime-projection-migrations.json'), JSON.stringify({
        status: migrations.length ? 'MIGRATED' : 'NONE',
        generated_at: nowIso(),
        migrations,
    }, null, 2));
    try {
        writeProjectionSqlite(join(projectionDir, 'runtime.sqlite'), projection);
    }
    catch (err) {
        writeFileSync(join(projectionDir, 'runtime-sqlite-error.txt'), String(err.message || err));
    }
    return projection;
}
// ---------------------------------------------------------------------------
// rebuildIndex
// ---------------------------------------------------------------------------
export function rebuildIndex(cwd = process.cwd()) {
    const root = projectRoot(cwd);
    ensureDir(safeJoin(root, AGENT_DIR));
    const projectPath = safeJoin(root, AGENT_DIR, 'project.yaml');
    const project = existsSync(projectPath) ? readYaml(projectPath) : null;
    const runsDir = safeJoin(root, AGENT_DIR, 'runs');
    const runs = existsSync(runsDir)
        ? readdirSync(runsDir)
            .filter((f) => statSync(join(runsDir, f)).isDirectory() && existsSync(join(runsDir, f, 'run.yaml')))
            .map((f) => normalizeRunMeta(readYaml(join(runsDir, f, 'run.yaml')), join(runsDir, f)))
            .sort((a, b) => a.id.localeCompare(b.id))
        : [];
    const artifacts = [];
    for (const run of runs) {
        const dir = join(root, run.run_dir);
        if (!existsSync(dir))
            continue;
        for (const rel of listFilesRecursive(dir))
            artifacts.push({ run_id: run.id, type: rel, path: join(run.run_dir, rel) });
    }
    const index = {
        schema_version: 1,
        generated_at: nowIso(),
        project,
        tasks: listTasksForIndex(root),
        runs,
        approvals: listApprovalsForIndex(root),
        promotions: listPromotionsForIndex(root),
        artifacts,
    };
    writeFileSync(safeJoin(root, AGENT_DIR, 'index.json'), JSON.stringify(index, null, 2));
    rebuildRuntimeProjectionStore(root);
    return index;
}
// ---------------------------------------------------------------------------
// loadIndex
// ---------------------------------------------------------------------------
export function loadIndex(cwd = process.cwd()) {
    const p = safeJoin(projectRoot(cwd), AGENT_DIR, 'index.json');
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : rebuildIndex(cwd);
}
