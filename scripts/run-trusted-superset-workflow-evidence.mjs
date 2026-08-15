import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { sha256Digest } from '../services/bi-control/src/assistant-foundation/core-contracts.mjs';
import { RealBiSpecialist } from '../services/bi-control/src/bi-specialist/specialist-agent.mjs';
import {
  NATIVE_ASSETS,
  clientFromEnvironment,
  provisionNativeAssets,
} from '../services/bi-control/src/visual-scenario-lab/native-superset-bridge.mjs';
import {
  TRUSTED_TARGET_VERSION,
  TYPED_RECOMMENDATION_VERSION,
  TrustedApprovalController,
  compileTrustedChangePlan,
  createTrustedWorkflowApproval,
} from '../services/bi-control/src/trusted-workflow/trusted-specialist-workflow.mjs';
import {
  ReviewedSupersetAssetAdapter,
  TrustedSupersetWorkflowExecutor,
} from '../services/bi-control/src/trusted-workflow/reviewed-superset-executor.mjs';

const evidenceRoot = resolve(process.env.M6_04_EVIDENCE_ROOT ?? 'docs/evidence/m6-04-trusted-workflow');
await mkdir(evidenceRoot, { recursive: true });
const client = await clientFromEnvironment();
const provisioned = await provisionNativeAssets(client);
const adapter = new ReviewedSupersetAssetAdapter({ client });
const specialist = await new RealBiSpecialist().investigate({
  databasePath: resolve('services/bi-control/fixtures/bi-specialist/candidate/training-order-to-cash.sqlite'),
  objective: 'Recommend a trusted synthetic executive KPI dashboard preview with bounded evidence and no persistence authority',
  runId: 'm6-04-deterministic-specialist',
});

const dashboard = provisioned.dashboardRecords.executive;
const charts = provisioned.chartRecordsByDashboard.executive;
if (charts.length !== 3) throw new Error('M6_04_EXPECTED_THREE_CHARTS');
const filterId = 'NATIVE_FILTER-M6_02_PLANT';
const actionShells = [
  {
    actionId: '01-dataset', actionType: 'dataset.update',
    asset: { identity: `dataset:${NATIVE_ASSETS.datasetUuid}`, kind: 'dataset' },
    dependsOn: [`database:${NATIVE_ASSETS.databaseUuid}`],
    after: { uuid: NATIVE_ASSETS.datasetUuid },
  },
  ...charts.map((chart, index) => ({
    actionId: `02-chart-${index + 1}`, actionType: 'chart.upsert',
    asset: { identity: `chart:${chart.uuid}`, kind: 'chart' },
    dependsOn: [`dataset:${NATIVE_ASSETS.datasetUuid}`],
    after: { uuid: chart.uuid },
  })),
  {
    actionId: '03-dashboard', actionType: 'dashboard.update',
    asset: { identity: `dashboard:${dashboard.uuid}`, kind: 'dashboard' },
    dependsOn: charts.map((chart) => `chart:${chart.uuid}`),
    after: { uuid: dashboard.uuid },
  },
  {
    actionId: '04-filter', actionType: 'filter.configure',
    asset: { identity: `filter:${dashboard.uuid}:${filterId}`, kind: 'filter' },
    dependsOn: [`dashboard:${dashboard.uuid}`, `dataset:${NATIVE_ASSETS.datasetUuid}`],
    after: { filterId, dashboardUuid: dashboard.uuid, datasetUuid: NATIVE_ASSETS.datasetUuid },
  },
];
for (const action of actionShells) action.before = await adapter.read(action);

actionShells[0].after = { ...actionShells[0].before, description: `${actionShells[0].before.description} · M6-04 trusted apply` };
for (let index = 0; index < charts.length; index += 1) {
  const action = actionShells[index + 1];
  action.after = { ...action.before, title: `M6-04 Trusted · ${action.before.title}` };
}
const dashboardAction = actionShells.at(-2);
dashboardAction.after = {
  ...dashboardAction.before,
  title: 'M6-04 Trusted Specialist Preview',
  slug: 'm6-04-trusted-specialist-preview',
  layoutId: 'm6-04-trusted-three-view',
};
const filterAction = actionShells.at(-1);
filterAction.after = { ...filterAction.before, column: 'line' };

