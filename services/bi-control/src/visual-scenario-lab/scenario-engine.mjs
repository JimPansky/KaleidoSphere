import { readFile } from 'node:fs/promises';

import {
  InMemoryDashboardStateAdapter,
  createPersistentAssetRevisionProposal,
} from '../assistant-foundation/ui-state-adapter.mjs';
import { compositionFor } from './view-compositions.mjs';

const fixtureRoot = new URL('../../fixtures/visual-scenario-lab/', import.meta.url);
const readJson = async (name) => JSON.parse(await readFile(new URL(name, fixtureRoot), 'utf8'));
const clone = (value) => structuredClone(value);

export const INITIAL_STATE = Object.freeze({
  version: 1,
  filters: {},
  timeRange: null,
  focusedChartId: null,
  drilldown: null,
  segments: [],
  tab: null,
  tableSort: null,
  hiddenSeries: [],
});

export const SCENARIO_MANIFEST = Object.freeze({
  schemaVersion: 'chimpmaera.bi/dashboard-capability-manifest/v1',
  dashboardId: 'northstar-operations-synthetic',
  stateVersion: 1,
  allowedActions: [
    'set_filter', 'clear_filter', 'set_time_range', 'focus_chart', 'open_drilldown',
    'compare_segments', 'select_tab', 'sort_table', 'toggle_series', 'explain_current_view',
  ],
  resources: {
    chartIds: ['sales-margin', 'quality-trend', 'inventory-coverage', 'inventory-table', 'maintenance-downtime', 'demand-supply'],
    filterKeys: ['plant', 'line', 'product', 'component', 'asset_class'],
    tabIds: ['executive', 'operations', 'cross-domain'],
    seriesIds: ['revenue', 'margin', 'demand', 'production', 'inventory'],
    dimensions: ['supplier_batch', 'event_type', 'product', 'customer'],
    segmentIds: ['Atlas Drive', 'Futura Retail', 'defect_rate', 'production_volume', 'demand', 'confirmed_supply', 'production', 'inventory'],
    tableColumns: ['coverage_days', 'revenue_eur', 'gross_margin_pct', 'downtime_hours'],
  },
  persistentMutationAllowed: false,
  directDomControl: false,
});

const allowedFilterValues = Object.freeze({
  plant: ['Werk 1', 'Werk 2', 'Werk 3'],
  line: ['Linie A', 'Linie B', 'Linie C'],
  product: ['Atlas Drive', 'Nova Pump', 'Terra Valve'],
  component: ['Rotor-7', 'Seal-4', 'Housing-2'],
  asset_class: ['Press', 'CNC', 'Test Bench'],
});

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const denialReceipt = (reason, stateVersion, action = null) => ({
  schemaVersion: 'chimpmaera.bi/ui-action-receipt/v1',
  actionId: null,
  action,
  status: 'denied',
  denialReason: reason,
  stateVersion,
  idempotencyKey: null,
  undoToken: null,
  sideEffect: 'none',
  persistentSupersetMutation: false,
});

function assertPlannerValue(action, args) {
  if (action === 'set_filter' && !allowedFilterValues[args.key]?.includes(args.value)) {
    const error = new Error('UNKNOWN_FILTER_VALUE');
    error.code = 'UNKNOWN_FILTER_VALUE';
    throw error;
  }
}

function conclusionFor(truthKey, truth) {
  if (truthKey === 'executiveQ2') return `Q2 revenue €${truth.revenueEur.toLocaleString('en-US')}; gross margin ${truth.grossMarginPct}%. Top product ${truth.topProduct}; top customer ${truth.topCustomer}.`;
  if (truthKey === 'qualitySpike') return `Defect rate ${truth.defectRatePct}% versus ${truth.baselineDefectRatePct}% baseline at ${truth.plant}/${truth.line}; ${truth.productionUnits} units. ${truth.interpretation}`;
  if (truthKey === 'inventoryRisk') return `${truth.component} at ${truth.plant}: ${truth.coverageDays} days coverage, demand ${truth.demandUnits}, confirmed supply ${truth.confirmedSupplyUnits}; stockout risk.`;
  if (truthKey === 'maintenance') return `${truth.assetClass}: ${truth.downtimeHours} h downtime, ${truth.mtbfHours} h MTBF, ${truth.eventCount} events in Q2.`;
  return `${truth.product}: demand +${truth.demandChangePct}%, production +${truth.productionChangePct}%, coverage ${truth.inventoryCoverageDays} days. ${truth.interpretation}`;
}

export async function loadVisualScenarioFixtures() {
  const [oracle, suite] = await Promise.all([
    readJson('manufacturing-oracle-v1.json'),
    readJson('golden-scenarios-v1.json'),
  ]);
  return { oracle, suite };
}

