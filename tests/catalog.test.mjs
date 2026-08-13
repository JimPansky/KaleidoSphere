import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  answerCatalogQuestion,
  CATALOG_SCHEMA_VERSION,
  ingestCatalogReceipt,
  searchCatalog,
} from '../services/bi-control/src/catalog.mjs';
import { runAnalyzeProfile } from '../services/bi-control/src/db-analyzer/workflow.mjs';

async function fixtureReceipt() {
  const analysis = await runAnalyzeProfile('services/bi-control/fixtures/mssql-profile-v1.json', {repositoryRoot: 'services/bi-control'});
  return {
    schemaVersion: 'chimpmaera.bi/analysis-receipt/v1',
    receiptId: `mssql-${analysis.snapshotSha256.slice(0, 24)}`,
    status: 'ANALYZED_READ_ONLY',
    analyzedAt: '2026-08-13T16:09:00.000Z',
    sourceMode: 'fixture',
    engine: 'mssql',
    scope: analysis.profile.scope,
    safety: {queryPackSelectOnly: true, rowSamples: false},
    analysis,
  };
}

function scoped(family, object = null, limit = 20) {
  return {family, scope: {schemas: ['dbo']}, object, limit};
}

test('M3 catalog schema ingests idempotently and keeps active snapshot provenance', async () => {
  const db = new DatabaseSync(':memory:');
  const receipt = await fixtureReceipt();
  ingestCatalogReceipt(db, receipt);
  ingestCatalogReceipt(db, receipt);
  assert.equal(db.prepare('SELECT value FROM catalog_meta WHERE key=?').get('schema_version').value, CATALOG_SCHEMA_VERSION);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM catalog_snapshots').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM catalog_facts').get().count, 11);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM catalog_extracts').get().count, 9);
  assert.equal(db.prepare('SELECT receipt_id FROM catalog_snapshots WHERE active=1').get().receipt_id, receipt.receiptId);

  const next = structuredClone(receipt);
  next.receiptId = 'mssql-next-snapshot';
  next.analysis.snapshotSha256 = 'f'.repeat(64);
  ingestCatalogReceipt(db, next);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM catalog_snapshots').get().count, 2);
  assert.equal(db.prepare('SELECT receipt_id FROM catalog_snapshots WHERE active=1').get().receipt_id, 'mssql-next-snapshot');
  db.close();
});

test('M3 catalog answers supported question families with provenance and caveats', async () => {
  const db = new DatabaseSync(':memory:');
  const receipt = await fixtureReceipt();
  ingestCatalogReceipt(db, receipt);
  for (const family of [
    'largest_tables',
    'row_estimates_freshness',
    'object_inventory_validity',
    'coverage_blind_spots',
    'bi_relevance_candidates',
  ]) {
    const answer = answerCatalogQuestion(db, scoped(family));
    assert.equal(answer.schemaVersion, 'chimpmaera.bi/catalog-answer/v1');
    assert.equal(answer.provenance.receiptId, receipt.receiptId);
    assert.equal(answer.provenance.snapshotSha256, receipt.analysis.snapshotSha256);
    assert(answer.provenance.coverage.length > 0);
    assert.match(answer.answer, /metadata|coverage|candidate|COUNT|bounded|estimates|authoritative/i);
  }
  const deps = answerCatalogQuestion(db, scoped('dependencies', {name: 'orders'}));
  assert.equal(deps.family, 'dependencies');
  const signatures = answerCatalogQuestion(db, scoped('stored_logic_signatures'));
  assert.equal(signatures.family, 'stored_logic_signatures');
  const scheduler = answerCatalogQuestion(db, scoped('scheduler_mv_refresh'));
  assert.equal(scheduler.family, 'scheduler_mv_refresh');
  db.close();
});

test('M3 catalog search is scoped, budgeted, and source-DB independent', async () => {
  const db = new DatabaseSync(':memory:');
  const receipt = await fixtureReceipt();
  ingestCatalogReceipt(db, receipt);
  const result = searchCatalog(db, {term: 'orders', scope: {schemas: ['dbo']}, limit: 5});
  assert.equal(result.schemaVersion, 'chimpmaera.bi/catalog-search/v1');
  assert(result.rows.some((row) => row.relation_name === 'orders' || row.object_name === 'orders'));
  assert(result.rows.length <= 5);
  assert.throws(() => searchCatalog(db, {term: 'orders', scope: {schemas: ['other']}, limit: 5}), /CATALOG_SCOPE_DENIED/);
  assert.throws(() => searchCatalog(db, {term: 'raw sql SELECT password', scope: {schemas: ['dbo']}, limit: 5}), /CATALOG_SEARCH_DENIED/);
  assert.throws(() => searchCatalog(db, {term: 'orders', scope: {schemas: ['dbo']}, limit: 101}), /CATALOG_RESULT_BUDGET_DENIED/);
  db.close();
});

test('M3 catalog fails closed for unsafe, ambiguous, nonexistent, and unsupported questions', async () => {
  const db = new DatabaseSync(':memory:');
  const receipt = await fixtureReceipt();
  ingestCatalogReceipt(db, receipt);
  assert.throws(() => answerCatalogQuestion(db, scoped('free_sql')), /CATALOG_QUESTION_UNSUPPORTED/);
  assert.throws(() => answerCatalogQuestion(db, scoped('dependencies', {name: 'missing_table'})), /CATALOG_OBJECT_NOT_FOUND/);
  assert.throws(() => answerCatalogQuestion(db, scoped('dependencies', {name: 'SELECT password'})), /CATALOG_UNSAFE_INPUT_DENIED/);
  assert.throws(() => answerCatalogQuestion(db, {family: 'largest_tables', scope: {schemas: ['dbo']}, object: null, limit: 0}), /CATALOG_RESULT_BUDGET_DENIED/);
  db.close();
});