const fingerprintBody = {
  product: 'Apache Superset',
  version: '6.1.0',
  openapiCanonicalSha256: '1e0aea80b9f9331d83717711c577575d1f0c706f5e0e3632d403a28df0c5caa6',
};
const capabilities = [
  { capabilityId: 'superset.dataset.reviewed-update', contractVersion: 'v1', status: 'supported' },
  { capabilityId: 'superset.chart.reviewed-upsert', contractVersion: 'v1', status: 'supported' },
  { capabilityId: 'superset.dashboard.reviewed-update', contractVersion: 'v1', status: 'supported' },
  { capabilityId: 'superset.dashboard.reviewed-filter-update', contractVersion: 'v1', status: 'supported' },
];
const database = (await client.list('database')).find((item) => item.uuid === NATIVE_ASSETS.databaseUuid);
const target = {
  schemaVersion: TRUSTED_TARGET_VERSION,
  targetId: process.env.COMPOSE_PROJECT_NAME ?? 'sba-m6-04-trusted-20260815',
  environment: 'disposable_local',
  baseUrl: client.baseUrl,
  fingerprint: { ...fingerprintBody, digest: sha256Digest(fingerprintBody) },
  capabilityRevision: 'm6-04-reviewed-public-rest-v1',
  capabilities,
  assets: [
    { identity: `database:${NATIVE_ASSETS.databaseUuid}`, kind: 'database', value: { uuid: database.uuid, name: database.database_name } },
    ...actionShells.map((action) => ({ identity: action.asset.identity, kind: action.asset.kind, value: structuredClone(action.before) })),
  ],
};
const recommendation = {
  schemaVersion: TYPED_RECOMMENDATION_VERSION,
  recommendationId: 'm6-04-live-recommendation-1',
  sourceRunId: specialist.runId,
  sourceDiscoveryDigest: sha256Digest(specialist.discovery),
  authority: 'advisory_only',
  actions: actionShells,
};
const plan = compileTrustedChangePlan({ planId: 'm6-04-live-plan-1', specialistResult: specialist, recommendation, target });
const issuedAt = new Date().toISOString();
const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
const approval = createTrustedWorkflowApproval({
  approvalId: 'm6-04-live-approval-1', actorId: 'synthetic-local-reviewer', sessionId: 'm6-04-isolated-session',
  plan, issuedAt, expiresAt, idempotencyKey: 'm6-04-live-idempotency-1',
});
const approvalController = new TrustedApprovalController();
approvalController.register(approval);
const authorization = approvalController.authorize({
  approval, plan, actorId: 'synthetic-local-reviewer', sessionId: 'm6-04-isolated-session', target,
  idempotencyKey: 'm6-04-live-idempotency-1', now: issuedAt,
});
const executor = new TrustedSupersetWorkflowExecutor({ adapter });
const applyReceipt = await executor.apply({ plan, authorization, idempotencyKey: 'm6-04-live-idempotency-1' });
const reconciliation = executor.snapshot();
const restoredExecutor = new TrustedSupersetWorkflowExecutor({ adapter, reconciliation });
const idempotentReceipt = await restoredExecutor.apply({ plan, authorization, idempotencyKey: 'm6-04-live-idempotency-1' });
if (idempotentReceipt.status !== 'already_applied') throw new Error('M6_04_IDEMPOTENCY_PROOF_FAILED');
const afterReadback = [];
for (const action of plan.actions) {
  const value = await adapter.read(action);
  if (sha256Digest(value) !== sha256Digest(action.after)) throw new Error(`M6_04_READBACK_MISMATCH:${action.actionId}`);
  afterReadback.push({ actionId: action.actionId, digest: sha256Digest(value) });
}
let unauthorizedDenial = null;
try {
  await new TrustedSupersetWorkflowExecutor({ adapter }).apply({ plan, authorization: { authorized: false }, idempotencyKey: 'denied' });
} catch (error) { unauthorizedDenial = error.code; }
if (unauthorizedDenial !== 'WORKFLOW_EXECUTION_AUTHORIZATION_REQUIRED') throw new Error('M6_04_UNAUTHORIZED_PROBE_FAILED');

const rollbackReceipt = await restoredExecutor.rollback({ rollbackToken: applyReceipt.rollbackToken });
const postRollback = [];
for (const action of plan.actions) {
  const value = await adapter.read(action);
  if (sha256Digest(value) !== sha256Digest(action.before)) throw new Error(`M6_04_ROLLBACK_READBACK_MISMATCH:${action.actionId}`);
  postRollback.push({ actionId: action.actionId, digest: sha256Digest(value) });
}

