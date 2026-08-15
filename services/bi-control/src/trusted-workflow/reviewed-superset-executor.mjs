import { canonicalJson } from '../canonical-json.js';
import { assertSafeJson, sha256Digest } from '../assistant-foundation/core-contracts.mjs';
import { APPLY_CAPABILITY_ID, CHANGE_PLAN_VERSION } from './trusted-specialist-workflow.mjs';

export const WORKFLOW_RECEIPT_VERSION = 'chimpmaera.bi/trusted-superset-workflow-receipt/v1';
export const WORKFLOW_ROLLBACK_VERSION = 'chimpmaera.bi/trusted-superset-rollback-receipt/v1';
export const WORKFLOW_RECONCILIATION_VERSION = 'chimpmaera.bi/trusted-superset-reconciliation/v1';

const fail = (code) => { const error = new Error(code); error.code = code; throw error; };
const clone = (value) => structuredClone(value);
const same = (left, right) => canonicalJson(left) === canonicalJson(right);

function parseJsonObject(value, code) {
  let parsed;
  try { parsed = JSON.parse(value); } catch { fail(code); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(code);
  return parsed;
}

function chartSemantic(params) {
  const parsed = parseJsonObject(params, 'SUPERSET_CHART_PARAMS_INVALID');
  const metrics = parsed.metrics ?? (parsed.metric ? [parsed.metric] : []);
  const metric = metrics[0];
  return {
    metricId: typeof metric === 'string' ? metric : metric?.label ?? metric?.optionName ?? 'none',
    groupBy: Array.isArray(parsed.groupby) ? parsed.groupby : parsed.groupby ? [parsed.groupby] : [],
  };
}

function normalizeFilter(filter, dashboardUuid) {
  const target = filter?.targets?.[0];
  return {
    filterId: filter.id,
    dashboardUuid,
    datasetUuid: target?.datasetUuid,
    column: target?.column?.name,
    filterType: filter?.filterType,
  };
}

export class ReviewedSupersetAssetAdapter {
  #client;

  constructor({ client }) { this.#client = client; }

  async #record(kind, uuid) {
    const values = await this.#client.list(kind);
    const found = values.find((item) => item.uuid === uuid);
    if (!found) fail(`SUPERSET_${kind.toUpperCase()}_NOT_FOUND`);
    return (await this.#client.request('GET', `/api/v1/${kind}/${found.id}`)).result;
  }

  async #database(uuid) {
    const values = await this.#client.list('database');
    const found = values.find((item) => item.uuid === uuid);
    if (!found) fail('SUPERSET_DATABASE_NOT_FOUND');
    return found;
  }

  async #dashboardChartUuids(dashboardId) {
    const charts = await this.#client.list('chart');
    return charts.filter((chart) => (chart.dashboards ?? []).some((dashboard) => dashboard.id === dashboardId))
      .map((chart) => chart.uuid).sort();
  }

  async read(action) {
    const { kind } = action.asset;
    const after = action.after;
    if (kind === 'dataset') {
      const record = await this.#record('dataset', after.uuid);
      return { uuid: record.uuid, tableName: record.table_name, databaseUuid: record.database?.uuid, description: record.description ?? '' };
    }
    if (kind === 'chart') {
      const record = await this.#record('chart', after.uuid);
      const semantic = chartSemantic(record.params);
      return { uuid: record.uuid, title: record.slice_name, vizType: record.viz_type, datasetUuid: record.datasource_uuid, ...semantic };
    }
    if (kind === 'dashboard') {
      const record = await this.#record('dashboard', after.uuid);
      return {
        uuid: record.uuid,
        title: record.dashboard_title,
        slug: record.slug,
        chartUuids: await this.#dashboardChartUuids(record.id),
        layoutId: record.certification_details ?? '',
      };
    }
    if (kind === 'filter') {
      const dashboard = await this.#record('dashboard', after.dashboardUuid);
      const metadata = parseJsonObject(dashboard.json_metadata, 'SUPERSET_DASHBOARD_METADATA_INVALID');
      const filter = (metadata.native_filter_configuration ?? []).find((item) => item.id === after.filterId);
      if (!filter) fail('SUPERSET_FILTER_NOT_FOUND');
      return normalizeFilter(filter, dashboard.uuid);
    }
    fail('SUPERSET_REVIEWED_ASSET_KIND_DENIED');
  }

  async applyValue(action, value) {
    if (!value) fail('SUPERSET_REVIEWED_DELETE_DENIED');
    const { kind } = action.asset;
    if (kind === 'dataset') {
      const record = await this.#record('dataset', action.after.uuid);
      const database = await this.#database(value.databaseUuid);
      await this.#client.request('PUT', `/api/v1/dataset/${record.id}`, {
        uuid: value.uuid,
        table_name: value.tableName,
        database_id: database.id,
        description: value.description,
        main_dttm_col: record.main_dttm_col,
        is_sqllab_view: false,
      });
    } else if (kind === 'chart') {
      const record = await this.#record('chart', action.after.uuid);
      const dataset = await this.#record('dataset', value.datasetUuid);
      const semantic = chartSemantic(record.params);
      if (semantic.metricId !== value.metricId || !same(semantic.groupBy, value.groupBy)) fail('SUPERSET_CHART_SEMANTIC_DRIFT_DENIED');
      await this.#client.request('PUT', `/api/v1/chart/${record.id}`, {
        uuid: value.uuid,
        slice_name: value.title,
        viz_type: value.vizType,
        datasource_id: dataset.id,
        datasource_type: 'table',
        dashboards: (record.dashboards ?? []).map((dashboard) => dashboard.id),
        params: record.params,
        description: record.description,
        certified_by: record.certified_by,
        certification_details: record.certification_details,
      });
    } else if (kind === 'dashboard') {
      const record = await this.#record('dashboard', action.after.uuid);
      const currentChartUuids = await this.#dashboardChartUuids(record.id);
      if (!same(currentChartUuids, [...value.chartUuids].sort())) fail('SUPERSET_DASHBOARD_DEPENDENCY_DRIFT_DENIED');
      await this.#client.request('PUT', `/api/v1/dashboard/${record.id}`, {
        uuid: value.uuid,
        dashboard_title: value.title,
        slug: value.slug,
        published: record.published,
        css: record.css,
        position_json: record.position_json,
        json_metadata: record.json_metadata,
        certified_by: record.certified_by,
        certification_details: value.layoutId,
      });
    } else if (kind === 'filter') {
      const record = await this.#record('dashboard', value.dashboardUuid);
      const metadata = parseJsonObject(record.json_metadata, 'SUPERSET_DASHBOARD_METADATA_INVALID');
      const filters = metadata.native_filter_configuration ?? [];
      const index = filters.findIndex((item) => item.id === value.filterId);
      if (index < 0) fail('SUPERSET_FILTER_NOT_FOUND');
      filters[index] = {
        ...filters[index],
        filterType: value.filterType,
        name: value.column.replaceAll('_', ' '),
        targets: [{ column: { name: value.column }, datasetUuid: value.datasetUuid }],
      };
      metadata.native_filter_configuration = filters;
      await this.#client.request('PUT', `/api/v1/dashboard/${record.id}`, {
        uuid: record.uuid,
        dashboard_title: record.dashboard_title,
        slug: record.slug,
        published: record.published,
        css: record.css,
        position_json: record.position_json,
        json_metadata: JSON.stringify(metadata),
        certified_by: record.certified_by,
        certification_details: record.certification_details,
      });
    } else fail('SUPERSET_REVIEWED_ASSET_KIND_DENIED');
    const readback = await this.read(action);
    if (!same(readback, value)) fail('SUPERSET_REVIEWED_APPLY_READBACK_MISMATCH');
    return readback;
  }
}

