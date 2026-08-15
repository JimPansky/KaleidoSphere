import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const fail = (code, details) => { const error = new Error(code); error.code = code; error.details = details; throw error; };
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quote = (identifier) => `"${String(identifier).replaceAll('"', '""')}"`;
const safeName = (value) => typeof value === 'string' && value.length <= 128 && !/[\0\r\n]/.test(value);
const typeFamily = (declared) => /INT|REAL|FLOA|DOUB|NUM|DEC/.test(declared.toUpperCase()) ? 'numeric'
  : /DATE|TIME/.test(declared.toUpperCase()) ? 'temporal' : /CHAR|CLOB|TEXT/.test(declared.toUpperCase()) ? 'text' : 'other';
const median = (values) => values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : null;
const quantile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)] : null;

export const DISCOVERY_CONTRACT_VERSION = 'chimpmaera.bi/progressive-discovery/v1';

class QueryBudget {
  constructor({ maxQueries, maxRowsPerQuery, maxDurationMs }) {
    this.maxQueries = maxQueries;
    this.maxRowsPerQuery = maxRowsPerQuery;
    this.deadline = Date.now() + maxDurationMs;
    this.queries = 0;
    this.rowsObserved = 0;
    this.receipts = [];
  }

  run(db, sql, params = [], purpose = 'bounded-read') {
    if (Date.now() > this.deadline) fail('DISCOVERY_TIME_BUDGET_EXCEEDED');
    if (this.queries >= this.maxQueries) fail('DISCOVERY_QUERY_BUDGET_EXCEEDED');
    if (!/^\s*(SELECT|PRAGMA)\b/i.test(sql) || /;\s*\S/.test(sql) || /\b(INSERT|UPDATE|DELETE|DROP|ALTER|ATTACH|DETACH|REPLACE|VACUUM)\b/i.test(sql)) {
      fail('DISCOVERY_READ_ONLY_SQL_REQUIRED');
    }
    const started = Date.now();
    const rows = db.prepare(sql).all(...params);
    if (rows.length > this.maxRowsPerQuery) fail('DISCOVERY_ROW_BUDGET_EXCEEDED');
    this.queries += 1;
    this.rowsObserved += rows.length;
    this.receipts.push({ purpose, sqlDigest: digest(sql), parameterCount: params.length, rows: rows.length, latencyMs: Date.now() - started });
    return rows;
  }
}
function prioritizedTables(inventory, objective) {
  const tokens = String(objective).toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 3);
  return [...inventory].sort((a, b) => {
    const score = (table) => tokens.reduce((sum, token) => sum + (table.name.toLowerCase().includes(token) ? 3 : 0)
      + table.columns.filter((column) => column.name.toLowerCase().includes(token)).length, 0);
    return score(b) - score(a) || a.name.localeCompare(b.name);
  });
}

function profileTable(db, table, budget) {
  const columns = table.columns.slice(0, 32);
  const rows = budget.run(db, `SELECT ${columns.map((column) => quote(column.name)).join(', ')} FROM ${quote(table.name)} LIMIT ${budget.maxRowsPerQuery}`,
    [], `profile:${table.name}`);
  const profiles = columns.map((column) => {
    const values = rows.map((row) => row[column.name]);
    const nonNull = values.filter((value) => value !== null && value !== undefined);
    const numeric = nonNull.filter((value) => typeof value === 'number' && Number.isFinite(value));
    const frequencies = new Map(nonNull.map((value) => [String(value), 0]));
    nonNull.forEach((value) => frequencies.set(String(value), frequencies.get(String(value)) + 1));
    const duplicates = [...frequencies.values()].filter((count) => count > 1).reduce((sum, count) => sum + count - 1, 0);
    return {
      name: column.name,
      declaredType: column.type,
      family: typeFamily(column.type),
      sampled: rows.length,
      nulls: values.length - nonNull.length,
      distinctSampled: frequencies.size,
      duplicateSampled: duplicates,
      numeric: numeric.length ? { min: Math.min(...numeric), max: Math.max(...numeric), median: median(numeric), q1: quantile(numeric, 0.25), q3: quantile(numeric, 0.75) } : null,
    };
  });
  return { table: table.name, sampledRows: rows.length, columns: profiles, sampleBounded: rows.length <= budget.maxRowsPerQuery };
}

function inferAnomalies(profiles) {
  const anomalies = [];
  for (const profile of profiles) for (const column of profile.columns) {
    const citation = `profile:${profile.table}.${column.name}`;
    if (column.nulls > 0) anomalies.push({ type: 'missing_values', table: profile.table, column: column.name, severity: column.nulls / Math.max(1, column.sampled) >= 0.25 ? 'high' : 'medium', evidence: citation });
    if (column.numeric?.min < 0) anomalies.push({ type: 'negative_values', table: profile.table, column: column.name, severity: 'high', evidence: citation });
    if (/(email|code|number|reference|serial)/i.test(column.name) && column.duplicateSampled > 0) anomalies.push({ type: 'duplicate_values', table: profile.table, column: column.name, severity: 'medium', evidence: citation });
    if (column.numeric && column.sampled >= 5) {
      const iqr = column.numeric.q3 - column.numeric.q1;
      if (iqr > 0 && column.numeric.max > column.numeric.q3 + 3 * iqr) anomalies.push({ type: 'extreme_values', table: profile.table, column: column.name, severity: 'medium', evidence: citation });
    }
  }
  return anomalies;
}

