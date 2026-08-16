const freeze = (value) => Object.freeze(value);

export const VIEW_COMPOSITIONS = freeze({
  'executive-sales': freeze({
    layoutId: 'executive-summary',
    viewSignature: 'executive-summary|kpi-strip+trend-wide+ranked-bars',
    chartTypes: ['big_number', 'time_series', 'grouped_bar'],
    rationale: 'The big number answers the headline revenue question, while the time-series and bar encodings show the same completed-period revenue in complementary temporal and magnitude views without mixing units.',
    title: 'Executive Q2 summary',
  }),
  'quality-investigation': freeze({
    layoutId: 'quality-investigation',
    viewSignature: 'quality-investigation|trend-wide+scatter+conditional-table',
    chartTypes: ['time_series', 'scatter', 'table_conditional'],
    rationale: 'The trend and scatter make the isolated defect-rate signal visible without implying causation, while the evidence table exposes the paired production row and supplier batch in exact synthetic values.',
    title: 'Quality signal investigation',
  }),
  'inventory-risk': freeze({
    layoutId: 'inventory-risk',
    viewSignature: 'inventory-risk|risk-kpi+conditional-table+stacked-bars',
    chartTypes: ['big_number', 'table_conditional', 'stacked_bar'],
    rationale: 'Coverage is the urgent scalar, the conditionally formatted table ranks constrained components, and stacked bars compare demand with confirmed inbound supply in shared units.',
    title: 'Inventory stockout risk',
  }),
  maintenance: freeze({
    layoutId: 'maintenance-reliability',
    viewSignature: 'maintenance-reliability|reliability-kpis+heatmap+event-trend',
    chartTypes: ['big_number', 'heatmap', 'time_series'],
    rationale: 'Downtime and MTBF are reliability KPIs, the heatmap reveals event concentration by asset and day, and the event trend preserves the requested Q2 timing.',
    title: 'Maintenance reliability',
  }),
  'cross-domain': freeze({
    layoutId: 'cross-domain-comparison',
    viewSignature: 'cross-domain-comparison|indexed-trend+grouped-bars+correlation',
    chartTypes: ['time_series', 'grouped_bar', 'scatter'],
    rationale: 'The trend, grouped bars, and point view compare demand and production changes in the same percentage unit, while the annotation explicitly treats the relationship as association rather than causation.',
    title: 'Demand, production & inventory',
  }),
  'voice-correction-cancel': freeze({
    layoutId: 'quality-investigation-compact',
    viewSignature: 'quality-investigation-compact|trend+heatmap+voice-state',
    chartTypes: ['time_series', 'heatmap'],
    rationale: 'The corrected plant intent uses a compact quality base view; trend and heatmap remain useful while the voice-state receipt is the primary interaction evidence.',
    title: 'Corrected quality view',
  }),
  'undo-idempotency': freeze({
    layoutId: 'executive-summary-reversible',
    viewSignature: 'executive-summary-reversible|kpis+ranked-bars+undo-state',
    chartTypes: ['big_number', 'grouped_bar'],
    rationale: 'The reversible product filter is shown on a compact executive basis where KPI and rank changes are legible before and after undo.',
    title: 'Reversible executive view',
  }),
  'persistent-request-denied': freeze({
    layoutId: 'executive-preview-denial',
    viewSignature: 'executive-preview-denial|treemap+preview-diff+denial-state',
    chartTypes: ['treemap', 'table_conditional'],
    rationale: 'A session-only treemap previews the proposed composition and a conditional diff table makes the denied persistent change reviewable without applying it.',
    title: 'Session-only composition preview',
  }),
});

export const VISUAL_DIVERSITY_RUBRIC = freeze({
  schemaVersion: 'chimpmaera.bi/visual-diversity-rubric/v1',
  minimumDistinctLayoutFamilies: 5,
  minimumDistinctChartTypes: 6,
  minimumRationaleCoverage: 0.8,
  maximumMisleadingChartTypes: 0,
  maximumSharedSignatureAcrossDomainScenarios: 2,
  domainScenarioIds: ['executive-sales', 'quality-investigation', 'inventory-risk', 'maintenance', 'cross-domain'],
  requiredEvidenceFields: ['viewSignature', 'chartTypes', 'layoutId', 'rationale'],
  responsiveRequirement: 'desktop_and_narrow_independently_usable_with_reflow_not_scale_only',
});

export function compositionFor(scenarioId) {
  const composition = VIEW_COMPOSITIONS[scenarioId];
  if (!composition) throw Object.assign(new Error('VIEW_COMPOSITION_UNKNOWN'), { code: 'VIEW_COMPOSITION_UNKNOWN' });
  return structuredClone(composition);
}

export function evaluateVisualDiversity(entries) {
  const domainEntries = entries.filter((entry) => VISUAL_DIVERSITY_RUBRIC.domainScenarioIds.includes(entry.scenarioId));
  const signatureCounts = Object.fromEntries([...new Set(domainEntries.map((entry) => entry.viewSignature))].map((signature) => [signature, domainEntries.filter((entry) => entry.viewSignature === signature).length]));
  const layoutFamilies = new Set(domainEntries.map((entry) => entry.layoutId));
  const chartTypes = new Set(entries.flatMap((entry) => entry.chartTypes));
  const rationaleCoverage = domainEntries.filter((entry) => typeof entry.rationale === 'string' && entry.rationale.length >= 40).length / domainEntries.length;
  const misleadingChartTypes = entries.flatMap((entry) => entry.misleadingChartTypes ?? []);
  const verdict = {
    distinctLayoutFamilies: layoutFamilies.size,
    distinctChartTypes: chartTypes.size,
    rationaleCoverage,
    misleadingChartTypeCount: misleadingChartTypes.length,
    maximumDomainSignatureReuse: Math.max(...Object.values(signatureCounts), 0),
  };
  verdict.passed = verdict.distinctLayoutFamilies >= VISUAL_DIVERSITY_RUBRIC.minimumDistinctLayoutFamilies
    && verdict.distinctChartTypes >= VISUAL_DIVERSITY_RUBRIC.minimumDistinctChartTypes
    && verdict.rationaleCoverage >= VISUAL_DIVERSITY_RUBRIC.minimumRationaleCoverage
    && verdict.misleadingChartTypeCount === VISUAL_DIVERSITY_RUBRIC.maximumMisleadingChartTypes
    && verdict.maximumDomainSignatureReuse <= VISUAL_DIVERSITY_RUBRIC.maximumSharedSignatureAcrossDomainScenarios;
  return verdict;
}
