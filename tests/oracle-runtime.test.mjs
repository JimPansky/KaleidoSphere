import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { buildPreflightEvidence, validateAnalyzeProfile } from '../services/bi-control/src/db-analyzer/core.mjs';
import {
  assertOracleReadOnlyCapabilities,
  compileOracleScopedQuery,
  runOracleQueries,
} from '../services/bi-control/src/db-analyzer/workflow.mjs';
import { auditCatalogQuery, auditQueryPackSafety } from '../services/bi-control/src/db-analyzer/query-safety.mjs';
import { buildLiveProfile, buildOracleConnectString, selectedEngine } from '../services/bi-control/src/runtime-config.mjs';

const env = {
  BI_ENGINE: 'oracle', ORACLE_HOST: 'oracle-test', ORACLE_PORT: '1521', ORACLE_DATABASE: 'FREE',
  ORACLE_SERVICE_NAME: 'FREEPDB1', ORACLE_USER: 'BI_ANALYZE', ORACLE_SCHEMAS: 'BI_DEMO',
  ORACLE_PROTOCOL: 'tcp', ORACLE_CONNECT_TIMEOUT_MS: '9000', ORACLE_QUERY_TIMEOUT_MS: '7000',
};

const pack = async () => {
  const directory = 'services/bi-control/query-packs/db-analyzer/v1/oracle';
  const manifest = JSON.parse(await readFile(`${directory}/manifest.json`, 'utf8'));
  const entries = await Promise.all(manifest.queries.map(async (query) => [query.id, await readFile(`${directory}/${query.file}`, 'utf8')]));
  return {manifest, entries, sqlByQueryId: Object.fromEntries(entries)};
};

test('Oracle config is explicit, bounded, Thin-compatible, and contains no password', () => {
  assert.equal(selectedEngine(env), 'oracle'); // Oracle probe 1
  assert.throws(() => selectedEngine({}), /CONFIG_BI_ENGINE_INVALID/); // probe 2
  assert.throws(() => selectedEngine({BI_ENGINE: 'postgres'}), /CONFIG_BI_ENGINE_INVALID/); // probe 3
  const profile = buildLiveProfile(env, 'CM_ORACLE_PASSWORD');
  assert.equal(validateAnalyzeProfile(profile), profile); // probe 4
  assert.deepEqual(profile.scope, {database: 'FREE', container: 'FREEPDB1', schemas: ['BI_DEMO']}); // probe 5
  assert.equal(profile.adapter.protocol, 'tcp'); // probe 6
  assert.equal(profile.policy.maxQueryTimeoutMs, 7000); // probe 7
  assert.equal(JSON.stringify(profile).includes('password'), true); // only passwordEnv field; probe 8
  assert.equal(JSON.stringify(profile).includes('secret-value'), false); // probe 9
  assert.match(buildOracleConnectString(profile.adapter), /SERVICE_NAME=FREEPDB1/); // probe 10
  assert.throws(() => buildLiveProfile({...env, ORACLE_PROTOCOL: 'udp'}, 'CM_ORACLE_PASSWORD'), /DB_ANALYZE_CONFIG_INVALID/); // probe 11
  assert.throws(() => buildLiveProfile({...env, ORACLE_SCHEMAS: 'BI_DEMO,bad schema'}, 'CM_ORACLE_PASSWORD'), /DB_ANALYZE_SCHEMA_SCOPE_INVALID|DB_ANALYZE_CONFIG_INVALID/); // probe 12
});