function relationshipGraph(db, inventory, budget) {
  const relationships = [];
  for (const table of inventory) {
    const foreignKeys = budget.run(db, `PRAGMA foreign_key_list(${quote(table.name)})`, [], `foreign-keys:${table.name}`);
    for (const fk of foreignKeys) relationships.push({
      kind: 'declared_foreign_key', fromTable: table.name, fromColumn: fk.from, toTable: fk.table, toColumn: fk.to,
      confidence: 1, evidence: `pragma:${table.name}:${fk.id}`,
    });
  }
  const declared = new Set(relationships.map((item) => `${item.fromTable}.${item.fromColumn}->${item.toTable}.${item.toColumn}`));
  for (const left of inventory) for (const column of left.columns) {
    if (!/_id$/.test(column.name.toLowerCase())) continue;
    const stem = column.name.toLowerCase().replace(/_id$/, '').replace(/ies$/, 'y').replace(/s$/, '');
    for (const right of inventory) {
      if (left.name === right.name || !right.columns.some((candidate) => candidate.pk === 1 || candidate.name.toLowerCase() === 'id')) continue;
      const rightStem = right.name.toLowerCase().replace(/ies$/, 'y').replace(/s$/, '');
      const key = `${left.name}.${column.name}->${right.name}.id`;
      if ((stem === rightStem || rightStem.endsWith(stem)) && !declared.has(key)) relationships.push({
        kind: 'inferred_key_name', fromTable: left.name, fromColumn: column.name, toTable: right.name, toColumn: 'id',
        confidence: 0.65, evidence: `name-pattern:${column.name}`,
      });
    }
  }
  return relationships;
}

function targetedRelationshipTests(db, relationships, budget) {
  const tests = [];
  for (const relation of relationships.filter((item) => item.kind === 'declared_foreign_key').slice(0, 12)) {
    const sql = `SELECT 1 AS orphan FROM ${quote(relation.fromTable)} c LEFT JOIN ${quote(relation.toTable)} p ON c.${quote(relation.fromColumn)} = p.${quote(relation.toColumn)} WHERE c.${quote(relation.fromColumn)} IS NOT NULL AND p.${quote(relation.toColumn)} IS NULL LIMIT 1`;
    const rows = budget.run(db, sql, [], `relationship-test:${relation.fromTable}.${relation.fromColumn}`);
    tests.push({ test: 'orphan_probe', relationship: `${relation.fromTable}.${relation.fromColumn}->${relation.toTable}.${relation.toColumn}`, passed: rows.length === 0,
      evidence: budget.receipts.at(-1).sqlDigest });
  }
  return tests;
}

function semanticModel(inventory, profiles) {
  const dimensions = [];
  const measures = [];
  const kpis = [];
  for (const table of inventory) for (const column of table.columns) {
    const family = typeFamily(column.type);
    if (family === 'numeric' && !/(^id$|_id$)/i.test(column.name)) measures.push({ table: table.name, column: column.name, aggregation: 'sum-or-average-after-grain-check' });
    else if (family === 'text' || family === 'temporal') dimensions.push({ table: table.name, column: column.name });
    if (/(amount|revenue|cost|price|total)/i.test(column.name)) kpis.push({ id: `${table.name}.${column.name}.sum`, label: `Total ${column.name}`, expression: `SUM(${column.name})`, validation: 'grain-and-null-check-required' });
    if (/(delay|late|lead_time|duration)/i.test(column.name)) kpis.push({ id: `${table.name}.${column.name}.avg`, label: `Average ${column.name}`, expression: `AVG(${column.name})`, validation: 'unit-grain-and-outlier-check-required' });
  }
  return { dimensions: dimensions.slice(0, 24), measures: measures.slice(0, 24), kpis: kpis.slice(0, 16), confidence: kpis.length ? 0.78 : 0.55 };
}

function visualizationProposal(semantic, anomalies, relationships) {
  const proposals = [];
  if (semantic.kpis.length) proposals.push({ type: 'big_number_with_trend', purpose: 'executive KPI with time context', safeguards: ['unit', 'time-grain', 'comparison-period'] });
  if (relationships.length) proposals.push({ type: 'sankey_or_process_flow', purpose: 'cross-entity/process relationship', safeguards: ['no implied causality', 'bounded categories'] });
  if (anomalies.length) proposals.push({ type: 'ranked_bar_with_evidence_table', purpose: 'quality/anomaly prioritization', safeguards: ['sample-bound label', 'absolute and rate'] });
  proposals.push({ type: 'detail_table', purpose: 'drilldown and evidence readback', safeguards: ['aggregate-first', 'no sensitive raw rows'] });
  return { mode: 'preview-only', proposals, responsive: true, overviewToDrilldown: true, persistentMutation: false };
}

