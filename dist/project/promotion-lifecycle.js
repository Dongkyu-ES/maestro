export const PROMOTION_STATUS_TO_STAGE = {
    proposed: 'candidate',
    approved: 'validated',
    applied: 'promoted',
    rejected: 'rejected',
};
export function ontologyStageForStatus(status) {
    return PROMOTION_STATUS_TO_STAGE[status];
}
/**
 * Legal forward transitions. `applied` and `rejected` are terminal. `proposed -> applied` is
 * intentionally absent: a candidate must be validated (approved) before it can be promoted (applied),
 * matching `applyApprovedPromotion`'s own "not approved" guard.
 */
export const PROMOTION_TRANSITIONS = {
    proposed: ['approved', 'rejected'],
    approved: ['applied', 'rejected'],
    applied: [],
    rejected: [],
};
export function canTransitionPromotion(from, to) {
    return PROMOTION_TRANSITIONS[from].includes(to);
}
/**
 * Throw if `from -> to` is not a legal promotion transition. Used to guard mutations so an already
 * terminal record (`applied`/`rejected`) cannot be silently reverted.
 */
export function assertPromotionTransition(from, to) {
    if (from === to)
        return; // idempotent self-transition is a no-op, not an error
    if (!canTransitionPromotion(from, to))
        throw new Error(`illegal promotion transition ${from} -> ${to} (${ontologyStageForStatus(from)} -> ${ontologyStageForStatus(to)}); legal next: ${PROMOTION_TRANSITIONS[from].join(', ') || '(terminal)'}`);
}
