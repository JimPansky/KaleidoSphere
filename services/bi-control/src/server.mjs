import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import sql from 'mssql';

import { answerCatalogQuestion, ingestCatalogReceipt, searchCatalog } from './catalog.mjs';
import { runAnalyzeProfile } from './db-analyzer/workflow.mjs';
import { coded, exactObject, validateActionRequest } from './policy.mjs';
import { buildLiveProfile, selectedEngine } from './runtime-config.mjs';

const port = Number(process.env.PORT ?? 18089);
const receiptDir = process.env.RECEIPT_DIR ?? '/var/lib/chimpmaera-bi/receipts';
const projectionDb = process.env.PROJECTION_DB ?? '/var/lib/chimpmaera-bi/projection/analytics.db';
const repositoryRoot = '/app';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const engine = selectedEngine();

async function secret(fileVariable, code) {
  const file = process.env[fileVariable];
  if (!file) throw coded(code);
  const value = (await readFile(file, 'utf8').catch(() => '')).trim();
  if (!value) throw coded(code);
  return value;
}

function authorized(request, token) {
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  const left = Buffer.from(supplied);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function bodyJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) throw coded('CONTROL_REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw coded('CONTROL_JSON_INVALID'); }
}

async function assertLivePrincipalReadOnly(profile, password) {
  const pool = await sql.connect({
    server: profile.adapter.host, port: profile.adapter.port, user: profile.adapter.user, password,
    database: profile.scope.database, connectionTimeout: profile.policy.maxQueryTimeoutMs,
    requestTimeout: profile.policy.maxQueryTimeoutMs,
    options: {encrypt: profile.adapter.encrypt, trustServerCertificate: profile.adapter.trustServerCertificate, readOnlyIntent: true, enableArithAbort: true},
  });
  try {
    const response = await pool.request().query(`SELECT
      DB_NAME() AS database_name,
      CAST(DATABASEPROPERTYEX(DB_NAME(), N'Updateability') AS nvarchar(32)) AS updateability,
      CAST(HAS_PERMS_BY_NAME(DB_NAME(), N'DATABASE', N'INSERT') AS int) AS can_insert,
      CAST(HAS_PERMS_BY_NAME(DB_NAME(), N'DATABASE', N'UPDATE') AS int) AS can_update,
      CAST(HAS_PERMS_BY_NAME(DB_NAME(), N'DATABASE', N'DELETE') AS int) AS can_delete,
      CAST(HAS_PERMS_BY_NAME(DB_NAME(), N'DATABASE', N'ALTER') AS int) AS can_alter,
      CAST(HAS_PERMS_BY_NAME(DB_NAME(), N'DATABASE', N'CONTROL') AS int) AS can_control`);
    const row = response.recordset?.[0];
    if (!row || row.database_name !== profile.scope.database) throw coded('DB_ANALYZE_SCOPE_MISMATCH');
    if ([row.can_insert, row.can_update, row.can_delete, row.can_alter, row.can_control].some((value) => value !== 0)) {
      throw coded('DB_ANALYZE_PRINCIPAL_NOT_READ_ONLY');
    }
    return {database: row.database_name, databaseUpdateability: row.updateability, principalDmlDdlPermissions: false, readOnlyIntent: true};
  } finally { await pool.close(); }
}

function extractRows(evidence, queryId) {
  return evidence.extracts.find((entry) => entry.queryId === queryId)?.rows ?? [];
}

