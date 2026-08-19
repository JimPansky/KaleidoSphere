import assert from 'node:assert/strict';
import test from 'node:test';

import { validateAnalyzeProfile } from '../services/bi-control/src/db-analyzer/core.mjs';
import {
  assertPostgresqlReadOnlySession,
  buildPostgresqlConnectionOptions,
  compilePostgresqlScopedQuery,
} from '../services/bi-control/src/db-analyzer/postgresql-adapter.mjs';
import { auditCatalogQuery } from '../services/bi-control/src/db-analyzer/query-safety.mjs';
import { buildLiveProfile, selectedEngine } from '../services/bi-control/src/runtime-config.mjs';

const env = {
  BI_ENGINE: 'postgresql', POSTGRESQL_HOST: 'postgres-test', POSTGRESQL_PORT: '5432',
  POSTGRESQL_DATABASE: 'kaleidosphere', POSTGRESQL_USER: 'bi_analyze',
  POSTGRESQL_SCHEMAS: 'public,reporting', POSTGRESQL_SSL: 'true',
  POSTGRESQL_CONNECT_TIMEOUT_MS: '9000', POSTGRESQL_QUERY_TIMEOUT_MS: '7000',
};

const query = {
  id: 'postgresql.structure.tables',
  scopeColumn: 'schema_name',
  outputColumns: ['schema_name', 'table_name'],
  sortKeys: ['schema_name', 'table_name'],
};
const catalogSql = 'SELECT table_schema AS schema_name, table_name FROM information_schema.tables;';

test('PostgreSQL configuration is explicit, bounded, and credential-free', () => {
  assert.equal(selectedEngine(env), 'postgresql');
  assert.throws(() => selectedEngine({...env, BI_ENGINE: 'postgres'}), /CONFIG_BI_ENGINE_INVALID/);
  const profile = buildLiveProfile(env, 'CM_POSTGRESQL_PASSWORD');
  assert.equal(validateAnalyzeProfile(profile), profile);
  assert.deepEqual(profile.scope, {database: 'kaleidosphere', container: null, schemas: ['public', 'reporting']});
  assert.equal(profile.policy.maxQueryTimeoutMs, 7000);
  assert.equal(profile.profileId, buildLiveProfile(env, 'A_DIFFERENT_PASSWORD_ENV').profileId);
  assert.equal(JSON.stringify(profile).includes('credential-value-must-not-appear'), false);
  assert.throws(() => buildLiveProfile({...env, POSTGRESQL_SCHEMAS: 'public,bad schema'}, 'CM_POSTGRESQL_PASSWORD'), /DB_ANALYZE_CONFIG_INVALID|DB_ANALYZE_SCHEMA_SCOPE_INVALID/);
  assert.throws(() => buildLiveProfile({...env, POSTGRESQL_QUERY_TIMEOUT_MS: '120001'}, 'CM_POSTGRESQL_PASSWORD'), /CONFIG_POSTGRESQL_QUERY_TIMEOUT_MS_INVALID/);
  assert.throws(() => buildLiveProfile({...env, POSTGRESQL_CONNECT_TIMEOUT_MS: '999'}, 'CM_POSTGRESQL_PASSWORD'), /CONFIG_POSTGRESQL_CONNECT_TIMEOUT_MS_INVALID/);
});

test('PostgreSQL connection contract enforces read-only startup and bounded timeouts', () => {
  const profile = buildLiveProfile(env, 'CM_POSTGRESQL_PASSWORD');
  const options = buildPostgresqlConnectionOptions(profile, 'ephemeral-test-only');
  assert.equal(options.options, '-c default_transaction_read_only=on');
  assert.equal(options.statement_timeout, 7000);
  assert.equal(options.query_timeout, 7000);
  assert.equal(options.connectionTimeoutMillis, 9000);
  assert.equal(options.application_name, 'kaleidosphere-read-only-analyzer');
  assert.deepEqual(options.ssl, {rejectUnauthorized: true});
  assert.throws(() => buildPostgresqlConnectionOptions(profile, ''), /DB_ANALYZE_POSTGRESQL_CONFIG_INVALID/);
  assert.throws(() => buildPostgresqlConnectionOptions({...profile, policy: {...profile.policy, access: 'READ_WRITE'}}, 'ephemeral-test-only'), /DB_ANALYZE_POSTGRESQL_CONFIG_INVALID/);
});

test('PostgreSQL scoped queries use values and reject unsafe identifiers or SQL fragments', () => {
  const compiled = compilePostgresqlScopedQuery(query, catalogSql, ['public', 'reporting']);
  assert.deepEqual(compiled.values, ['public', 'reporting']);
  assert.match(compiled.statement, /IN \(\$1, \$2\)/);
  assert.equal(compiled.statement.includes("'public'"), false);
  assert.throws(() => compilePostgresqlScopedQuery(query, 'DELETE FROM information_schema.tables', ['public']), /DB_QUERY_SELECT_ONLY_DENIED/);
  assert.throws(() => compilePostgresqlScopedQuery(query, `${catalogSql} DROP TABLE x;`, ['public']), /DB_QUERY_MUTATION_DENIED/);
  assert.throws(() => compilePostgresqlScopedQuery(query, `${catalogSql} SELECT table_name FROM information_schema.tables;`, ['public']), /DB_QUERY_MULTI_STATEMENT_DENIED/);
  assert.throws(() => compilePostgresqlScopedQuery(query, 'SELECT id FROM public.customers;', ['public']), /DB_QUERY_ROW_SOURCE_DENIED/);
  assert.throws(() => compilePostgresqlScopedQuery({...query, scopeColumn: 'schema_name;DROP'}, catalogSql, ['public']), /DB_ANALYZE_QUERY_CONTRACT_INVALID/);
});

test('PostgreSQL catalog allowlist and runtime session proof fail closed', () => {
  assert.doesNotThrow(() => auditCatalogQuery({engine: 'postgresql', queryId: query.id, sql: catalogSql}));
  assert.throws(() => auditCatalogQuery({engine: 'postgresql', queryId: 'probe', sql: 'SELECT id FROM public.customers;'}), /DB_QUERY_ROW_SOURCE_DENIED/);
  assert.throws(() => auditCatalogQuery({engine: 'postgresql', queryId: 'probe', sql: 'SELECT table_name FROM information_schema.tables; EXEC do_work;'}), /DB_QUERY_MUTATION_DENIED/);
  assert.doesNotThrow(() => assertPostgresqlReadOnlySession([{transaction_read_only: 'on', default_transaction_read_only: 'on'}]));
  assert.throws(() => assertPostgresqlReadOnlySession([{transaction_read_only: 'off', default_transaction_read_only: 'on'}]), /DB_ANALYZE_PRINCIPAL_NOT_READ_ONLY/);
});
