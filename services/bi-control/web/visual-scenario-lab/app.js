const elements = Object.fromEntries([
  'scenario-list', 'scenario-count', 'active-filters', 'active-time', 'undo-button', 'transcript-content',
  'action-trace', 'state-version', 'expected-state', 'actual-state', 'run-verdict', 'scenario-id',
  'mutation-count', 'conclusion-card', 'oracle-conclusion', 'live-status',
].map((id) => [id, document.getElementById(id)]));

let activeSessionId = null;
let activeButton = null;

const add = (parent, tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  parent.append(node);
  return node;
};

const renderFilters = (filters) => {
  elements['active-filters'].replaceChildren();
  const entries = Object.entries(filters);
  if (entries.length === 0) return add(elements['active-filters'], 'span', 'Keine', 'empty-chip');
  entries.forEach(([key, value]) => add(elements['active-filters'], 'span', `${key}: ${value}`, 'filter-chip'));
};

const renderTrace = (trace) => {
  elements['action-trace'].replaceChildren();
  trace.forEach((event) => {
    const item = add(elements['action-trace'], 'li', undefined, `trace-item ${event.receipt.status}`);
    const row = add(item, 'div', undefined, 'trace-row');
    add(row, 'code', event.request.action ?? 'revision_preview');
    add(row, 'span', event.receipt.status.replace('_', ' '), 'receipt-status');
    add(item, 'small', `${event.provenance} · ${event.contract}`);
    if (event.receipt.denialReason) add(item, 'p', event.receipt.denialReason, 'denial-reason');
  });
};

const renderTranscript = (result) => {
  elements['transcript-content'].replaceChildren();
  add(elements['transcript-content'], 'p', result.scenario.utterance, 'user-bubble');
  const events = add(elements['transcript-content'], 'div', undefined, 'stream-events');
  result.transcriptEvents.forEach((event) => add(events, 'span', event));
  add(elements['transcript-content'], 'p', result.oracle.conclusion, 'assistant-bubble');
};

const renderResult = (result) => {
  renderTranscript(result);
  renderTrace(result.normalizedActionTrace);
  renderFilters(result.actualState.filters);
  elements['active-time'].textContent = result.actualState.timeRange ? `${result.actualState.timeRange.from} → ${result.actualState.timeRange.to}` : 'Alle Daten';
  elements['state-version'].textContent = `state v${result.actualState.version}`;
  elements['expected-state'].textContent = JSON.stringify(result.expectedState, null, 2);
  elements['actual-state'].textContent = JSON.stringify(result.actualState, null, 2);
  elements['scenario-id'].textContent = result.scenario.id;
  elements['mutation-count'].textContent = String(result.verdict.unauthorizedPersistentMutations);
  elements['oracle-conclusion'].textContent = result.oracle.conclusion;
  elements['conclusion-card'].hidden = false;
  const passed = result.verdict.exactStateMatch && result.verdict.oracleMatch && result.verdict.unauthorizedPersistentMutations === 0;
  elements['run-verdict'].textContent = passed ? 'Exact match' : 'Mismatch';
  elements['run-verdict'].className = `verdict ${passed ? 'pass' : 'fail'}`;
  elements['undo-button'].disabled = !result.normalizedActionTrace.some((entry) => entry.receipt.undoToken);
  const focused = result.actualState.focusedChartId;
  document.querySelectorAll('.chart-card').forEach((card) => card.classList.toggle('focused', card.id === focused || (focused === 'inventory-coverage' && card.id === 'inventory-table')));
  elements['live-status'].textContent = `${result.scenario.title}: ${passed ? 'exact state match' : 'state mismatch'}`;
};

const runScenario = async (scenario, button) => {
  elements['run-verdict'].textContent = 'Läuft …';
  elements['run-verdict'].className = 'verdict neutral';
  button.setAttribute('aria-busy', 'true');
  try {
    const response = await fetch(`/api/run/${encodeURIComponent(scenario.id)}`, { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.code ?? 'SCENARIO_FAILED');
    activeSessionId = result.sessionId;
    activeButton?.removeAttribute('aria-current');
    activeButton = button;
    activeButton.setAttribute('aria-current', 'true');
    renderResult(result);
  } catch (error) {
    elements['run-verdict'].textContent = 'Fehler';
    elements['run-verdict'].className = 'verdict fail';
    elements['live-status'].textContent = error.message;
  } finally {
    button.removeAttribute('aria-busy');
  }
};

elements['undo-button'].addEventListener('click', async () => {
  if (!activeSessionId) return;
  const response = await fetch(`/api/undo/${encodeURIComponent(activeSessionId)}`, { method: 'POST' });
  const payload = await response.json();
  if (!response.ok) {
    elements['live-status'].textContent = payload.code ?? 'UNDO_FAILED';
    return;
  }
  renderFilters(payload.actualState.filters);
  elements['active-time'].textContent = payload.actualState.timeRange ? `${payload.actualState.timeRange.from} → ${payload.actualState.timeRange.to}` : 'Alle Daten';
  elements['actual-state'].textContent = JSON.stringify(payload.actualState, null, 2);
  elements['state-version'].textContent = `state v${payload.actualState.version}`;
  elements['undo-button'].disabled = true;
  elements['live-status'].textContent = 'Vorheriger Sitzungszustand wiederhergestellt.';
});

const configResponse = await fetch('/api/config');
const config = await configResponse.json();
elements['scenario-count'].textContent = String(config.scenarios.length);
config.scenarios.forEach((scenario, index) => {
  const button = add(elements['scenario-list'], 'button', undefined, 'scenario-button');
  button.type = 'button';
  button.dataset.scenario = scenario.id;
  add(button, 'span', String(index + 1).padStart(2, '0'), 'scenario-number');
  const text = add(button, 'span', undefined, 'scenario-text');
  add(text, 'strong', scenario.title);
  add(text, 'small', scenario.utterance);
  button.addEventListener('click', () => runScenario(scenario, button));
});

document.querySelectorAll('.tool-button').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.tool-button').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
    elements['live-status'].textContent = `${button.textContent} dashboard tab selected.`;
  });
});
