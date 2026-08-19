import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {compilePostgresqlProfileQuery} from '../services/bi-control/src/db-analyzer/postgresql-adapter.mjs';
import {runPostgresqlControlledProbe, runPostgresqlQueries} from '../services/bi-control/src/db-analyzer/postgresql-runtime.mjs';
import {validateOrThrow} from '../services/bi-control/src/graph-pilot/schema-validator.mjs';

const profile = {
  engine: 'postgresql',
  mode: 'RUNTIME',
  scope: {database: 'ks23_e2e', container: null, schemas: ['ks23_app']},
  policy: {access: 'READ_ONLY', allowRowSamples: false, maxQueryTimeoutMs: 5000},
  adapter: {
    kind: 'postgresql', host: '127.0.0.1', port: 5432, user: 'ks23_scan',
    passwordEnv: 'KS23_TEST_PASSWORD', ssl: false, connectTimeoutMs: 5000
  }
};

const query = {
  id: 'postgresql.structure.schemas',
  category: 'schemas',
  outputColumns: ['schema_name'],
  sortKeys: ['schema_name'],
  scopeColumn: 'schema_name'
};

test('PostgreSQL runtime binds the frozen profile scope and rejects an override before dispatch', () => {
  const statement = 'SELECT namespace.nspname AS schema_name FROM pg_catalog.pg_namespace AS namespace;';
  const compiled = compilePostgresqlProfileQuery({profile, query, statement});
  assert.deepEqual(compiled.values, ['ks23_app']);
  assert.match(compiled.statement, /IN \(\$1\)/);
  assert.throws(() => compilePostgresqlProfileQuery({
    profile, query, statement, requestedSchemas: ['ks23_outside']
  }), /DB_ANALYZE_SCOPE_OVERRIDE_DENIED/);
});

test('PostgreSQL runtime opens a read-only transaction, projects exact columns and closes the pool', async () => {
  const events = [];
  class FakeClient {
    async query(input) {
      const text = typeof input === 'string' ? input : input.text;
      events.push(text);
      if (text.includes("current_setting('transaction_read_only')")) {
        return {rows: [{transaction_read_only: 'on', default_transaction_read_only: 'on'}]};
      }
      if (text.includes('FROM (SELECT')) return {rows: [{schema_name: 'ks23_app', ignored: 'not-projected'}]};
      return {rows: []};
    }
    release(destroy) { events.push(`release:${destroy}`); }
  }
  class FakePool {
    async connect() { events.push('connect'); return new FakeClient(); }
    async end() { events.push('end'); }
  }
  class FakeDriverClient {}
  process.env.KS23_TEST_PASSWORD = 'fixture-only-password';
  const result = await runPostgresqlQueries({
    profile,
    manifest: {queries: [query]},
    entries: [[query.id, 'SELECT namespace.nspname AS schema_name FROM pg_catalog.pg_namespace AS namespace;']],
    driver: {Pool: FakePool, Client: FakeDriverClient}
  });
  delete process.env.KS23_TEST_PASSWORD;
  assert.deepEqual(result.results[query.id].rows, [{schema_name: 'ks23_app'}]);
  assert.ok(events.includes('BEGIN READ ONLY'));
  assert.ok(events.includes('COMMIT'));
  assert.ok(events.includes('release:true'));
  assert.equal(events.at(-1), 'end');
});

test('controlled probes expose only the closed timeout/cancel registry', async () => {
  await assert.rejects(() => runPostgresqlControlledProbe({
    profile, password: 'fixture-only-password', probeId: 'free-sql'
  }), /DB_ANALYZE_POSTGRESQL_PROBE_INVALID/);
  await assert.rejects(() => runPostgresqlControlledProbe({
    profile, password: 'fixture-only-password', probeId: 'cancel', abortAfterMs: 1
  }), /DB_ANALYZE_POSTGRESQL_PROBE_INVALID/);
});

