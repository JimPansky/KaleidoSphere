import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256Digest } from '../services/bi-control/src/assistant-foundation/core-contracts.mjs';
import {
  APPLY_CAPABILITY_ID,
  CHANGE_PLAN_VERSION,
  TRUSTED_TARGET_VERSION,
  TYPED_RECOMMENDATION_VERSION,
  TrustedApprovalController,
  compileTrustedChangePlan,
  createTrustedWorkflowApproval,
} from '../services/bi-control/src/trusted-workflow/trusted-specialist-workflow.mjs';
import { TrustedSupersetWorkflowExecutor } from '../services/bi-control/src/trusted-workflow/reviewed-superset-executor.mjs';

const uuids = {
  database: 'a6040000-0000-4000-8000-000000000001',
  dataset: 'a6040000-0000-4000-8000-000000000002',
  chart: 'a6040000-0000-4000-8000-000000000003',
  dashboard: 'a6040000-0000-4000-8000-000000000004',
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
    runId: 'm6-04-specialist-1',
    self_check: { mutationPerformed: false },
    discovery,
    synthesis: { source: 'deterministic-evidence-core' },
  };
}

function target() {
  const fingerprintBody = { product: 'Apache Superset', version: '6.1.0', openapiCanonicalSha256: '1e0aea80b9f9331d83717711c577575d1f0c706f5e0e3632d403a28df0c5caa6' };
  return {
    schemaVersion: TRUSTED_TARGET_VERSION,
    targetId: 'm6-04-disposable-local',
    environment: 'disposable_local',
    baseUrl: 'http://127.0.0.1:39044',
    fingerprint: { ...fingerprintBody, digest: sha256Digest(fingerprintBody) },
    capabilityRevision: 'm6-04-local-v1',
    capabilities: [
      { capabilityId: 'superset.dataset.reviewed-update', contractVersion: 'v1', status: 'supported' },
      { capabilityId: 'superset.chart.reviewed-upsert', contractVersion: 'v1', status: 'supported' },
      { capabilityId: 'superset.dashboard.reviewed-update', contractVersion: 'v1', status: 'supported' },
      { capabilityId: 'superset.dashboard.reviewed-filter-update', contractVersion: 'v1', status: 'supported' },
    ],
    assets: [
      { identity: `database:${uuids.database}`, kind: 'database', value: { uuid: uuids.database, name: 'M6-04 synthetic database' } },
      { identity: `dataset:${uuids.dataset}`, kind: 'dataset', value: { uuid: uuids.dataset, tableName: 'm6_04_synthetic', databaseUuid: uuids.database, description: 'before' } },
    ],
  };
}

function recommendation(result = specialist()) {
  return {
    schemaVersion: TYPED_RECOMMENDATION_VERSION,
    recommendationId: 'recommendation-1',
    sourceRunId: result.runId,
    sourceDiscoveryDigest: sha256Digest(result.discovery),
    authority: 'advisory_only',
    actions: [
      {
        actionId: '04-filter', actionType: 'filter.configure',
        asset: { identity: `filter:${uuids.dashboard}:plant`, kind: 'filter' },
        dependsOn: [`dashboard:${uuids.dashboard}`, `dataset:${uuids.dataset}`], before: null,
        after: { filterId: 'plant', dashboardUuid: uuids.dashboard, datasetUuid: uuids.dataset, column: 'plant', filterType: 'filter_select' },
      },
      {
        actionId: '03-dashboard', actionType: 'dashboard.update',
        asset: { identity: `dashboard:${uuids.dashboard}`, kind: 'dashboard' },
        dependsOn: [`chart:${uuids.chart}`], before: null,
        after: { uuid: uuids.dashboard, title: 'M6-04 trusted synthetic dashboard', slug: 'm6-04-trusted-synthetic', chartUuids: [uuids.chart], layoutId: 'single-kpi-with-filter' },
      },
      {
        actionId: '02-chart', actionType: 'chart.upsert',
        asset: { identity: `chart:${uuids.chart}`, kind: 'chart' },
        dependsOn: [`dataset:${uuids.dataset}`], before: null,
        after: { uuid: uuids.chart, title: 'Synthetic revenue', vizType: 'big_number', datasetUuid: uuids.dataset, metricId: 'orders.revenue.sum', groupBy: [] },
      },
      {
        actionId: '01-dataset', actionType: 'dataset.update',
        asset: { identity: `dataset:${uuids.dataset}`, kind: 'dataset' },
        dependsOn: [`database:${uuids.database}`],
        before: { uuid: uuids.dataset, tableName: 'm6_04_synthetic', databaseUuid: uuids.database, description: 'before' },
        after: { uuid: uuids.dataset, tableName: 'm6_04_synthetic', databaseUuid: uuids.database, description: 'M6-04 synthetic bounded aggregate fixture' },
      },
    ],
  };
}