async function writeProjection(receipt) {
  await mkdir(path.dirname(projectionDb), {recursive: true});
  const temporary = `${projectionDb}.${process.pid}.tmp`;
  const db = new DatabaseSync(temporary);
  try {
    db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE bi_analysis_summary (
        receipt_id TEXT PRIMARY KEY, source_engine TEXT NOT NULL, source_database TEXT NOT NULL, source_mode TEXT NOT NULL,
        runtime_validation TEXT NOT NULL, status TEXT NOT NULL, analyzed_at TEXT NOT NULL,
        relation_count INTEGER NOT NULL, column_count INTEGER NOT NULL,
        constraint_count INTEGER NOT NULL, index_count INTEGER NOT NULL,
        snapshot_sha256 TEXT NOT NULL UNIQUE, source_read_only INTEGER NOT NULL CHECK(source_read_only=1)
      );
      CREATE TABLE bi_analysis_detail (
        row_id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL, schema_name TEXT NOT NULL,
        relation_name TEXT NOT NULL, relation_kind TEXT NOT NULL, column_name TEXT NOT NULL,
        data_type TEXT NOT NULL, ordinal_position INTEGER NOT NULL, is_nullable INTEGER NOT NULL,
        FOREIGN KEY(receipt_id) REFERENCES bi_analysis_summary(receipt_id)
      );`);
    const relations = extractRows(receipt.analysis, `${receipt.engine}.structure.relations`);
    const columns = extractRows(receipt.analysis, `${receipt.engine}.structure.columns`);
    const constraints = extractRows(receipt.analysis, `${receipt.engine}.structure.constraints`);
    const indexes = extractRows(receipt.analysis, `${receipt.engine}.structure.indexes`);
    db.prepare(`INSERT INTO bi_analysis_summary VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(receipt.receiptId, receipt.engine, receipt.scope.database, receipt.sourceMode, receipt.analysis.runtimeValidation,
        receipt.status, receipt.analyzedAt, relations.length, columns.length, constraints.length, indexes.length,
        receipt.analysis.snapshotSha256, 1);
    const relationKinds = new Map(relations.map((row) => [`${row.schema_name}.${row.relation_name}`, row.relation_kind]));
    const statement = db.prepare(`INSERT INTO bi_analysis_detail VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const column of columns) {
      const rowId = sha256(`${receipt.receiptId}:${column.schema_name}:${column.relation_name}:${column.column_name}`);
      statement.run(rowId, receipt.receiptId, column.schema_name, column.relation_name,
        relationKinds.get(`${column.schema_name}.${column.relation_name}`) ?? column.relation_kind ?? 'UNKNOWN',
        column.column_name, column.data_type, Number(column.ordinal_position), column.is_nullable ? 1 : 0);
    }
    ingestCatalogReceipt(db, receipt);
  } finally { db.close(); }
  await rename(temporary, projectionDb);
  return sha256(await readFile(projectionDb));
}

async function analyze() {
  await mkdir(receiptDir, {recursive: true});
  const sourceMode = process.env.BI_SOURCE_MODE ?? 'fixture';
  let profileFile;
  let readOnlyEvidence;
  if (sourceMode === 'fixture') {
    if (engine !== 'mssql') throw coded('DB_ANALYZE_SOURCE_MODE_DENIED');
    profileFile = '/app/fixtures/mssql-profile-v1.json';
    readOnlyEvidence = {database: 'CM_BI_FIXTURE', databaseUpdateability: 'FIXTURE', principalDmlDdlPermissions: false, readOnlyIntent: true};
  } else if (sourceMode === 'live') {
    const passwordVariable = engine === 'mssql' ? 'MSSQL_PASSWORD_FILE' : 'ORACLE_PASSWORD_FILE';
    const passwordEnv = engine === 'mssql' ? 'CM_MSSQL_PASSWORD' : 'CM_ORACLE_PASSWORD';
    const password = await secret(passwordVariable, 'DB_ANALYZE_CREDENTIAL_MISSING');
    process.env[passwordEnv] = password;
    const profile = buildLiveProfile(process.env, passwordEnv);
    readOnlyEvidence = engine === 'mssql'
      ? await assertLivePrincipalReadOnly(profile, password)
      : {database: profile.scope.database, serviceName: profile.scope.container, principalDmlDdlPermissions: false, oracleThinMode: true, sourceScopeBound: true};
    profileFile = path.join(receiptDir, 'live-profile.json');
    await writeFile(profileFile, `${JSON.stringify(profile, null, 2)}\n`, {mode: 0o600});
  } else throw coded('DB_ANALYZE_SOURCE_MODE_DENIED');

  try {
    const analysis = await runAnalyzeProfile(profileFile, {repositoryRoot});
    const analyzedAt = new Date().toISOString();
    const receiptId = `${engine}-${sha256(`${analysis.snapshotSha256}:${sourceMode}:${analysis.profile.scope.database}`).slice(0, 24)}`;
    const receipt = {
      schemaVersion: 'chimpmaera.bi/analysis-receipt/v1', receiptId, status: 'ANALYZED_READ_ONLY', analyzedAt,
      sourceMode, engine, scope: analysis.profile.scope,
      safety: {queryPackSelectOnly: true, rowSamples: false, ...readOnlyEvidence}, analysis,
    };
    const projectionSha256 = await writeProjection(receipt);
    receipt.projection = {path: 'analytics.db', sha256: projectionSha256, tables: ['bi_analysis_summary', 'bi_analysis_detail']};
    const rendered = `${JSON.stringify(receipt, null, 2)}\n`;
    await writeFile(path.join(receiptDir, `${receiptId}.json`), rendered, {mode: 0o600});
    await writeFile(path.join(receiptDir, 'latest.json'), rendered, {mode: 0o600});
    return receipt;
  } finally {
    delete process.env.CM_MSSQL_PASSWORD;
    delete process.env.CM_ORACLE_PASSWORD;
  }
}

async function latestReceipt() {
  return JSON.parse(await readFile(path.join(receiptDir, 'latest.json'), 'utf8').catch(() => { throw coded('ANALYSIS_RECEIPT_MISSING'); }));
}

async function publish() {
  const receipt = await latestReceipt();
  const token = await secret('CONTROL_TOKEN_FILE', 'CONTROL_TOKEN_MISSING');
  const response = await fetch(process.env.SUPERSET_MATERIALIZER_URL, {
    method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
    body: JSON.stringify({receiptId: receipt.receiptId, snapshotSha256: receipt.analysis.snapshotSha256, projectionSha256: receipt.projection.sha256}),
    signal: AbortSignal.timeout(120000),
  });
  const result = await response.json().catch(() => ({code: 'SUPERSET_RESPONSE_INVALID'}));
  if (!response.ok) throw coded(result.code ?? 'SUPERSET_MATERIALIZATION_FAILED');
  await writeFile(path.join(receiptDir, 'latest-publish.json'), `${JSON.stringify(result, null, 2)}\n`, {mode: 0o600});
  return result;
}

async function readback() {
  const [receipt, publication] = await Promise.all([
    latestReceipt(),
    readFile(path.join(receiptDir, 'latest-publish.json'), 'utf8').then(JSON.parse).catch(() => null),
  ]);
  const db = new DatabaseSync(projectionDb, {readOnly: true});
  try {
    const summary = db.prepare('SELECT * FROM bi_analysis_summary WHERE receipt_id=?').get(receipt.receiptId);
    const detailCount = db.prepare('SELECT COUNT(*) AS count FROM bi_analysis_detail WHERE receipt_id=?').get(receipt.receiptId).count;
    const catalogSnapshot = db.prepare('SELECT snapshot_sha256, receipt_id, schema_version.value AS schema_version FROM catalog_snapshots JOIN catalog_meta schema_version ON schema_version.key=? WHERE catalog_snapshots.snapshot_sha256=? AND active=1').get('schema_version', receipt.analysis.snapshotSha256);
    const technicalOverview = {
      systemSchemaRows: db.prepare('SELECT COUNT(*) AS count FROM technical_system_schema_overview WHERE snapshot_sha256=?').get(receipt.analysis.snapshotSha256).count,
      tableCapacityRows: db.prepare('SELECT COUNT(*) AS count FROM technical_tables_capacity WHERE snapshot_sha256=?').get(receipt.analysis.snapshotSha256).count,
      codeDependencyRows: db.prepare('SELECT COUNT(*) AS count FROM technical_code_dependencies WHERE snapshot_sha256=?').get(receipt.analysis.snapshotSha256).count,
      coverageRows: db.prepare('SELECT COUNT(*) AS count FROM technical_coverage_blind_spots WHERE snapshot_sha256=?').get(receipt.analysis.snapshotSha256).count,
      biCandidateRows: db.prepare('SELECT COUNT(*) AS count FROM technical_bi_relevance_candidates WHERE snapshot_sha256=?').get(receipt.analysis.snapshotSha256).count,
    };
    if (!summary || summary.snapshot_sha256 !== receipt.analysis.snapshotSha256) throw coded('PROJECTION_READBACK_MISMATCH');
    if (!catalogSnapshot || catalogSnapshot.receipt_id !== receipt.receiptId) throw coded('CATALOG_READBACK_MISMATCH');
    return {schemaVersion: 'chimpmaera.bi/readback/v1', receiptId: receipt.receiptId, summary, detailCount, catalogSnapshot, technicalOverview, publication};
  } finally { db.close(); }
}

async function catalogQuestion(body) {
  const db = new DatabaseSync(projectionDb, {readOnly: true});
  try { return answerCatalogQuestion(db, body); }
  finally { db.close(); }
}

async function catalogSearch(body) {
  const db = new DatabaseSync(projectionDb, {readOnly: true});
  try { return searchCatalog(db, body); }
  finally { db.close(); }
}

function send(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store'});
  response.end(body);
}

const token = await secret('CONTROL_TOKEN_FILE', 'CONTROL_TOKEN_MISSING');
await mkdir(receiptDir, {recursive: true});
const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/healthz') return send(response, 200, {status: 'ok'});
    if (!authorized(request, token)) throw coded('CONTROL_AUTH_DENIED');
    if (request.method === 'GET' && request.url === '/v1/status') {
      const latest = await readFile(path.join(receiptDir, 'latest.json'), 'utf8').then(JSON.parse).catch(() => null);
      return send(response, 200, {status: 'READY', engine, sourceMode: process.env.BI_SOURCE_MODE ?? 'fixture',
        latestReceiptId: latest?.receiptId ?? null, scope: latest?.scope ?? null,
        catalogReady: latest?.analysis?.snapshotSha256 ? true : false});
    }
    if (request.method !== 'POST') throw coded('CONTROL_ROUTE_DENIED');
    const body = await bodyJson(request);
    if (request.url === '/v1/analyze') { validateActionRequest(body, 'analyze'); return send(response, 200, await analyze()); }
    if (request.url === '/v1/publish') { validateActionRequest(body, 'publish'); return send(response, 200, await publish()); }
    if (request.url === '/v1/readback') { validateActionRequest(body, 'readback'); return send(response, 200, await readback()); }
    if (request.url === '/v1/catalog/question') return send(response, 200, await catalogQuestion(body));
    if (request.url === '/v1/catalog/search') return send(response, 200, await catalogSearch(body));
    exactObject(body, []); throw coded('CONTROL_ROUTE_DENIED');
  } catch (error) {
    const code = String(error.code ?? error.message ?? 'CONTROL_INTERNAL_ERROR').replace(/[^A-Z0-9_]/g, '_').slice(0, 128);
    send(response, code === 'CONTROL_AUTH_DENIED' ? 401 : 400, {status: 'DENIED', code});
  }
});
server.listen(port, '0.0.0.0');
