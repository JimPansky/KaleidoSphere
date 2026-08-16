import { sha256Digest, assertSafeJson } from './core-contracts.mjs';

export const UI_ACTION_VERSION = 'chimpmaera.bi/ui-action/v1';
export const DASHBOARD_CAPABILITY_MANIFEST_VERSION = 'chimpmaera.bi/dashboard-capability-manifest/v1';
export const UI_ACTIONS = Object.freeze([
  'set_filter', 'clear_filter', 'set_time_range', 'focus_chart', 'open_drilldown',
  'compare_segments', 'select_tab', 'sort_table', 'toggle_series', 'explain_current_view',
]);
export const VOICE_EVENT_TYPES = Object.freeze([
  'transcript.partial', 'transcript.final', 'assistant.delta', 'assistant.final',
  'ui_action.proposed', 'ui_action.applied', 'ui_action.denied',
  'interaction.interrupted', 'interaction.cancelled',
]);
const fail = (code) => { const error = new Error(code); error.code = code; throw error; };

export function assertDashboardCapabilityManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== DASHBOARD_CAPABILITY_MANIFEST_VERSION || !manifest.dashboardId || !Number.isSafeInteger(manifest.stateVersion) || manifest.stateVersion < 1) fail('DASHBOARD_MANIFEST_INVALID');
  if (!Array.isArray(manifest.allowedActions) || manifest.allowedActions.some((action) => !UI_ACTIONS.includes(action))) fail('DASHBOARD_CAPABILITY_UNSAFE');
  if (!manifest.resources || ['chartIds', 'filterKeys', 'tabIds', 'seriesIds', 'dimensions', 'segmentIds', 'tableColumns'].some((key) => !Array.isArray(manifest.resources[key]))) fail('DASHBOARD_RESOURCES_INVALID');
  if (manifest.persistentMutationAllowed !== false || manifest.directDomControl !== false) fail('DASHBOARD_MUTATION_BOUNDARY_INVALID');
  return manifest;
}

export function assertVoiceStreamEvent(event) {
  if (!event || event.schemaVersion !== 'chimpmaera.bi/voice-stream-event/v1' || !VOICE_EVENT_TYPES.includes(event.eventType)) fail('VOICE_EVENT_INVALID');
  if (typeof event.language !== 'string' || event.language.length < 2 || typeof event.confidence !== 'number' || event.confidence < 0 || event.confidence > 1) fail('VOICE_METADATA_INVALID');
  assertSafeJson(event.payload);
  return event;
}

export function createPersonalSavedViewRequest({ requestId, dashboardId, stateVersion, name }) {
  return Object.freeze({ schemaVersion: 'chimpmaera.bi/personal-saved-view-request/v1', requestId, dashboardId, stateVersion, name, scope: 'personal', status: 'request_only', persistentSupersetMutation: false });
}

export function createPersistentAssetRevisionProposal({ proposalId, dashboardId, baseRevision, diff, approvalChannel }) {
  assertSafeJson(diff);
  if (approvalChannel === 'voice') fail('VOICE_ONLY_PERSISTENT_APPROVAL_DENIED');
  return Object.freeze({
    schemaVersion: 'chimpmaera.bi/persistent-asset-revision-proposal/v1', proposalId, dashboardId, baseRevision,
    diff, status: 'proposal_only', requirements: ['preview_diff', 'trusted_ui_approval', 'bi_control_apply', 'readback', 'rollback'],
    applied: false,
  });
}

export class InMemoryDashboardStateAdapter {
  #manifest;
  #state;
  #idempotency = new Map();
  #undo = new Map();

  constructor(manifest, state = {}) {
    assertDashboardCapabilityManifest(manifest);
    this.#manifest = structuredClone(manifest);
    this.#state = { version: manifest.stateVersion, filters: {}, timeRange: null, focusedChartId: null, drilldown: null, segments: [], tab: null, tableSort: null, hiddenSeries: [], ...structuredClone(state) };
  }