function plan() {
  const result = specialist();
  return compileTrustedChangePlan({ planId: 'plan-1', specialistResult: result, recommendation: recommendation(result), target: target() });
}

function existingPlan() {
  const result = specialist();
  const targetValue = target();
  const recommendationValue = recommendation(result);
  const beforeValues = {
    '02-chart': { ...recommendationValue.actions.find((item) => item.actionId === '02-chart').after, title: 'Before chart' },
    '03-dashboard': { ...recommendationValue.actions.find((item) => item.actionId === '03-dashboard').after, title: 'Before dashboard', slug: 'before-dashboard', layoutId: 'm6-02-reviewed-layout' },
    '04-filter': { ...recommendationValue.actions.find((item) => item.actionId === '04-filter').after, column: 'line' },
  };
  for (const action of recommendationValue.actions) {
    if (beforeValues[action.actionId]) action.before = beforeValues[action.actionId];
  }
  for (const action of recommendationValue.actions.filter((item) => beforeValues[item.actionId])) {
    targetValue.assets.push({ identity: action.asset.identity, kind: action.asset.kind, value: structuredClone(action.before) });
  }
  return compileTrustedChangePlan({ planId: 'plan-existing', specialistResult: result, recommendation: recommendationValue, target: targetValue });
}

test('G2 compiles deterministic specialist recommendations into exact reviewable dependency-ordered diffs', () => {
  const first = plan();
  const second = plan();
  assert.equal(first.schemaVersion, CHANGE_PLAN_VERSION);
  assert.deepEqual(first, second);
  assert.equal(first.previewDigest, second.previewDigest);
  assert.deepEqual(first.applyOrder, ['01-dataset', '02-chart', '03-dashboard', '04-filter']);
  assert.equal(first.specialistBinding.modelAuthority, false);
  assert.equal(first.specialistBinding.rawModelOutputIncluded, false);
  assert.equal(first.actions.length, 4);
  assert(first.actions.every((action) => Object.hasOwn(action, 'before') && Object.hasOwn(action, 'after')));
  assert.deepEqual(first.limitations, ['synthetic-disposable-target-only', 'typed-reviewed-adapter-only', 'no-free-form-sql', 'no-dom-control']);
});

