import { createHash } from 'node:crypto';

import { canonicalJson } from './db-analyzer/core.mjs';

export const DISCOVERY_STATE_SCHEMA = 'chimpmaera.bi/discovery-state/v1';
export const DISCOVERY_RESPONSE_SCHEMA = 'chimpmaera.bi/discovery-response/v1';
export const DISCOVERY_EXPORT_SCHEMA = 'chimpmaera.bi/discovery-brief/v1';

const SESSION_ID = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const SAFE_TEXT = /^[\p{L}\p{N}\s.,:;!?()[\]/_+\-'"&%]{1,500}$/u;
const DENIED_TEXT = /\b(?:select|insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|exec(?:ute)?|dbcc|backup|restore|raw\s+sql|sql\s*lab|source\s+code|pl\/sql\s+source|password|credential|secret|api[_ -]?key|ignore\s+(?:all\s+)?previous|system\s+prompt|materiali[sz]e|dashboard|dataset|chart)\b/i;
const FIELD_NAMES = new Set([
  'audienceRole',
  'businessQuestions',
  'confirmedKpiCandidates',
  'dimensions',
  'timeGranularity',
  'filtersSegments',
  'drilldowns',
  'freshnessNeed',
  'accessConfidentiality',
  'openAssumptions',
]);
const TIME_GRANULARITIES = new Set(['snapshot', 'day', 'week', 'month', 'quarter', 'year']);
const ACCESS_CLASSES = new Set(['PUBLIC_INTERNAL', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'UNKNOWN_REVIEW_REQUIRED']);

const fail = (code) => {
  const error = new Error(code);
  error.code = code;
  throw error;
};

const nowIso = () => new Date().toISOString();
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const compareText = (left, right) => Buffer.compare(Buffer.from(String(left ?? ''), 'utf8'), Buffer.from(String(right ?? ''), 'utf8'));
const safeString = (value, code = 'DISCOVERY_TEXT_DENIED') => {
  if (typeof value !== 'string') fail(code);
  const trimmed = value.trim();
  if (!SAFE_TEXT.test(trimmed) || DENIED_TEXT.test(trimmed)) fail(code);
  return trimmed;
};

function exact(value, allowed, required = allowed, code = 'DISCOVERY_REQUEST_SURFACE_DENIED') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))) fail(code);
  return value;
}

function rows(db, sql, params = []) {
  return db.prepare(sql).all(...params);
}

function latest(db) {
  const snapshot = (() => {
    try { return db.prepare('SELECT * FROM catalog_snapshots WHERE active=1 ORDER BY analyzed_at DESC LIMIT 1').get(); }
    catch { return null; }
  })();
  if (!snapshot) fail('DISCOVERY_CATALOG_MISSING');
  return snapshot;
}

