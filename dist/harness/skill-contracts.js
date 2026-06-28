import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { runVerifier } from './verifier.js';
const SHARED_VERIFIER_TYPES = new Set(['artifact', 'test', 'ledger', 'diff', 'review_custody']);
const BINDING_KEYS = new Set(['id', 'type', 'artifactRef', 'expectedSha256', 'command', 'mustInclude', 'forbiddenChangedPaths']);
function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}
function contractFiles(root, runDir) {
    const files = [];
    const runContract = runDir ? join(runDir, 'skill-acceptance-contracts.json') : '';
    if (runContract && existsSync(runContract))
        files.push(runContract);
    const dir = join(root, '.agent', 'skill-contracts');
    if (existsSync(dir)) {
        for (const file of readdirSync(dir).filter((item) => item.endsWith('.json')).sort())
            files.push(join(dir, file));
    }
    return files;
}
function normalizeContracts(value) {
    if (Array.isArray(value))
        return value;
    if (value && typeof value === 'object' && Array.isArray(value.contracts))
        return value.contracts;
    return [];
}
function toVerifierInput(root, binding) {
    return {
        type: binding.type,
        root,
        artifactRef: binding.artifactRef,
        expectedSha256: binding.expectedSha256,
        command: binding.command ? [...binding.command] : undefined,
        mustInclude: binding.mustInclude ? [...binding.mustInclude] : undefined,
        forbiddenChangedPaths: binding.forbiddenChangedPaths ? [...binding.forbiddenChangedPaths] : undefined,
    };
}
function unknownBindingKeys(binding) {
    return Object.keys(binding).filter((key) => !BINDING_KEYS.has(key));
}
function validateContract(root, contract) {
    const reasons = [];
    const hardness = contract?.hardness === 'SOFT' || contract?.hardness === 'HARD' ? contract.hardness : 'INVALID';
    if (contract?.schema_version !== 1)
        reasons.push('schema_version must be 1');
    if (!contract?.skill_name)
        reasons.push('skill_name is required');
    if (!contract?.skill_path)
        reasons.push('skill_path is required');
    if (contract.skill_path?.startsWith('/') || contract.skill_path?.includes('..'))
        reasons.push('skill_path must be repo-relative');
    if (!contract.allowed_tool_intents?.length)
        reasons.push('allowed_tool_intents must declare the native tool boundary');
    if (hardness === 'INVALID')
        reasons.push('hardness must be SOFT or HARD');
    const bindings = contract.verifier_bindings || [];
    for (const binding of bindings) {
        if (!binding.id)
            reasons.push(`${contract.skill_name}: verifier binding missing id`);
        if (!SHARED_VERIFIER_TYPES.has(binding.type))
            reasons.push(`${contract.skill_name}: verifier binding uses non-shared type ${String(binding.type)}`);
        if (hardness === 'HARD' && binding.type === 'artifact' && !binding.expectedSha256)
            reasons.push(`${binding.id}: HARD artifact verifier binding requires expectedSha256`);
        if (hardness === 'HARD' && binding.type === 'test')
            reasons.push(`${binding.id}: HARD test verifier bindings are non-executing; use digest-bound artifacts or ledger proof`);
        const extras = unknownBindingKeys(binding);
        if (extras.length)
            reasons.push(`${contract.skill_name}: bespoke verifier keys forbidden (${extras.join(', ')})`);
    }
    if (hardness === 'SOFT') {
        if (bindings.length)
            reasons.push('SOFT skills cannot carry verifier bindings or gate completion');
    }
    else if (hardness === 'HARD') {
        if (!bindings.length)
            reasons.push('HARD skills require at least one shared verifier binding');
        if (!contract.forgery_fixture)
            reasons.push('HARD skills require a forgery_fixture that fails');
        for (const binding of bindings) {
            const result = runVerifier(toVerifierInput(root, binding));
            if (result.status !== 'supported')
                reasons.push(`${binding.id}: verifier did not support raw evidence (${result.reason})`);
        }
        if (contract.forgery_fixture) {
            const forged = runVerifier(toVerifierInput(root, contract.forgery_fixture.binding));
            if (forged.status === 'supported')
                reasons.push(`${contract.forgery_fixture.id}: forgery fixture unexpectedly passed`);
            const extras = unknownBindingKeys(contract.forgery_fixture.binding);
            if (extras.length)
                reasons.push(`${contract.forgery_fixture.id}: bespoke verifier keys forbidden (${extras.join(', ')})`);
        }
    }
    return {
        skill_name: contract?.skill_name || 'unknown',
        hardness,
        status: reasons.length ? 'FAIL' : 'PASS',
        reasons,
    };
}
export function verifySkillContracts(options) {
    const checks = [];
    const files = contractFiles(options.root, options.runDir);
    for (const file of files) {
        try {
            for (const contract of normalizeContracts(readJson(file)))
                checks.push(validateContract(options.root, contract));
        }
        catch (error) {
            checks.push({
                skill_name: basename(file),
                hardness: 'INVALID',
                status: 'FAIL',
                reasons: [error instanceof Error ? error.message : String(error)],
            });
        }
    }
    const report = {
        schema_version: 1,
        generated_at: new Date().toISOString(),
        decision: checks.every((check) => check.status === 'PASS') ? 'PASS' : 'FAIL',
        contracts_path: options.runDir ? 'run skill-acceptance-contracts.json plus .agent/skill-contracts/*.json' : '.agent/skill-contracts/*.json',
        checks,
    };
    const reportPath = options.reportPath || join(options.root, '.agent', 'hard-gates', 'skill-contracts-verification.json');
    mkdirSync(join(options.root, '.agent', 'hard-gates'), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    return report;
}
export function skillContractIssuesForRun(root, runDir, responseText) {
    const claimsHardGate = /\bHARD\b|gate(?:d|s)? completion|completion gate|PASS/i.test(responseText);
    const hasRunContract = existsSync(join(runDir, 'skill-acceptance-contracts.json'));
    const hasRepoContracts = existsSync(join(root, '.agent', 'skill-contracts'));
    if (!hasRunContract && !hasRepoContracts) {
        return claimsHardGate
            ? ['native skill output claims HARD/gated success but no AcceptanceContract verifier evidence exists']
            : [];
    }
    const report = verifySkillContracts({ root, runDir, reportPath: join(runDir, 'skill-contracts-verification.json') });
    const issues = [];
    for (const check of report.checks) {
        if (check.status === 'FAIL')
            issues.push(`${check.skill_name} ${check.hardness}: ${check.reasons.join('; ')}`);
    }
    const hasPassingHardContract = report.checks.some((check) => check.hardness === 'HARD' && check.status === 'PASS');
    if (claimsHardGate && !hasPassingHardContract)
        issues.push('native skill output claims HARD/gated/PASS success but no passing HARD AcceptanceContract verifier evidence exists');
    return issues.slice(0, 8);
}
