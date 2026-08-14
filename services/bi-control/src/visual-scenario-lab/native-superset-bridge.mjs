import { readFile } from 'node:fs/promises';

import { sha256Digest } from '../assistant-foundation/core-contracts.mjs';
import { INITIAL_STATE, loadVisualScenarioFixtures } from './scenario-engine.mjs';
import { compositionFor } from './view-compositions.mjs';

export const NATIVE_STATE_VERSION = 'chimpmaera.bi/native-superset-ui-state/v1';
export const NATIVE_READBACK_VERSION = 'chimpmaera.bi/native-superset-readback/v1';
export const MANAGED_BY = 'sba-m6-02-native-bridge';
export const SUPPORTED_NATIVE_ACTIONS = Object.freeze(['set_filter', 'clear_filter', 'set_time_range', 'explain_current_view']);
export const FAIL_CLOSED_NATIVE_ACTIONS = Object.freeze([
  'focus_chart', 'open_drilldown', 'compare_segments', 'select_tab', 'sort_table', 'toggle_series',
]);

const uuid = (suffix) => `c6020000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const dashboard = (key, suffix, slug, title) => Object.freeze({ key, uuid: uuid(suffix), slug, title });

export const NATIVE_ASSETS = Object.freeze({
  databaseUuid: uuid(1),
  datasetUuid: uuid(2),
  datasetTable: 'northstar_scenario_oracle',
  dashboards: Object.freeze({
    executive: dashboard('executive', 101, 'm6-02-executive-summary', 'M6-02 Executive Summary'),
    quality: dashboard('quality', 102, 'm6-02-quality-investigation', 'M6-02 Quality Investigation'),
    inventory: dashboard('inventory', 103, 'm6-02-inventory-risk', 'M6-02 Inventory Risk'),
    maintenance: dashboard('maintenance', 104, 'm6-02-maintenance-reliability', 'M6-02 Maintenance Reliability'),
    crossDomain: dashboard('crossDomain', 105, 'm6-02-cross-domain', 'M6-02 Cross-domain Comparison'),
    voiceCorrection: dashboard('voiceCorrection', 106, 'm6-02-voice-correction-cancel', 'M6-02 Corrected Quality View'),
    undoIdempotency: dashboard('undoIdempotency', 107, 'm6-02-undo-idempotency', 'M6-02 Reversible Executive View'),
    persistentDenied: dashboard('persistentDenied', 108, 'm6-02-persistent-request-denied', 'M6-02 Session-only Preview'),
  }),
  scenarioDashboard: Object.freeze({
    'executive-sales': 'executive',
    'quality-investigation': 'quality',
    'inventory-risk': 'inventory',
    maintenance: 'maintenance',
    'cross-domain': 'crossDomain',
    'voice-correction-cancel': 'voiceCorrection',
    'undo-idempotency': 'undoIdempotency',
    'persistent-request-denied': 'persistentDenied',
  }),
});

const CHART_TYPE_TO_SUPERSET = Object.freeze({
  big_number: 'big_number',
  time_series: 'echarts_timeseries_line',
  grouped_bar: 'echarts_timeseries_bar',
  stacked_bar: 'echarts_timeseries_bar',
  table_conditional: 'table',
  scatter: 'echarts_timeseries_scatter',
  heatmap: 'heatmap_v2',
  treemap: 'treemap_v2',
});

const CHART_SCOPES = Object.freeze({
  executive: [['revenue_eur'], ['revenue_eur'], ['revenue_eur']],
  quality: [['defect_rate_pct'], ['defect_rate_pct'], null],
  inventory: [['coverage_days'], null, ['demand_units', 'confirmed_supply_units']],
  maintenance: [['downtime_hours'], ['downtime_hours', 'mtbf_hours'], ['downtime_hours']],
  crossDomain: [['demand_change_pct', 'production_change_pct'], ['demand_change_pct', 'production_change_pct'], ['demand_change_pct', 'production_change_pct']],
  voiceCorrection: [['defect_rate_pct'], ['defect_rate_pct']],
  undoIdempotency: [['revenue_eur'], ['revenue_eur']],
  persistentDenied: [['demand_change_pct', 'production_change_pct'], null],
});

const TRUTH_KEY_BY_ASSET = Object.freeze({
  executive: 'executive_q2', quality: 'quality_spike', inventory: 'inventory_risk', maintenance: 'maintenance_q2',
  crossDomain: 'cross_domain_q2', voiceCorrection: 'quality_spike', undoIdempotency: 'executive_q2', persistentDenied: 'cross_domain_q2',
});

const CHART_TITLES = Object.freeze({
  executive: ['Revenue · EUR', 'Q2 revenue signal', 'Revenue by period'],
  quality: ['Defect-rate timing', 'Defect-rate signal', 'Supplier-batch evidence'],
  inventory: ['Coverage · days', 'Constraint evidence', 'Demand vs confirmed supply'],
  maintenance: ['Downtime · hours', 'Reliability concentration', 'Q2 downtime timing'],
  crossDomain: ['Demand vs production change · %', 'Domain change gap · %', 'Change association · not causation'],
  voiceCorrection: ['Corrected plant defect trend', 'Corrected-plant concentration'],
  undoIdempotency: ['Reversible revenue KPI', 'Reversible revenue view'],
  persistentDenied: ['Session-only change preview', 'Denied-change evidence'],
});

const TABLE_COLUMNS_BY_TRUTH = Object.freeze({
  quality_spike: ['metric_key', 'metric_value', 'entity_key'],
  inventory_risk: ['metric_key', 'metric_value', 'entity_key'],
  cross_domain_q2: ['metric_key', 'metric_value', 'entity_key'],
});

const RESPONSIVE_DASHBOARD_CSS = `
@media (max-width: 600px) {
  .grid-row { flex-direction: column !important; height: auto !important; }
  .grid-row > .dragdroppable { width: 100% !important; min-width: 0 !important; flex: 1 1 auto !important; }
  .resizable-container { width: 100% !important; max-width: 100% !important; min-width: 0 !important; height: 340px !important; }
  .dashboard-component-chart-holder { width: 100% !important; min-width: 0 !important; height: 340px !important; margin-bottom: 16px !important; }
  .dashboard-component-chart { min-width: 0 !important; }
}
`;

const allowedFilterValues = Object.freeze({
  plant: ['Werk 1', 'Werk 2', 'Werk 3'],
  line: ['Linie A', 'Linie B', 'Linie C'],
  product: ['Atlas Drive', 'Nova Pump', 'Terra Valve'],
  component: ['Rotor-7', 'Seal-4', 'Housing-2'],
  asset_class: ['Press', 'CNC', 'Test Bench'],
});

const clone = (value) => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = (code) => { const error = new Error(code); error.code = code; throw error; };
const stableChartUuid = (dashboardIndex, chartIndex) => uuid(1000 + (dashboardIndex * 100) + chartIndex);

function nativeFilterId(key) {
  return `NATIVE_FILTER-M6_02_${key.toUpperCase()}`;
}

function serializePermalinkState(state) {
  const masks = {};
  for (const [key, value] of Object.entries(state.filters)) {
    masks[nativeFilterId(key)] = {
      id: nativeFilterId(key),
      extraFormData: { filters: [{ col: key, op: 'IN', val: [value] }] },
      filterState: { value: [value], label: value },
    };
  }
  if (state.timeRange) {
    const value = `${state.timeRange.from} : ${state.timeRange.to}`;
    masks[nativeFilterId('time_range')] = {
      id: nativeFilterId('time_range'),
      extraFormData: { time_range: value },
      filterState: { value, label: value },
    };
  }
  return {
    dataMask: masks,
    urlParams: [
      ['cm_managed_by', MANAGED_BY],
      ['cm_state_version', String(state.version)],
      ['cm_cancelled', state.cancelled === true ? 'true' : 'false'],
    ],
  };
}

function publicState(value) {
  const parameters = Object.fromEntries(value?.urlParams ?? []);
  if (!value || parameters.cm_managed_by !== MANAGED_BY || !/^\d+$/.test(parameters.cm_state_version ?? '')) fail('NATIVE_STATE_READBACK_INVALID');
  const filters = {};
  let timeRange = null;
  for (const [id, mask] of Object.entries(value.dataMask ?? {})) {
    if (id === nativeFilterId('time_range')) {
      const serialized = mask?.extraFormData?.time_range;
      const [from, to] = typeof serialized === 'string' ? serialized.split(' : ') : [];
      if (!from || !to) fail('NATIVE_STATE_READBACK_INVALID');
      timeRange = { from, to };
      continue;
    }
    const filter = mask?.extraFormData?.filters?.[0];
    const selected = filter?.val?.[0];
    if (id !== nativeFilterId(filter?.col) || filter?.op !== 'IN' || !allowedFilterValues[filter.col]?.includes(selected)) fail('NATIVE_STATE_READBACK_INVALID');
    filters[filter.col] = selected;
  }
  return {
    ...clone(INITIAL_STATE),
    version: Number(parameters.cm_state_version),
    filters,
    timeRange,
    cancelled: parameters.cm_cancelled === 'true',
  };
}

function receipt(request, status, state, extra = {}) {
  return {
    schemaVersion: 'chimpmaera.bi/ui-action-receipt/v1',
    actionId: request?.actionId ?? null,
    action: request?.action ?? null,
    status,
    stateVersion: state.version,
    idempotencyKey: request?.idempotencyKey ?? null,
    undoToken: null,
    sideEffect: 'none',
    persistentSupersetMutation: false,
    nativeInterface: 'Apache Superset public REST API v1',
    ...extra,
  };
}

function assertRequest(request, state, dashboardAsset) {
  if (!request || request.schemaVersion !== 'chimpmaera.bi/ui-action/v1' || !request.actionId || !request.idempotencyKey) fail('UI_ACTION_INVALID');
  if (request.stateVersion !== state.version) fail('DASHBOARD_STATE_STALE');
  if (request.preconditions?.dashboardUuid !== dashboardAsset.uuid || request.preconditions?.dashboardSlug !== dashboardAsset.slug) fail('UI_ACTION_PRECONDITION_FAILED');
  if (state.cancelled) fail('INTERACTION_CANCELLED');
}

function applySupportedState(state, request) {
  const next = clone(state);
  const args = request.args ?? {};
  if (request.action === 'set_filter') {
    if (!allowedFilterValues[args.key]?.includes(args.value)) fail('UNKNOWN_FILTER_VALUE');
    next.filters[args.key] = args.value;
  } else if (request.action === 'clear_filter') {
    if (!Object.hasOwn(allowedFilterValues, args.key)) fail('UI_ACTION_RESOURCE_DENIED');
    delete next.filters[args.key];
  } else if (request.action === 'set_time_range') {
    if (Number.isNaN(Date.parse(args.from)) || Number.isNaN(Date.parse(args.to)) || Date.parse(args.from) > Date.parse(args.to)) fail('UI_ACTION_ARGUMENT_INVALID');
    next.timeRange = { from: args.from, to: args.to };
  }
  if (request.action !== 'explain_current_view') next.version += 1;
  return next;
}

export class SupersetPublicApiClient {
  #baseUrl;
  #fetch;
  #username;
  #password;
  #accessToken;
  #csrfToken;
  #cookies = new Map();
  #lastRequestStartedAt = 0;

  constructor({ baseUrl, username = 'cm_admin', password, fetchImpl = globalThis.fetch }) {
    const parsed = new URL(baseUrl);
    if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname) || parsed.username || parsed.password || parsed.search || parsed.hash) fail('SUPERSET_NATIVE_TARGET_DENIED');
    this.#baseUrl = parsed.origin;
    this.#username = username;
    this.#password = password;
    this.#fetch = fetchImpl;
  }

  get baseUrl() { return this.#baseUrl; }

  #captureCookies(response) {
    const values = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);
    for (const value of values) {
      const pair = value.split(';', 1)[0];
      const separator = pair.indexOf('=');
      if (separator > 0) this.#cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }

  #cookieHeader() {
    return [...this.#cookies].map(([key, value]) => `${key}=${value}`).join('; ');
  }

  async #pace() {
    const remaining = 30 - (Date.now() - this.#lastRequestStartedAt);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    this.#lastRequestStartedAt = Date.now();
  }

  async authenticate() {
    const response = await this.#fetch(`${this.#baseUrl}/api/v1/security/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: this.#username, password: this.#password, provider: 'db', refresh: true }),
    });
    this.#captureCookies(response);
    const body = await response.json();
    if (!response.ok || !body.access_token) fail('SUPERSET_NATIVE_AUTH_FAILED');
    this.#accessToken = body.access_token;
    const csrf = await this.request('GET', '/api/v1/security/csrf_token/');
    if (typeof csrf.result !== 'string' || csrf.result.length < 20) fail('SUPERSET_NATIVE_CSRF_FAILED');
    this.#csrfToken = csrf.result;
  }

  async request(method, path, body, { expected = [200], headers = {} } = {}) {
    if (!this.#accessToken && path !== '/api/v1/security/login') fail('SUPERSET_NATIVE_AUTH_REQUIRED');
    await this.#pace();
    const requestHeaders = { authorization: `Bearer ${this.#accessToken}`, accept: 'application/json', ...headers };
    const cookie = this.#cookieHeader();
    if (cookie) requestHeaders.cookie = cookie;
    const init = { method, headers: requestHeaders };
    if (body !== undefined) {
      requestHeaders['content-type'] = 'application/json';
      requestHeaders['x-csrftoken'] = this.#csrfToken;
      init.body = JSON.stringify(body);
    }
    const response = await this.#fetch(`${this.#baseUrl}${path}`, init);
    this.#captureCookies(response);
    const text = await response.text();
    let value = null;
    try { value = text ? JSON.parse(text) : null; } catch { fail('SUPERSET_NATIVE_NON_JSON_RESPONSE'); }
    if (!expected.includes(response.status)) {
      const error = new Error(`SUPERSET_NATIVE_HTTP_${response.status}`);
      error.code = `SUPERSET_NATIVE_HTTP_${response.status}`;
      error.detail = value?.message ?? value?.errors ?? null;
      throw error;
    }
    return value;
  }

  async list(kind) {
    const query = encodeURIComponent('(page:0,page_size:200)');
    return (await this.request('GET', `/api/v1/${kind}/?q=${query}`)).result ?? [];
  }

  getDashboard(idOrSlug) { return this.request('GET', `/api/v1/dashboard/${encodeURIComponent(idOrSlug)}`); }

  async createPermalink(dashboardId, state) {
    return this.request('POST', `/api/v1/dashboard/${dashboardId}/permalink`, serializePermalinkState(state), { expected: [201] });
  }

  readPermalink(key) { return this.request('GET', `/api/v1/dashboard/permalink/${encodeURIComponent(key)}`); }
}

