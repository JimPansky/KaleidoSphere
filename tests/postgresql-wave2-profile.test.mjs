import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {
  compilePostgresqlWave2ProfileDispatches,
  runPostgresqlWave2Profiles,
  validatePostgresqlWave2Manifest,
} from '../services/bi-control/src/db-analyzer/postgresql-wave2.mjs';

const profile = (overrides = {}) => ({
  schemaVersion: 'chimpmaera.db/analyze-profile/v1',
  profileId: 'ks23-postgres-e2e-v1',
  engine: 'postgresql',
  mode: 'RUNTIME',
  queryPack: {version: 'v1'},
  scope: {database: 'ks23_e2e', container: null, schemas: ['ks23_app']},
  policy: {
    access: 'READ_ONLY',
    allowRowSamples: false,
    maxQueryTimeoutMs: 5000,
    postgresqlAnalysis: {
      schemaVersion: 'kaleidosphere.analysis/postgresql-wave2-policy/v1',
      enabled: true,
      profileTargets: [
        {schemaName: 'ks23_app', relationName: 'accounts', columnName: 'account_id'},
        {schemaName: 'ks23_app', relationName: 'staging_events', columnName: 'account_id'},
      ],
      sensitiveTargets: [],
      relationshipCandidates: {enabled: true, nameMatch: 'EXACT_COLUMN_NAME', minimumConfidenceBasisPoints: 7500},
      budgets: {maxProfileTargets: 4, maxRelationshipCandidates: 4, maxQueries: 8, maxQueryTimeoutMs: 5000},
      disclosure: {allowRawValues: false, allowExampleValues: false, allowDistributions: false},
      ...overrides,
    },
  },
  adapter: {
    kind: 'postgresql', host: '127.0.0.1', port: 5432, user: 'ks23_scan',
    passwordEnv: 'KS_WAVE2_TEST_PASSWORD', ssl: false, connectTimeoutMs: 5000,
  },
});

async function fixture() {
  const directory = 'services/bi-control/query-packs/db-analyzer/v1/postgresql';
  const [structureEvidence, manifest] = await Promise.all([
    readFile('docs/evidence/postgresql-e2e/run-1/evidence.canonical.json', 'utf8').then(JSON.parse),
    readFile(`${directory}/analysis-wave2-manifest.json`, 'utf8').then(JSON.parse),
  ]);
  const sqlByMethodId = Object.fromEntries(await Promise.all(manifest.methods.map(async (method) => [
    method.id, await readFile(`${directory}/${method.file}`, 'utf8'),
  ])));
  return {structureEvidence, manifest, sqlByMethodId};
}

test('Wave 2 profile pack is hash-bound and compiles only exact scoped aggregate targets', async () => {
  const {structureEvidence, manifest, sqlByMethodId} = await fixture();
  validatePostgresqlWave2Manifest(manifest, sqlByMethodId);
  const first = compilePostgresqlWave2ProfileDispatches({profile: profile(), structureEvidence, manifest, sqlByMethodId});
  const second = compilePostgresqlWave2ProfileDispatches({profile: profile(), structureEvidence, manifest, sqlByMethodId});
  assert.deepEqual(second, first);
  assert.equal(first.length, 2);
  assert.match(first[0].statement, /FROM "ks23_app"\."accounts"/);
  assert.match(first[0].statement, /COUNT\(DISTINCT "account_id"\)/i);
  assert.deepEqual(first[0].values, []);
  assert.equal(first.every((entry) => entry.readOnly && entry.aggregateOnly && entry.parameterCount === 0), true);
  assert.equal(JSON.stringify(first).includes('KS23_RAW_ROW_CANARY'), false);

  const tampered = {...manifest, methods: manifest.methods.map((method) => ({...method, templateSha256: '0'.repeat(64)}))};
  assert.throws(() => validatePostgresqlWave2Manifest(tampered, sqlByMethodId), /DB_WAVE2_TEMPLATE_HASH_MISMATCH/);
});

