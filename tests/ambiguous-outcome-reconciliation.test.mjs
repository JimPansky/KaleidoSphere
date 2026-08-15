import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { sha256Digest } from '../services/bi-control/src/assistant-foundation/core-contracts.mjs';
import {
  APPLY_CAPABILITY_ID,
  TRUSTED_TARGET_VERSION,
  TYPED_RECOMMENDATION_VERSION,
  compileTrustedChangePlan,
} from '../services/bi-control/src/trusted-workflow/trusted-specialist-workflow.mjs';
import {
  FileOutcomeJournal,
  OutcomeJournal,
  authorizeFreshRetryAfterUnchanged,
  createOutcomeContext,
  reconcileUnknownOutcome,
  transitionOutcomeState,
} from '../services/bi-control/src/trusted-workflow/ambiguous-outcome-reconciliation.mjs';

const uuids = {
  database: 'a6050000-0000-4000-8000-000000000001',
  dataset: 'a6050000-0000-4000-8000-000000000002',
  chart: 'a6050000-0000-4000-8000-000000000003',
  dashboard: 'a6050000-0000-4000-8000-000000000004',
};

const actionUuids = {
  '01-dataset': 'a6050000-0000-4000-8000-000000000101',
  '02-chart': 'a6050000-0000-4000-8000-000000000102',
};

function specialist() {
  const discovery = {
    visualizationProposal: { mode: 'preview-only', proposals: [{ type: 'big_number_with_trend' }], persistentMutation: false },
    trustedApplyReadbackRollback: { state: 'proposal-only', applyPerformed: false },
    semanticKpiModel: { kpis: [{ id: 'orders.revenue.sum', expression: 'SUM(revenue)', validation: 'grain-and-null-check-required' }] },
    evidenceConfidenceBlindSpots: { blindSpots: ['synthetic-fixture-only'] },
  };
  return {
    schemaVersion: 'chimpmaera.bi/real-bi-specialist/v1',
    runId: 'm6-05-specialist-1',
    self_check: { mutationPerformed: false },
    discovery,
    synthesis: { source: 'deterministic-evidence-core' },
  };
}

function target() {
  const fingerprintBody = { product: 'Apache Superset', version: '6.1.0', openapiCanonicalSha256: '1e0aea80b9f9331d83717711c577575d1f0c706f5e0e3632d403a28df0c5caa6' };
  return {
    schemaVersion: TRUSTED_TARGET_VERSION,
    targetId: 'm6-05-disposable-local',
    environment: 'disposable_local',
    baseUrl: 'http://127.0.0.1:39045',
    fingerprint: { ...fingerprintBody, digest: sha256Digest(fingerprintBody) },
    capabilityRevision: 'm6-05-local-v1',
    capabilities: [
      { capabilityId: 'superset.dataset.reviewed-update', contractVersion: 'v1', status: 'supported' },
      { capabilityId: 'superset.chart.reviewed-upsert', contractVersion: 'v1', status: 'supported' },
    ],
    assets: [
      { identity: `database:${uuids.database}`, kind: 'database', value: { uuid: uuids.database, name: 'M6-05 synthetic database' } },
      { identity: `dataset:${uuids.dataset}`, kind: 'dataset', value: { uuid: uuids.dataset, tableName: 'm6_05_synthetic', databaseUuid: uuids.database, description: 'before' } },
      {
        identity: `chart:${uuids.chart}`,
        kind: 'chart',
        value: { uuid: uuids.chart, title: 'Before chart', vizType: 'big_number', datasetUuid: uuids.dataset, metricId: 'orders.revenue.sum', groupBy: [] },
      },
    ],
  };
}

function recommendation(result = specialist()) {
  return {
    schemaVersion: TYPED_RECOMMENDATION_VERSION,
    recommendationId: 'm6-05-recommendation-1',
    sourceRunId: result.runId,
    sourceDiscoveryDigest: sha256Digest(result.discovery),
    authority: 'advisory_only',
    actions: [
      {
        actionId: '02-chart', actionType: 'chart.upsert',
        asset: { identity: `chart:${uuids.chart}`, kind: 'chart' },
        dependsOn: [`dataset:${uuids.dataset}`],
        before: { uuid: uuids.chart, title: 'Before chart', vizType: 'big_number', datasetUuid: uuids.dataset, metricId: 'orders.revenue.sum', groupBy: [] },
        after: { uuid: uuids.chart, title: 'After chart', vizType: 'big_number', datasetUuid: uuids.dataset, metricId: 'orders.revenue.sum', groupBy: [] },
      },
      {
        actionId: '01-dataset', actionType: 'dataset.update',
        asset: { identity: `dataset:${uuids.dataset}`, kind: 'dataset' },
        dependsOn: [`database:${uuids.database}`],
        before: { uuid: uuids.dataset, tableName: 'm6_05_synthetic', databaseUuid: uuids.database, description: 'before' },
        after: { uuid: uuids.dataset, tableName: 'm6_05_synthetic', databaseUuid: uuids.database, description: 'after' },
      },
    ],
  };
}