test('G2 fails closed on unsupported actions, capability gaps, drifted before-state, free SQL, and unbound specialist output', () => {
  const result = specialist();
  const base = recommendation(result);
  const compile = (recommendationValue = base, targetValue = target(), specialistValue = result) => compileTrustedChangePlan({ planId: 'plan-negative', specialistResult: specialistValue, recommendation: recommendationValue, target: targetValue });
  assert.throws(() => compile({ ...base, actions: [{ ...base.actions[0], actionType: 'sql.execute' }] }), /UNSUPPORTED_SPECIALIST_ACTION/);
  const missing = target(); missing.capabilities = missing.capabilities.filter((item) => item.capabilityId !== 'superset.chart.reviewed-upsert');
  assert.throws(() => compile(base, missing), /TARGET_CAPABILITY_UNSUPPORTED/);
  const drift = structuredClone(base); drift.actions.at(-1).before.description = 'not-current';
  assert.throws(() => compile(drift), /TARGET_BEFORE_STATE_MISMATCH/);
  const sql = structuredClone(base); sql.actions[1].after.rawSql = 'DROP TABLE x';
  assert.throws(() => compile(sql), /TYPED_ACTION_VALUE_INVALID|UNREVIEWED_ACTION_SURFACE_DENIED/);
  assert.throws(() => compile({ ...base, sourceRunId: 'different-run' }), /SPECIALIST_RECOMMENDATION_BINDING_MISMATCH/);
  const modelAuthority = specialist(); modelAuthority.self_check.mutationPerformed = true;
  assert.throws(() => compile(recommendation(modelAuthority), target(), modelAuthority), /SPECIALIST_AUTHORITY_BOUNDARY_INVALID/);
});

test('G3 binds trusted one-shot approval to actor, session, target, capability, preview, expiry, and idempotency', () => {
  const approvedPlan = plan();
  const approval = createTrustedWorkflowApproval({
    approvalId: 'approval-1', actorId: 'actor-1', sessionId: 'session-1', plan: approvedPlan,
    issuedAt: '2026-08-15T05:00:00.000Z', expiresAt: '2026-08-15T05:05:00.000Z', idempotencyKey: 'idem-1',
  });
  const controller = new TrustedApprovalController();
  controller.register(approval);
  const authorized = controller.authorize({ approval, plan: approvedPlan, actorId: 'actor-1', sessionId: 'session-1', target: target(), idempotencyKey: 'idem-1', now: '2026-08-15T05:01:00.000Z' });
  assert.equal(authorized.authorized, true);
  assert.throws(() => controller.authorize({ approval, plan: approvedPlan, actorId: 'actor-1', sessionId: 'session-1', target: target(), idempotencyKey: 'idem-1', now: '2026-08-15T05:02:00.000Z' }), /APPROVAL_GRANT_REPLAY/);
});

test('G3 denies stale, mismatched, voice-only, model-generated, partial, drifted, and untrusted approvals', () => {
  const approvedPlan = plan();
  const approvalOptions = { approvalId: 'approval-negative', actorId: 'actor-1', sessionId: 'session-1', plan: approvedPlan, issuedAt: '2026-08-15T05:00:00.000Z', expiresAt: '2026-08-15T05:05:00.000Z', idempotencyKey: 'idem-1' };
  assert.throws(() => createTrustedWorkflowApproval({ ...approvalOptions, channel: 'voice' }), /VOICE_ONLY_APPROVAL_DENIED/);
  assert.throws(() => createTrustedWorkflowApproval({ ...approvalOptions, modelGenerated: true }), /UNTRUSTED_APPROVAL_SOURCE_DENIED/);
  assert.throws(() => createTrustedWorkflowApproval({ ...approvalOptions, inputSource: 'assistant_inferred' }), /UNTRUSTED_APPROVAL_SOURCE_DENIED/);
  assert.throws(() => createTrustedWorkflowApproval({ ...approvalOptions, approvedActionIds: approvedPlan.applyOrder.slice(0, 1) }), /PARTIAL_APPROVAL_DENIED/);

  const stale = createTrustedWorkflowApproval(approvalOptions);
  const staleController = new TrustedApprovalController(); staleController.register(stale);
  assert.throws(() => staleController.authorize({ approval: stale, plan: approvedPlan, actorId: 'actor-1', sessionId: 'session-1', target: target(), idempotencyKey: 'idem-1', now: '2026-08-15T05:05:00.000Z' }), /APPROVAL_GRANT_EXPIRED/);

  for (const override of [{ actorId: 'actor-2' }, { sessionId: 'session-2' }, { idempotencyKey: 'idem-2' }]) {
    const item = createTrustedWorkflowApproval({ ...approvalOptions, approvalId: `approval-${Object.values(override)[0]}` });
    const controller = new TrustedApprovalController(); controller.register(item);
    assert.throws(() => controller.authorize({ approval: item, plan: approvedPlan, actorId: 'actor-1', sessionId: 'session-1', target: target(), idempotencyKey: 'idem-1', now: '2026-08-15T05:01:00.000Z', ...override }), /APPROVAL_PRINCIPAL_MISMATCH|APPROVAL_EXACT_BINDING_MISMATCH/);
  }

  const driftedTarget = target(); driftedTarget.capabilityRevision = 'm6-04-local-v2';
  const driftApproval = createTrustedWorkflowApproval({ ...approvalOptions, approvalId: 'approval-drift' });
  const driftController = new TrustedApprovalController(); driftController.register(driftApproval);
  assert.throws(() => driftController.authorize({ approval: driftApproval, plan: approvedPlan, actorId: 'actor-1', sessionId: 'session-1', target: driftedTarget, idempotencyKey: 'idem-1', now: '2026-08-15T05:01:00.000Z' }), /APPROVED_TARGET_DRIFTED/);
});

