import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { runAnalyzeProfile } from '../services/bi-control/src/db-analyzer/workflow.mjs';
import { auditCatalogQuery, auditQueryPackSafety } from '../services/bi-control/src/db-analyzer/query-safety.mjs';

test('portable MSSQL fixture produces a scoped, read-only, synthetic-unvalidated receipt input', async () => {
  const evidence = await runAnalyzeProfile('services/bi-control/fixtures/mssql-profile-v1.json', {repositoryRoot: 'services/bi-control'});
  assert.equal(evidence.engine, 'mssql');
  assert.equal(evidence.runtimeValidation, 'SYNTHETIC_UNVALIDATED');
  assert.equal(evidence.profile.policy.access, 'READ_ONLY');
  assert.equal(evidence.profile.policy.allowRowSamples, false);
  assert.equal(evidence.coverageLedger.allComplete, true);
  assert.equal(evidence.extracts.find((entry) => entry.queryId === 'mssql.structure.relations').rows.length, 2);
});

test('the full shipped MSSQL pack audits as SELECT-only catalog metadata', async () => {
  const directory = 'services/bi-control/query-packs/db-analyzer/v1/mssql';
  const manifest = JSON.parse(await readFile(`${directory}/manifest.json`, 'utf8'));
  const sqlByQueryId = Object.fromEntries(await Promise.all(manifest.queries.map(async (query) => [query.id, await readFile(`${directory}/${query.file}`, 'utf8')])));
  const audit = auditQueryPackSafety({manifest, sqlByQueryId});
  assert.equal(audit.zeroMutatingStatements, true);
  assert.equal(audit.zeroRowSamples, true);
  assert.equal(audit.queryCount, manifest.queries.length);
});

test('write SQL, multi-statement SQL, and row-source SQL fail closed', () => {
  assert.throws(() => auditCatalogQuery({engine:'mssql', queryId:'probe', sql:'UPDATE dbo.orders SET amount=0;'}), /DB_QUERY_SELECT_ONLY_DENIED/);
  assert.throws(() => auditCatalogQuery({engine:'mssql', queryId:'probe', sql:'SELECT name FROM sys.tables; DROP TABLE x;'}), /DB_QUERY_MUTATION_DENIED/);
  assert.throws(() => auditCatalogQuery({engine:'mssql', queryId:'probe', sql:'SELECT order_id FROM dbo.orders;'}), /DB_QUERY_ROW_SOURCE_DENIED/);
});
