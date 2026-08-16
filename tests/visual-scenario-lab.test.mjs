import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INITIAL_STATE,
  SCENARIO_MANIFEST,
  loadVisualScenarioFixtures,
  runGoldenSuite,
  runNegativeProbes,
  runScenario,
} from '../services/bi-control/src/visual-scenario-lab/scenario-engine.mjs';
import {
  loadPortableSeed, renderPortableSeed, semanticSeedProjection,
} from '../services/bi-control/src/visual-scenario-lab/seed-portability.mjs';
import {
  evaluateVisualDiversity, VISUAL_DIVERSITY_RUBRIC, VIEW_COMPOSITIONS,
} from '../services/bi-control/src/visual-scenario-lab/view-compositions.mjs';
import {
  MANAGED_BY, NativeSupersetStateAdapter, SupersetPublicApiClient,
} from '../services/bi-control/src/visual-scenario-lab/native-superset-bridge.mjs';

test('M6-01 oracle is deterministic, synthetic, practical, and engine-neutral', async () => {
  const { oracle, suite } = await loadVisualScenarioFixtures();
  assert.equal(oracle.synthetic, true);
  assert.match(oracle.company, /synthetic/i);
  assert.deepEqual(oracle.portableEngines, ['mssql', 'oracle']);
  assert.equal(suite.rubricDefinedBeforeImplementation, true);
  assert.equal(suite.scenarios.length, 8);
  assert.equal(new Set(suite.scenarios.map((item) => item.id)).size, 8);
  const seed = await loadPortableSeed();
  assert.equal(seed.rows.length, 12);
  const semantic = semanticSeedProjection(seed);
  assert.equal(semantic.find((row) => row.metricKey === 'revenue_eur').metricValue, 12480000);
  for (const engine of ['mssql', 'oracle', 'sqlite']) {
    const sql = renderPortableSeed(seed, engine);
    assert.match(sql, /CREATE TABLE scenario_oracle/);
    assert.equal((sql.match(/INSERT INTO scenario_oracle/g) ?? []).length, 12);
    assert.doesNotMatch(sql, /@|MERGE|IDENTITY|NVARCHAR|GO\s*$/m);
  }
  assert.match(renderPortableSeed(seed, 'oracle'), /DATE '2026-04-01'/);
  assert.doesNotMatch(renderPortableSeed(seed, 'mssql'), /DATE '2026-04-01'/);
});

test('M6-01 portable seed executes as a real isolated sample database', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const seed = await loadPortableSeed();
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(renderPortableSeed(seed, 'sqlite'));
    const count = database.prepare('SELECT COUNT(*) AS count FROM scenario_oracle').get();
    assert.equal(count.count, 12);
    const stockout = database.prepare("SELECT metric_key, metric_value FROM scenario_oracle WHERE truth_key = 'inventory_risk' ORDER BY metric_key").all().map((row) => ({ ...row }));
    assert.deepEqual(stockout, [
      { metric_key: 'confirmed_supply_units', metric_value: 900 },
      { metric_key: 'coverage_days', metric_value: 2.4 },
      { metric_key: 'demand_units', metric_value: 4200 },
    ]);
  } finally {
    database.close();
  }
});

test('M6-01 manifest permits only frozen ui-action/v1 session actions', () => {
  assert.equal(SCENARIO_MANIFEST.persistentMutationAllowed, false);
  assert.equal(SCENARIO_MANIFEST.directDomControl, false);
  assert.deepEqual(SCENARIO_MANIFEST.allowedActions, [
    'set_filter', 'clear_filter', 'set_time_range', 'focus_chart', 'open_drilldown',
    'compare_segments', 'select_tab', 'sort_table', 'toggle_series', 'explain_current_view',
  ]);
});

test('M6-01 all eight golden scenarios reach exact expected state and oracle truth', async () => {
  const results = await runGoldenSuite();
  assert.equal(results.length, 8);
  for (const result of results) {
    assert.deepEqual(result.actualState, result.expectedState, result.scenario.id);
    assert.equal(result.verdict.exactStateMatch, true, result.scenario.id);
    assert.equal(result.verdict.oracleMatch, true, result.scenario.id);
    assert.equal(result.verdict.unauthorizedPersistentMutations, 0, result.scenario.id);
    assert.equal(result.verdict.directDomOrJsActions, 0, result.scenario.id);
    assert.ok(result.oracle.conclusion.length > 30, result.scenario.id);
    assert.equal(result.nativeSupersetReadback.mode, 'faithful_embedded_shell');
    assert.equal(result.viewComposition.selectionMode, 'session_only_preview');
    assert.equal(result.viewComposition.persistentMutation, false);
    assert.equal(result.viewComposition.trustedUiApprovalRequiredForPersistence, true);
  }
});

