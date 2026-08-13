import { createHash } from 'node:crypto';

import { canonicalJson } from './db-analyzer/core.mjs';

export const CATALOG_SCHEMA_VERSION = 'chimpmaera.bi/local-technical-catalog/v1';
export const CATALOG_ANSWER_SCHEMA = 'chimpmaera.bi/catalog-answer/v1';
export const CATALOG_SEARCH_SCHEMA = 'chimpmaera.bi/catalog-search/v1';

const QUESTION_FAMILIES = new Set([
  'largest_tables',
  'row_estimates_freshness',
  'object_inventory_validity',
  'dependencies',
  'stored_logic_signatures',
  'scheduler_mv_refresh',
  'coverage_blind_spots',
  'bi_relevance_candidates',
]);

const FORBIDDEN_INPUT = /\b(?:select|insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|exec(?:ute)?|dbcc|backup|restore|sql\s*lab|raw\s+sql|source\s+code|pl\/sql\s+source|password|credential|secret|api[_ -]?key|ignore\s+(?:all\s+)?previous|system\s+prompt)\b/i;
const FORBIDDEN_DETAIL_KEYS = /\b(?:source_text|view_text|trigger_body|job_action|program_action|password|credential|secret|api_key|username)\b/i;

const fail = (code) => {
  const error = new Error(code);
  error.code = code;
  throw error;
};

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const text = (value) => value === undefined || value === null ? null : String(value);
const numberOrNull = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const boolInt = (value) => value === true || value === 1 || value === 'YES' || value === 'Y' ? 1 : 0;
const nowIso = () => new Date().toISOString();
const objectKey = (schema, name) => `${schema ?? ''}.${name ?? ''}`.toUpperCase();
const compareText = (left, right) => Buffer.compare(Buffer.from(String(left ?? ''), 'utf8'), Buffer.from(String(right ?? ''), 'utf8'));

function exact(value, keys, code = 'CATALOG_REQUEST_DENIED') {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) fail(code);
}

function assertSafeDetail(row) {
  for (const key of Object.keys(row)) if (FORBIDDEN_DETAIL_KEYS.test(key)) fail('CATALOG_UNSAFE_FACT_DENIED');
}

function rowObjectName(category, row) {
  if (category === 'schemas') return row.schema_name;
  if (category === 'relations') return row.relation_name;
  if (category === 'columns') return row.column_name;
  if (category === 'comments') return row.column_name ?? row.relation_name;
  if (category === 'constraints') return row.constraint_name;
  if (category === 'indexes') return row.index_name;
  if (category === 'sequences') return row.sequence_name;
  if (category === 'synonyms') return row.synonym_name;
  if (category === 'partitions') return row.subpartition_name ?? row.partition_name ?? row.relation_name;
  if (category === 'lobs') return row.segment_name ?? row.column_name;
  if (category === 'tablespaces') return row.tablespace_name;
  if (category === 'statistics') return row.index_name ?? row.relation_name;
  if (category === 'sizes') return row.segment_name;
  if (category === 'stored-objects') return row.object_name;
  if (category === 'stored-arguments') return row.argument_name ?? row.subprogram_name ?? row.object_name;
  if (category === 'stored-errors') return row.object_name;
  if (category === 'stored-dependencies') return row.source_object_name;
  if (category === 'operations') return row.object_name ?? row.relation_name;
  if (category === 'db-links') return row.db_link_name;
  return null;
}

function rowsByQuery(receipt, queryId) {
  return receipt.analysis.extracts.find((entry) => entry.queryId === queryId)?.rows ?? [];
}

function rowsByCategory(receipt, category) {
  return receipt.analysis.extracts.filter((entry) => entry.category === category).flatMap((entry) => entry.rows);
}

function coverageEntriesFor(receipt, categories) {
  const wanted = new Set(categories);
  return receipt.analysis.coverageLedger.entries
    .filter((entry) => wanted.has(entry.category) || wanted.has(entry.queryId));
}