export function initializeDiscovery(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS discovery_sessions (
      session_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      state_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS discovery_events (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      occurred_at TEXT NOT NULL,
      action TEXT NOT NULL,
      request_sha256 TEXT NOT NULL,
      state_sha256 TEXT NOT NULL,
      FOREIGN KEY(session_id) REFERENCES discovery_sessions(session_id)
    );`);
}

function sessionId(value) {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) fail('DISCOVERY_SESSION_ID_INVALID');
  return value;
}

function scopeFor(db, snapshot, requestScope) {
  const known = rows(db, 'SELECT schema_name FROM technical_system_schema_overview WHERE snapshot_sha256=? ORDER BY schema_name', [snapshot.snapshot_sha256])
    .map((row) => row.schema_name);
  if (known.length === 0) fail('DISCOVERY_CATALOG_SCOPE_MISSING');
  if (requestScope === undefined) return { schemas: known };
  exact(requestScope, ['schemas'], ['schemas'], 'DISCOVERY_SCOPE_INVALID');
  if (!Array.isArray(requestScope.schemas) || requestScope.schemas.length === 0 || requestScope.schemas.length > 20) fail('DISCOVERY_SCOPE_INVALID');
  const allowed = new Set(known);
  const schemas = [...new Set(requestScope.schemas.map((entry) => safeString(entry, 'DISCOVERY_SCOPE_INVALID')))].sort();
  if (schemas.some((schema) => !allowed.has(schema))) fail('DISCOVERY_SCOPE_DENIED');
  return { schemas };
}

function provenance(snapshot, row, category, queryId) {
  return {
    receiptId: snapshot.receipt_id,
    snapshotSha256: snapshot.snapshot_sha256,
    engine: snapshot.engine,
    database: snapshot.database_name,
    queryId: queryId ?? row.query_id,
    category: category ?? row.category,
    schemaName: row.schema_name ?? null,
    relationName: row.relation_name ?? null,
    columnName: row.column_name ?? null,
    objectName: row.object_name ?? null,
  };
}

function requireProvenance(reference) {
  exact(reference, ['receiptId', 'snapshotSha256', 'engine', 'database', 'queryId', 'category', 'schemaName', 'relationName', 'columnName', 'objectName'], undefined, 'DISCOVERY_PROVENANCE_INVALID');
  for (const key of ['receiptId', 'snapshotSha256', 'engine', 'database', 'queryId', 'category']) {
    if (typeof reference[key] !== 'string' || reference[key].length === 0) fail('DISCOVERY_PROVENANCE_INVALID');
  }
}

function suggestionId(snapshot, type, parts) {
  return `${type}_${sha256([snapshot.snapshot_sha256, type, ...parts].join(':')).slice(0, 16)}`;
}

function buildGuidance(db, snapshot, scope) {
  const schemaPlaceholders = scope.schemas.map(() => '?').join(',');
  const params = [snapshot.snapshot_sha256, ...scope.schemas];
  const candidateRows = rows(db, `SELECT schema_name, relation_name, relation_kind, deterministic_score, signal_summary
    FROM technical_bi_relevance_candidates WHERE snapshot_sha256=? AND schema_name IN (${schemaPlaceholders})
    ORDER BY deterministic_score DESC, schema_name, relation_name LIMIT 12`, params);
  const columnRows = rows(db, `SELECT schema_name, relation_name, column_name, data_type, ordinal_position
    FROM catalog_columns WHERE snapshot_sha256=? AND schema_name IN (${schemaPlaceholders})
    ORDER BY schema_name, relation_name, ordinal_position LIMIT 300`, params);
  const coverageRows = rows(db, `SELECT query_id, category, state, visibility, reason_code, row_count, caveat
    FROM technical_coverage_blind_spots WHERE snapshot_sha256=?
    ORDER BY CASE state WHEN 'DENIED' THEN 0 WHEN 'TIMEOUT' THEN 1 WHEN 'ERROR' THEN 2 WHEN 'PARTIAL' THEN 3 ELSE 4 END, query_id LIMIT 20`, [snapshot.snapshot_sha256]);

  const kpiCandidates = [];
  for (const column of columnRows.filter((row) => /(amount|total|qty|quantity|count|price|cost|value|measure|revenue|sales|margin)/i.test(row.column_name)).slice(0, 20)) {
    const ref = provenance(snapshot, column, 'columns', `${snapshot.engine}.structure.columns`);
    kpiCandidates.push({
      id: suggestionId(snapshot, 'kpi', [column.schema_name, column.relation_name, column.column_name]),
      label: `${column.schema_name}.${column.relation_name}.${column.column_name}`,
      rationale: `Technical measure hint from column name and type ${column.data_type}.`,
      technicalReferences: [ref],
    });
  }

  const dimensions = [];
  for (const column of columnRows.filter((row) => /(id|key|code|type|status|category|name|region|customer|product|department)/i.test(row.column_name)).slice(0, 30)) {
    const ref = provenance(snapshot, column, 'columns', `${snapshot.engine}.structure.columns`);
    dimensions.push({
      id: suggestionId(snapshot, 'dim', [column.schema_name, column.relation_name, column.column_name]),
      label: `${column.schema_name}.${column.relation_name}.${column.column_name}`,
      rationale: `Technical dimension hint from column name and type ${column.data_type}.`,
      technicalReferences: [ref],
    });
  }

  const timeCandidates = [];
  timeCandidates.push({
    id: suggestionId(snapshot, 'time', ['catalog_snapshot', snapshot.analyzed_at]),
    label: `Catalog snapshot analyzed at ${snapshot.analyzed_at}`,
    rationale: 'Technical snapshot time boundary from the local catalog receipt; use when no business time column is confirmed.',
    technicalReferences: [{
      receiptId: snapshot.receipt_id,
      snapshotSha256: snapshot.snapshot_sha256,
      engine: snapshot.engine,
      database: snapshot.database_name,
      queryId: 'catalog_snapshots',
      category: 'catalog_snapshot',
      schemaName: null,
      relationName: null,
      columnName: null,
      objectName: null,
    }],
  });
  for (const column of columnRows.filter((row) => /(date|time|period|month|year|created|updated|modified)/i.test(row.column_name)).slice(0, 20)) {
    const ref = provenance(snapshot, column, 'columns', `${snapshot.engine}.structure.columns`);
    timeCandidates.push({
      id: suggestionId(snapshot, 'time', [column.schema_name, column.relation_name, column.column_name]),
      label: `${column.schema_name}.${column.relation_name}.${column.column_name}`,
      rationale: `Technical time hint from column name and type ${column.data_type}.`,
      technicalReferences: [ref],
    });
  }

  const drilldowns = candidateRows.map((row) => {
    const ref = provenance(snapshot, row, 'bi_relevance_candidates', 'technical_bi_relevance_candidates');
    return {
      id: suggestionId(snapshot, 'drill', [row.schema_name, row.relation_name]),
      label: `${row.schema_name}.${row.relation_name}`,
      rationale: `Catalog BI relevance signals: ${row.signal_summary}.`,
      technicalReferences: [ref],
    };
  });

  for (const suggestion of [...kpiCandidates, ...dimensions, ...timeCandidates, ...drilldowns]) {
    if (!Array.isArray(suggestion.technicalReferences) || suggestion.technicalReferences.length === 0) fail('DISCOVERY_PROVENANCE_INVALID');
    for (const ref of suggestion.technicalReferences) requireProvenance(ref);
  }

  return {
    questions: [
      { id: 'audience_role', text: 'Which audience role will use this BI brief?', derivedFrom: [] },
      { id: 'business_questions', text: 'Which business questions should the brief answer?', derivedFrom: [] },
      { id: 'kpi_candidates', text: 'Which catalog-backed KPI candidates should be confirmed?', derivedFrom: kpiCandidates.flatMap((item) => item.technicalReferences).slice(0, 8) },
      { id: 'dimensions_time_filters', text: 'Which catalog-backed dimensions, time grain, filters, and drilldowns are needed?', derivedFrom: [...dimensions, ...timeCandidates, ...drilldowns].flatMap((item) => item.technicalReferences).slice(0, 8) },
      { id: 'access_confidentiality', text: 'What access and confidentiality class applies before M5?', derivedFrom: coverageRows.map((row) => provenance(snapshot, row, 'coverage', row.query_id)).slice(0, 8) },
    ],
    suggestions: {
      kpiCandidates,
      dimensions,
      timeCandidates,
      drilldownCandidates: drilldowns,
      coverageBlindSpots: coverageRows.map((row) => ({ ...row, technicalReferences: [provenance(snapshot, row, 'coverage', row.query_id)] })),
    },
  };
}

function initialState(db, snapshot, session, scope) {
  const now = nowIso();
  return {
    schemaVersion: DISCOVERY_STATE_SCHEMA,
    sessionId: session,
    revision: 1,
    status: 'IN_PROGRESS',
    createdAt: now,
    updatedAt: now,
    catalog: {
      receiptId: snapshot.receipt_id,
      snapshotSha256: snapshot.snapshot_sha256,
      engine: snapshot.engine,
      database: snapshot.database_name,
      sourceMode: snapshot.source_mode,
      runtimeValidation: snapshot.runtime_validation,
      scope,
    },
    audienceRole: null,
    businessQuestions: [],
    confirmedKpiCandidates: [],
    dimensions: [],
    time: {
      selectedCandidateIds: [],
      granularity: null,
      freshnessNeed: null,
    },
    filtersSegments: [],
    drilldowns: [],
    accessConfidentiality: {
      classification: null,
      constraints: [],
    },
    openAssumptions: [],
    confirmation: {
      status: 'UNCONFIRMED',
      confirmedAt: null,
      confirmedRevision: null,
    },
    guidance: buildGuidance(db, snapshot, scope),
  };
}

function validateState(state) {
  exact(state, ['schemaVersion', 'sessionId', 'revision', 'status', 'createdAt', 'updatedAt', 'catalog', 'audienceRole', 'businessQuestions',
    'confirmedKpiCandidates', 'dimensions', 'time', 'filtersSegments', 'drilldowns', 'accessConfidentiality', 'openAssumptions', 'confirmation', 'guidance'], undefined, 'DISCOVERY_STATE_INVALID');
  if (state.schemaVersion !== DISCOVERY_STATE_SCHEMA || !SESSION_ID.test(state.sessionId)
    || !Number.isInteger(state.revision) || state.revision < 1 || !['IN_PROGRESS', 'CONFIRMED'].includes(state.status)) fail('DISCOVERY_STATE_INVALID');
  exact(state.catalog, ['receiptId', 'snapshotSha256', 'engine', 'database', 'sourceMode', 'runtimeValidation', 'scope'], undefined, 'DISCOVERY_STATE_INVALID');
  exact(state.catalog.scope, ['schemas'], undefined, 'DISCOVERY_STATE_INVALID');
  if (!Array.isArray(state.catalog.scope.schemas) || state.catalog.scope.schemas.length === 0) fail('DISCOVERY_STATE_INVALID');
  exact(state.time, ['selectedCandidateIds', 'granularity', 'freshnessNeed'], undefined, 'DISCOVERY_STATE_INVALID');
  exact(state.accessConfidentiality, ['classification', 'constraints'], undefined, 'DISCOVERY_STATE_INVALID');
  exact(state.confirmation, ['status', 'confirmedAt', 'confirmedRevision'], undefined, 'DISCOVERY_STATE_INVALID');
  if (!['UNCONFIRMED', 'CONFIRMED'].includes(state.confirmation.status)) fail('DISCOVERY_STATE_INVALID');
  return state;
}

function loadState(db, session) {
  initializeDiscovery(db);
  const row = db.prepare('SELECT state_json FROM discovery_sessions WHERE session_id=?').get(session);
  if (!row) fail('DISCOVERY_SESSION_NOT_FOUND');
  return validateState(JSON.parse(row.state_json));
}

function saveState(db, state, action, request) {
  validateState(state);
  const rendered = canonicalJson(state);
  const eventId = sha256(`${state.sessionId}:${state.revision}:${action}:${rendered}:${nowIso()}`);
  db.prepare(`INSERT OR REPLACE INTO discovery_sessions(session_id, created_at, updated_at, state_json) VALUES (?, ?, ?, ?)`)
    .run(state.sessionId, state.createdAt, state.updatedAt, rendered);
  db.prepare(`INSERT INTO discovery_events VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(eventId, state.sessionId, state.revision, state.updatedAt, action, sha256(canonicalJson(request)), sha256(rendered));
}

function assertCurrentCatalog(state, snapshot) {
  if (state.catalog.snapshotSha256 !== snapshot.snapshot_sha256 || state.catalog.receiptId !== snapshot.receipt_id) {
    fail('DISCOVERY_CATALOG_SNAPSHOT_MISMATCH');
  }
}

function allSuggestionIds(state) {
  const values = new Map();
  for (const group of ['kpiCandidates', 'dimensions', 'timeCandidates', 'drilldownCandidates']) {
    for (const suggestion of state.guidance.suggestions[group]) values.set(suggestion.id, suggestion);
  }
  return values;
}

function assertIds(state, ids, prefixes) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 30) fail('DISCOVERY_CATALOG_REFERENCE_INVALID');
  const suggestions = allSuggestionIds(state);
  const result = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !prefixes.some((prefix) => id.startsWith(`${prefix}_`))) fail('DISCOVERY_CATALOG_REFERENCE_INVALID');
    const suggestion = suggestions.get(id);
    if (!suggestion) fail('DISCOVERY_CATALOG_REFERENCE_UNKNOWN');
    result.push(suggestion);
  }
  return [...new Set(result.map((item) => item.id))];
}