function chartParams(vizType, datasetId, chartType, metricColumn, { truthKey, metricKeys }) {
  const metric = {
    aggregate: 'SUM', column: { ...metricColumn, optionName: '_col_metric_value' }, expressionType: 'SIMPLE',
    hasCustomLabel: true, isNew: false, label: 'Synthetic metric value', optionName: 'metric_m6_02_sum_metric_value', sqlExpression: null,
  };
  const adhocFilters = [{ clause: 'WHERE', comparator: truthKey, expressionType: 'SIMPLE', operator: '==', sqlExpression: null, subject: 'truth_key' }];
  if (metricKeys?.length) adhocFilters.push({ clause: 'WHERE', comparator: metricKeys, expressionType: 'SIMPLE', operator: 'IN', sqlExpression: null, subject: 'metric_key' });
  const common = { datasource: `${datasetId}__table`, viz_type: vizType, adhoc_filters: adhocFilters, row_limit: 1000, time_range: 'No filter' };
  if (chartType === 'big_number') return { ...common, metric, x_axis: 'period_start', subheader: 'Synthetic oracle · stated unit' };
  if (chartType === 'table_conditional') return { ...common, all_columns: TABLE_COLUMNS_BY_TRUTH[truthKey] ?? ['metric_key', 'metric_value', 'entity_key'], order_by_cols: [], page_length: 10, server_pagination: false };
  if (chartType === 'heatmap') return { ...common, x_axis: 'period_start', groupby: 'metric_key', metric, linear_color_scheme: 'blue_white_yellow', normalize_across: 'heatmap_v2', show_legend: true, show_values: true };
  if (chartType === 'treemap') return { ...common, groupby: ['entity_key'], metric, show_legend: true };
  return {
    ...common, x_axis: 'period_start', time_grain_sqla: 'P1D', metrics: [metric], groupby: ['metric_key'],
    show_legend: false, show_markers: true, marker_size: 8, x_axis_time_format: 'smart_date', y_axis_format: 'SMART_NUMBER',
    stack: chartType === 'stacked_bar' ? 'Stack' : null,
  };
}