export function initializeCatalog(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS catalog_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR REPLACE INTO catalog_meta(key, value) VALUES ('schema_version', '${CATALOG_SCHEMA_VERSION}');
    CREATE TABLE IF NOT EXISTS catalog_snapshots (
      snapshot_sha256 TEXT PRIMARY KEY,
      receipt_id TEXT NOT NULL UNIQUE,
      engine TEXT NOT NULL,
      database_name TEXT NOT NULL,
      container_name TEXT,
      source_mode TEXT NOT NULL,
      runtime_validation TEXT NOT NULL,
      analyzed_at TEXT NOT NULL,
      ingested_at TEXT NOT NULL,
      active INTEGER NOT NULL CHECK(active IN (0,1)),
      coverage_all_complete INTEGER NOT NULL CHECK(coverage_all_complete IN (0,1)),
      coverage_json TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS catalog_extracts (
      snapshot_sha256 TEXT NOT NULL,
      query_id TEXT NOT NULL,
      category TEXT NOT NULL,
      state TEXT NOT NULL,
      reason_code TEXT,
      visibility TEXT NOT NULL,
      row_count INTEGER NOT NULL,
      empty_interpretation TEXT NOT NULL,
      query_sha256 TEXT NOT NULL,
      PRIMARY KEY(snapshot_sha256, query_id),
      FOREIGN KEY(snapshot_sha256) REFERENCES catalog_snapshots(snapshot_sha256)
    );
    CREATE TABLE IF NOT EXISTS catalog_facts (
      fact_id TEXT PRIMARY KEY,
      snapshot_sha256 TEXT NOT NULL,
      receipt_id TEXT NOT NULL,
      category TEXT NOT NULL,
      object_sha256 TEXT NOT NULL,
      schema_name TEXT,
      relation_name TEXT,
      object_name TEXT,
      object_kind TEXT,
      column_name TEXT,
      query_id TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      UNIQUE(snapshot_sha256, query_id, object_sha256),
      FOREIGN KEY(snapshot_sha256) REFERENCES catalog_snapshots(snapshot_sha256)
    );
    CREATE INDEX IF NOT EXISTS catalog_facts_scope_idx ON catalog_facts(snapshot_sha256, schema_name, relation_name, category);
    CREATE TABLE IF NOT EXISTS catalog_relations (
      snapshot_sha256 TEXT NOT NULL,
      schema_name TEXT NOT NULL,
      relation_name TEXT NOT NULL,
      relation_kind TEXT NOT NULL,
      status TEXT,
      temporary INTEGER NOT NULL,
      created_at TEXT,
      modified_at TEXT,
      object_sha256 TEXT NOT NULL,
      PRIMARY KEY(snapshot_sha256, schema_name, relation_name, relation_kind)
    );
    CREATE TABLE IF NOT EXISTS catalog_columns (
      snapshot_sha256 TEXT NOT NULL,
      schema_name TEXT NOT NULL,
      relation_name TEXT NOT NULL,
      relation_kind TEXT NOT NULL,
      column_name TEXT NOT NULL,
      ordinal_position INTEGER NOT NULL,
      data_type TEXT NOT NULL,
      is_nullable INTEGER NOT NULL,
      object_sha256 TEXT NOT NULL,
      PRIMARY KEY(snapshot_sha256, schema_name, relation_name, column_name)
    );
    CREATE TABLE IF NOT EXISTS catalog_dependencies (
      snapshot_sha256 TEXT NOT NULL,
      source_schema_name TEXT NOT NULL,
      source_object_name TEXT NOT NULL,
      source_object_kind TEXT,
      target_schema_name TEXT,
      target_object_name TEXT,
      target_object_kind TEXT,
      target_db_link_name TEXT,
      native_dependency_kind TEXT,
      resolution_state TEXT,
      column_resolution_state TEXT,
      object_sha256 TEXT NOT NULL,
      PRIMARY KEY(snapshot_sha256, object_sha256)
    );
    CREATE TABLE IF NOT EXISTS technical_system_schema_overview (
      row_id TEXT PRIMARY KEY,
      receipt_id TEXT NOT NULL,
      snapshot_sha256 TEXT NOT NULL,
      engine TEXT NOT NULL,
      database_name TEXT NOT NULL,
      schema_name TEXT NOT NULL,
      source_mode TEXT NOT NULL,
      runtime_validation TEXT NOT NULL,
      relation_count INTEGER NOT NULL,
      column_count INTEGER NOT NULL,
      stored_object_count INTEGER NOT NULL,
      invalid_object_count INTEGER NOT NULL,
      compile_issue_count INTEGER NOT NULL,
      denied_or_unknown_collectors INTEGER NOT NULL,
      coverage_all_complete INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS technical_tables_capacity (
      row_id TEXT PRIMARY KEY,
      receipt_id TEXT NOT NULL,
      snapshot_sha256 TEXT NOT NULL,
      schema_name TEXT NOT NULL,
      relation_name TEXT NOT NULL,
      relation_kind TEXT NOT NULL,
      column_count INTEGER NOT NULL,
      constraint_count INTEGER NOT NULL,
      index_count INTEGER NOT NULL,
      num_rows_estimate REAL,
      last_analyzed TEXT,
      stale_stats TEXT,
      bytes REAL,
      blocks REAL,
      size_semantics TEXT,
      row_count_semantics TEXT
    );
    CREATE TABLE IF NOT EXISTS technical_code_dependencies (
      row_id TEXT PRIMARY KEY,
      receipt_id TEXT NOT NULL,
      snapshot_sha256 TEXT NOT NULL,
      schema_name TEXT NOT NULL,
      object_name TEXT NOT NULL,
      object_kind TEXT NOT NULL,
      status TEXT,
      signature_count INTEGER NOT NULL,
      compile_issue_count INTEGER NOT NULL,
      depends_on_count INTEGER NOT NULL,
      used_by_count INTEGER NOT NULL,
      source_line_count INTEGER,
      source_hash_sha256 TEXT,
      wrapped_code_blind_spot TEXT
    );
    CREATE TABLE IF NOT EXISTS technical_coverage_blind_spots (
      row_id TEXT PRIMARY KEY,
      receipt_id TEXT NOT NULL,
      snapshot_sha256 TEXT NOT NULL,
      query_id TEXT NOT NULL,
      category TEXT NOT NULL,
      state TEXT NOT NULL,
      visibility TEXT NOT NULL,
      reason_code TEXT,
      row_count INTEGER NOT NULL,
      empty_interpretation TEXT NOT NULL,
      caveat TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS technical_bi_relevance_candidates (
      row_id TEXT PRIMARY KEY,
      receipt_id TEXT NOT NULL,
      snapshot_sha256 TEXT NOT NULL,
      schema_name TEXT NOT NULL,
      relation_name TEXT NOT NULL,
      relation_kind TEXT NOT NULL,
      deterministic_score INTEGER NOT NULL,
      signal_summary TEXT NOT NULL,
      candidate_label TEXT NOT NULL
    );`);
}

export function ingestCatalogReceipt(db, receipt) {
  if (receipt?.schemaVersion !== 'chimpmaera.bi/analysis-receipt/v1' || !receipt.analysis?.snapshotSha256) fail('CATALOG_RECEIPT_INVALID');
  initializeCatalog(db);
  const snapshot = receipt.analysis.snapshotSha256;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE catalog_snapshots SET active=0').run();
    db.prepare(`INSERT OR REPLACE INTO catalog_snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(snapshot, receipt.receiptId, receipt.engine, receipt.scope.database, receipt.scope.container ?? null,
        receipt.sourceMode, receipt.analysis.runtimeValidation, receipt.analyzedAt, nowIso(),
        1, receipt.analysis.coverageLedger.allComplete ? 1 : 0, canonicalJson(receipt.analysis.coverageLedger), sha256(canonicalJson(receipt)));

    for (const table of ['catalog_extracts', 'catalog_facts', 'catalog_relations', 'catalog_columns', 'catalog_dependencies',
      'technical_system_schema_overview', 'technical_tables_capacity', 'technical_code_dependencies',
      'technical_coverage_blind_spots', 'technical_bi_relevance_candidates']) {
      db.prepare(`DELETE FROM ${table} WHERE snapshot_sha256=?`).run(snapshot);
    }

    const insertExtract = db.prepare(`INSERT INTO catalog_extracts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertFact = db.prepare(`INSERT INTO catalog_facts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const extract of receipt.analysis.extracts) {
      insertExtract.run(snapshot, extract.queryId, extract.category, extract.state, extract.reasonCode, extract.visibility,
        extract.rows.length, extract.emptyInterpretation, extract.querySha256);
      for (const row of extract.rows) {
        assertSafeDetail(row);
        const objectName = rowObjectName(extract.category, row);
        const factId = sha256(`${snapshot}:${extract.queryId}:${row.objectSha256}`);
        insertFact.run(factId, snapshot, receipt.receiptId, extract.category, row.objectSha256, row.schema_name ?? row.source_schema_name ?? null,
          row.relation_name ?? row.source_object_name ?? null, objectName, row.object_kind ?? row.relation_kind ?? null,
          row.column_name ?? null, extract.queryId, canonicalJson(row));
      }
    }

    const insertRelation = db.prepare(`INSERT INTO catalog_relations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const row of rowsByCategory(receipt, 'relations')) {
      insertRelation.run(snapshot, row.schema_name, row.relation_name, row.relation_kind, row.status ?? null, boolInt(row.temporary),
        row.created_at ?? null, row.modified_at ?? null, row.objectSha256);
    }
    const insertColumn = db.prepare(`INSERT INTO catalog_columns VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const row of rowsByCategory(receipt, 'columns')) {
      insertColumn.run(snapshot, row.schema_name, row.relation_name, row.relation_kind, row.column_name,
        Number(row.ordinal_position), row.data_type, boolInt(row.is_nullable), row.objectSha256);
    }
    const insertDependency = db.prepare(`INSERT INTO catalog_dependencies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const row of rowsByCategory(receipt, 'stored-dependencies')) {
      insertDependency.run(snapshot, row.source_schema_name, row.source_object_name, row.source_object_kind ?? null,
        row.target_schema_name ?? null, row.target_object_name ?? null, row.target_object_kind ?? null,
        row.target_db_link_name ?? null, row.native_dependency_kind ?? null, row.resolution_state ?? null,
        row.column_resolution_state ?? null, row.objectSha256);
    }
    materializeOverviewTables(db, receipt);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function materializeOverviewTables(db, receipt) {
  const snapshot = receipt.analysis.snapshotSha256;
  const schemas = rowsByCategory(receipt, 'schemas').map((row) => row.schema_name);
  const storedObjects = rowsByCategory(receipt, 'stored-objects');
  const storedErrors = rowsByCategory(receipt, 'stored-errors');
  const deniedUnknown = receipt.analysis.coverageLedger.entries.filter((entry) => ['DENIED', 'TIMEOUT', 'ERROR', 'PARTIAL'].includes(entry.state)).length;
  const insertSchema = db.prepare(`INSERT INTO technical_system_schema_overview VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const schemaName of schemas.length ? schemas : receipt.scope.schemas) {
    const relationCount = rowsByCategory(receipt, 'relations').filter((row) => row.schema_name === schemaName).length;
    const columnCount = rowsByCategory(receipt, 'columns').filter((row) => row.schema_name === schemaName).length;
    const schemaStored = storedObjects.filter((row) => row.schema_name === schemaName);
    const schemaErrors = storedErrors.filter((row) => row.schema_name === schemaName);
    insertSchema.run(sha256(`${snapshot}:schema:${schemaName}`), receipt.receiptId, snapshot, receipt.engine, receipt.scope.database,
      schemaName, receipt.sourceMode, receipt.analysis.runtimeValidation, relationCount, columnCount, schemaStored.length,
      schemaStored.filter((row) => row.status && row.status !== 'VALID').length, schemaErrors.length, deniedUnknown,
      receipt.analysis.coverageLedger.allComplete ? 1 : 0);
  }

  const relationRows = rowsByCategory(receipt, 'relations');
  const tableStats = new Map(rowsByQuery(receipt, `${receipt.engine}.statistics.tables`)
    .map((row) => [objectKey(row.schema_name, row.relation_name), row]));
  const sizes = new Map(rowsByQuery(receipt, `${receipt.engine}.size.segments`)
    .map((row) => [objectKey(row.schema_name, row.segment_name), row]));
  const insertTable = db.prepare(`INSERT INTO technical_tables_capacity VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const relation of relationRows) {
    const key = objectKey(relation.schema_name, relation.relation_name);
    const stat = tableStats.get(key);
    const size = sizes.get(key);
    insertTable.run(sha256(`${snapshot}:table:${relation.schema_name}:${relation.relation_name}:${relation.relation_kind}`),
      receipt.receiptId, snapshot, relation.schema_name, relation.relation_name, relation.relation_kind,
      rowsByCategory(receipt, 'columns').filter((row) => objectKey(row.schema_name, row.relation_name) === key).length,
      rowsByCategory(receipt, 'constraints').filter((row) => objectKey(row.schema_name, row.relation_name) === key).length,
      rowsByCategory(receipt, 'indexes').filter((row) => objectKey(row.schema_name, row.relation_name) === key).length,
      numberOrNull(stat?.num_rows_estimate), stat?.last_analyzed ?? null, stat?.stale_stats ?? null,
      numberOrNull(size?.bytes), numberOrNull(size?.blocks), size?.size_semantics ?? null, stat?.row_count_semantics ?? null);
  }

  const args = rowsByCategory(receipt, 'stored-arguments');
  const deps = rowsByCategory(receipt, 'stored-dependencies');
  const insertCode = db.prepare(`INSERT INTO technical_code_dependencies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const object of storedObjects) {
    const key = objectKey(object.schema_name, object.object_name);
    insertCode.run(sha256(`${snapshot}:code:${object.schema_name}:${object.object_name}:${object.object_kind}`),
      receipt.receiptId, snapshot, object.schema_name, object.object_name, object.object_kind, object.status ?? null,
      args.filter((row) => objectKey(row.schema_name, row.object_name) === key).length,
      storedErrors.filter((row) => objectKey(row.schema_name, row.object_name) === key).length,
      deps.filter((row) => objectKey(row.source_schema_name, row.source_object_name) === key).length,
      deps.filter((row) => objectKey(row.target_schema_name, row.target_object_name) === key).length,
      numberOrNull(object.source_line_count), object.source_hash_sha256 ?? null, object.wrapped_code_blind_spot ?? null);
  }

  const insertCoverage = db.prepare(`INSERT INTO technical_coverage_blind_spots VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const entry of receipt.analysis.coverageLedger.entries) {
    insertCoverage.run(sha256(`${snapshot}:coverage:${entry.queryId}`), receipt.receiptId, snapshot, entry.queryId,
      entry.category, entry.state, entry.visibility, entry.reasonCode, entry.rowCount, entry.emptyInterpretation,
      coverageCaveat(entry));
  }

  const insertCandidate = db.prepare(`INSERT INTO technical_bi_relevance_candidates VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const comments = rowsByCategory(receipt, 'comments');
  for (const relation of relationRows) {
    const relColumns = rowsByCategory(receipt, 'columns').filter((row) => objectKey(row.schema_name, row.relation_name) === objectKey(relation.schema_name, relation.relation_name));
    const signals = [];
    if (relation.relation_kind === 'TABLE' || relation.relation_kind === 'MATERIALIZED_VIEW') signals.push('persisted_relation');
    if (relColumns.some((row) => /(date|time|period|month|year|created|updated)/i.test(row.column_name))) signals.push('time_column');
    if (relColumns.some((row) => /(amount|total|qty|quantity|count|price|cost|value|measure)/i.test(row.column_name))) signals.push('measure_hint_column');
    if (relColumns.some((row) => /(id|key|code|type|status|category|name)/i.test(row.column_name))) signals.push('dimension_hint_column');
    if (comments.some((row) => objectKey(row.schema_name, row.relation_name) === objectKey(relation.schema_name, relation.relation_name))) signals.push('comment_metadata_present');
    const score = signals.length;
    if (score === 0) continue;
    insertCandidate.run(sha256(`${snapshot}:candidate:${relation.schema_name}:${relation.relation_name}`), receipt.receiptId, snapshot,
      relation.schema_name, relation.relation_name, relation.relation_kind, score, signals.sort().join(', '),
      'DETERMINISTIC_TECHNICAL_CANDIDATE');
  }
}

function coverageCaveat(entry) {
  if (entry.state === 'SUCCEEDED' && entry.emptyInterpretation === 'VERIFIED_EMPTY') return 'Collector succeeded with verified empty metadata for its bounded scope.';
  if (entry.state === 'SUCCEEDED') return 'Collector succeeded for its bounded scope.';
  if (entry.state === 'PARTIAL') return 'Collector returned partial metadata; do not treat omissions as absence.';
  if (entry.state === 'DENIED') return 'Collector was denied; evidence is invisible, not absent.';
  if (entry.state === 'TIMEOUT') return 'Collector timed out; evidence is unknown.';
  if (entry.state === 'ERROR') return 'Collector errored; evidence is unknown.';
  return 'Collector state is not interpreted as object absence.';
}

function latest(db) {
  const snapshot = db.prepare('SELECT * FROM catalog_snapshots WHERE active=1 ORDER BY analyzed_at DESC LIMIT 1').get();
  if (!snapshot) fail('CATALOG_SNAPSHOT_MISSING');
  return snapshot;
}

function parseScope(snapshot, scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) fail('CATALOG_SCOPE_INVALID');
  exact(scope, ['schemas'], 'CATALOG_SCOPE_INVALID');
  if (!Array.isArray(scope.schemas) || scope.schemas.length === 0 || scope.schemas.length > 20
    || scope.schemas.some((schema) => typeof schema !== 'string' || schema.length < 1 || schema.length > 128)) fail('CATALOG_SCOPE_INVALID');
  const known = new Set(dbSchemas(snapshot));
  for (const schema of scope.schemas) if (!known.has(schema)) fail('CATALOG_SCOPE_DENIED');
  return scope.schemas;
}

let schemaCache = new Map();
function dbSchemas(snapshot) {
  const key = snapshot.snapshot_sha256;
  return schemaCache.get(key) ?? [];
}

function setSchemaCache(snapshot, rows) {
  schemaCache.set(snapshot.snapshot_sha256, rows.map((row) => row.schema_name));
}

function requestLimit(value, fallback = 20) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 100) fail('CATALOG_RESULT_BUDGET_DENIED');
  return value;
}

function provenance(snapshot, coverage) {
  return {
    receiptId: snapshot.receipt_id,
    snapshotSha256: snapshot.snapshot_sha256,
    engine: snapshot.engine,
    database: snapshot.database_name,
    sourceMode: snapshot.source_mode,
    runtimeValidation: snapshot.runtime_validation,
    coverage: coverage.map((entry) => ({
      queryId: entry.query_id ?? entry.queryId,
      category: entry.category,
      state: entry.state,
      visibility: entry.visibility,
      reasonCode: entry.reason_code ?? entry.reasonCode ?? null,
      caveat: coverageCaveat({
        state: entry.state,
        emptyInterpretation: entry.empty_interpretation ?? entry.emptyInterpretation,
      }),
    })),
  };
}

function rows(db, sql, params = []) {
  return db.prepare(sql).all(...params);
}

function one(db, sql, params = []) {
  return db.prepare(sql).get(...params);
}

function bindSchemas(schemas) {
  return schemas.map(() => '?').join(',');
}

function answer(snapshot, family, rowsValue, coverage, caveat) {
  return {
    schemaVersion: CATALOG_ANSWER_SCHEMA,
    status: 'ANSWERED_WITH_EVIDENCE',
    family,
    answer: caveat,
    rows: rowsValue,
    provenance: provenance(snapshot, coverage),
  };
}

function resolveObject(db, snapshot, schemas, object) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) fail('CATALOG_OBJECT_REQUIRED');
  exact(object, ['name'], 'CATALOG_OBJECT_INVALID');
  if (typeof object.name !== 'string' || object.name.length < 1 || object.name.length > 260) fail('CATALOG_OBJECT_INVALID');
  const parts = object.name.split('.');
  const schema = parts.length === 2 ? parts[0] : null;
  const name = parts.length === 2 ? parts[1] : object.name;
  const params = [snapshot.snapshot_sha256, ...schemas, name.toUpperCase()];
  const schemaClause = schema ? 'AND UPPER(schema_name)=?' : '';
  if (schema) params.push(schema.toUpperCase());
  const matches = rows(db, `SELECT schema_name, object_name, object_kind, category FROM catalog_facts
    WHERE snapshot_sha256=? AND schema_name IN (${bindSchemas(schemas)}) AND UPPER(object_name)=? ${schemaClause}
      AND category IN ('relations','stored-objects','sequences','synonyms')
    GROUP BY schema_name, object_name, object_kind, category
    ORDER BY schema_name, object_name, object_kind`, params);
  if (matches.length === 0) fail('CATALOG_OBJECT_NOT_FOUND');
  const identityKeys = new Set(matches.map((match) => `${match.schema_name}.${match.object_name}`));
  if (identityKeys.size > 1) fail('CATALOG_OBJECT_AMBIGUOUS');
  return matches[0];
}