test('Wave 2 rejects out-of-scope and sensitive targets before any runtime dispatch', async () => {
  const {structureEvidence, manifest, sqlByMethodId} = await fixture();
  assert.throws(() => compilePostgresqlWave2ProfileDispatches({
    profile: profile({profileTargets: [{schemaName: 'ks23_outside', relationName: 'secret_decoy', columnName: 'decoy_value'}]}),
    structureEvidence, manifest, sqlByMethodId,
  }), /DB_WAVE2_PROFILE_SCOPE_INVALID/);
  assert.throws(() => compilePostgresqlWave2ProfileDispatches({
    profile: profile({sensitiveTargets: [{schemaName: 'ks23_app', relationName: 'accounts', columnName: 'account_id', classification: 'SENSITIVE'}]}),
    structureEvidence, manifest, sqlByMethodId,
  }), /DB_WAVE2_SENSITIVE_TARGET_DENIED/);
});

test('Wave 2 runtime accepts only deterministic count rows and closes its read-only pool', async () => {
  const {structureEvidence, manifest, sqlByMethodId} = await fixture();
  const events = [];
  class FakeClient {
    async query(input) {
      const text = typeof input === 'string' ? input : input.text;
      events.push(text);
      if (text.includes("current_setting('transaction_read_only')")) {
        return {rows: [{transaction_read_only: 'on', default_transaction_read_only: 'on'}]};
      }
      if (typeof input === 'object') return {rows: [{row_count: '3', null_count: '1', distinct_count: '2'}]};
      return {rows: []};
    }
    release(destroy) { events.push(`release:${destroy}`); }
  }
  class FakePool {
    async connect() { events.push('connect'); return new FakeClient(); }
    async end() { events.push('end'); }
  }
  process.env.KS_WAVE2_TEST_PASSWORD = 'fixture-only-password';
  const evidence = await runPostgresqlWave2Profiles({
    profile: profile(), structureEvidence, manifest, sqlByMethodId, driver: {Pool: FakePool},
  });
  delete process.env.KS_WAVE2_TEST_PASSWORD;
  assert.equal(evidence.runtimeValidation, 'RUNTIME_VALIDATED');
  assert.equal(evidence.factCount, 2);
  assert.deepEqual(evidence.facts[0].metrics, {distinctCount: 2, nullCount: 1, rowCount: 3});
  assert.equal(evidence.facts.every((fact) => fact.observationKind === 'OBSERVED' && fact.claimStatus === 'MEASURED_AGGREGATE'), true);
  assert.deepEqual(evidence.disclosure, {
    aggregateCountsOnly: true, distributionsPersisted: false, labelsPersisted: false, rowMaterialPersisted: false,
  });
  assert.ok(events.includes('BEGIN READ ONLY'));
  assert.ok(events.includes('COMMIT'));
  assert.ok(events.includes('release:true'));
  assert.equal(events.at(-1), 'end');
  assert.doesNotMatch(JSON.stringify(evidence), /sampleValue|exampleValue|rawValue/i);
});

test('Wave 2 rejects inconsistent aggregate metrics and returns no partial evidence', async () => {
  const {structureEvidence, manifest, sqlByMethodId} = await fixture();
  class FakeClient {
    async query(input) {
      const text = typeof input === 'string' ? input : input.text;
      if (text.includes("current_setting('transaction_read_only')")) {
        return {rows: [{transaction_read_only: 'on', default_transaction_read_only: 'on'}]};
      }
      if (typeof input === 'object') return {rows: [{row_count: '2', null_count: '1', distinct_count: '2'}]};
      return {rows: []};
    }
    release() {}
  }
  class FakePool { async connect() { return new FakeClient(); } async end() {} }
  process.env.KS_WAVE2_TEST_PASSWORD = 'fixture-only-password';
  await assert.rejects(() => runPostgresqlWave2Profiles({
    profile: profile(), structureEvidence, manifest, sqlByMethodId, driver: {Pool: FakePool},
  }), /DB_WAVE2_PROFILE_RESULT_INVALID/);
  delete process.env.KS_WAVE2_TEST_PASSWORD;
});