test('the E2E fixture and Compose harness are isolated, digest-pinned and contain the required blind spots', async () => {
  const [compose, fixture] = await Promise.all([
    readFile('tests/fixtures/postgresql-e2e/compose.yaml', 'utf8'),
    readFile('tests/fixtures/postgresql-e2e/fixture.sql', 'utf8')
  ]);
  assert.match(compose, /postgres@sha256:94f23d40fdaf5e60cb2fd8a98c22f02a7b8724949f310d95a0ddf075e8c8b208/);
  assert.match(compose, /target: 5432/);
  assert.match(compose, /published: \$\{KS23_HOST_PORT:/);
  assert.match(compose, /host_ip: 127\.0\.0\.1/);
  assert.match(compose, /ks23_private:[\s\S]+driver: bridge/);
  assert.doesNotMatch(compose, /18789|8000|8081|docker\.sock|privileged:/);
  assert.match(fixture, /NOT VALID/);
  assert.match(fixture, /CREATE UNIQUE INDEX[\s\S]+WHERE event_id > 0/);
  assert.match(fixture, /ks23_outside\.secret_decoy/);
  assert.match(fixture, /KS23_RAW_ROW_CANARY_17F2C3/);
  assert.doesNotMatch(fixture, /postgres(?:ql)?:\/\//i);
});

test('the machine readback schema is closed and hash-bound', async () => {
  const schema = JSON.parse(await readFile('contracts/postgresql-e2e/v1/readback.schema.json', 'utf8'));
  const hash = 'a'.repeat(64);
  const valid = {
    schemaVersion: 'kaleidosphere.db/postgresql-e2e-readback/v1',
    fixtureId: 'ks23-postgres-e2e-v1',
    image: {
      reference: 'docker.io/library/postgres@sha256:94f23d40fdaf5e60cb2fd8a98c22f02a7b8724949f310d95a0ddf075e8c8b208',
      platform: 'linux/amd64',
      manifestDigest: 'sha256:94f23d40fdaf5e60cb2fd8a98c22f02a7b8724949f310d95a0ddf075e8c8b208'
    },
    canonicalEvidence: {run1Sha256: hash, run2Sha256: hash, byteIdentical: true, diskReadbackValidated: true, runtimeValidated: true},
    groundTruth: {beforeSha256: hash, afterSha256: hash, unchanged: true, schemas: 1, relations: 3, columns: 13, constraints: 9, foreignKeys: 1, notValidatedChecks: 1, partialUniqueIndexes: 1},
    session: {transactionReadOnly: 'on', defaultTransactionReadOnly: 'on', roleName: 'ks23_scan', adminCapabilities: false, boundedTimeouts: true},
    negativeProbes: {mutationPolicyDispatches: 0, rawRowPolicyDispatches: 0, scopeOverrideDispatches: 0, databaseMutationSqlState: '25006', databaseDdlSqlState: '25006', timeoutState: 'TIMEOUT', timeoutSqlState: '57014', cancelState: 'CANCELLED', cancelSqlState: '57014', activeFollowers: 0, postProbeHealthy: true, noPartialEvidence: true},
    privacy: {rawRowCanaryMatches: 0, outsideCanaryMatches: 0, credentialCanaryMatches: 0, dsnMatches: 0, rawValueFields: 0},
    nonClaims: ['local synthetic evidence only']
  };
  assert.equal(validateOrThrow(valid, schema), true);
  assert.throws(() => validateOrThrow({...valid, rawRows: []}, schema), /SCHEMA_VALIDATION_FAILED/);
});

test('the cleanup receipt schema requires zero owned resources and unchanged inventories', async () => {
  const schema = JSON.parse(await readFile('contracts/postgresql-e2e/v1/cleanup.schema.json', 'utf8'));
  const hash = 'b'.repeat(64);
  const receipt = {
    schemaVersion: 'kaleidosphere.db/postgresql-e2e-cleanup/v1',
    ownedResources: {containers: 0, networks: 0, volumes: 0},
    secretDirectoryAbsent: true,
    preexistingInventory: {
      unchanged: true, containerCount: 13, networkCount: 16, volumeCount: 31,
      containersSha256: hash, networksSha256: hash, volumesSha256: hash
    },
    gateway: {unchanged: true, active: true, inventorySha256: hash}
  };
  assert.equal(validateOrThrow(receipt, schema), true);
  assert.throws(() => validateOrThrow({...receipt, ownedResources: {...receipt.ownedResources, volumes: 1}}, schema), /SCHEMA_VALIDATION_FAILED/);
});