function dashboardPosition(chartRecords, asset, composition) {
  const chartIds = chartRecords.map((chart) => `CHART-${chart.id}`);
  const layouts = {
    'executive-summary': [[[0, 12, 26]], [[1, 12, 38]], [[2, 12, 38]]],
    'quality-investigation': [[[0, 12, 34]], [[1, 12, 36]], [[2, 12, 32]]],
    'inventory-risk': [[[0, 12, 26]], [[1, 12, 32]], [[2, 12, 36]]],
    'maintenance-reliability': [[[0, 12, 28]], [[1, 12, 44]], [[2, 12, 32]]],
    'cross-domain-comparison': [[[0, 12, 36]], [[1, 12, 36]], [[2, 12, 36]]],
    'quality-investigation-compact': [[[0, 12, 34]], [[1, 12, 34]]],
    'executive-summary-reversible': [[[0, 12, 28]], [[1, 12, 34]]],
    'executive-preview-denial': [[[0, 12, 34]], [[1, 12, 32]]],
  };
  const rows = layouts[composition.layoutId];
  if (!rows || rows.flat().length !== chartIds.length) fail('SUPERSET_NATIVE_LAYOUT_INVALID');
  const rowIds = rows.map((_row, index) => `ROW-${asset.key.toUpperCase()}-${index + 1}`);
  const position = {
    DASHBOARD_VERSION_KEY: 'v2',
    ROOT_ID: { type: 'ROOT', id: 'ROOT_ID', children: ['GRID_ID'] },
    GRID_ID: { type: 'GRID', id: 'GRID_ID', children: ['HEADER', ...rowIds] },
    HEADER: { type: 'HEADER', id: 'HEADER', children: [], meta: { text: `${asset.title} · ${MANAGED_BY}` } },
  };
  rows.forEach((row, rowIndex) => {
    position[rowIds[rowIndex]] = {
      type: 'ROW', id: rowIds[rowIndex], children: row.map(([chartIndex]) => chartIds[chartIndex]),
      meta: { background: 'BACKGROUND_TRANSPARENT' },
    };
    row.forEach(([chartIndex, width, height]) => {
      const chartId = chartIds[chartIndex];
      position[chartId] = { type: 'CHART', id: chartId, children: [], meta: { width, height, chartId: chartRecords[chartIndex].id } };
    });
  });
  return position;
}