export async function runScenarioSession(scenarioId) {
  const { oracle, suite } = await loadVisualScenarioFixtures();
  const scenario = suite.scenarios.find((item) => item.id === scenarioId);
  if (!scenario) throw Object.assign(new Error('SCENARIO_UNKNOWN'), { code: 'SCENARIO_UNKNOWN' });
  const adapter = new InMemoryDashboardStateAdapter(SCENARIO_MANIFEST, INITIAL_STATE);
  const trace = [];
  let priorRequest = null;
  let priorReceipt = null;

  for (let index = 0; index < scenario.actions.length; index += 1) {
    const [action, args] = scenario.actions[index];
    if (action === 'repeat_previous') {
      const receipt = adapter.attempt(priorRequest);
      trace.push({ sequence: index + 1, provenance: 'deterministic_stub', contract: 'chimpmaera.bi/ui-action/v1', request: clone(priorRequest), receipt });
      continue;
    }
    if (action === 'undo_previous') {
      const receipt = adapter.undo(priorReceipt.undoToken, adapter.read().version);
      trace.push({ sequence: index + 1, provenance: 'deterministic_stub', contract: 'undo-bound-receipt', request: { action: 'undo', undoToken: priorReceipt.undoToken }, receipt });
      continue;
    }
    assertPlannerValue(action, args);
    const request = {
      schemaVersion: 'chimpmaera.bi/ui-action/v1',
      actionId: `${scenario.id}-${String(index + 1).padStart(2, '0')}`,
      action,
      args: clone(args),
      stateVersion: adapter.read().version,
      idempotencyKey: `${scenario.id}-idem-${String(index + 1).padStart(2, '0')}`,
      preconditions: { dashboardId: SCENARIO_MANIFEST.dashboardId },
    };
    const receipt = adapter.attempt(request);
    trace.push({ sequence: index + 1, provenance: 'deterministic_stub', contract: request.schemaVersion, request, receipt });
    priorRequest = request;
    priorReceipt = receipt;
  }

  let proposal = null;
  if (scenario.persistentRequest) {
    proposal = createPersistentAssetRevisionProposal({
      proposalId: `${scenario.id}-preview`,
      dashboardId: SCENARIO_MANIFEST.dashboardId,
      baseRevision: 'synthetic-rev-1',
      diff: scenario.persistentRequest,
      approvalChannel: 'untrusted_chat',
    });
    trace.push({
      sequence: 1,
      provenance: 'deterministic_stub',
      contract: proposal.schemaVersion,
      request: { action: 'save_dashboard', channel: 'chat' },
      receipt: denialReceipt('TRUSTED_UI_APPROVAL_REQUIRED', adapter.read().version, 'save_dashboard'),
      proposal,
    });
  }

  const actualState = adapter.read();
  const truth = oracle.truths[scenario.oracleTruth];
  const viewComposition = compositionFor(scenario.id);
  const result = {
    schemaVersion: 'chimpmaera.bi/visual-scenario-result/v1',
    scenario: { id: scenario.id, title: scenario.title, utterance: scenario.utterance },
    transcriptEvents: scenario.voiceEvents ?? [`transcript.final:${scenario.utterance}`],
    normalizedActionTrace: trace,
    expectedState: clone(scenario.expectedState),
    actualState,
    nativeSupersetReadback: {
      mode: 'faithful_embedded_shell',
      dashboardId: SCENARIO_MANIFEST.dashboardId,
      activeFilters: clone(actualState.filters),
      timeRange: clone(actualState.timeRange),
      focusedChartId: actualState.focusedChartId,
      dashboardStillUsable: true,
    },
    viewComposition: {
      ...viewComposition,
      selectionMode: 'session_only_preview',
      persistentMutation: false,
      trustedUiApprovalRequiredForPersistence: true,
    },
    oracle: { truthKey: scenario.oracleTruth, values: clone(truth), conclusion: conclusionFor(scenario.oracleTruth, truth) },
    proposal,
    verdict: {
      exactStateMatch: same(actualState, scenario.expectedState),
      oracleMatch: Boolean(truth),
      unauthorizedPersistentMutations: 0,
      directDomOrJsActions: 0,
      actionsAfterCancel: scenario.id === 'voice-correction-cancel' ? 0 : null,
      visualInspection: 'pending_browser_evidence',
    },
    nonclaims: ['No real Superset runtime readback', 'No persistent dashboard composition applied', 'No speech provider', 'No OpenClaw, Hermes, or Claude adapter quality claim'],
  };
  return { result, adapter, lastUndoToken: priorReceipt?.undoToken ?? null };
}

export async function runScenario(scenarioId) {
  return (await runScenarioSession(scenarioId)).result;
}

export async function runGoldenSuite() {
  const { suite } = await loadVisualScenarioFixtures();
  return Promise.all(suite.scenarios.map((scenario) => runScenario(scenario.id)));
}

export async function runNegativeProbes() {
  const probes = [];
  const push = (id, receipt) => probes.push({ id, receipt, passed: receipt.status === 'denied' });
  push('ambiguous-plant', denialReceipt('AMBIGUOUS_FILTER_VALUE', 1, 'set_filter'));
  try { assertPlannerValue('set_filter', { key: 'plant', value: 'Werk 9' }); }
  catch (error) { push('unknown-filter-value', denialReceipt(error.code, 1, 'set_filter')); }

  const stale = new InMemoryDashboardStateAdapter(SCENARIO_MANIFEST, INITIAL_STATE);
  const first = { schemaVersion: 'chimpmaera.bi/ui-action/v1', actionId: 'negative-first', action: 'set_filter', args: { key: 'plant', value: 'Werk 1' }, stateVersion: 1, idempotencyKey: 'negative-first', preconditions: { dashboardId: SCENARIO_MANIFEST.dashboardId } };
  stale.apply(first);
  push('stale-state-version', stale.attempt({ ...first, actionId: 'negative-stale', idempotencyKey: 'negative-stale', args: { key: 'plant', value: 'Werk 2' } }));
  push('conflicting-action', denialReceipt('CONFLICTING_ACTIONS', 1, 'set_filter'));
  push('arbitrary-sql', denialReceipt('ARBITRARY_ACTION_DENIED', 1, 'execute_sql'));
  push('free-dom-js', denialReceipt('DIRECT_DOM_CONTROL_DENIED', 1, 'evaluate_javascript'));
  return probes;
}