function stringList(value, code = 'DISCOVERY_TEXT_DENIED') {
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0 || list.length > 20) fail(code);
  return list.map((entry) => safeString(entry, code));
}

function resetConfirmationForRevision(state) {
  if (state.confirmation.status === 'CONFIRMED') state.revision += 1;
  state.status = 'IN_PROGRESS';
  state.confirmation = { status: 'UNCONFIRMED', confirmedAt: null, confirmedRevision: null };
  state.updatedAt = nowIso();
}

function applyAnswer(state, field, value) {
  if (!FIELD_NAMES.has(field)) fail('DISCOVERY_FIELD_UNSUPPORTED');
  resetConfirmationForRevision(state);
  if (field === 'audienceRole') state.audienceRole = safeString(value);
  else if (field === 'businessQuestions') state.businessQuestions = stringList(value);
  else if (field === 'confirmedKpiCandidates') state.confirmedKpiCandidates = assertIds(state, value, ['kpi']);
  else if (field === 'dimensions') state.dimensions = assertIds(state, value, ['dim']);
  else if (field === 'timeGranularity') {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      exact(value, ['candidateIds', 'granularity'], ['candidateIds', 'granularity'], 'DISCOVERY_TIME_INVALID');
      state.time.selectedCandidateIds = assertIds(state, value.candidateIds, ['time']);
      if (!TIME_GRANULARITIES.has(value.granularity)) fail('DISCOVERY_TIME_INVALID');
      state.time.granularity = value.granularity;
    } else if (TIME_GRANULARITIES.has(value)) state.time.granularity = value;
    else fail('DISCOVERY_TIME_INVALID');
  } else if (field === 'filtersSegments') state.filtersSegments = stringList(value);
  else if (field === 'drilldowns') state.drilldowns = assertIds(state, value, ['drill']);
  else if (field === 'freshnessNeed') state.time.freshnessNeed = safeString(value);
  else if (field === 'accessConfidentiality') {
    if (typeof value === 'string') {
      if (!ACCESS_CLASSES.has(value)) fail('DISCOVERY_ACCESS_INVALID');
      state.accessConfidentiality.classification = value;
      state.accessConfidentiality.constraints = [];
    } else {
      exact(value, ['classification', 'constraints'], ['classification'], 'DISCOVERY_ACCESS_INVALID');
      if (!ACCESS_CLASSES.has(value.classification)) fail('DISCOVERY_ACCESS_INVALID');
      state.accessConfidentiality.classification = value.classification;
      state.accessConfidentiality.constraints = value.constraints === undefined ? [] : stringList(value.constraints, 'DISCOVERY_ACCESS_INVALID');
    }
  } else if (field === 'openAssumptions') state.openAssumptions = stringList(value);
}

