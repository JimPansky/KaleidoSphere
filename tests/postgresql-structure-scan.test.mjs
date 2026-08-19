import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildPreflightEvidence,
  validateAnalyzeProfile,
} from '../services/bi-control/src/db-analyzer/core.mjs';
import { buildStructureMapOutputs } from '../services/bi-control/src/db-analyzer/outputs.mjs';
import { auditCatalogQuery, auditQueryPackSafety } from '../services/bi-control/src/db-analyzer/query-safety.mjs';
import { renderAnalyzeEvidence, runAnalyzeProfile } from '../services/bi-control/src/db-analyzer/workflow.mjs';

const packDirectory = 'services/bi-control/query-packs/db-analyzer/v1/postgresql';
const fixtureDirectory = 'services/bi-control/fixtures';

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const clone = (value) => structuredClone(value);

async function loadInputs() {
  const [manifest, profile, resultSets, incompleteResultSets, negativeCases] = await Promise.all([
    readJson(`${packDirectory}/manifest.json`),
    readJson(`${fixtureDirectory}/postgresql-structure-profile-v1.json`),
    readJson(`${fixtureDirectory}/postgresql-structure-results-v1.json`),
    readJson(`${fixtureDirectory}/postgresql-structure-results-incomplete-v1.json`),
    readJson(`${fixtureDirectory}/postgresql-structure-negative-cases-v1.json`),
  ]);
  const sqlByQueryId = Object.fromEntries(await Promise.all(manifest.queries
    .map(async (query) => [query.id, await readFile(`${packDirectory}/${query.file}`, 'utf8')])));
  const profileContext = {
    profileId: profile.profileId,
    mode: profile.mode,
    scope: profile.scope,
    policy: profile.policy,
    adapter: profile.adapter.kind,
  };
  return { manifest, profile, profileContext, resultSets, incompleteResultSets, negativeCases, sqlByQueryId };
}

const build = ({ manifest, sqlByQueryId, resultSets, profileContext }) => buildPreflightEvidence({
  manifest, sqlByQueryId, resultSets, profileContext,
});

test('PostgreSQL structure fixture yields deterministic catalog-only inventory, constraints and declared dependencies', async () => {
  const evidence = await runAnalyzeProfile(`${fixtureDirectory}/postgresql-structure-profile-v1.json`, {
    repositoryRoot: 'services/bi-control',
  });
  assert.equal(evidence.engine, 'postgresql');
  assert.equal(evidence.runtimeValidation, 'SYNTHETIC_UNVALIDATED');
  assert.equal(evidence.coverageLedger.allComplete, true);
  assert.match(evidence.snapshotSha256, /^[a-f0-9]{64}$/);

  const relations = evidence.extracts.find((entry) => entry.category === 'relations').rows;
  const columns = evidence.extracts.find((entry) => entry.category === 'columns').rows;
  const constraints = evidence.extracts.find((entry) => entry.category === 'constraints').rows;
  const dependencies = evidence.extracts.find((entry) => entry.category === 'dependencies').rows;
  assert.equal(relations.length, 3);
  assert.equal(columns.length, 6);
  assert.deepEqual([...new Set(constraints.map((row) => row.constraint_kind))].sort(), [
    'CHECK', 'FOREIGN_KEY', 'PRIMARY_KEY', 'UNIQUE',
  ]);
  assert.ok([...relations, ...columns, ...constraints, ...dependencies]
    .every((row) => /^[a-f0-9]{64}$/.test(row.objectSha256)));
  assert.deepEqual(dependencies.map((row) => [row.relationship_authority, row.inferred]), [['CATALOG_DECLARED', false]]);
  assert.ok(evidence.blindSpots.some((entry) => entry.code === 'CHECK_DEFINITION_CONTENT_OMITTED'));

  const serialized = JSON.stringify(evidence);
  assert.doesNotMatch(serialized, /sample[_A-Z-]?value|example[_A-Z-]?value|raw[_A-Z-]?value|top[_A-Z-]?value/i);
  assert.doesNotMatch(serialized, /null[_A-Z-]?count|distinct[_A-Z-]?count|fk[_A-Z-]?candidate/i);
});

test('identical snapshot bytes and hashes are stable across input object and row order', async () => {
  const inputs = await loadInputs();
  const first = build(inputs);
  const reorderedResults = Object.fromEntries(Object.entries(inputs.resultSets.results).reverse().map(([queryId, result]) => [
    queryId,
    {...clone(result), rows: [...result.rows].reverse()},
  ]));
  const reordered = build({...inputs, resultSets: {...inputs.resultSets, results: reorderedResults}});
  assert.equal(renderAnalyzeEvidence(reordered), renderAnalyzeEvidence(first));
  assert.equal(reordered.snapshotSha256, first.snapshotSha256);
});