export function discoverDatabase({ databasePath, objective, maxTables = 24, maxRowsPerQuery = 64, maxQueries = 96, maxDurationMs = 5_000 }) {
  if (!safeName(objective) && !(typeof objective === 'string' && objective.length <= 2_000)) fail('OBJECTIVE_INVALID');
  if (/\b(drop|delete|truncate|attach|write|overwrite|exfiltrate|all raw rows)\b/i.test(objective)) fail('OBJECTIVE_CAPABILITY_DENIED');
  const db = new DatabaseSync(databasePath, { readOnly: true });
  const budget = new QueryBudget({ maxQueries, maxRowsPerQuery, maxDurationMs });
  try {
    const tableRows = budget.run(db, `SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT ${Math.min(maxTables, 64)}`, [], 'structural-inventory');
    const inventory = tableRows.map(({ name }) => ({ name, columns: budget.run(db, `PRAGMA table_xinfo(${quote(name)})`, [], `columns:${name}`)
      .map((column) => ({ name: column.name, type: column.type || '', nullable: column.notnull === 0, pk: column.pk })) }));
    const prioritized = prioritizedTables(inventory, objective).slice(0, maxTables);
    const relationships = relationshipGraph(db, prioritized, budget);
    const profiles = prioritized.map((table) => profileTable(db, table, budget));
    const anomalies = inferAnomalies(profiles);
    const targetedTests = targetedRelationshipTests(db, relationships, budget);
    for (const test of targetedTests.filter((item) => !item.passed)) anomalies.push({ type: 'orphan_relationship', relationship: test.relationship, severity: 'high', evidence: test.evidence });
    const semantic = semanticModel(prioritized, profiles);
    const visualization = visualizationProposal(semantic, anomalies, relationships);
    const blindSpots = [];
    if (profiles.some((profile) => profile.sampledRows === maxRowsPerQuery)) blindSpots.push('profiles-are-bounded-samples-not-full-population');
    if (!relationships.some((item) => item.kind === 'declared_foreign_key')) blindSpots.push('no-declared-foreign-keys');
    if (!semantic.kpis.length) blindSpots.push('kpi-semantics-require-user-confirmation');
    return {
      schemaVersion: DISCOVERY_CONTRACT_VERSION,
      objectiveRisk: { objective, risk: 'read-only-local-fixture', deniedCapabilities: ['mutation', 'raw-unbounded-scan', 'external-access'] },
      scopePreflight: { databaseKind: 'sqlite', readOnly: true, maxTables, maxRowsPerQuery, maxQueries, maxDurationMs },
      structuralInventory: prioritized,
      entityProcessRelationshipGraph: relationships,
      prioritizedBoundedProfiling: profiles,
      anomalyQualityCauseHypotheses: {
        anomalies,
        causeHypotheses: anomalies.slice(0, 12).map((item) => ({ hypothesis: `${item.type} may affect KPI trust or process performance`, confidence: 0.45, status: 'requires-targeted-domain-test', evidence: item.evidence })),
      },
      targetedTests,
      evidenceConfidenceBlindSpots: { evidenceReceipts: budget.receipts, confidence: targetedTests.every((test) => test.passed) ? 0.82 : 0.67, blindSpots },
      semanticKpiModel: semantic,
      visualizationProposal: visualization,
      userCorrection: { requiredBeforePersistence: true, questions: ['Confirm KPI grain and units', 'Confirm anomaly business thresholds', 'Select executive or operational emphasis'] },
      trustedApplyReadbackRollback: { state: 'proposal-only', approvalRequired: true, applyPerformed: false, readbackPerformed: false, rollbackAvailable: true },
      budgetUsage: { queries: budget.queries, rowsObserved: budget.rowsObserved, withinBudget: true },
    };
  } finally {
    db.close();
  }
}

export class TrustedSemanticStore {
  #current = null;
  #history = [];

  preview(model) {
    const previewDigest = digest(model);
    return { previewDigest, approvalBinding: `approve:${previewDigest}`, mutationPerformed: false };
  }

  apply({ model, approvalBinding }) {
    const previewDigest = digest(model);
    if (approvalBinding !== `approve:${previewDigest}`) fail('TRUSTED_APPROVAL_BINDING_INVALID');
    this.#history.push(structuredClone(this.#current));
    this.#current = structuredClone(model);
    return { applied: true, previewDigest, readbackDigest: digest(this.#current), idempotent: this.#history.at(-1) && digest(this.#history.at(-1)) === previewDigest };
  }

  readback() { return structuredClone(this.#current); }

  rollback() {
    if (!this.#history.length) fail('ROLLBACK_POINT_MISSING');
    this.#current = this.#history.pop();
    return { rolledBack: true, readbackDigest: digest(this.#current) };
  }
}