function completionErrors(state) {
  const missing = [];
  if (!state.audienceRole) missing.push('audienceRole');
  if (state.businessQuestions.length === 0) missing.push('businessQuestions');
  if (state.confirmedKpiCandidates.length === 0) missing.push('confirmedKpiCandidates');
  if (state.dimensions.length === 0) missing.push('dimensions');
  if (!state.time.granularity || state.time.selectedCandidateIds.length === 0) missing.push('timeGranularity');
  if (!state.time.freshnessNeed) missing.push('freshnessNeed');
  if (!state.accessConfidentiality.classification) missing.push('accessConfidentiality');
  return missing;
}

function selectedSuggestions(state, ids) {
  const suggestions = allSuggestionIds(state);
  return ids.map((id) => suggestions.get(id));
}

function buildExport(state) {
  if (state.confirmation.status !== 'CONFIRMED') fail('DISCOVERY_EXPORT_UNCONFIRMED_DENIED');
  const kpis = selectedSuggestions(state, state.confirmedKpiCandidates);
  const dimensions = selectedSuggestions(state, state.dimensions);
  const timeCandidates = selectedSuggestions(state, state.time.selectedCandidateIds);
  const drilldowns = selectedSuggestions(state, state.drilldowns);
  const coverage = state.guidance.suggestions.coverageBlindSpots;
  const markdown = [
    `# BI Discovery Brief ${state.sessionId} r${state.revision}`,
    '',
    `Status: ${state.status}`,
    `Audience role: ${state.audienceRole}`,
    `Catalog receipt: ${state.catalog.receiptId}`,
    `Snapshot SHA-256: ${state.catalog.snapshotSha256}`,
    '',
    '## Business Questions',
    ...state.businessQuestions.map((entry) => `- ${entry}`),
    '',
    '## Confirmed KPI Candidates',
    ...kpis.map((entry) => `- ${entry.label} (${entry.id})`),
    '',
    '## Dimensions And Time',
    ...dimensions.map((entry) => `- Dimension: ${entry.label} (${entry.id})`),
    ...timeCandidates.map((entry) => `- Time: ${entry.label} (${entry.id}), grain ${state.time.granularity}`),
    '',
    '## Filters, Segments, Drilldowns',
    ...state.filtersSegments.map((entry) => `- Filter/segment: ${entry}`),
    ...drilldowns.map((entry) => `- Drilldown: ${entry.label} (${entry.id})`),
    '',
    '## Access And Open Assumptions',
    `- Classification: ${state.accessConfidentiality.classification}`,
    ...state.accessConfidentiality.constraints.map((entry) => `- Constraint: ${entry}`),
    ...state.openAssumptions.map((entry) => `- Assumption: ${entry}`),
    '',
    '## Coverage And Blind Spots',
    ...coverage.map((entry) => `- ${entry.query_id}: ${entry.state} ${entry.caveat}`),
    '',
    '## M5 Boundary',
    '- This M4 brief does not create datasets, charts, dashboards, SQL, Superset mutations, or source-database queries.',
  ].join('\n');
  return {
    schemaVersion: DISCOVERY_EXPORT_SCHEMA,
    status: 'EXPORTED_CONFIRMED_DISCOVERY_BRIEF',
    sessionId: state.sessionId,
    revision: state.revision,
    catalog: state.catalog,
    audienceRole: state.audienceRole,
    businessQuestions: state.businessQuestions,
    confirmedInterests: { kpiCandidates: kpis, dimensions, timeCandidates, drilldowns },
    freshnessNeed: state.time.freshnessNeed,
    filtersSegments: state.filtersSegments,
    accessConfidentiality: state.accessConfidentiality,
    openAssumptions: state.openAssumptions,
    coverageBlindSpots: coverage,
    provenance: {
      receiptId: state.catalog.receiptId,
      snapshotSha256: state.catalog.snapshotSha256,
      evidenceSources: [...kpis, ...dimensions, ...timeCandidates, ...drilldowns].flatMap((entry) => entry.technicalReferences)
        .sort((left, right) => compareText(left.queryId, right.queryId) || compareText(left.schemaName, right.schemaName) || compareText(left.relationName, right.relationName) || compareText(left.columnName, right.columnName)),
    },
    m5Boundary: 'No dynamic Superset datasets, charts, dashboards, SQL execution, Superset mutation, source-row access, or source-database query is performed by M4.',
    markdown,
  };
}