function fixtures() {
  const result = specialist();
  const plan = compileTrustedChangePlan({ planId: 'm6-05-plan-1', specialistResult: result, recommendation: recommendation(result), target: target() });
  const authorization = {
    authorized: true,
    executionId: plan.planId,
    capabilityId: APPLY_CAPABILITY_ID,
    previewDigest: plan.previewDigest,
    targetBindingDigest: sha256Digest(plan.targetBinding),
    idempotencyKey: 'm6-05-idem-1',
  };
  const context = createOutcomeContext({
    actorId: 'actor-1',
    sessionId: 'session-1',
    target: target(),
    plan,
    authorization,
    idempotencyKey: 'm6-05-idem-1',
    actionUuids,
    createdAt: '2026-08-15T06:40:00.000Z',
  });
  return { plan, authorization, context };
}

function adapterFor(plan, relationByActionId) {
  const values = new Map(plan.actions.map((action) => {
    const relation = relationByActionId[action.actionId];
    return [action.actionId, relation === 'after' ? action.after : action.before];
  }));
  const calls = { read: 0, applyValue: 0 };
  return {
    calls,
    adapter: {
      async read(action) {
        calls.read += 1;
        return structuredClone(values.get(action.actionId));
      },
      async applyValue() {
        calls.applyValue += 1;
        throw new Error('reconciliation must never dispatch mutations');
      },
    },
  };
}

