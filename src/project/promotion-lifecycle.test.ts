import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROMOTION_STATUS_TO_STAGE,
  PROMOTION_TRANSITIONS,
  type PromotionStatus,
  assertPromotionTransition,
  canTransitionPromotion,
  ontologyStageForStatus,
} from './promotion-lifecycle.js';

test('status vocabulary maps 1:1 onto the ontology promotion grammar', () => {
  assert.equal(ontologyStageForStatus('proposed'), 'candidate');
  assert.equal(ontologyStageForStatus('approved'), 'validated');
  assert.equal(ontologyStageForStatus('applied'), 'promoted');
  assert.equal(ontologyStageForStatus('rejected'), 'rejected');
  // every status has a stage
  const all: PromotionStatus[] = ['proposed', 'approved', 'applied', 'rejected'];
  for (const s of all) assert.ok(PROMOTION_STATUS_TO_STAGE[s], `stage for ${s}`);
});

test('legal forward transitions match candidate -> validated -> promoted', () => {
  assert.ok(canTransitionPromotion('proposed', 'approved')); // candidate -> validated
  assert.ok(canTransitionPromotion('proposed', 'rejected'));
  assert.ok(canTransitionPromotion('approved', 'applied')); // validated -> promoted
  assert.ok(canTransitionPromotion('approved', 'rejected'));
});

test('proposed cannot skip straight to applied (must be validated first)', () => {
  assert.equal(canTransitionPromotion('proposed', 'applied'), false);
  assert.throws(() => assertPromotionTransition('proposed', 'applied'), /illegal promotion transition/);
});

test('applied and rejected are terminal — no revert', () => {
  assert.deepEqual(PROMOTION_TRANSITIONS.applied, []);
  assert.deepEqual(PROMOTION_TRANSITIONS.rejected, []);
  assert.throws(() => assertPromotionTransition('applied', 'rejected'), /illegal promotion transition/);
  assert.throws(() => assertPromotionTransition('applied', 'approved'), /\(terminal\)/);
  assert.throws(() => assertPromotionTransition('rejected', 'approved'), /illegal promotion transition/);
});

test('idempotent self-transition is a no-op, not an error', () => {
  assert.doesNotThrow(() => assertPromotionTransition('applied', 'applied'));
  assert.doesNotThrow(() => assertPromotionTransition('proposed', 'proposed'));
});

test('error names both vocabularies for operator clarity', () => {
  assert.throws(() => assertPromotionTransition('applied', 'approved'), /promoted -> validated/);
});
