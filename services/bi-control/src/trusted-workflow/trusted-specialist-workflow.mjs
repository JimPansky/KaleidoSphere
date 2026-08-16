import { canonicalJson } from '../canonical-json.js';
import { assertSafeJson, sha256Digest } from '../assistant-foundation/core-contracts.mjs';
import { createApprovalGrant, ExecutionController } from '../assistant-foundation/execution-control.mjs';
import { SPECIALIST_AGENT_VERSION } from '../bi-specialist/specialist-agent.mjs';

export const TRUSTED_TARGET_VERSION = 'chimpmaera.bi/trusted-superset-target/v1';
export const TYPED_RECOMMENDATION_VERSION = 'chimpmaera.bi/typed-specialist-recommendation/v1';
export const CHANGE_PLAN_VERSION = 'chimpmaera.bi/trusted-superset-change-plan/v1';
export const WORKFLOW_APPROVAL_VERSION = 'chimpmaera.bi/trusted-workflow-approval/v1';
export const APPLY_CAPABILITY_ID = 'superset.asset-revision.apply';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const ACTION_CAPABILITY = Object.freeze({
  'dataset.update': 'superset.dataset.reviewed-update',
  'chart.upsert': 'superset.chart.reviewed-upsert',
  'dashboard.update': 'superset.dashboard.reviewed-update',
  'filter.configure': 'superset.dashboard.reviewed-filter-update',
});
const ACTION_KIND = Object.freeze({
  'dataset.update': 'dataset',
  'chart.upsert': 'chart',
  'dashboard.update': 'dashboard',
  'filter.configure': 'filter',
});
const VALUE_FIELDS = Object.freeze({
  'dataset.update': new Set(['uuid', 'tableName', 'databaseUuid', 'description']),
  'chart.upsert': new Set(['uuid', 'title', 'vizType', 'datasetUuid', 'metricId', 'groupBy']),
  'dashboard.update': new Set(['uuid', 'title', 'slug', 'chartUuids', 'layoutId']),
  'filter.configure': new Set(['filterId', 'dashboardUuid', 'datasetUuid', 'column', 'filterType']),
});
const SUPERSET_VIZ_TYPES = new Set(['big_number', 'echarts_timeseries_line', 'echarts_timeseries_bar', 'echarts_timeseries_scatter', 'table', 'heatmap_v2', 'treemap_v2']);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SAFE_LABEL = /^[^\u0000-\u001f\u007f]{1,256}$/;
const FORBIDDEN_ACTION_KEYS = new Set([
  'sql', 'raw_sql', 'query', 'dom', 'javascript', 'script', 'selector', 'url', 'uri', 'path',
  'secret', 'token', 'password', 'cookie', 'raw', 'raw_row', 'raw_response', 'response',
  'prompt', 'reasoning', 'chain_of_thought',
]);
const fail = (code) => { const error = new Error(code); error.code = code; throw error; };
const clone = (value) => structuredClone(value);

function exactKeys(value, allowed, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(code);
  if (Object.keys(value).some((key) => !allowed.has(key))) fail(code);
}

function rejectForbiddenActionSurface(value) {
  if (Array.isArray(value)) return value.forEach(rejectForbiddenActionSurface);
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[ .-]+/g, '_').toLowerCase();
    if (FORBIDDEN_ACTION_KEYS.has(normalized)) fail('UNREVIEWED_ACTION_SURFACE_DENIED');
    rejectForbiddenActionSurface(item);
  }
}

function canonicalClone(value) {
  canonicalJson(value);
  return clone(value);
}

function fingerprintBody(fingerprint) {
  return {
    product: fingerprint.product,
    version: fingerprint.version,
    openapiCanonicalSha256: fingerprint.openapiCanonicalSha256,
  };
}

function capabilitySnapshot(target) {
  return [...target.capabilities]
    .map(({ capabilityId, contractVersion, status }) => ({ capabilityId, contractVersion, status }))
    .sort((a, b) => a.capabilityId.localeCompare(b.capabilityId));
}