function response(action, state, extra = {}) {
  return {
    schemaVersion: DISCOVERY_RESPONSE_SCHEMA,
    action,
    state,
    audit: {
      sessionId: state.sessionId,
      revision: state.revision,
      stateSha256: sha256(canonicalJson(state)),
      confirmed: state.confirmation.status === 'CONFIRMED',
    },
    ...extra,
  };
}

export function handleDiscovery(db, request) {
  initializeDiscovery(db);
  exact(request, ['action', 'sessionId', 'scope', 'field', 'value', 'confirmed', 'format'], ['action', 'sessionId']);
  const action = request.action;
  const id = sessionId(request.sessionId);
  const snapshot = latest(db);
  if (action === 'start') {
    const existing = db.prepare('SELECT state_json FROM discovery_sessions WHERE session_id=?').get(id);
    if (existing) return response('start', validateState(JSON.parse(existing.state_json)), { idempotent: true });
    const state = initialState(db, snapshot, id, scopeFor(db, snapshot, request.scope));
    saveState(db, state, 'start', request);
    return response('start', state, { idempotent: false });
  }
  if (action === 'resume' || action === 'status') {
    const state = loadState(db, id);
    return response(action, state, { catalogSnapshotCurrent: state.catalog.snapshotSha256 === snapshot.snapshot_sha256 });
  }
  if (action === 'answer' || action === 'revise') {
    exact(request, ['action', 'sessionId', 'field', 'value'], ['action', 'sessionId', 'field', 'value']);
    const state = loadState(db, id);
    assertCurrentCatalog(state, snapshot);
    applyAnswer(state, request.field, request.value);
    saveState(db, state, action, request);
    return response(action, state, { missingForConfirmation: completionErrors(state) });
  }
  if (action === 'confirm') {
    exact(request, ['action', 'sessionId', 'confirmed'], ['action', 'sessionId', 'confirmed']);
    if (request.confirmed !== true) fail('DISCOVERY_CONFIRMATION_NOT_EXPLICIT');
    const state = loadState(db, id);
    assertCurrentCatalog(state, snapshot);
    const missing = completionErrors(state);
    if (missing.length > 0) fail(`DISCOVERY_CONFIRMATION_INCOMPLETE_${missing.join('_').toUpperCase()}`);
    state.status = 'CONFIRMED';
    state.updatedAt = nowIso();
    state.confirmation = { status: 'CONFIRMED', confirmedAt: state.updatedAt, confirmedRevision: state.revision };
    saveState(db, state, action, request);
    return response('confirm', state);
  }
  if (action === 'export') {
    exact(request, ['action', 'sessionId', 'format'], ['action', 'sessionId']);
    if (request.format !== undefined && !['json', 'markdown'].includes(request.format)) fail('DISCOVERY_EXPORT_FORMAT_DENIED');
    const state = loadState(db, id);
    assertCurrentCatalog(state, snapshot);
    const exported = buildExport(state);
    saveState(db, state, action, request);
    return response('export', state, { export: exported });
  }
  fail('DISCOVERY_ACTION_DENIED');
}
