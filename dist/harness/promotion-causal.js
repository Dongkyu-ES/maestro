import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runHarnessSlice } from './harness-run.js';
function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}
function promotionContext(promotion) {
    return `Promotion ${promotion.id}:\n${promotion.text}`;
}
function runDir(root, report) {
    return join(root, report.runDir);
}
function safeReadJson(path) {
    if (!existsSync(path))
        return undefined;
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return undefined;
    }
}
function extractDecision(root, report) {
    const processLog = safeReadJson(join(runDir(root, report), 'executor.process.json'));
    const lastMessage = typeof processLog?.last_message === 'string' ? processLog.last_message : '';
    const jsonStart = lastMessage.indexOf('{');
    if (jsonStart >= 0) {
        try {
            const parsed = JSON.parse(lastMessage.slice(jsonStart));
            if (typeof parsed.decision === 'string' && parsed.decision.trim())
                return parsed.decision.trim();
        }
        catch {
            // Fall back to the plain decision=<value> format used by harness fixtures.
        }
    }
    const match = /(?:^|\b)decision\s*[:=]\s*([A-Za-z0-9_-]+)/.exec(lastMessage);
    if (match?.[1])
        return match[1];
    return lastMessage.trim();
}
function contextBundle(root, report) {
    return safeReadJson(join(runDir(root, report), 'context-bundle.json'));
}
function contextDeltaIsPromotionOnly(options) {
    const baseline = contextBundle(options.root, options.baseline);
    const control = contextBundle(options.root, options.control);
    const treatment = contextBundle(options.root, options.treatment);
    const expectedPromotionContext = promotionContext(options.promotion);
    return (options.baseline.contextSha256 === options.control.contextSha256 &&
        options.control.contextSha256 !== options.treatment.contextSha256 &&
        baseline?.goal === control?.goal &&
        control?.goal === treatment?.goal &&
        baseline?.context_extras === undefined &&
        control?.context_extras === undefined &&
        treatment?.context_extras === expectedPromotionContext &&
        treatment?.included_context_extras_sha256 === sha256(expectedPromotionContext));
}
function causalReason(options) {
    if (!options.stableControl)
        return 'baseline and control decisions differ; run behavior is not stable';
    if (!options.contextDeltaIsPromotionOnly)
        return 'control and treatment context delta is not isolated to the promotion';
    if (!options.changedTreatment)
        return 'treatment decision did not differ from the stable baseline/control decision';
    return 'stable baseline/control plus promotion-only context delta changed the treatment decision';
}
export async function verifyPromotionCausal(options) {
    const causalRunId = `promotion-causal-${randomUUID()}`;
    const promotion = promotionContext(options.promotion);
    const baseline = await runHarnessSlice({
        root: options.root,
        goal: options.goal,
        executor: options.executor,
        executorBin: options.executorBin,
        runId: `${causalRunId}-baseline`,
    });
    const control = await runHarnessSlice({
        root: options.root,
        goal: options.goal,
        executor: options.executor,
        executorBin: options.executorBin,
        runId: `${causalRunId}-control`,
    });
    const treatment = await runHarnessSlice({
        root: options.root,
        goal: options.goal,
        contextExtras: promotion,
        executor: options.executor,
        executorBin: options.executorBin,
        runId: `${causalRunId}-treatment`,
    });
    const baselineDecision = extractDecision(options.root, baseline);
    const controlDecision = extractDecision(options.root, control);
    const treatmentDecision = extractDecision(options.root, treatment);
    const stableControl = baselineDecision === controlDecision;
    const changedTreatment = treatmentDecision !== baselineDecision;
    const onlyPromotion = contextDeltaIsPromotionOnly({
        root: options.root,
        promotion: options.promotion,
        baseline,
        control,
        treatment,
    });
    const causal = stableControl && changedTreatment && onlyPromotion;
    const report = {
        schema_version: 1,
        generated_at: new Date().toISOString(),
        causal,
        baselineDecision,
        controlDecision,
        treatmentDecision,
        baselineContextSha256: baseline.contextSha256,
        controlContextSha256: control.contextSha256,
        treatmentContextSha256: treatment.contextSha256,
        contextDeltaIsPromotionOnly: onlyPromotion,
        reason: causalReason({ stableControl, changedTreatment, contextDeltaIsPromotionOnly: onlyPromotion }),
        runs: { baseline, control, treatment },
    };
    const reportDir = join(options.root, '.agent', 'hard-gates');
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(join(reportDir, 'promotion-causal-verification.json'), `${JSON.stringify(report, null, 2)}\n`);
    return report;
}