export function assertTrustedTarget(target) {
  exactKeys(target, new Set(['schemaVersion', 'targetId', 'environment', 'baseUrl', 'fingerprint', 'capabilityRevision', 'capabilities', 'assets']), 'TRUSTED_TARGET_INVALID');
  if (target.schemaVersion !== TRUSTED_TARGET_VERSION || !ID.test(target.targetId ?? '') || target.environment !== 'disposable_local') fail('TRUSTED_TARGET_INVALID');
  let parsed;
  try { parsed = new URL(target.baseUrl); } catch { fail('TRUSTED_TARGET_URL_INVALID'); }
  if (parsed.protocol !== 'http:' || !LOOPBACK.has(parsed.hostname) || parsed.username || parsed.password || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) fail('TRUSTED_TARGET_URL_DENIED');
  exactKeys(target.fingerprint, new Set(['product', 'version', 'openapiCanonicalSha256', 'digest']), 'TARGET_FINGERPRINT_INVALID');
  if (target.fingerprint.product !== 'Apache Superset' || !/^6\.1\.\d+$/.test(target.fingerprint.version ?? '') || !/^[a-f0-9]{64}$/.test(target.fingerprint.openapiCanonicalSha256 ?? '')) fail('TARGET_FINGERPRINT_INVALID');
  if (target.fingerprint.digest !== sha256Digest(fingerprintBody(target.fingerprint))) fail('TARGET_FINGERPRINT_DIGEST_MISMATCH');
  if (!ID.test(target.capabilityRevision ?? '') || !Array.isArray(target.capabilities) || target.capabilities.length === 0) fail('TARGET_CAPABILITY_INVALID');
  const capabilityIds = new Set();
  for (const item of target.capabilities) {
    exactKeys(item, new Set(['capabilityId', 'contractVersion', 'status']), 'TARGET_CAPABILITY_INVALID');
    if (!ID.test(item.capabilityId ?? '') || !/^v[1-9][0-9]*$/.test(item.contractVersion ?? '') || !['supported', 'partial', 'unsupported'].includes(item.status)) fail('TARGET_CAPABILITY_INVALID');
    if (capabilityIds.has(item.capabilityId)) fail('TARGET_CAPABILITY_DUPLICATE');
    capabilityIds.add(item.capabilityId);
  }
  if (!Array.isArray(target.assets)) fail('TARGET_ASSET_SNAPSHOT_INVALID');
  const assetIds = new Set();
  for (const asset of target.assets) {
    exactKeys(asset, new Set(['identity', 'kind', 'value']), 'TARGET_ASSET_SNAPSHOT_INVALID');
    if (!ID.test(asset.identity ?? '') || !['database', 'dataset', 'chart', 'dashboard', 'filter'].includes(asset.kind)) fail('TARGET_ASSET_SNAPSHOT_INVALID');
    if (assetIds.has(asset.identity)) fail('TARGET_ASSET_DUPLICATE');
    assetIds.add(asset.identity);
    assertSafeJson(asset.value);
    rejectForbiddenActionSurface(asset.value);
  }
  assertSafeJson(target);
  return target;
}

function assertSpecialistResult(result) {
  if (!result || result.schemaVersion !== SPECIALIST_AGENT_VERSION || !ID.test(result.runId ?? '')) fail('SPECIALIST_RESULT_INVALID');
  if (result.self_check?.mutationPerformed !== false || result.discovery?.visualizationProposal?.mode !== 'preview-only' || result.discovery?.trustedApplyReadbackRollback?.applyPerformed !== false) fail('SPECIALIST_AUTHORITY_BOUNDARY_INVALID');
  assertSafeJson(result);
  return result;
}

function expectedIdentity(kind, value) {
  if (kind === 'filter') return `filter:${value.dashboardUuid}:${value.filterId}`;
  return `${kind}:${value.uuid}`;
}

