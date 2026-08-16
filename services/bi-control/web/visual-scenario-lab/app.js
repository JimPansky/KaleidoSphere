const elements = Object.fromEntries([
  'scenario-list', 'scenario-count', 'active-filters', 'active-time', 'undo-button', 'transcript-content',
  'action-trace', 'state-version', 'expected-state', 'actual-state', 'run-verdict', 'scenario-id',
  'mutation-count', 'conclusion-card', 'oracle-conclusion', 'live-status',
  'composition-meta', 'visual-composition', 'view-title',
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

const chartCopy = {
  big_number: ['Headline KPI', '12.48M', 'EUR · Q2 2026'],
  time_series: ['Time series', 'Q2 operational trend', 'Apr', 'May', 'Jun'],
  grouped_bar: ['Grouped comparison', 'Requested segments', 'Atlas', 'Futura', 'Other'],
  stacked_bar: ['Demand vs supply', 'Units by week', 'W1', 'W2', 'W3'],
  table_conditional: ['Conditional table', 'Ranked exceptions', 'Rotor-7', 'SB-X17', 'Press-04'],
  scatter: ['Correlation', 'Volume vs rate', 'Production volume →', 'Defect rate ↑'],
  heatmap: ['Event heatmap', 'Concentration by day', 'Mon', 'Wed', 'Fri'],
  treemap: ['Treemap preview', 'Contribution share', 'Atlas', 'Nova', 'Terra'],
};

const renderChart = (type, index) => {
  const copy = chartCopy[type];
  const article = add(elements['visual-composition'], 'article', undefined, `viz-card viz-${type}`);
  article.dataset.chartType = type;
  article.tabIndex = 0;
  article.setAttribute('aria-label', `${copy[0]}: ${copy[1]}. Units and legend are visible.`);
  const header = add(article, 'header');
  const titles = add(header, 'div');
  add(titles, 'span', copy[0], 'chart-kicker');
  add(titles, 'h3', copy[1]);
  add(header, 'span', type.replace('_', ' '), 'chart-type-pill');
  const visual = add(article, 'div', undefined, `viz-plot plot-${type}`);
  visual.setAttribute('role', 'img');
  visual.setAttribute('aria-label', `${copy[1]}; ${copy.slice(2).join(', ')}`);
  if (type === 'big_number') {
    add(visual, 'strong', index === 0 ? '12.48M' : '68 h');
    add(visual, 'span', copy[2]);
  } else if (type === 'table_conditional') {
    copy.slice(2).forEach((label, row) => { const line = add(visual, 'div', undefined, `table-line severity-${row}`); add(line, 'span', label); add(line, 'strong', ['2.4 d', '8.6%', '41.5 h'][row]); });
  } else if (type === 'scatter') {
    add(visual, 'span', copy[3], 'axis-y'); add(visual, 'span', copy[2], 'axis-x');
    [18, 37, 55, 72, 84].forEach((left, point) => { const dot = add(visual, 'i'); dot.style.left = `${left}%`; dot.style.bottom = `${[23, 31, 44, 65, 78][point]}%`; });
  } else if (type === 'heatmap') {
    for (let cell = 0; cell < 21; cell += 1) { const block = add(visual, 'i'); block.style.opacity = String(.18 + ((cell * 7) % 9) / 12); }
    add(visual, 'span', 'Events · count', 'unit-label');
  } else if (type === 'treemap') {
    copy.slice(2).forEach((label, cell) => add(visual, 'div', label, `tree-cell tree-${cell}`));
  } else {
    copy.slice(2).forEach((label, bar) => { const group = add(visual, 'div', undefined, 'series-group'); add(group, 'i', undefined, 'series-primary').style.height = `${45 + bar * 18}%`; if (type.includes('bar')) add(group, 'i', undefined, 'series-secondary').style.height = `${30 + bar * 13}%`; add(group, 'span', label); });
    add(visual, 'small', type === 'time_series' ? 'Value · indexed or stated unit' : 'Units · synthetic oracle', 'unit-label');
  }
  const legend = add(article, 'div', undefined, 'chart-legend');
  add(legend, 'span', '● Primary');
  if (type !== 'big_number' && type !== 'table_conditional') add(legend, 'span', '● Comparison');
};

const renderComposition = (result) => {
  const view = result.viewComposition;
  elements['view-title'].textContent = view.title;
  elements['composition-meta'].replaceChildren();
  add(elements['composition-meta'], 'span', view.layoutId, 'layout-pill');
  add(elements['composition-meta'], 'span', 'Session-only preview', 'preview-pill');
  add(elements['composition-meta'], 'p', view.rationale);
  elements['visual-composition'].replaceChildren();
  elements['visual-composition'].dataset.layoutId = view.layoutId;
  elements['visual-composition'].dataset.viewSignature = view.viewSignature;
  view.chartTypes.forEach(renderChart);
};

const renderResult = (result) => {
  renderComposition(result);
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
  document.querySelectorAll('.viz-card').forEach((card, index) => card.classList.toggle('focused', Boolean(focused) && index === 0));
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