test('M6-02 visual diversity rubric requires five domain layouts and six meaningful chart types', async () => {
  const results = await runGoldenSuite();
  const entries = results.map((result) => ({ scenarioId: result.scenario.id, ...result.viewComposition }));
  const verdict = evaluateVisualDiversity(entries);
  assert.equal(VISUAL_DIVERSITY_RUBRIC.minimumDistinctLayoutFamilies, 5);
  assert.equal(VISUAL_DIVERSITY_RUBRIC.minimumDistinctChartTypes, 6);
  assert.equal(verdict.distinctLayoutFamilies, 5);
  assert.ok(verdict.distinctChartTypes >= 6);
  assert.ok(verdict.rationaleCoverage >= 0.8);
  assert.equal(verdict.misleadingChartTypeCount, 0);
  assert.ok(verdict.maximumDomainSignatureReuse < 3);
  assert.equal(verdict.passed, true);
});

test('M6-02 every scenario exposes complete composition evidence and readable-unit rationale', () => {
  assert.equal(Object.keys(VIEW_COMPOSITIONS).length, 8);
  for (const [scenarioId, composition] of Object.entries(VIEW_COMPOSITIONS)) {
    assert.ok(composition.viewSignature.includes('|'), scenarioId);
    assert.ok(composition.chartTypes.length >= 2, scenarioId);
    assert.ok(composition.layoutId.length > 5, scenarioId);
    assert.ok(composition.rationale.length >= 40, scenarioId);
  }
  assert.deepEqual(VISUAL_DIVERSITY_RUBRIC.requiredEvidenceFields, ['viewSignature', 'chartTypes', 'layoutId', 'rationale']);
});

test('M6-02 diversity gate rejects misleading or repeated domain compositions', () => {
  const invalid = VISUAL_DIVERSITY_RUBRIC.domainScenarioIds.map((scenarioId) => ({
    scenarioId,
    layoutId: 'same-layout',
    viewSignature: 'same-signature',
    chartTypes: ['pie'],
    rationale: 'A deliberately invalid rationale long enough to isolate the structural diversity failures.',
    misleadingChartTypes: ['pie_for_time_series'],
  }));
  const verdict = evaluateVisualDiversity(invalid);
  assert.equal(verdict.passed, false);
  assert.equal(verdict.distinctLayoutFamilies, 1);
  assert.equal(verdict.maximumDomainSignatureReuse, 5);
  assert.equal(verdict.misleadingChartTypeCount, 5);
});

test('M6-02 native client accepts only credential-free loopback targets', () => {
  assert.doesNotThrow(() => new SupersetPublicApiClient({ baseUrl: 'http://127.0.0.1:28088', password: 'local-test-only' }));
  assert.throws(() => new SupersetPublicApiClient({ baseUrl: 'https://superset.example', password: 'local-test-only' }), /SUPERSET_NATIVE_TARGET_DENIED/);
  assert.throws(() => new SupersetPublicApiClient({ baseUrl: 'http://user:secret@127.0.0.1:28088', password: 'local-test-only' }), /SUPERSET_NATIVE_TARGET_DENIED/);
});

test('M6-02 native permalink adapter reads back supported effects and fails closed without fake mutation', async () => {
  const values = new Map();
  let sequence = 0;
  const dashboard = { id: 7, uuid: 'c6020000-0000-4000-8000-000000000101', slug: 'm6-02-executive-summary' };
  const fakeClient = {
    async createPermalink(_dashboardId, state) {
      const key = `key-${sequence += 1}`;
      const dataMask = {};
      for (const [filterKey, value] of Object.entries(state.filters)) {
        const id = `NATIVE_FILTER-M6_02_${filterKey.toUpperCase()}`;
        dataMask[id] = { id, extraFormData: { filters: [{ col: filterKey, op: 'IN', val: [value] }] }, filterState: { value: [value], label: value } };
      }
      values.set(key, { dashboardId: dashboard.uuid, state: { dataMask, urlParams: [['cm_managed_by', MANAGED_BY], ['cm_state_version', String(state.version)], ['cm_cancelled', String(state.cancelled === true)]] } });
      return { key };
    },
    async readPermalink(key) { return structuredClone(values.get(key)); },
    async getDashboard() { return { result: { ...dashboard, dashboard_title: 'M6-02 Executive Summary' } }; },
  };
  const adapter = new NativeSupersetStateAdapter({ client: fakeClient, dashboardRecord: dashboard });
  await adapter.initialize();
  const request = {
    schemaVersion: 'chimpmaera.bi/ui-action/v1', actionId: 'native-supported-1', action: 'set_filter',
    args: { key: 'plant', value: 'Werk 3' }, stateVersion: 1, idempotencyKey: 'native-supported-idem-1',
    preconditions: { dashboardUuid: dashboard.uuid, dashboardSlug: dashboard.slug },
  };
  const applied = await adapter.apply(request);
  assert.equal(applied.status, 'applied');
  assert.equal((await adapter.readback()).state.filters.plant, 'Werk 3');
  const writesAfterApply = adapter.httpMutations;
  assert.equal((await adapter.apply(request)).status, 'already_applied');
  assert.equal(adapter.httpMutations, writesAfterApply);
  const unsupported = await adapter.attempt({ ...request, actionId: 'native-unsupported-1', action: 'focus_chart', stateVersion: 2, idempotencyKey: 'native-unsupported-idem-1' });
  assert.equal(unsupported.denialReason, 'SUPERSET_PUBLIC_ACTION_UNSUPPORTED');
  assert.equal(adapter.httpMutations, writesAfterApply);
  await adapter.undo(applied.undoToken, 2);
  assert.deepEqual((await adapter.readback()).state.filters, {});
});