function nativeFilterConfiguration(datasetUuid) {
  const filters = Object.keys(allowedFilterValues).map((key) => ({
    id: nativeFilterId(key),
    controlValues: { enableEmptyFilter: false, defaultToFirstItem: false, multiSelect: false, searchAllOptions: false, inverseSelection: false },
    name: key.replace('_', ' '),
    filterType: 'filter_select',
    targets: [{ column: { name: key }, datasetUuid }],
    defaultDataMask: { extraFormData: {}, filterState: {} },
    cascadeParentIds: [],
    scope: { rootPath: ['ROOT_ID'], excluded: [] },
    type: 'NATIVE_FILTER',
  }));
  filters.push({
    id: nativeFilterId('time_range'), controlValues: {}, name: 'time range', filterType: 'filter_time', targets: [{}],
    defaultDataMask: { extraFormData: {}, filterState: {} }, cascadeParentIds: [], scope: { rootPath: ['ROOT_ID'], excluded: [] }, type: 'NATIVE_FILTER',
  });
  return filters;
}

export async function provisionNativeAssets(client) {
  const databases = await client.list('database');
  const database = databases.find((item) => item.database_name === 'ChimpMaera BI managed projection');
  if (!database || database.allow_dml === true || database.expose_in_sqllab === true) fail('SUPERSET_NATIVE_DATABASE_BOUNDARY_INVALID');
  await client.request('PUT', `/api/v1/database/${database.id}`, {
    uuid: NATIVE_ASSETS.databaseUuid,
    database_name: 'ChimpMaera BI managed projection', expose_in_sqllab: false, allow_file_upload: false,
    allow_ctas: false, allow_cvas: false, allow_dml: false, external_url: `urn:chimpmaera:${MANAGED_BY}:database`,
  });

  const datasets = await client.list('dataset');
  let dataset = datasets.find((item) => item.uuid === NATIVE_ASSETS.datasetUuid);
  if (!dataset) {
    const created = await client.request('POST', '/api/v1/dataset/', {
      database: database.id, table_name: NATIVE_ASSETS.datasetTable, uuid: NATIVE_ASSETS.datasetUuid,
      external_url: `urn:chimpmaera:${MANAGED_BY}:dataset`, normalize_columns: false, always_filter_main_dttm: false,
    }, { expected: [201] });
    dataset = { id: created.id, uuid: NATIVE_ASSETS.datasetUuid };
  }
  await client.request('PUT', `/api/v1/dataset/${dataset.id}`, {
    table_name: NATIVE_ASSETS.datasetTable, database_id: database.id, uuid: NATIVE_ASSETS.datasetUuid,
    description: `Synthetic 12-row oracle projection · managed_by=${MANAGED_BY} · no customer data`,
    main_dttm_col: 'period_start', is_sqllab_view: false, external_url: `urn:chimpmaera:${MANAGED_BY}:dataset`,
  });
  await client.request('PUT', `/api/v1/dataset/${dataset.id}/refresh`, {});
  const datasetReadback = (await client.request('GET', `/api/v1/dataset/${dataset.id}`)).result;
  const metricColumn = datasetReadback?.columns?.find((column) => column.column_name === 'metric_value');
  if (!metricColumn || metricColumn.is_dttm === true) fail('SUPERSET_NATIVE_METRIC_COLUMN_READBACK_MISMATCH');

  const existingDashboards = await client.list('dashboard');
  const dashboardRecords = {};
  for (const asset of Object.values(NATIVE_ASSETS.dashboards)) {
    let record = existingDashboards.find((item) => item.uuid === asset.uuid);
    if (!record) {
      const created = await client.request('POST', '/api/v1/dashboard/', {
        dashboard_title: asset.title, slug: asset.slug, uuid: asset.uuid, published: true, css: RESPONSIVE_DASHBOARD_CSS,
        position_json: JSON.stringify({}), json_metadata: JSON.stringify({ native_filter_configuration: [] }),
        certified_by: MANAGED_BY, certification_details: `Synthetic local evidence; managed_by=${MANAGED_BY}`,
      }, { expected: [201] });
      record = { id: created.id, uuid: asset.uuid, slug: asset.slug };
    }
    dashboardRecords[asset.key] = { ...record, ...asset };
  }

  const existingCharts = await client.list('chart');
  const chartRecordsByDashboard = {};
  let dashboardIndex = 0;
  for (const asset of Object.values(NATIVE_ASSETS.dashboards)) {
    dashboardIndex += 1;
    const composition = compositionFor(Object.entries(NATIVE_ASSETS.scenarioDashboard).find(([, key]) => key === asset.key)?.[0]);
    const records = [];
    for (let index = 0; index < composition.chartTypes.length; index += 1) {
      const chartType = composition.chartTypes[index];
      const chartUuid = stableChartUuid(dashboardIndex, index + 1);
      const title = CHART_TITLES[asset.key][index];
      const payload = {
        slice_name: title, description: `Domain-appropriate ${chartType}; managed_by=${MANAGED_BY}`,
        viz_type: CHART_TYPE_TO_SUPERSET[chartType], datasource_id: dataset.id, datasource_type: 'table',
        dashboards: [dashboardRecords[asset.key].id], uuid: chartUuid,
        params: JSON.stringify(chartParams(CHART_TYPE_TO_SUPERSET[chartType], dataset.id, chartType, metricColumn, {
          truthKey: TRUTH_KEY_BY_ASSET[asset.key], metricKeys: CHART_SCOPES[asset.key][index],
        })),
        certified_by: MANAGED_BY, certification_details: composition.rationale,
        external_url: `urn:chimpmaera:${MANAGED_BY}:chart:${asset.key}:${index + 1}`,
      };
      let record = existingCharts.find((item) => item.uuid === chartUuid);
      if (!record) {
        const created = await client.request('POST', '/api/v1/chart/', payload, { expected: [201] });
        record = { id: created.id, uuid: chartUuid };
      } else {
        await client.request('PUT', `/api/v1/chart/${record.id}`, payload);
      }
      records.push({ ...record, chartType, vizType: CHART_TYPE_TO_SUPERSET[chartType], title });
    }
    chartRecordsByDashboard[asset.key] = records;
    const metadata = {
      native_filter_configuration: nativeFilterConfiguration(NATIVE_ASSETS.datasetUuid),
      timed_refresh_immune_slices: [],
    };
    await client.request('PUT', `/api/v1/dashboard/${dashboardRecords[asset.key].id}`, {
      dashboard_title: asset.title, slug: asset.slug, uuid: asset.uuid, published: true, css: RESPONSIVE_DASHBOARD_CSS,
      position_json: JSON.stringify(dashboardPosition(records, asset, composition)), json_metadata: JSON.stringify(metadata),
      certified_by: MANAGED_BY, certification_details: `Synthetic local evidence; managed_by=${MANAGED_BY}`,
    });
  }

  const independent = { databases: await client.list('database'), datasets: await client.list('dataset'), charts: await client.list('chart'), dashboards: await client.list('dashboard') };
  const managed = {
    database: independent.databases.filter((item) => item.uuid === NATIVE_ASSETS.databaseUuid),
    datasets: independent.datasets.filter((item) => item.uuid === NATIVE_ASSETS.datasetUuid),
    charts: independent.charts.filter((item) => Object.values(chartRecordsByDashboard).flat().some((chart) => chart.uuid === item.uuid)),
    dashboards: independent.dashboards.filter((item) => Object.values(NATIVE_ASSETS.dashboards).some((asset) => asset.uuid === item.uuid)),
  };
  const expectedCharts = Object.values(chartRecordsByDashboard).flat().length;
  const expectedDashboards = Object.keys(NATIVE_ASSETS.dashboards).length;
  if (managed.database.length !== 1 || managed.datasets.length !== 1 || managed.charts.length !== expectedCharts || managed.dashboards.length !== expectedDashboards) fail('SUPERSET_NATIVE_ASSET_READBACK_MISMATCH');
  return {
    status: 'PROVISIONED_IDEMPOTENT_PUBLIC_REST', managedBy: MANAGED_BY, dataset: { ...dataset, uuid: NATIVE_ASSETS.datasetUuid },
    dashboardRecords, chartRecordsByDashboard,
    counts: { databases: 1, datasets: 1, charts: expectedCharts, dashboards: expectedDashboards },
    assetReadback: {
      database: managed.database.map(({ id, uuid: value, database_name: name }) => ({ id, uuid: value, name })),
      datasets: managed.datasets.map(({ id, uuid: value, table_name: tableName }) => ({ id, uuid: value, tableName })),
      charts: managed.charts.map(({ id, uuid: value, slice_name: title, viz_type: vizType }) => ({ id, uuid: value, title, vizType })),
      dashboards: managed.dashboards.map(({ id, uuid: value, slug, dashboard_title: title }) => ({ id, uuid: value, slug, title })),
    },
    independentReadbackDigest: sha256Digest(managed),
  };
}