test('G4/G5 reviewed executor applies in dependency order, reads back, is idempotent, and rolls back exactly', async () => {
  const approvedPlan = existingPlan();
  const values = new Map(approvedPlan.actions.map((action) => [action.asset.identity, structuredClone(action.before)]));
  const calls = [];
  const adapter = {
    async read(action) { return structuredClone(values.get(action.asset.identity)); },
    async applyValue(action, value) { calls.push(action.actionId); values.set(action.asset.identity, structuredClone(value)); return structuredClone(value); },
  };
  const executor = new TrustedSupersetWorkflowExecutor({ adapter, clock: () => '2026-08-15T05:01:00.000Z' });
  const authorization = { authorized: true, executionId: approvedPlan.planId, capabilityId: APPLY_CAPABILITY_ID, previewDigest: approvedPlan.previewDigest, targetBindingDigest: sha256Digest(approvedPlan.targetBinding), idempotencyKey: 'executor-idem-1' };
  const receipt = await executor.apply({ plan: approvedPlan, authorization, idempotencyKey: 'executor-idem-1' });
  assert.equal(receipt.status, 'succeeded');
  assert.deepEqual(calls, approvedPlan.applyOrder);
  assert.equal((await executor.apply({ plan: approvedPlan, authorization, idempotencyKey: 'executor-idem-1' })).status, 'already_applied');
  assert.equal(calls.length, approvedPlan.actions.length);
  const reconciliation = executor.snapshot();
  const restoredExecutor = new TrustedSupersetWorkflowExecutor({ adapter, reconciliation, clock: () => '2026-08-15T05:01:00.000Z' });
  assert.equal((await restoredExecutor.apply({ plan: approvedPlan, authorization, idempotencyKey: 'executor-idem-1' })).status, 'already_applied');
  assert.equal(calls.length, approvedPlan.actions.length);
  const rollback = await restoredExecutor.rollback({ rollbackToken: receipt.rollbackToken });
  assert.equal(rollback.status, 'rolled_back');
  for (const action of approvedPlan.actions) assert.deepEqual(values.get(action.asset.identity), action.before);
  await assert.rejects(restoredExecutor.rollback({ rollbackToken: receipt.rollbackToken }), /WORKFLOW_ROLLBACK_TOKEN_INVALID/);
});

