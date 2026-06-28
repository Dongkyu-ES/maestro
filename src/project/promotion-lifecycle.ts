import type { PromotionRecord } from '../util.js';

/**
 * Formal promotion lifecycle — makes the previously-implicit promotion state transitions explicit
 * and guarded, and aligns Warden's status vocabulary to the MetaOntology promotion grammar.
 *
 * Warden has always used the vocabulary `proposed -> approved -> applied` (+ `rejected`). The
 * MetaOntology OS promotion grammar names the same lifecycle `candidate -> validated -> promoted`
 * (+ `rejected`) — register a candidate, validate it, then promote it. They are one lifecycle with
 * two vocabularies; this module pins the mapping and the legal transitions so:
 *  - the ontology projection can render promotions in the 9-space grammar, and
 *  - illegal transitions (e.g. reverting an already-`applied` promotion, which silently dropped its
 *    `applied_path`) are rejected instead of silently overwriting state.
 *
 * The status union itself is unchanged (it is load-bearing for `product-gate.ts` / `core.test.ts`);
 * this layer only adds guards and the grammar bridge on top of it.
 */

export type PromotionStatus = PromotionRecord['status'];

/** The MetaOntology promotion grammar stage corresponding to each Warden status. */
export type OntologyPromotionStage = 'candidate' | 'validated' | 'promoted' | 'rejected';

export const PROMOTION_STATUS_TO_STAGE: Record<PromotionStatus, OntologyPromotionStage> = {
  proposed: 'candidate',
  approved: 'validated',
  applied: 'promoted',
  rejected: 'rejected',
};

export function ontologyStageForStatus(status: PromotionStatus): OntologyPromotionStage {
  return PROMOTION_STATUS_TO_STAGE[status];
}

/**
 * Legal forward transitions. `applied` and `rejected` are terminal. `proposed -> applied` is
 * intentionally absent: a candidate must be validated (approved) before it can be promoted (applied),
 * matching `applyApprovedPromotion`'s own "not approved" guard.
 */
export const PROMOTION_TRANSITIONS: Record<PromotionStatus, readonly PromotionStatus[]> = {
  proposed: ['approved', 'rejected'],
  approved: ['applied', 'rejected'],
  applied: [],
  rejected: [],
};

export function canTransitionPromotion(from: PromotionStatus, to: PromotionStatus): boolean {
  return PROMOTION_TRANSITIONS[from].includes(to);
}

/**
 * Throw if `from -> to` is not a legal promotion transition. Used to guard mutations so an already
 * terminal record (`applied`/`rejected`) cannot be silently reverted.
 */
export function assertPromotionTransition(from: PromotionStatus, to: PromotionStatus): void {
  if (from === to) return; // idempotent self-transition is a no-op, not an error
  if (!canTransitionPromotion(from, to))
    throw new Error(
      `illegal promotion transition ${from} -> ${to} (${ontologyStageForStatus(from)} -> ${ontologyStageForStatus(
        to,
      )}); legal next: ${PROMOTION_TRANSITIONS[from].join(', ') || '(terminal)'}`,
    );
}