test('the M2 Oracle technical inventory pack is SELECT-only, row-sample-free, redacted, and bind-scoped', async () => {
  const {manifest, sqlByQueryId} = await pack();
  const audit = auditQueryPackSafety({manifest, sqlByQueryId});
  assert.equal(manifest.queries.length, 24); // probe 13
  assert.equal(audit.queryCount, 24); // probe 14
  assert.equal(audit.zeroMutatingStatements, true); // probe 15
  assert.equal(audit.zeroRowSamples, true); // probe 16
  assert.deepEqual(new Set(manifest.queries.map((query) => query.category)), new Set([
    'preflight', 'schemas', 'relations', 'columns', 'comments', 'constraints', 'indexes',
    'sequences', 'synonyms', 'partitions', 'lobs', 'tablespaces', 'statistics', 'sizes',
    'stored-objects', 'stored-arguments', 'stored-errors', 'stored-dependencies',
    'operations', 'db-links',
  ])); // probe 16b
  for (const query of manifest.queries) {
    assert.equal(query.readOnly, true);
    assert.doesNotMatch(query.outputColumns.join(','), /\b(?:source_text|trigger_body|job_action|program_action|username|password|host)\b/i);
  }
  const storedObjects = manifest.queries.find((query) => query.id === 'oracle.stored.objects');
  assert(storedObjects.outputColumns.includes('source_hash_sha256')); // probe 16c
  assert(storedObjects.outputColumns.includes('source_line_count')); // probe 16d
  const dbLinks = manifest.queries.find((query) => query.id === 'oracle.operations.db_links');
  assert(dbLinks.outputColumns.includes('target_host_sha256')); // probe 16e
  assert(dbLinks.outputColumns.includes('credential_policy')); // probe 16f
  const relation = manifest.queries.find((query) => query.id === 'oracle.structure.relations');
  const compiled = compileOracleScopedQuery(relation, sqlByQueryId[relation.id], ['BI_DEMO']);
  assert.deepEqual(compiled.binds, {scope0: 'BI_DEMO'}); // probe 17
  assert.match(compiled.statement, /IN \(:scope0\)/); // probe 18
  assert.equal(compiled.statement.includes('BI_DEMO'), false); // probe 19
  assert.throws(() => auditCatalogQuery({engine: 'oracle', queryId: 'probe', sql: 'DELETE FROM all_objects;'}), /DB_QUERY_SELECT_ONLY_DENIED/); // probe 20
  assert.throws(() => auditCatalogQuery({engine: 'oracle', queryId: 'probe', sql: 'SELECT owner FROM all_objects; DROP TABLE x;'}), /DB_QUERY_MUTATION_DENIED/); // probe 21
});

test('Oracle M2 coverage ledger distinguishes visible, denied, and unknown states without empty-success inference', async () => {
  const {manifest, sqlByQueryId} = await pack();
  const profile = buildLiveProfile(env, 'CM_ORACLE_PASSWORD');
  const results = Object.fromEntries(manifest.queries.map((query) => [query.id, {state: 'SUCCEEDED', reasonCode: null, rows: []}]));
  results['oracle.preflight.identity'] = {state: 'SUCCEEDED', reasonCode: null, rows: [{
    engine: 'oracle', engine_version: '26ai-free', engine_edition: null, database_name: 'FREE', container_name: 'FREEPDB1', compatibility_level: null,
  }]};
  results['oracle.preflight.rights'] = {state: 'SUCCEEDED', reasonCode: null, rows: [
    {permission_name: 'SYSTEM:CREATE SESSION', has_permission: 1},
    {permission_name: 'OBJECT:SELECT:BI_DEMO.ORDERS', has_permission: 1},
  ]};
  results['oracle.structure.schemas'] = {state: 'SUCCEEDED', reasonCode: null, rows: [{schema_name: 'BI_DEMO'}]};
  results['oracle.size.segments'] = {state: 'DENIED', reasonCode: 'ORA_01031', rows: []};
  results['oracle.operations.scheduler'] = {state: 'ERROR', reasonCode: 'ORA_00942', rows: []};
  const evidence = buildPreflightEvidence({
    manifest,
    sqlByQueryId,
    resultSets: {schemaVersion: 'chimpmaera.db/runtime-query-results/v1', engine: 'oracle', runtimeValidated: true, results},
    profileContext: {
      profileId: profile.profileId, mode: profile.mode, scope: profile.scope, policy: profile.policy, adapter: profile.adapter.kind,
    },
  });
  const byId = new Map(evidence.coverageLedger.entries.map((entry) => [entry.queryId, entry]));
  assert.equal(byId.get('oracle.structure.schemas').visibility, 'VISIBLE_COMPLETE'); // probe 21b
  assert.equal(byId.get('oracle.structure.schemas').emptyInterpretation, 'NOT_CLAIMED'); // probe 21c
  assert.equal(byId.get('oracle.size.segments').visibility, 'INVISIBLE'); // probe 21d
  assert.equal(byId.get('oracle.size.segments').emptyInterpretation, 'NOT_CLAIMED'); // probe 21e
  assert.equal(byId.get('oracle.operations.scheduler').visibility, 'UNKNOWN'); // probe 21f
  assert.equal(evidence.coverageLedger.allComplete, false); // probe 21g
});