  read() { return structuredClone(this.#state); }

  apply(request) {
    if (!request || request.schemaVersion !== UI_ACTION_VERSION || !request.actionId || !request.idempotencyKey) fail('UI_ACTION_INVALID');
    if (!UI_ACTIONS.includes(request.action) || !this.#manifest.allowedActions.includes(request.action)) fail('UI_ACTION_UNSAFE');
    assertSafeJson(request.args ?? {});
    if (request.preconditions?.dashboardId && request.preconditions.dashboardId !== this.#manifest.dashboardId) fail('UI_ACTION_PRECONDITION_FAILED');
    const priorReceipt = this.#idempotency.get(request.idempotencyKey);
    if (priorReceipt) {
      if (priorReceipt.requestDigest !== sha256Digest(request)) fail('UI_ACTION_IDEMPOTENCY_MISMATCH');
      return { ...structuredClone(priorReceipt), status: 'already_applied' };
    }
    if (request.stateVersion !== this.#state.version) fail('DASHBOARD_STATE_STALE');
    const before = structuredClone(this.#state);
    const args = request.args ?? {};
    const allowed = (kind, value) => typeof value === 'string' && this.#manifest.resources[kind].includes(value);
    switch (request.action) {
      case 'set_filter': if (!allowed('filterKeys', args.key)) fail('UI_ACTION_RESOURCE_DENIED'); this.#state.filters[args.key] = args.value; break;
      case 'clear_filter': if (!allowed('filterKeys', args.key)) fail('UI_ACTION_RESOURCE_DENIED'); delete this.#state.filters[args.key]; break;
      case 'set_time_range': if (Number.isNaN(Date.parse(args.from)) || Number.isNaN(Date.parse(args.to)) || Date.parse(args.from) > Date.parse(args.to)) fail('UI_ACTION_ARGUMENT_INVALID'); this.#state.timeRange = { from: args.from, to: args.to }; break;
      case 'focus_chart': if (!allowed('chartIds', args.chartId)) fail('UI_ACTION_RESOURCE_DENIED'); this.#state.focusedChartId = args.chartId; break;
      case 'open_drilldown': if (!allowed('chartIds', args.chartId) || !allowed('dimensions', args.dimension)) fail('UI_ACTION_RESOURCE_DENIED'); this.#state.drilldown = { chartId: args.chartId, dimension: args.dimension }; break;
      case 'compare_segments': if (!Array.isArray(args.segments) || args.segments.length < 2 || args.segments.length > 10 || args.segments.some((item) => !allowed('segmentIds', item))) fail('UI_ACTION_RESOURCE_DENIED'); this.#state.segments = [...args.segments]; break;
      case 'select_tab': if (!allowed('tabIds', args.tabId)) fail('UI_ACTION_RESOURCE_DENIED'); this.#state.tab = args.tabId; break;
      case 'sort_table': if (!allowed('chartIds', args.chartId) || !allowed('tableColumns', args.column) || !['asc', 'desc'].includes(args.direction)) fail('UI_ACTION_RESOURCE_DENIED'); this.#state.tableSort = { chartId: args.chartId, column: args.column, direction: args.direction }; break;
      case 'toggle_series': {
        if (!allowed('seriesIds', args.series)) fail('UI_ACTION_RESOURCE_DENIED');
        const set = new Set(this.#state.hiddenSeries); set.has(args.series) ? set.delete(args.series) : set.add(args.series); this.#state.hiddenSeries = [...set].sort(); break;
      }
      case 'explain_current_view': break;
      default: fail('UI_ACTION_UNSAFE');
    }
    const mutated = request.action !== 'explain_current_view';
    if (mutated) this.#state.version += 1;
    const undoToken = mutated ? sha256Digest({ actionId: request.actionId, before }) : null;
    if (undoToken) this.#undo.set(undoToken, before);
    const receipt = Object.freeze({
      schemaVersion: 'chimpmaera.bi/ui-action-receipt/v1', actionId: request.actionId, action: request.action,
      status: 'applied', previousStateVersion: before.version, stateVersion: this.#state.version,
      idempotencyKey: request.idempotencyKey, requestDigest: sha256Digest(request), undoToken,
      sideEffect: mutated ? 'reversible_session' : 'none', persistentSupersetMutation: false,
    });
    this.#idempotency.set(request.idempotencyKey, receipt);
    return structuredClone(receipt);
  }

  attempt(request) {
    try { return this.apply(request); }
    catch (error) {
      return {
        schemaVersion: 'chimpmaera.bi/ui-action-receipt/v1', actionId: request?.actionId ?? null,
        action: request?.action ?? null, status: 'denied', denialReason: error.code ?? 'UI_ACTION_DENIED',
        stateVersion: this.#state.version, idempotencyKey: request?.idempotencyKey ?? null,
        undoToken: null, sideEffect: 'none', persistentSupersetMutation: false,
      };
    }
  }

  undo(undoToken, expectedStateVersion) {
    if (expectedStateVersion !== this.#state.version) fail('DASHBOARD_STATE_STALE');
    const before = this.#undo.get(undoToken);
    if (!before) fail('UI_UNDO_TOKEN_INVALID');
    this.#undo.delete(undoToken);
    this.#state = { ...structuredClone(before), version: this.#state.version + 1 };
    return { status: 'undone', stateVersion: this.#state.version, persistentSupersetMutation: false };
  }
}