test('G2 binds ambiguous outcome context to actor, session, target, capabilities, snapshot, plan, preview, idempotency, action UUIDs, and preconditions', () => {
  const { context, plan } = fixtures();
  assert.equal(context.actorId, 'actor-1');
  assert.equal(context.sessionId, 'session-1');
  assert.equal(context.target.targetId, 'm6-05-disposable-local');
  assert.equal(context.target.fingerprintDigest, plan.targetBinding.fingerprintDigest);
  assert.equal(context.target.capabilityDigest, plan.targetBinding.capabilityDigest);
  assert.equal(context.target.assetSnapshotDigest, plan.targetBinding.assetSnapshotDigest);
  assert.equal(context.previewDigest, plan.previewDigest);
  assert.equal(context.planDigest, sha256Digest(plan));
  assert.equal(context.actionBindings.length, 2);
  assert.match(context.preconditionDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(context.privacy.cotPersisted, false);
});

test('G2 state machine fails closed on blind retry, terminal mutation, and unknown events', () => {
  assert.equal(transitionOutcomeState(null, 'initialized'), 'not_dispatched');
  assert.equal(transitionOutcomeState('not_dispatched', 'dispatch_response_lost'), 'outcome_unknown');
  assert.equal(transitionOutcomeState('outcome_unknown', 'reconcile_exact_before'), 'unchanged_safe_to_retry');
  assert.equal(transitionOutcomeState('unchanged_safe_to_retry', 'fresh_retry_authorized'), 'not_dispatched');
  assert.throws(() => transitionOutcomeState('outcome_unknown', 'fresh_retry_authorized'), /OUTCOME_ILLEGAL_TRANSITION/);
  assert.throws(() => transitionOutcomeState('committed_equivalent', 'dispatch_response_lost'), /OUTCOME_ILLEGAL_TRANSITION/);
  assert.throws(() => transitionOutcomeState('not_dispatched', 'blind_retry'), /OUTCOME_ILLEGAL_TRANSITION/);
});

test('G2 hash-chained journal verifies restart persistence and rejects tampering, truncation shape, and raw persistence fields', async () => {
  const { context } = fixtures();
  const tmp = await mkdtemp(join(tmpdir(), 'm6-05-outcome-'));
  try {
    const filePath = join(tmp, 'journal.json');
    const journal = await FileOutcomeJournal.open({ filePath, context, clock: () => '2026-08-15T06:41:00.000Z' });
    await journal.appendAndFlush({ eventType: 'initialized', evidence: { targetReadinessDigest: context.target.assetSnapshotDigest }, decision: { dispatchAllowed: true } });
    await journal.appendAndFlush({ eventType: 'dispatch_response_lost', evidence: { transportFault: 'loopback_response_cut_after_dispatch' }, decision: { blindRetryAllowed: false } });
    assert.equal(journal.state, 'outcome_unknown');
    const reopened = await FileOutcomeJournal.open({ filePath, context });
    assert.equal(reopened.state, 'outcome_unknown');
    assert.equal(reopened.entries().length, 2);
    const tampered = reopened.snapshot();
    tampered.entries[1].decision.blindRetryAllowed = true;
    assert.throws(() => new OutcomeJournal({ context, entries: tampered.entries }), /OUTCOME_JOURNAL_HASH_MISMATCH/);
    const reordered = reopened.snapshot();
    reordered.entries.reverse();
    assert.throws(() => new OutcomeJournal({ context, entries: reordered.entries }), /OUTCOME_JOURNAL_ENTRY_INVALID|OUTCOME_JOURNAL_STATE_CHAIN_INVALID/);
    assert.throws(() => reopened.append({ eventType: 'reconcile_manual_review', evidence: { rawResponse: { status: 200 } } }), /OUTCOME_JOURNAL_RAW_OR_SECRET_FIELD_DENIED/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('G3 reconciles exact committed after-state without redispatching duplicate mutation requests', async () => {
  const { context, plan } = fixtures();
  const journal = new OutcomeJournal({ context });
  journal.append({ eventType: 'initialized' });
  journal.append({ eventType: 'dispatch_response_lost', decision: { blindRetryAllowed: false } });
  const { adapter, calls } = adapterFor(plan, { '01-dataset': 'after', '02-chart': 'after' });
  const result = await reconcileUnknownOutcome({ journal, plan, adapter, target: target(), occurredAt: '2026-08-15T06:42:00.000Z' });
  assert.equal(result.state, 'committed_equivalent');
  assert.equal(result.classification, 'committed_equivalent');
  assert.equal(calls.read, 2);
  assert.equal(calls.applyValue, 0);
  assert.deepEqual(result.entry.decision, {
    classification: 'committed_equivalent',
    retryAllowed: false,
    retryRequiresFreshGrant: false,
    compensationAllowed: false,
    manualReviewRequired: false,
  });
});

test('G3 permits unchanged pre-dispatch retry only after new bound authorization', async () => {
  const { context, plan } = fixtures();
  const journal = new OutcomeJournal({ context });
  journal.append({ eventType: 'initialized' });
  journal.append({ eventType: 'dispatch_response_lost', decision: { blindRetryAllowed: false } });
  const { adapter, calls } = adapterFor(plan, { '01-dataset': 'before', '02-chart': 'before' });
  const result = await reconcileUnknownOutcome({ journal, plan, adapter, target: target() });
  assert.equal(result.state, 'unchanged_safe_to_retry');
  assert.equal(result.entry.decision.retryRequiresFreshGrant, true);
  assert.equal(calls.applyValue, 0);
  assert.throws(() => authorizeFreshRetryAfterUnchanged({
    journal,
    context,
    plan,
    authorization: { ...fixtures().authorization, idempotencyKey: 'm6-05-idem-1' },
    idempotencyKey: 'm6-05-idem-1',
  }), /OUTCOME_FRESH_RETRY_REQUIRES_NEW_IDEMPOTENCY/);
  const freshAuthorization = {
    authorized: true,
    executionId: plan.planId,
    capabilityId: APPLY_CAPABILITY_ID,
    previewDigest: plan.previewDigest,
    targetBindingDigest: sha256Digest(plan.targetBinding),
    idempotencyKey: 'm6-05-idem-2',
  };
  const retryEntry = authorizeFreshRetryAfterUnchanged({ journal, context, plan, authorization: freshAuthorization, idempotencyKey: 'm6-05-idem-2' });
  assert.equal(retryEntry.toState, 'not_dispatched');
  assert.equal(retryEntry.decision.blindRedispatch, false);
});

test('G3 classifies owned partial, diverged, foreign-owned, and target drift as no-retry outcomes', async () => {
  const { context, plan } = fixtures();
  const partialJournal = new OutcomeJournal({ context });
  partialJournal.append({ eventType: 'initialized' });
  partialJournal.append({ eventType: 'dispatch_response_lost' });
  const partial = await reconcileUnknownOutcome({ journal: partialJournal, plan, target: target(), ...adapterFor(plan, { '01-dataset': 'after', '02-chart': 'before' }) });
  assert.equal(partial.state, 'partial');
  assert.equal(partial.entry.decision.retryAllowed, false);
  assert.equal(partial.entry.decision.compensationAllowed, true);

  const divergedJournal = new OutcomeJournal({ context });
  divergedJournal.append({ eventType: 'initialized' });
  divergedJournal.append({ eventType: 'dispatch_response_lost' });
  const divergedAdapter = { async read(action) { return { ...action.after, title: 'foreign change', description: 'foreign change' }; } };
  const diverged = await reconcileUnknownOutcome({ journal: divergedJournal, plan, adapter: divergedAdapter, target: target() });
  assert.equal(diverged.state, 'diverged');
  assert.equal(diverged.entry.decision.manualReviewRequired, true);

  const foreignJournal = new OutcomeJournal({ context });
  foreignJournal.append({ eventType: 'initialized' });
  foreignJournal.append({ eventType: 'dispatch_response_lost' });
  const foreign = await reconcileUnknownOutcome({ journal: foreignJournal, plan, target: target(), ...adapterFor(plan, { '01-dataset': 'after', '02-chart': 'after' }), ownership: { '01-dataset': 'foreign' } });
  assert.equal(foreign.state, 'manual_review');
  assert.equal(foreign.entry.decision.retryAllowed, false);

  const driftJournal = new OutcomeJournal({ context });
  driftJournal.append({ eventType: 'initialized' });
  driftJournal.append({ eventType: 'dispatch_response_lost' });
  const driftedTarget = target();
  driftedTarget.assets[1].value.description = 'drifted before reconciliation';
  const drift = await reconcileUnknownOutcome({ journal: driftJournal, plan, target: driftedTarget, ...adapterFor(plan, { '01-dataset': 'before', '02-chart': 'before' }) });
  assert.equal(drift.state, 'manual_review');
  assert.equal(drift.entry.decision.manualReviewRequired, true);
});