function assertAction(action, targetAssets, capabilityById) {
  exactKeys(action, new Set(['actionId', 'actionType', 'asset', 'dependsOn', 'before', 'after']), 'TYPED_ACTION_INVALID');
  if (!ID.test(action.actionId ?? '') || !Object.hasOwn(ACTION_CAPABILITY, action.actionType)) fail('UNSUPPORTED_SPECIALIST_ACTION');
  exactKeys(action.asset, new Set(['identity', 'kind']), 'TYPED_ACTION_ASSET_INVALID');
  if (action.asset.kind !== ACTION_KIND[action.actionType] || !ID.test(action.asset.identity ?? '')) fail('TYPED_ACTION_ASSET_INVALID');
  const fields = VALUE_FIELDS[action.actionType];
  if (action.before !== null) exactKeys(action.before, fields, 'TYPED_ACTION_VALUE_INVALID');
  exactKeys(action.after, fields, 'TYPED_ACTION_VALUE_INVALID');
  rejectForbiddenActionSurface(action);
  assertSafeJson(action);
  const uuidValues = ['uuid', 'databaseUuid', 'datasetUuid', 'dashboardUuid', 'chartUuids'];
  for (const field of uuidValues) {
    const value = action.after[field];
    const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
    if (values.some((item) => !UUID.test(item))) fail('TYPED_ACTION_UUID_INVALID');
  }
  if (action.asset.identity !== expectedIdentity(action.asset.kind, action.after)) fail('TYPED_ACTION_IDENTITY_MISMATCH');
  if (action.before?.uuid && action.before.uuid !== action.after.uuid) fail('STABLE_ASSET_IDENTITY_REQUIRED');
  const snapshot = targetAssets.get(action.asset.identity);
  if ((snapshot === undefined && action.before !== null) || (snapshot !== undefined && canonicalJson(snapshot.value) !== canonicalJson(action.before))) fail('TARGET_BEFORE_STATE_MISMATCH');
  if (!Array.isArray(action.dependsOn) || action.dependsOn.some((identity) => !ID.test(identity))) fail('TYPED_ACTION_DEPENDENCY_INVALID');
  if (action.actionType === 'dataset.update') {
    if (!IDENTIFIER.test(action.after.tableName ?? '') || !SAFE_LABEL.test(action.after.description ?? '') || !action.dependsOn.includes(`database:${action.after.databaseUuid}`)) fail('TYPED_DATASET_ACTION_INVALID');
  } else if (action.actionType === 'chart.upsert') {
    if (!SAFE_LABEL.test(action.after.title ?? '') || !SUPERSET_VIZ_TYPES.has(action.after.vizType) || !SAFE_LABEL.test(action.after.metricId ?? '')
      || !Array.isArray(action.after.groupBy) || action.after.groupBy.some((item) => !IDENTIFIER.test(item)) || !action.dependsOn.includes(`dataset:${action.after.datasetUuid}`)) fail('TYPED_CHART_ACTION_INVALID');
  } else if (action.actionType === 'dashboard.update') {
    if (!SAFE_LABEL.test(action.after.title ?? '') || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(action.after.slug ?? '') || !SAFE_LABEL.test(action.after.layoutId ?? '')
      || !Array.isArray(action.after.chartUuids) || action.after.chartUuids.some((item) => !UUID.test(item) || !action.dependsOn.includes(`chart:${item}`))) fail('TYPED_DASHBOARD_ACTION_INVALID');
  } else if (action.actionType === 'filter.configure') {
    if (!ID.test(action.after.filterId ?? '') || !IDENTIFIER.test(action.after.column ?? '') || !['filter_select', 'filter_time'].includes(action.after.filterType)
      || !action.dependsOn.includes(`dashboard:${action.after.dashboardUuid}`) || !action.dependsOn.includes(`dataset:${action.after.datasetUuid}`)) fail('TYPED_FILTER_ACTION_INVALID');
  }
  if (capabilityById.get(ACTION_CAPABILITY[action.actionType])?.status !== 'supported') fail('TARGET_CAPABILITY_UNSUPPORTED');
}

function dependencyOrder(actions, existingAssets) {
  const byAsset = new Map(actions.map((action) => [action.asset.identity, action]));
  const visiting = new Set();
  const visited = new Set();
  const order = [];
  const visit = (action) => {
    if (visiting.has(action.asset.identity)) fail('TYPED_ACTION_DEPENDENCY_CYCLE');
    if (visited.has(action.asset.identity)) return;
    visiting.add(action.asset.identity);
    for (const dependency of [...action.dependsOn].sort()) {
      const producer = byAsset.get(dependency);
      if (producer) visit(producer);
      else if (!existingAssets.has(dependency)) fail('TYPED_ACTION_DEPENDENCY_UNKNOWN');
    }
    visiting.delete(action.asset.identity);
    visited.add(action.asset.identity);
    order.push(action.actionId);
  };
  [...actions].sort((a, b) => a.actionId.localeCompare(b.actionId)).forEach(visit);
  return order;
}