test('PostgreSQL pack is SELECT-only, catalog-allowlisted and projects declared relationships separately from inference', async () => {
  const inputs = await loadInputs();
  const audit = auditQueryPackSafety(inputs);
  assert.equal(audit.queryCount, 6);
  assert.equal(audit.zeroMutatingStatements, true);
  assert.equal(audit.zeroRowSamples, true);
  const evidence = build(inputs);
  const outputs = buildStructureMapOutputs({evidence, manifest: inputs.manifest, sqlByQueryId: inputs.sqlByQueryId});
  assert.ok(outputs.projections.relationships.rows.some((row) => row.relationshipKind === 'FOREIGN_KEY'));
  assert.ok(outputs.projections.relationships.rows.some((row) => row.relationshipKind === 'PG_DEPEND_REWRITE_NORMAL'));
  assert.ok(outputs.projections.relationships.rows.every((row) => row.relationshipAuthority === 'CATALOG_DECLARED' && row.inferred === false));
  assert.throws(() => auditCatalogQuery({
    engine: 'postgresql',
    queryId: 'postgresql.structure.unsafe',
    sql: 'SELECT customer_email FROM public.customers;',
  }), /DB_QUERY_ROW_SOURCE_DENIED/);
});

test('incomplete catalog fixture preserves visible partial evidence and explicit blind spots', async () => {
  const inputs = await loadInputs();
  const evidence = build({...inputs, resultSets: inputs.incompleteResultSets});
  assert.equal(evidence.coverageLedger.allComplete, false);
  assert.equal(evidence.coverage.PARTIAL, 1);
  assert.equal(evidence.coverage.DENIED, 1);
  assert.equal(evidence.extracts.find((entry) => entry.category === 'constraints').rows.length, 1);
  assert.equal(evidence.extracts.find((entry) => entry.category === 'dependencies').emptyInterpretation, 'NOT_CLAIMED');
  assert.ok(evidence.blindSpots.some((entry) => entry.queryId === 'postgresql.structure.constraints'
    && entry.coverageState === 'PARTIAL'));
  assert.ok(evidence.blindSpots.some((entry) => entry.queryId === 'postgresql.structure.dependencies'
    && entry.coverageState === 'DENIED'));
});

test('versioned negative catalog cases fail closed on scope and inferred relationship drift', async () => {
  const inputs = await loadInputs();
  assert.equal(inputs.negativeCases.schemaVersion, 'kaleidosphere.db/postgresql-structure-negative-cases/v1');
  for (const negativeCase of inputs.negativeCases.cases) {
    const resultSets = clone(inputs.resultSets);
    resultSets.results[negativeCase.queryId].rows = [negativeCase.row];
    assert.throws(() => build({...inputs, resultSets}), new RegExp(negativeCase.expectedError), negativeCase.caseId);
  }
});

test('scope allowlist, query allowlist and row budgets fail closed', async () => {
  const inputs = await loadInputs();
  const deniedProfileContext = clone(inputs.profileContext);
  deniedProfileContext.policy.catalogScan.allowedQueryIds = deniedProfileContext.policy.catalogScan.allowedQueryIds
    .filter((queryId) => queryId !== 'postgresql.structure.dependencies');
  assert.throws(() => build({...inputs, profileContext: deniedProfileContext}), /DB_CATALOG_SCAN_ALLOWLIST_DENIED/);

  const boundedProfileContext = clone(inputs.profileContext);
  boundedProfileContext.policy.catalogScan.maxRowsPerQuery = 1;
  assert.throws(() => build({...inputs, profileContext: boundedProfileContext}), /DB_CATALOG_SCAN_BUDGET_EXCEEDED/);

  const outsideScope = clone(inputs.resultSets);
  outsideScope.results['postgresql.structure.schemas'].rows[0].schema_name = 'private';
  assert.throws(() => build({...inputs, resultSets: outsideScope}), /DB_QUERY_RESULT_SCOPE_INVALID/);
});

test('profile and result contracts reject widened budgets and raw/example-value fields', async () => {
  const inputs = await loadInputs();
  assert.equal(validateAnalyzeProfile(inputs.profile), inputs.profile);
  const invalidProfile = clone(inputs.profile);
  invalidProfile.policy.catalogScan.maxQueries = 5;
  assert.throws(() => validateAnalyzeProfile(invalidProfile), /DB_CATALOG_SCAN_POLICY_INVALID/);

  const rawValueResult = clone(inputs.resultSets);
  rawValueResult.results['postgresql.structure.columns'].rows[0].sample_value = 'must-not-enter-evidence';
  assert.throws(() => build({...inputs, resultSets: rawValueResult}), /DB_QUERY_RESULT_COLUMNS_INVALID/);
});