test('M6-01 executive scenario selects the exact last completed quarter and comparison', async () => {
  const result = await runScenario('executive-sales');
  assert.deepEqual(result.actualState.timeRange, { from: '2026-04-01', to: '2026-06-30' });
  assert.equal(result.actualState.tab, 'executive');
  assert.equal(result.actualState.focusedChartId, 'sales-margin');
  assert.deepEqual(result.actualState.segments, ['Atlas Drive', 'Futura Retail']);
  assert.equal(result.oracle.values.revenueEur, 12480000);
  assert.equal(result.oracle.values.grossMarginPct, 31.4);
});

test('M6-01 quality finding exposes the root signal without causal overclaim', async () => {
  const result = await runScenario('quality-investigation');
  assert.deepEqual(result.actualState.filters, { plant: 'Werk 3', line: 'Linie C' });
  assert.equal(result.oracle.values.defectRatePct, 8.6);
  assert.equal(result.oracle.values.productionUnits, 18200);
  assert.equal(result.oracle.values.supplierBatch, 'SB-X17');
  assert.match(result.oracle.conclusion, /causation is not established/i);
});

test('M6-01 inventory, maintenance, and cross-domain numeric truths are exact', async () => {
  const inventory = await runScenario('inventory-risk');
  assert.equal(inventory.oracle.values.coverageDays, 2.4);
  assert.equal(inventory.actualState.tableSort.direction, 'asc');
  assert.deepEqual(inventory.actualState.segments, ['demand', 'confirmed_supply']);
  const maintenance = await runScenario('maintenance');
  assert.equal(maintenance.oracle.values.downtimeHours, 41.5);
  assert.equal(maintenance.oracle.values.mtbfHours, 68);
  assert.equal(maintenance.oracle.values.eventCount, 6);
  const cross = await runScenario('cross-domain');
  assert.equal(cross.oracle.values.demandChangePct, 24);
  assert.equal(cross.oracle.values.productionChangePct, 9);
  assert.match(cross.oracle.conclusion, /correlation, not proof of causation/i);
});

test('M6-01 voice correction and cancel leave only corrected intent with no post-cancel action', async () => {
  const result = await runScenario('voice-correction-cancel');
  assert.deepEqual(result.actualState.filters, { plant: 'Werk 3' });
  assert.equal(result.normalizedActionTrace.length, 1);
  assert.equal(result.verdict.actionsAfterCancel, 0);
  assert.deepEqual(result.transcriptEvents, [
    'transcript.partial:Werk 2', 'interaction.interrupted', 'transcript.final:Werk 3',
    'ui_action.applied:set_filter', 'interaction.cancelled',
  ]);
});

test('M6-01 duplicate action is idempotent and undo restores exact prior content', async () => {
  const result = await runScenario('undo-idempotency');
  assert.equal(result.normalizedActionTrace[0].receipt.status, 'applied');
  assert.equal(result.normalizedActionTrace[1].receipt.status, 'already_applied');
  assert.equal(result.normalizedActionTrace[2].receipt.status, 'undone');
  assert.deepEqual({ ...result.actualState, version: INITIAL_STATE.version }, INITIAL_STATE);
  assert.equal(result.actualState.version, 3);
});

test('M6-01 persistent request is preview-only and never mutates Superset state', async () => {
  const result = await runScenario('persistent-request-denied');
  assert.deepEqual(result.actualState, INITIAL_STATE);
  assert.equal(result.proposal.status, 'proposal_only');
  assert.equal(result.proposal.applied, false);
  assert.deepEqual(result.proposal.requirements, ['preview_diff', 'trusted_ui_approval', 'bi_control_apply', 'readback', 'rollback']);
  assert.equal(result.normalizedActionTrace[0].receipt.denialReason, 'TRUSTED_UI_APPROVAL_REQUIRED');
});

test('M6-01 ambiguity, unknown values, stale state, conflicts, SQL, and free DOM/JS fail closed', async () => {
  const probes = await runNegativeProbes();
  assert.deepEqual(probes.map((probe) => probe.id), [
    'ambiguous-plant', 'unknown-filter-value', 'stale-state-version', 'conflicting-action', 'arbitrary-sql', 'free-dom-js',
  ]);
  assert.ok(probes.every((probe) => probe.passed));
  assert.deepEqual(probes.map((probe) => probe.receipt.denialReason), [
    'AMBIGUOUS_FILTER_VALUE', 'UNKNOWN_FILTER_VALUE', 'DASHBOARD_STATE_STALE', 'CONFLICTING_ACTIONS', 'ARBITRARY_ACTION_DENIED', 'DIRECT_DOM_CONTROL_DENIED',
  ]);
  assert.ok(probes.every((probe) => probe.receipt.persistentSupersetMutation === false));
});