test('G5 cancellation and timeout compensate safely or stop before dispatch', async () => {
  const approvedPlan = existingPlan();
  const initial = new Map(approvedPlan.actions.map((action) => [action.asset.identity, structuredClone(action.before)]));
  const authorization = { authorized: true, executionId: approvedPlan.planId, capabilityId: APPLY_CAPABILITY_ID, previewDigest: approvedPlan.previewDigest, targetBindingDigest: sha256Digest(approvedPlan.targetBinding), idempotencyKey: 'pre-cancel' };

  const preCancelled = new AbortController(); preCancelled.abort();
  let preCancelCalls = 0;
  const noDispatch = new TrustedSupersetWorkflowExecutor({ adapter: {
    async read() { preCancelCalls += 1; throw new Error('must not dispatch'); },
    async applyValue() { preCancelCalls += 1; throw new Error('must not dispatch'); },
  }, clock: () => '2026-08-15T05:00:00.000Z' });
  await assert.rejects(noDispatch.apply({ plan: approvedPlan, authorization, idempotencyKey: 'pre-cancel', signal: preCancelled.signal }), /WORKFLOW_CANCELLED/);
  assert.equal(preCancelCalls, 0);

  const clockValues = ['2026-08-15T05:00:00.000Z', '2026-08-15T05:00:01.000Z'];
  const timeout = new TrustedSupersetWorkflowExecutor({ adapter: {
    async read() { throw new Error('must not dispatch'); }, async applyValue() { throw new Error('must not dispatch'); },
  }, clock: () => clockValues.shift() ?? '2026-08-15T05:00:01.000Z' });
  await assert.rejects(timeout.apply({ plan: approvedPlan, authorization: { ...authorization, idempotencyKey: 'timeout' }, idempotencyKey: 'timeout', maxDurationMs: 10 }), /WORKFLOW_TIMEOUT/);

  const values = new Map([...initial].map(([key, value]) => [key, structuredClone(value)]));
  const during = new AbortController();
  let applyCount = 0;
  const cancellable = new TrustedSupersetWorkflowExecutor({ adapter: {
    async read(action) { return structuredClone(values.get(action.asset.identity)); },
    async applyValue(action, value) {
      values.set(action.asset.identity, structuredClone(value));
      if (++applyCount === 1) during.abort();
      return structuredClone(value);
    },
  } });
  await assert.rejects(
    cancellable.apply({ plan: approvedPlan, authorization: { ...authorization, idempotencyKey: 'cancel-during' }, idempotencyKey: 'cancel-during', signal: during.signal }),
    (error) => error.code === 'WORKFLOW_CANCELLED' && error.compensation.length === 1 && error.compensation[0].status === 'restored',
  );
  for (const [identity, value] of initial) assert.deepEqual(values.get(identity), value);
});

test('G5 partial failure compensates every dispatched action in reverse order and retains negative evidence', async () => {
  const approvedPlan = existingPlan();
  const initial = new Map(approvedPlan.actions.map((action) => [action.asset.identity, structuredClone(action.before)]));
  const values = new Map([...initial].map(([key, value]) => [key, structuredClone(value)]));
  const adapter = {
    async read(action) { return structuredClone(values.get(action.asset.identity)); },
    async applyValue(action, value) { values.set(action.asset.identity, structuredClone(value)); return structuredClone(value); },
  };
  const executor = new TrustedSupersetWorkflowExecutor({ adapter });
  const authorization = { authorized: true, executionId: approvedPlan.planId, capabilityId: APPLY_CAPABILITY_ID, previewDigest: approvedPlan.previewDigest, targetBindingDigest: sha256Digest(approvedPlan.targetBinding), idempotencyKey: 'partial-failure' };
  await assert.rejects(
    executor.apply({ plan: approvedPlan, authorization, idempotencyKey: 'partial-failure', failAfterActionId: approvedPlan.applyOrder[1] }),
    (error) => error.code === 'INJECTED_PARTIAL_FAILURE' && error.compensation.length === 2 && error.compensation.every((item) => item.status === 'restored'),
  );
  for (const [identity, value] of initial) assert.deepEqual(values.get(identity), value);
});