test('Oracle read-only preflight rejects known system, DML, and out-of-scope capabilities', () => {
  const profile = buildLiveProfile(env, 'CM_ORACLE_PASSWORD');
  assert.doesNotThrow(() => assertOracleReadOnlyCapabilities(profile, [
    {permission_name: 'SYSTEM:CREATE SESSION', has_permission: 1},
    {permission_name: 'SYSTEM:SET CONTAINER', has_permission: 1},
    {permission_name: 'OBJECT:SELECT:BI_DEMO.ORDERS', has_permission: 1},
    {permission_name: 'OBJECT:EXECUTE:BI_DEMO.M2_PKG', has_permission: 1},
  ])); // probe 22
  assert.throws(() => assertOracleReadOnlyCapabilities(profile, [{permission_name: 'SYSTEM:CREATE TABLE', has_permission: 1}]), /DB_ANALYZE_ORACLE_PREFLIGHT_FAILED|DB_ANALYZE_PRINCIPAL_NOT_READ_ONLY/); // probe 23
  assert.throws(() => assertOracleReadOnlyCapabilities(profile, [
    {permission_name: 'SYSTEM:CREATE SESSION', has_permission: 1},
    {permission_name: 'OBJECT:UPDATE:BI_DEMO.ORDERS', has_permission: 1},
  ]), /DB_ANALYZE_PRINCIPAL_NOT_READ_ONLY/); // probe 24
  assert.throws(() => assertOracleReadOnlyCapabilities(profile, [
    {permission_name: 'SYSTEM:CREATE SESSION', has_permission: 1},
    {permission_name: 'COLUMN_OBJECT:UPDATE:BI_DEMO.ORDERS.STATUS', has_permission: 1},
  ]), /DB_ANALYZE_PRINCIPAL_NOT_READ_ONLY/); // probe 24b
  assert.throws(() => assertOracleReadOnlyCapabilities(profile, [
    {permission_name: 'SYSTEM:CREATE SESSION', has_permission: 1},
    {permission_name: 'OBJECT:SELECT:OTHER.SECRETS', has_permission: 1},
  ]), /DB_ANALYZE_PRINCIPAL_NOT_READ_ONLY/); // probe 25
  assert.throws(() => assertOracleReadOnlyCapabilities(profile, [
    {permission_name: 'SYSTEM:CREATE SESSION', has_permission: 1},
    {permission_name: 'OBJECT:EXECUTE:OTHER.DO_WORK', has_permission: 1},
  ]), /DB_ANALYZE_PRINCIPAL_NOT_READ_ONLY/); // probe 25b
});

test('Oracle driver preflight errors still close the connection and pool', async () => {
  const {manifest, entries} = await pack();
  const profile = buildLiveProfile(env, 'CM_ORACLE_PASSWORD');
  let connectionClosed = 0;
  let poolClosed = 0;
  const driver = {
    thin: true,
    OUT_FORMAT_OBJECT: 4002,
    async createPool() {
      return {
        async getConnection() { return {async execute() { const error = new Error('ORA-01031'); error.errorNum = 1031; throw error; }, async close() { connectionClosed += 1; }}; },
        async close() { poolClosed += 1; },
      };
    },
  };
  process.env.CM_ORACLE_PASSWORD = ['ephemeral', 'test', 'only'].join('-');
  try {
    await assert.rejects(() => runOracleQueries({profile, manifest, entries, driver}), /DB_ANALYZE_ORACLE_PREFLIGHT_FAILED/); // probe 26
  } finally {
    delete process.env.CM_ORACLE_PASSWORD;
  }
  assert.equal(connectionClosed, 1); // probe 27
  assert.equal(poolClosed, 1); // probe 28
});