export class TrustedSupersetWorkflowExecutor {
  #adapter;
  #idempotency = new Map();
  #rollback = new Map();
  #clock;

  constructor({ adapter, clock = () => new Date().toISOString(), reconciliation = null }) {
    this.#adapter = adapter;
    this.#clock = clock;
    if (reconciliation !== null) {
      if (reconciliation.schemaVersion !== WORKFLOW_RECONCILIATION_VERSION || !Array.isArray(reconciliation.idempotency) || !Array.isArray(reconciliation.rollbackPoints)) fail('WORKFLOW_RECONCILIATION_INVALID');
      for (const item of reconciliation.idempotency) this.#idempotency.set(item.idempotencyKey, clone(item.value));
      for (const item of reconciliation.rollbackPoints) this.#rollback.set(item.rollbackToken, clone(item.value));
    }
  }

  snapshot() {
    const value = {
      schemaVersion: WORKFLOW_RECONCILIATION_VERSION,
      idempotency: [...this.#idempotency].map(([idempotencyKey, item]) => ({ idempotencyKey, value: clone(item) })).sort((a, b) => a.idempotencyKey.localeCompare(b.idempotencyKey)),
      rollbackPoints: [...this.#rollback].map(([rollbackToken, item]) => ({ rollbackToken, value: clone(item) })).sort((a, b) => a.rollbackToken.localeCompare(b.rollbackToken)),
    };
    assertSafeJson(value);
    return value;
  }

  async apply({ plan, authorization, idempotencyKey, failAfterActionId = null, signal = null, maxDurationMs = 30_000 }) {
    if (!plan || plan.schemaVersion !== CHANGE_PLAN_VERSION || authorization?.authorized !== true || authorization.executionId !== plan.planId || authorization.capabilityId !== APPLY_CAPABILITY_ID) fail('WORKFLOW_EXECUTION_AUTHORIZATION_REQUIRED');
    const planBody = Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'previewDigest'));
    if (plan.previewDigest !== sha256Digest(planBody)) fail('WORKFLOW_PLAN_DIGEST_MISMATCH');
    if (authorization.previewDigest !== plan.previewDigest || authorization.targetBindingDigest !== sha256Digest(plan.targetBinding) || authorization.idempotencyKey !== idempotencyKey) fail('WORKFLOW_AUTHORIZATION_BINDING_MISMATCH');
    if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > 120_000) fail('WORKFLOW_DURATION_BUDGET_INVALID');
    const planDigest = sha256Digest(plan);
    const prior = this.#idempotency.get(idempotencyKey);
    if (prior) {
      if (prior.planDigest !== planDigest) fail('WORKFLOW_IDEMPOTENCY_CONFLICT');
      return { ...clone(prior.receipt), status: 'already_applied' };
    }
    const byId = new Map(plan.actions.map((action) => [action.actionId, action]));
    const applied = [];
    const startedAt = this.#clock();
    const deadline = Date.parse(startedAt) + maxDurationMs;
    if (!Number.isFinite(deadline)) fail('WORKFLOW_CLOCK_INVALID');
    const assertActive = () => {
      if (signal?.aborted) fail('WORKFLOW_CANCELLED');
      if (Date.parse(this.#clock()) >= deadline) fail('WORKFLOW_TIMEOUT');
    };
    try {
      for (const actionId of plan.applyOrder) {
        assertActive();
        const action = byId.get(actionId);
        const current = await this.#adapter.read(action);
        if (!same(current, action.before)) fail('WORKFLOW_PRE_APPLY_DRIFT_DENIED');
        const readback = await this.#adapter.applyValue(action, action.after);
        applied.push(action);
        assertActive();
        if (failAfterActionId === actionId) fail('INJECTED_PARTIAL_FAILURE');
        if (!same(readback, action.after)) fail('WORKFLOW_ACTION_READBACK_MISMATCH');
      }
    } catch (error) {
      const compensation = [];
      for (const action of [...applied].reverse()) {
        try {
          const restored = await this.#adapter.applyValue(action, action.before);
          compensation.push({ actionId: action.actionId, restoredDigest: sha256Digest(restored), status: 'restored' });
        } catch (rollbackError) {
          compensation.push({ actionId: action.actionId, status: 'rollback_failed', errorCode: rollbackError.code ?? 'ROLLBACK_FAILED' });
        }
      }
      const wrapped = new Error(error.code ?? 'WORKFLOW_APPLY_FAILED');
      wrapped.code = error.code ?? 'WORKFLOW_APPLY_FAILED';
      wrapped.compensation = compensation;
      throw wrapped;
    }
    const readback = [];
    for (const action of plan.actions) readback.push({ actionId: action.actionId, valueDigest: sha256Digest(await this.#adapter.read(action)) });
    const rollbackToken = sha256Digest({ planDigest, idempotencyKey, before: plan.actions.map(({ actionId, before }) => ({ actionId, before })) });
    const receipt = {
      schemaVersion: WORKFLOW_RECEIPT_VERSION,
      executionId: plan.planId,
      capabilityId: APPLY_CAPABILITY_ID,
      status: 'succeeded',
      startedAt,
      finishedAt: this.#clock(),
      planDigest,
      previewDigest: plan.previewDigest,
      idempotencyKey,
      appliedActionIds: clone(plan.applyOrder),
      readback,
      rollbackToken,
      sideEffect: 'reversible',
      responsePayloadPersisted: false,
      sourceRecordsPersisted: false,
    };
    assertSafeJson(receipt);
    this.#rollback.set(rollbackToken, { planDigest, actions: clone(plan.actions), applyOrder: clone(plan.applyOrder) });
    this.#idempotency.set(idempotencyKey, { planDigest, receipt: clone(receipt) });
    return receipt;
  }

  async rollback({ rollbackToken }) {
    const point = this.#rollback.get(rollbackToken);
    if (!point) fail('WORKFLOW_ROLLBACK_TOKEN_INVALID');
    const byId = new Map(point.actions.map((action) => [action.actionId, action]));
    const restored = [];
    for (const actionId of [...point.applyOrder].reverse()) {
      const action = byId.get(actionId);
      const current = await this.#adapter.read(action);
      if (!same(current, action.after)) fail('WORKFLOW_ROLLBACK_DRIFT_DENIED');
      const readback = await this.#adapter.applyValue(action, action.before);
      restored.push({ actionId, valueDigest: sha256Digest(readback) });
    }
    this.#rollback.delete(rollbackToken);
    const receipt = {
      schemaVersion: WORKFLOW_ROLLBACK_VERSION,
      status: 'rolled_back',
      planDigest: point.planDigest,
      restored,
      completedAt: this.#clock(),
      rollbackTokenConsumed: true,
      responsePayloadPersisted: false,
    };
    assertSafeJson(receipt);
    return receipt;
  }
}