export function searchCatalog(db, request) {
  exact(request, ['term', 'scope', 'limit'], 'CATALOG_SEARCH_REQUEST_DENIED');
  if (typeof request.term !== 'string' || request.term.length < 2 || request.term.length > 80 || FORBIDDEN_INPUT.test(request.term)) fail('CATALOG_SEARCH_DENIED');
  const snapshot = latest(db);
  const schemaRows = rows(db, 'SELECT schema_name FROM technical_system_schema_overview WHERE snapshot_sha256=? ORDER BY schema_name', [snapshot.snapshot_sha256]);
  setSchemaCache(snapshot, schemaRows);
  const schemas = parseScope(snapshot, request.scope);
  const limit = requestLimit(request.limit, 20);
  const like = `%${request.term.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
  const resultRows = rows(db, `SELECT category, schema_name, relation_name, object_name, object_kind, column_name, query_id
    FROM catalog_facts WHERE snapshot_sha256=? AND schema_name IN (${bindSchemas(schemas)})
      AND (object_name LIKE ? ESCAPE '\\' OR relation_name LIKE ? ESCAPE '\\' OR column_name LIKE ? ESCAPE '\\' OR detail_json LIKE ? ESCAPE '\\')
    ORDER BY schema_name, relation_name, object_name, column_name LIMIT ?`, [snapshot.snapshot_sha256, ...schemas, like, like, like, like, limit]);
  return {
    schemaVersion: CATALOG_SEARCH_SCHEMA,
    status: 'SEARCHED_SAFE_CATALOG',
    term: request.term,
    rows: resultRows,
    provenance: provenance(snapshot, rows(db, 'SELECT * FROM catalog_extracts WHERE snapshot_sha256=? ORDER BY query_id', [snapshot.snapshot_sha256])),
  };
}

export function answerCatalogQuestion(db, request) {
  exact(request, ['family', 'scope', 'object', 'limit'], 'CATALOG_QUESTION_REQUEST_DENIED');
  if (!QUESTION_FAMILIES.has(request.family)) fail('CATALOG_QUESTION_UNSUPPORTED');
  if (request.object !== null && typeof request.object?.name === 'string' && FORBIDDEN_INPUT.test(request.object.name)) fail('CATALOG_UNSAFE_INPUT_DENIED');
  const snapshot = latest(db);
  const schemaRows = rows(db, 'SELECT schema_name FROM technical_system_schema_overview WHERE snapshot_sha256=? ORDER BY schema_name', [snapshot.snapshot_sha256]);
  setSchemaCache(snapshot, schemaRows);
  const schemas = parseScope(snapshot, request.scope);
  const limit = requestLimit(request.limit, 20);
  const scoped = bindSchemas(schemas);
  const params = [snapshot.snapshot_sha256, ...schemas];
  if (request.family === 'largest_tables') {
    const data = rows(db, `SELECT schema_name, relation_name, relation_kind, bytes, blocks, num_rows_estimate, size_semantics, row_count_semantics
      FROM technical_tables_capacity WHERE snapshot_sha256=? AND schema_name IN (${scoped})
      ORDER BY bytes IS NULL, bytes DESC, num_rows_estimate IS NULL, num_rows_estimate DESC, schema_name, relation_name LIMIT ?`, [...params, limit]);
    return answer(snapshot, request.family, data, coverageRows(db, snapshot, ['sizes', 'statistics', 'relations']), 'Largest tables are ranked only from visible size/statistics metadata; unknown bytes remain unknown.');
  }
  if (request.family === 'row_estimates_freshness') {
    const data = rows(db, `SELECT schema_name, relation_name, relation_kind, num_rows_estimate, last_analyzed, stale_stats, row_count_semantics
      FROM technical_tables_capacity WHERE snapshot_sha256=? AND schema_name IN (${scoped})
      ORDER BY last_analyzed IS NULL, last_analyzed, schema_name, relation_name LIMIT ?`, [...params, limit]);
    return answer(snapshot, request.family, data, coverageRows(db, snapshot, ['statistics', 'relations']), 'Row counts are optimizer estimates only; no COUNT(*) was run.');
  }
  if (request.family === 'object_inventory_validity') {
    const data = rows(db, `SELECT * FROM technical_system_schema_overview WHERE snapshot_sha256=? AND schema_name IN (${scoped})
      ORDER BY schema_name LIMIT ?`, [...params, limit]);
    return answer(snapshot, request.family, data, coverageRows(db, snapshot, ['schemas', 'relations', 'stored-objects', 'stored-errors']), 'Inventory and validity are bounded by collector coverage; denied/unknown collectors are caveated.');
  }
  if (request.family === 'dependencies') {
    const object = resolveObject(db, snapshot, schemas, request.object);
    const dependsOn = rows(db, `SELECT 'DEPENDS_ON' AS direction, source_schema_name, source_object_name, source_object_kind,
        target_schema_name, target_object_name, target_object_kind, target_db_link_name, native_dependency_kind, resolution_state, column_resolution_state
      FROM catalog_dependencies WHERE snapshot_sha256=? AND source_schema_name=? AND source_object_name=?
      ORDER BY target_schema_name, target_object_name`, [snapshot.snapshot_sha256, object.schema_name, object.object_name]);
    const usedBy = rows(db, `SELECT 'USED_BY' AS direction, source_schema_name, source_object_name, source_object_kind,
        target_schema_name, target_object_name, target_object_kind, target_db_link_name, native_dependency_kind, resolution_state, column_resolution_state
      FROM catalog_dependencies WHERE snapshot_sha256=? AND target_schema_name=? AND target_object_name=?
      ORDER BY source_schema_name, source_object_name`, [snapshot.snapshot_sha256, object.schema_name, object.object_name]);
    const data = [...dependsOn, ...usedBy]
      .sort((left, right) => compareText(left.direction, right.direction)
        || compareText(left.source_schema_name, right.source_schema_name)
        || compareText(left.source_object_name, right.source_object_name)
        || compareText(left.target_schema_name, right.target_schema_name)
        || compareText(left.target_object_name, right.target_object_name))
      .slice(0, limit);
    return answer(snapshot, request.family, data, coverageRows(db, snapshot, ['stored-dependencies']), 'Dependencies come only from visible native dependency metadata; dynamic SQL and denied collectors remain blind spots.');
  }
  if (request.family === 'stored_logic_signatures') {
    const whereObject = request.object ? resolveObject(db, snapshot, schemas, request.object) : null;
    const objectClause = whereObject ? 'AND object_name=? AND schema_name=?' : '';
    const data = rows(db, `SELECT category, schema_name, relation_name, object_name, object_kind, column_name, query_id, detail_json
      FROM catalog_facts WHERE snapshot_sha256=? AND schema_name IN (${scoped}) AND category IN ('stored-objects','stored-arguments','stored-errors') ${objectClause}
      ORDER BY schema_name, object_name, category, column_name LIMIT ?`, whereObject ? [...params, whereObject.object_name, whereObject.schema_name, limit] : [...params, limit]);
    return answer(snapshot, request.family, data, coverageRows(db, snapshot, ['stored-objects', 'stored-arguments', 'stored-errors']), 'Stored logic answers include metadata, signatures, hashes and issue metadata only; raw source/error text is excluded.');
  }
  if (request.family === 'scheduler_mv_refresh') {
    const data = rows(db, `SELECT category, schema_name, relation_name, object_name, object_kind, detail_json, query_id
      FROM catalog_facts WHERE snapshot_sha256=? AND schema_name IN (${scoped}) AND (query_id LIKE '%.operations.scheduler' OR query_id LIKE '%.structure.mview_refresh')
      ORDER BY schema_name, relation_name, object_name LIMIT ?`, [...params, limit]);
    return answer(snapshot, request.family, data, coverageRows(db, snapshot, ['operations']), 'Scheduler and materialized-view refresh state is shown only where metadata collectors succeeded.');
  }
  if (request.family === 'coverage_blind_spots') {
    const data = rows(db, `SELECT query_id, category, state, visibility, reason_code, row_count, empty_interpretation, caveat
      FROM technical_coverage_blind_spots WHERE snapshot_sha256=?
      ORDER BY CASE state WHEN 'DENIED' THEN 0 WHEN 'TIMEOUT' THEN 1 WHEN 'ERROR' THEN 2 WHEN 'PARTIAL' THEN 3 ELSE 4 END, query_id LIMIT ?`, [snapshot.snapshot_sha256, limit]);
    return answer(snapshot, request.family, data, coverageRows(db, snapshot, ['*']), 'Coverage states are authoritative; UNKNOWN or DENIED is never converted into absence.');
  }
  if (request.family === 'bi_relevance_candidates') {
    const data = rows(db, `SELECT schema_name, relation_name, relation_kind, deterministic_score, signal_summary, candidate_label
      FROM technical_bi_relevance_candidates WHERE snapshot_sha256=? AND schema_name IN (${scoped})
      ORDER BY deterministic_score DESC, schema_name, relation_name LIMIT ?`, [...params, limit]);
    return answer(snapshot, request.family, data, coverageRows(db, snapshot, ['relations', 'columns', 'comments', 'constraints', 'indexes', 'statistics']), 'BI relevance rows are deterministic technical candidates only; no business semantics are inferred.');
  }
  fail('CATALOG_QUESTION_UNSUPPORTED');
}

function coverageRows(db, snapshot, categories) {
  if (categories.includes('*')) return rows(db, 'SELECT * FROM catalog_extracts WHERE snapshot_sha256=? ORDER BY query_id', [snapshot.snapshot_sha256]);
  const clause = categories.map(() => '?').join(',');
  return rows(db, `SELECT * FROM catalog_extracts WHERE snapshot_sha256=? AND category IN (${clause}) ORDER BY query_id`, [snapshot.snapshot_sha256, ...categories]);
}