export function compileTrustedChangePlan({ planId, specialistResult, recommendation, target }) {
  if (!ID.test(planId ?? '')) fail('CHANGE_PLAN_ID_INVALID');
  assertSpecialistResult(specialistResult);
  assertTrustedTarget(target);
  exactKeys(recommendation, new Set(['schemaVersion', 'recommendationId', 'sourceRunId', 'sourceDiscoveryDigest', 'authority', 'actions']), 'TYPED_RECOMMENDATION_INVALID');
  if (recommendation.schemaVersion !== TYPED_RECOMMENDATION_VERSION || !ID.test(recommendation.recommendationId ?? '') || recommendation.authority !== 'advisory_only') fail('TYPED_RECOMMENDATION_INVALID');
  if (recommendation.sourceRunId !== specialistResult.runId || recommendation.sourceDiscoveryDigest !== sha256Digest(specialistResult.discovery)) fail('SPECIALIST_RECOMMENDATION_BINDING_MISMATCH');
  if (!Array.isArray(recommendation.actions) || recommendation.actions.length === 0 || recommendation.actions.length > 24) fail('TYPED_RECOMMENDATION_ACTION_BUDGET');
  assertSafeJson(recommendation);
  const targetAssets = new Map(target.assets.map((asset) => [asset.identity, asset]));
  const capabilityById = new Map(target.capabilities.map((item) => [item.capabilityId, item]));
  const actionIds = new Set();
  const assetIds = new Set();
  for (const action of recommendation.actions) {
    assertAction(action, targetAssets, capabilityById);
    if (actionIds.has(action.actionId) || assetIds.has(action.asset.identity)) fail('TYPED_ACTION_DUPLICATE');
    actionIds.add(action.actionId);
    assetIds.add(action.asset.identity);
  }
  const actions = [...recommendation.actions].sort((a, b) => a.actionId.localeCompare(b.actionId)).map(canonicalClone);
  const capabilities = capabilitySnapshot(target);
  const targetBinding = {
    targetId: target.targetId,
    environment: target.environment,
    baseUrlOrigin: new URL(target.baseUrl).origin,
    fingerprintDigest: target.fingerprint.digest,
    capabilityRevision: target.capabilityRevision,
    capabilityDigest: sha256Digest(capabilities),
    assetSnapshotDigest: sha256Digest([...target.assets].sort((a, b) => a.identity.localeCompare(b.identity))),
  };
  const body = {
    schemaVersion: CHANGE_PLAN_VERSION,
    planId,
    recommendationId: recommendation.recommendationId,
    specialistBinding: {
      runId: specialistResult.runId,
      schemaVersion: specialistResult.schemaVersion,
      discoveryDigest: recommendation.sourceDiscoveryDigest,
      modelAuthority: false,
      rawModelOutputIncluded: false,
    },
    targetBinding,
    capabilities,
    actions,
    applyOrder: dependencyOrder(actions, targetAssets),
    limitations: ['synthetic-disposable-target-only', 'typed-reviewed-adapter-only', 'no-free-form-sql', 'no-dom-control'],
    nonclaims: ['no-delivery', 'no-production-or-customer-use', 'no-model-authority', 'no-causal-proof'],
  };
  const plan = { ...body, previewDigest: sha256Digest(body) };
  assertSafeJson(plan);
  return Object.freeze(canonicalClone(plan));
}

function approvalArgs(plan, idempotencyKey) {
  return { planId: plan.planId, previewDigest: plan.previewDigest, actionIds: plan.applyOrder, idempotencyKey };
}

function approvalResource(plan, actorId, sessionId) {
  return {
    actorId,
    sessionId,
    targetId: plan.targetBinding.targetId,
    fingerprintDigest: plan.targetBinding.fingerprintDigest,
    capabilityDigest: plan.targetBinding.capabilityDigest,
    assetSnapshotDigest: plan.targetBinding.assetSnapshotDigest,
  };
}

function approvalPolicy(expiresAt) {
  return { approvalChannel: 'trusted_ui', oneShot: true, reusable: false, expiresAt, driftPolicy: 'deny' };
}