test('G6 denies non-loopback/path targets, injection-shaped values, secret literals, action-budget excess, and dependency cycles', () => {
  const result = specialist();
  const base = recommendation(result);
  const compile = (recommendationValue = base, targetValue = target()) => compileTrustedChangePlan({ planId: 'g6-negative', specialistResult: result, recommendation: recommendationValue, target: targetValue });
  for (const baseUrl of ['https://127.0.0.1:39044', 'http://127.0.0.1:39044/api', 'http://user:pass@127.0.0.1:39044', 'http://localhost.evil:39044']) {
    const denied = target(); denied.baseUrl = baseUrl;
    assert.throws(() => compile(base, denied), /TRUSTED_TARGET_URL_DENIED/);
  }
  const fingerprint = target(); fingerprint.fingerprint.digest = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => compile(base, fingerprint), /TARGET_FINGERPRINT_DIGEST_MISMATCH/);
  const injection = structuredClone(base); injection.actions[0].after.column = "plant'); DROP TABLE x;--";
  assert.throws(() => compile(injection), /TYPED_FILTER_ACTION_INVALID/);
  const secret = structuredClone(base); secret.actions.at(-1).after.description = 'Bearer abcdefghijklmnop';
  assert.throws(() => compile(secret), /SENSITIVE_VALUE_DENIED/);
  assert.throws(() => compile({ ...base, actions: Array.from({ length: 25 }, () => structuredClone(base.actions[0])) }), /TYPED_RECOMMENDATION_ACTION_BUDGET/);
  const cycle = structuredClone(base);
  cycle.actions.find((action) => action.actionId === '01-dataset').dependsOn.push(`chart:${uuids.chart}`);
  assert.throws(() => compile(cycle), /TYPED_ACTION_DEPENDENCY_CYCLE/);
});

test('G6 executor revalidates authorized plan bytes, denies idempotency substitution, and fails rollback on drift', async () => {
  const approvedPlan = existingPlan();
  const values = new Map(approvedPlan.actions.map((action) => [action.asset.identity, structuredClone(action.before)]));
  const adapter = {
    async read(action) { return structuredClone(values.get(action.asset.identity)); },
    async applyValue(action, value) { values.set(action.asset.identity, structuredClone(value)); return structuredClone(value); },
  };
  const authorizationFor = (planValue, idempotencyKey) => ({ authorized: true, executionId: planValue.planId, capabilityId: APPLY_CAPABILITY_ID, previewDigest: planValue.previewDigest, targetBindingDigest: sha256Digest(planValue.targetBinding), idempotencyKey });
  const tampered = structuredClone(approvedPlan); tampered.actions[0].after.description = 'substituted after approval';
  await assert.rejects(new TrustedSupersetWorkflowExecutor({ adapter }).apply({ plan: tampered, authorization: authorizationFor(approvedPlan, 'tamper'), idempotencyKey: 'tamper' }), /WORKFLOW_PLAN_DIGEST_MISMATCH/);

  const executor = new TrustedSupersetWorkflowExecutor({ adapter });
  const receipt = await executor.apply({ plan: approvedPlan, authorization: authorizationFor(approvedPlan, 'same-key'), idempotencyKey: 'same-key' });
  const substituted = structuredClone(approvedPlan);
  substituted.actions[0].after.description = 'validly redigested but not the same plan';
  const body = Object.fromEntries(Object.entries(substituted).filter(([key]) => key !== 'previewDigest'));
  substituted.previewDigest = sha256Digest(body);
  await assert.rejects(executor.apply({ plan: substituted, authorization: authorizationFor(substituted, 'same-key'), idempotencyKey: 'same-key' }), /WORKFLOW_IDEMPOTENCY_CONFLICT/);
  values.set(approvedPlan.actions[0].asset.identity, { ...approvedPlan.actions[0].after, description: 'concurrent drift' });
  await assert.rejects(executor.rollback({ rollbackToken: receipt.rollbackToken }), /WORKFLOW_ROLLBACK_DRIFT_DENIED/);
});