const partialPlan = compileTrustedChangePlan({
  planId: 'm6-04-live-plan-partial-failure',
  specialistResult: specialist,
  recommendation: { ...recommendation, recommendationId: 'm6-04-live-recommendation-partial-failure' },
  target,
});
const partialIssuedAt = new Date().toISOString();
const partialApproval = createTrustedWorkflowApproval({
  approvalId: 'm6-04-live-approval-partial-failure', actorId: 'synthetic-local-reviewer', sessionId: 'm6-04-isolated-session',
  plan: partialPlan, issuedAt: partialIssuedAt, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), idempotencyKey: 'm6-04-live-partial-failure',
});
const partialController = new TrustedApprovalController();
partialController.register(partialApproval);
const partialAuthorization = partialController.authorize({
  approval: partialApproval, plan: partialPlan, actorId: 'synthetic-local-reviewer', sessionId: 'm6-04-isolated-session', target,
  idempotencyKey: 'm6-04-live-partial-failure', now: partialIssuedAt,
});
let partialFailure;
try {
  await new TrustedSupersetWorkflowExecutor({ adapter }).apply({
    plan: partialPlan,
    authorization: partialAuthorization,
    idempotencyKey: 'm6-04-live-partial-failure',
    failAfterActionId: partialPlan.applyOrder[1],
  });
} catch (error) {
  partialFailure = { code: error.code, compensation: error.compensation };
}
if (partialFailure?.code !== 'INJECTED_PARTIAL_FAILURE' || partialFailure.compensation.length !== 2 || partialFailure.compensation.some((item) => item.status !== 'restored')) throw new Error('M6_04_PARTIAL_COMPENSATION_FAILED');
for (const action of partialPlan.actions) {
  if (sha256Digest(await adapter.read(action)) !== sha256Digest(action.before)) throw new Error(`M6_04_PARTIAL_COMPENSATION_READBACK_MISMATCH:${action.actionId}`);
}

const projectionBytes = await readFile('.runtime/projection/analytics.db');
const manifest = {
  schemaVersion: 'chimpmaera.bi/trusted-superset-workflow-evidence/v1',
  generatedAt: new Date().toISOString(),
  runtime: {
    projectName: target.targetId,
    baseUrl: target.baseUrl,
    loopbackOnly: true,
    product: fingerprintBody.product,
    version: fingerprintBody.version,
    image: 'apache/superset:6.1.0@sha256:fb3464528ec7076f91195f0ff7835755aa023e281f1bb78a84782ce7a36b3705',
    fixture: 'northstar-components-synthetic-v1',
    projectionDigest: `sha256:${createHash('sha256').update(projectionBytes).digest('hex')}`,
    customerData: false,
  },
  specialistBinding: plan.specialistBinding,
  targetBinding: plan.targetBinding,
  preview: {
    planId: plan.planId,
    previewDigest: plan.previewDigest,
    actionCount: plan.actions.length,
    applyOrder: plan.applyOrder,
    beforeAfterDiff: plan.actions.map(({ actionId, actionType, asset, dependsOn, before, after }) => ({ actionId, actionType, asset, dependsOn, before, after })),
    limitations: plan.limitations,
    nonclaims: plan.nonclaims,
  },
  approval: {
    approvalId: approval.approvalId,
    actorId: approval.actorId,
    sessionId: approval.sessionId,
    previewDigest: approval.previewDigest,
    targetBindingDigest: approval.targetBindingDigest,
    oneShot: approval.oneShot,
    reusable: approval.reusable,
    channel: approval.channel,
    modelGenerated: approval.modelGenerated,
  },
  apply: {
    receipt: applyReceipt,
    idempotentSecondStatus: idempotentReceipt.status,
    afterReadback,
    chartVizTypes: plan.actions.filter((action) => action.actionType === 'chart.upsert').map((action) => action.after.vizType),
    distinctChartVizTypes: new Set(plan.actions.filter((action) => action.actionType === 'chart.upsert').map((action) => action.after.vizType)).size,
    unauthorizedDenial,
  },
  rollback: { receipt: rollbackReceipt, postRollback },
  reconciliation: { digest: sha256Digest(reconciliation), completedEntries: reconciliation.idempotency.length, rollbackPoints: reconciliation.rollbackPoints.length, replayedWithoutDispatch: idempotentReceipt.status === 'already_applied' },
  partialFailure,
  privacy: { responsePayloadPersisted: false, sourceRecordsPersisted: false, modelTranscriptPersisted: false, chainOfThoughtPersisted: false },
  nonclaims: ['no-delivery', 'no-production-or-customer-use', 'no-organizationally-independent-validation', 'no-causal-proof', 'no-deployment'],
};
await writeFile(resolve(evidenceRoot, 'live-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`M6-04 live workflow: ${plan.actions.length} actions, ${manifest.apply.distinctChartVizTypes} chart types, idempotent, rollback exact, partial compensation ${partialFailure.compensation.length}/${partialFailure.compensation.length}\n`);