export function createTrustedWorkflowApproval({ approvalId, actorId, sessionId, plan, issuedAt, expiresAt, idempotencyKey, channel = 'trusted_ui', inputSource = 'direct_confirmation', modelGenerated = false, approvedActionIds = plan?.applyOrder }) {
  if (channel !== 'trusted_ui') fail('VOICE_ONLY_APPROVAL_DENIED');
  if (inputSource !== 'direct_confirmation' || modelGenerated !== false) fail('UNTRUSTED_APPROVAL_SOURCE_DENIED');
  if (!ID.test(approvalId ?? '') || !ID.test(actorId ?? '') || !ID.test(sessionId ?? '') || !ID.test(idempotencyKey ?? '')) fail('WORKFLOW_APPROVAL_IDENTITY_INVALID');
  if (!plan || plan.schemaVersion !== CHANGE_PLAN_VERSION || plan.previewDigest !== sha256Digest(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'previewDigest')))) fail('CHANGE_PLAN_DIGEST_MISMATCH');
  if (canonicalJson(approvedActionIds) !== canonicalJson(plan.applyOrder)) fail('PARTIAL_APPROVAL_DENIED');
  const args = approvalArgs(plan, idempotencyKey);
  const resource = approvalResource(plan, actorId, sessionId);
  const policy = approvalPolicy(expiresAt);
  const baseGrant = createApprovalGrant({
    grantId: approvalId,
    executionId: plan.planId,
    capabilityId: APPLY_CAPABILITY_ID,
    args,
    resource,
    policy,
    issuedAt,
    expiresAt,
    channel,
  });
  return Object.freeze({
    schemaVersion: WORKFLOW_APPROVAL_VERSION,
    approvalId,
    actorId,
    sessionId,
    planId: plan.planId,
    previewDigest: plan.previewDigest,
    targetBindingDigest: sha256Digest(plan.targetBinding),
    idempotencyKey,
    approvedActionIds: clone(approvedActionIds),
    channel,
    inputSource,
    modelGenerated,
    oneShot: true,
    reusable: false,
    baseGrant,
  });
}

export class TrustedApprovalController {
  #controller = new ExecutionController();

  register(approval) {
    if (!approval || approval.schemaVersion !== WORKFLOW_APPROVAL_VERSION || approval.oneShot !== true || approval.reusable !== false) fail('WORKFLOW_APPROVAL_INVALID');
    if (approval.channel !== 'trusted_ui' || approval.inputSource !== 'direct_confirmation' || approval.modelGenerated !== false) fail('UNTRUSTED_APPROVAL_SOURCE_DENIED');
    this.#controller.registerGrant(approval.baseGrant);
  }

  authorize({ approval, plan, actorId, sessionId, target, idempotencyKey, now, guards = [{ mandatory: true, decision: 'allow' }] }) {
    assertTrustedTarget(target);
    if (!approval || approval.schemaVersion !== WORKFLOW_APPROVAL_VERSION || !plan || plan.schemaVersion !== CHANGE_PLAN_VERSION) fail('WORKFLOW_APPROVAL_INVALID');
    if (approval.actorId !== actorId || approval.sessionId !== sessionId) fail('APPROVAL_PRINCIPAL_MISMATCH');
    if (approval.planId !== plan.planId || approval.previewDigest !== plan.previewDigest || approval.targetBindingDigest !== sha256Digest(plan.targetBinding) || approval.idempotencyKey !== idempotencyKey) fail('APPROVAL_EXACT_BINDING_MISMATCH');
    if (canonicalJson(approval.approvedActionIds) !== canonicalJson(plan.applyOrder)) fail('PARTIAL_APPROVAL_DENIED');
    const currentCapabilities = capabilitySnapshot(target);
    const currentBinding = {
      targetId: target.targetId,
      environment: target.environment,
      baseUrlOrigin: new URL(target.baseUrl).origin,
      fingerprintDigest: target.fingerprint.digest,
      capabilityRevision: target.capabilityRevision,
      capabilityDigest: sha256Digest(currentCapabilities),
      assetSnapshotDigest: sha256Digest([...target.assets].sort((a, b) => a.identity.localeCompare(b.identity))),
    };
    if (canonicalJson(currentBinding) !== canonicalJson(plan.targetBinding)) fail('APPROVED_TARGET_DRIFTED');
    const args = approvalArgs(plan, idempotencyKey);
    const resource = approvalResource(plan, actorId, sessionId);
    const policy = approvalPolicy(approval.baseGrant.expiresAt);
    const authorized = this.#controller.authorize({
      grantId: approval.approvalId,
      executionId: plan.planId,
      capabilityId: APPLY_CAPABILITY_ID,
      args,
      resource,
      policy,
      guards,
      now,
    });
    return Object.freeze({
      ...authorized,
      previewDigest: plan.previewDigest,
      targetBindingDigest: sha256Digest(plan.targetBinding),
      idempotencyKey,
    });
  }
}