export class NativeSupersetStateAdapter {
  #client;
  #dashboard;
  #state;
  #permalinkKey;
  #idempotency = new Map();
  #undo = new Map();
  #httpMutations = 0;

  constructor({ client, dashboardRecord }) {
    this.#client = client;
    this.#dashboard = clone(dashboardRecord);
    this.#state = { ...clone(INITIAL_STATE), cancelled: false };
  }

  read() { return clone(this.#state); }
  get httpMutations() { return this.#httpMutations; }
  get permalinkKey() { return this.#permalinkKey; }

  async initialize() {
    const created = await this.#client.createPermalink(this.#dashboard.id, this.#state);
    this.#httpMutations += 1;
    this.#permalinkKey = created.key;
    const readback = await this.readback();
    if (!same(readback.state, this.#state)) fail('SUPERSET_NATIVE_INITIAL_READBACK_MISMATCH');
    return readback;
  }

  async readback() {
    const permalink = await this.#client.readPermalink(this.#permalinkKey);
    const dashboard = await this.#client.getDashboard(this.#dashboard.slug);
    if (dashboard.result?.uuid !== this.#dashboard.uuid || dashboard.result?.slug !== this.#dashboard.slug) fail('SUPERSET_NATIVE_DASHBOARD_READBACK_MISMATCH');
    if (![String(this.#dashboard.id), this.#dashboard.uuid].includes(String(permalink.dashboardId))) fail('SUPERSET_NATIVE_PERMALINK_DASHBOARD_MISMATCH');
    const state = publicState(permalink.state);
    return {
      schemaVersion: NATIVE_READBACK_VERSION, mode: 'public_rest_permalink_data_mask_v1',
      dashboard: { id: dashboard.result.id, uuid: dashboard.result.uuid, slug: dashboard.result.slug, title: dashboard.result.dashboard_title },
      permalinkKey: this.#permalinkKey, state, rawPermalinkStateDigest: sha256Digest(permalink.state),
      dashboardStillUsable: true, independentGetCount: 2,
    };
  }

  async attempt(request) {
    try { return await this.apply(request); }
    catch (error) { return receipt(request, 'denied', this.#state, { denialReason: error.code ?? 'UI_ACTION_DENIED' }); }
  }

  async apply(request) {
    const prior = this.#idempotency.get(request?.idempotencyKey);
    if (prior) {
      if (prior.requestDigest !== sha256Digest(request)) fail('UI_ACTION_IDEMPOTENCY_MISMATCH');
      return { ...clone(prior), status: 'already_applied' };
    }
    assertRequest(request, this.#state, this.#dashboard);
    if (FAIL_CLOSED_NATIVE_ACTIONS.includes(request.action)) fail('SUPERSET_PUBLIC_ACTION_UNSUPPORTED');
    if (!SUPPORTED_NATIVE_ACTIONS.includes(request.action)) fail('ARBITRARY_ACTION_DENIED');
    const before = clone(this.#state);
    const next = applySupportedState(before, request);
    let result;
    if (request.action === 'explain_current_view') {
      const readback = await this.readback();
      result = receipt(request, 'applied', this.#state, { requestDigest: sha256Digest(request), nativeReadbackDigest: sha256Digest(readback), sideEffect: 'none' });
    } else {
      const created = await this.#client.createPermalink(this.#dashboard.id, next);
      this.#httpMutations += 1;
      this.#permalinkKey = created.key;
      this.#state = next;
      const readback = await this.readback();
      if (!same(readback.state, this.#state)) fail('SUPERSET_NATIVE_APPLY_READBACK_MISMATCH');
      const undoToken = sha256Digest({ actionId: request.actionId, before, permalinkKey: this.#permalinkKey });
      this.#undo.set(undoToken, before);
      result = receipt(request, 'applied', this.#state, {
        previousStateVersion: before.version, requestDigest: sha256Digest(request), undoToken,
        sideEffect: 'reversible_native_permalink_state', nativeReadbackDigest: sha256Digest(readback),
      });
    }
    this.#idempotency.set(request.idempotencyKey, clone(result));
    return result;
  }

  async undo(undoToken, expectedStateVersion) {
    if (expectedStateVersion !== this.#state.version) fail('DASHBOARD_STATE_STALE');
    const before = this.#undo.get(undoToken);
    if (!before) fail('UI_UNDO_TOKEN_INVALID');
    const restored = { ...clone(before), version: this.#state.version + 1 };
    const created = await this.#client.createPermalink(this.#dashboard.id, restored);
    this.#httpMutations += 1;
    this.#permalinkKey = created.key;
    this.#undo.delete(undoToken);
    this.#state = restored;
    const readback = await this.readback();
    if (!same(readback.state, this.#state)) fail('SUPERSET_NATIVE_UNDO_READBACK_MISMATCH');
    return { status: 'undone', stateVersion: this.#state.version, persistentSupersetMutation: false, nativeReadbackDigest: sha256Digest(readback) };
  }

  async cancel() {
    if (this.#state.cancelled) return { status: 'already_cancelled', stateVersion: this.#state.version, persistentSupersetMutation: false };
    const next = { ...clone(this.#state), version: this.#state.version + 1, cancelled: true };
    const created = await this.#client.createPermalink(this.#dashboard.id, next);
    this.#httpMutations += 1;
    this.#permalinkKey = created.key;
    this.#state = next;
    const readback = await this.readback();
    if (!same(readback.state, this.#state)) fail('SUPERSET_NATIVE_CANCEL_READBACK_MISMATCH');
    return { status: 'cancelled', stateVersion: this.#state.version, persistentSupersetMutation: false, nativeReadbackDigest: sha256Digest(readback) };
  }
}

function denial(request, state, reason) {
  return receipt(request, 'denied', state, { denialReason: reason });
}

export async function runNativeGoldenSuite({ client, provisioned, runId }) {
  const startedAt = new Date().toISOString();
  const { oracle, suite } = await loadVisualScenarioFixtures();
  const scenarios = [];
  for (const scenario of suite.scenarios) {
    const assetKey = NATIVE_ASSETS.scenarioDashboard[scenario.id];
    const dashboardRecord = provisioned.dashboardRecords[assetKey];
    const adapter = new NativeSupersetStateAdapter({ client, dashboardRecord });
    await adapter.initialize();
    const trace = [];
    let priorRequest = null;
    let priorReceipt = null;
    for (let index = 0; index < scenario.actions.length; index += 1) {
      const [action, args] = scenario.actions[index];
      if (action === 'repeat_previous') {
        const beforeMutations = adapter.httpMutations;
        const current = await adapter.attempt(priorRequest);
        trace.push({ sequence: index + 1, provenance: 'superset_public_rest_v1', contract: priorRequest.schemaVersion, request: clone(priorRequest), receipt: current, idempotencyHttpMutationDelta: adapter.httpMutations - beforeMutations });
        continue;
      }
      if (action === 'undo_previous') {
        const current = await adapter.undo(priorReceipt.undoToken, adapter.read().version);
        trace.push({ sequence: index + 1, provenance: 'superset_public_rest_v1', contract: 'undo-bound-receipt', request: { action: 'undo', undoToken: priorReceipt.undoToken }, receipt: current });
        continue;
      }
      const request = {
        schemaVersion: 'chimpmaera.bi/ui-action/v1', actionId: `${runId}-${scenario.id}-${String(index + 1).padStart(2, '0')}`,
        action, args: clone(args), stateVersion: adapter.read().version,
        idempotencyKey: `${runId}-${scenario.id}-idem-${String(index + 1).padStart(2, '0')}`,
        preconditions: { dashboardUuid: dashboardRecord.uuid, dashboardSlug: dashboardRecord.slug },
      };
      const current = await adapter.attempt(request);
      trace.push({ sequence: index + 1, provenance: 'superset_public_rest_v1', contract: request.schemaVersion, request, receipt: current });
      if (current.status === 'applied') { priorRequest = request; priorReceipt = current; }
    }
    let cancelReceipt = null;
    let actionsAfterCancel = null;
    if (scenario.id === 'voice-correction-cancel') {
      cancelReceipt = await adapter.cancel();
      const beforeMutations = adapter.httpMutations;
      const deniedAfterCancel = await adapter.attempt({
        schemaVersion: 'chimpmaera.bi/ui-action/v1', actionId: `${runId}-${scenario.id}-post-cancel`, action: 'set_filter',
        args: { key: 'plant', value: 'Werk 2' }, stateVersion: adapter.read().version,
        idempotencyKey: `${runId}-${scenario.id}-post-cancel`, preconditions: { dashboardUuid: dashboardRecord.uuid, dashboardSlug: dashboardRecord.slug },
      });
      actionsAfterCancel = adapter.httpMutations - beforeMutations;
      trace.push({ sequence: trace.length + 1, provenance: 'superset_public_rest_v1', contract: 'interaction.cancelled', request: { action: 'post_cancel_probe' }, receipt: deniedAfterCancel });
    }
    if (scenario.persistentRequest) {
      const request = { action: 'save_dashboard', actionId: `${runId}-${scenario.id}-persistent`, idempotencyKey: `${runId}-${scenario.id}-persistent` };
      trace.push({ sequence: trace.length + 1, provenance: 'superset_public_rest_v1', contract: 'persistent-asset-revision-proposal/v1', request, receipt: denial(request, adapter.read(), 'TRUSTED_UI_APPROVAL_REQUIRED') });
    }
    const actualState = adapter.read();
    const readback = await adapter.readback();
    const expectedState = clone(INITIAL_STATE);
    for (const [action, args] of scenario.actions) {
      if (action === 'repeat_previous') continue;
      if (action === 'undo_previous') {
        Object.assign(expectedState, clone(INITIAL_STATE), { version: actualState.version });
        continue;
      }
      if (SUPPORTED_NATIVE_ACTIONS.includes(action)) Object.assign(expectedState, applySupportedState(expectedState, { action, args }));
    }
    if (scenario.id === 'voice-correction-cancel') Object.assign(expectedState, { version: actualState.version, cancelled: true });
    else expectedState.cancelled = false;
    const composition = compositionFor(scenario.id);
    const unsupportedDenials = trace.filter((item) => FAIL_CLOSED_NATIVE_ACTIONS.includes(item.request?.action)).every((item) => item.receipt.status === 'denied' && item.receipt.denialReason === 'SUPERSET_PUBLIC_ACTION_UNSUPPORTED');
    scenarios.push({
      scenarioId: scenario.id, dashboard: readback.dashboard, expectedState, actualState, trace, cancelReceipt,
      nativeSupersetReadback: readback,
      mutationCounts: { nativeSessionStateWrites: adapter.httpMutations, persistentDashboardWrites: 0 },
      viewSignature: composition.viewSignature, chartTypes: composition.chartTypes, layoutId: composition.layoutId, rationale: composition.rationale,
      oracle: { truthKey: scenario.oracleTruth, values: clone(oracle.truths[scenario.oracleTruth]), digest: sha256Digest(oracle.truths[scenario.oracleTruth]) },
      denialCount: trace.filter((item) => item.receipt.status === 'denied').length,
      unsupportedActionDenialCount: trace.filter((item) => FAIL_CLOSED_NATIVE_ACTIONS.includes(item.request?.action) && item.receipt.status === 'denied').length,
      verdict: {
        exactStateMatch: same(actualState, expectedState), unsupportedActionsFailClosed: unsupportedDenials,
        idempotencyWithoutSecondHttpMutation: scenario.id !== 'undo-idempotency' || trace.find((item) => item.request?.action === 'set_filter' && item.receipt.status === 'already_applied')?.idempotencyHttpMutationDelta === 0,
        undoReadback: scenario.id !== 'undo-idempotency' || actualState.filters.product === undefined,
        actionsAfterCancel, persistentSupersetMutation: false,
        nativeReadback: readback.mode === 'public_rest_permalink_data_mask_v1' && readback.dashboardStillUsable,
      },
    });
  }
  const allPassed = scenarios.every((scenario) => Object.entries(scenario.verdict).every(([key, value]) => key === 'actionsAfterCancel' ? value === null || value === 0 : value === true || value === false && key === 'persistentSupersetMutation'));
  return { runId, startedAt, completedAt: new Date().toISOString(), scenarios, allPassed, digest: sha256Digest(scenarios) };
}

export async function clientFromEnvironment() {
  const passwordPath = process.env.SUPERSET_ADMIN_PASSWORD_FILE ?? '.runtime/secrets/superset_admin_password';
  const password = (await readFile(passwordPath, 'utf8')).trim();
  if (!password) fail('SUPERSET_NATIVE_PASSWORD_MISSING');
  const client = new SupersetPublicApiClient({ baseUrl: process.env.SUPERSET_URL ?? 'http://127.0.0.1:28088', password });
  await client.authenticate();
  return client;
}
