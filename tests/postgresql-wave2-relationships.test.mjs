import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {identitySha256} from '../services/bi-control/src/db-analyzer/core.mjs';
import {
  buildPostgresqlWave2RulePlan,
  compilePostgresqlWave2RelationshipDispatches,
  runPostgresqlWave2Profiles,
  runPostgresqlWave2Relationships,
} from '../services/bi-control/src/db-analyzer/postgresql-wave2.mjs';

const profile = () => ({
  schemaVersion: 'chimpmaera.db/analyze-profile/v1',
  profileId: 'ks23-postgres-e2e-v1',
  engine: 'postgresql',
  mode: 'RUNTIME',
  queryPack: {version: 'v1'},
  scope: {database: 'ks23_e2e', container: null, schemas: ['ks23_app']},
  policy: {
    access: 'READ_ONLY', allowRowSamples: false, maxQueryTimeoutMs: 5000,
    postgresqlAnalysis: {
      schemaVersion: 'kaleidosphere.analysis/postgresql-wave2-policy/v1',
      enabled: true,
      profileTargets: [
        {schemaName: 'ks23_app', relationName: 'accounts', columnName: 'account_id'},
        {schemaName: 'ks23_app', relationName: 'orders', columnName: 'account_id'},
        {schemaName: 'ks23_app', relationName: 'staging_events', columnName: 'account_id'},
      ],
      sensitiveTargets: [],
      relationshipCandidates: {enabled: true, nameMatch: 'EXACT_COLUMN_NAME', minimumConfidenceBasisPoints: 7500},
      budgets: {maxProfileTargets: 4, maxRelationshipCandidates: 4, maxQueries: 8, maxQueryTimeoutMs: 5000},
      disclosure: {allowRawValues: false, allowExampleValues: false, allowDistributions: false},
    },
  },
  adapter: {
    kind: 'postgresql', host: '127.0.0.1', port: 5432, user: 'ks23_scan',
    passwordEnv: 'KS_WAVE2_REL_TEST_PASSWORD', ssl: false, connectTimeoutMs: 5000,
  },
});

async function inputs() {
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

class ProfileClient {
  async query(input) {
    const text = typeof input === 'string' ? input : input.text;
    if (text.includes("current_setting('transaction_read_only')")) {
      return {rows: [{transaction_read_only: 'on', default_transaction_read_only: 'on'}]};
    }
    if (typeof input === 'object') {
      if (text.includes('"accounts"')) return {rows: [{row_count: '2', null_count: '0', distinct_count: '2'}]};
      if (text.includes('"orders"')) return {rows: [{row_count: '3', null_count: '0', distinct_count: '2'}]};
      return {rows: [{row_count: '3', null_count: '1', distinct_count: '2'}]};
    }
    return {rows: []};
  }
  release() {}
}
class ProfilePool { async connect() { return new ProfileClient(); } async end() {} }

async function profiled(input) {
  process.env.KS_WAVE2_REL_TEST_PASSWORD = 'fixture-only-password';
  const result = await runPostgresqlWave2Profiles({...input, profile: profile(), driver: {Pool: ProfilePool}});
  delete process.env.KS_WAVE2_REL_TEST_PASSWORD;
  return result;
}

const relationshipDriver = (matchedDistinctCount) => {
  class RelationshipClient {
    async query(input) {
      const text = typeof input === 'string' ? input : input.text;
      if (text.includes("current_setting('transaction_read_only')")) {
        return {rows: [{transaction_read_only: 'on', default_transaction_read_only: 'on'}]};
      }
      if (typeof input === 'object') return {rows: [{
        source_non_null_count: '2', source_distinct_count: '2', target_distinct_count: '2',
        matched_distinct_count: String(matchedDistinctCount),
      }]};
      return {rows: []};
    }
    release() {}
  }
  return {Pool: class { async connect() { return new RelationshipClient(); } async end() {} }};
};

test('relationship dispatches require exact-name/type and a single-column declared unique target', async () => {
  const input = await inputs();
  const profileEvidence = await profiled(input);
  const dispatches = compilePostgresqlWave2RelationshipDispatches({
    ...input, profile: profile(), profileEvidence,
  });
  assert.equal(dispatches.length, 1);
  assert.deepEqual(dispatches[0].source, {schemaName: 'ks23_app', relationName: 'staging_events', columnName: 'account_id'});
  assert.deepEqual(dispatches[0].target, {schemaName: 'ks23_app', relationName: 'accounts', columnName: 'account_id'});
  assert.equal(dispatches.some(({source}) => source.relationName === 'orders'), false, 'declared FK is not duplicated');
  assert.match(dispatches[0].statement, /EXISTS[\s\S]+"accounts"/);
  assert.deepEqual(dispatches[0].values, []);

  const changedFacts = profileEvidence.facts.map((fact) => fact.target.relationName === 'staging_events'
    ? {...fact, plan: {...fact.plan, nativeTypeOid: '25'}} : fact);
  const {profileEvidenceSha256: _hash, ...profileBody} = {...profileEvidence, facts: changedFacts};
  const typeMismatch = {...profileBody, profileEvidenceSha256: identitySha256(profileBody)};
  assert.equal(compilePostgresqlWave2RelationshipDispatches({
    ...input, profile: profile(), profileEvidence: typeMismatch,
  }).length, 0);
});

test('high-overlap evidence is separated into observed, computed and inferred proposal-only facts', async () => {
  const input = await inputs();
  const profileEvidence = await profiled(input);
  process.env.KS_WAVE2_REL_TEST_PASSWORD = 'fixture-only-password';
  const relationships = await runPostgresqlWave2Relationships({
    ...input, profile: profile(), profileEvidence, driver: relationshipDriver(2),
  });
  delete process.env.KS_WAVE2_REL_TEST_PASSWORD;
  assert.equal(relationships.summary.evaluatedPairCount, 1);
  assert.equal(relationships.summary.eligibleCandidateCount, 1);
  assert.equal(relationships.observations[0].observationKind, 'OBSERVED');
  assert.equal(relationships.computations[0].observationKind, 'COMPUTED');
  assert.equal(relationships.computations[0].metrics.overlapBasisPoints, 10000);
  assert.equal(relationships.candidates[0].observationKind, 'INFERRED');
  assert.equal(relationships.candidates[0].claimStatus, 'PROPOSAL_ONLY');
  assert.equal(relationships.candidates[0].confidence, 'HIGH');
  assert.deepEqual(relationships.authority, {executionAuthority: 'NONE', mutationAuthority: 'NONE', proposalOnly: true});
  assert.match(relationships.candidates[0].limitations.join(','), /SEMANTIC_RELATIONSHIP_NOT_ESTABLISHED/);

  const plan = buildPostgresqlWave2RulePlan({profileEvidence, relationshipEvidence: relationships});
  assert.equal(plan.stepCount, profileEvidence.factCount + 1);
  assert.equal(plan.steps.some(({action}) => action === 'REVIEW_RELATIONSHIP_CANDIDATE'), true);
  assert.equal(plan.steps.every(({executionAuthority, mutationAuthority}) => executionAuthority === 'NONE' && mutationAuthority === 'NONE'), true);
});

test('insufficient overlap remains measured negative evidence and is not promoted to a candidate', async () => {
  const input = await inputs();
  const profileEvidence = await profiled(input);
  process.env.KS_WAVE2_REL_TEST_PASSWORD = 'fixture-only-password';
  const relationships = await runPostgresqlWave2Relationships({
    ...input, profile: profile(), profileEvidence, driver: relationshipDriver(1),
  });
  delete process.env.KS_WAVE2_REL_TEST_PASSWORD;
  assert.equal(relationships.summary.evaluatedPairCount, 1);
  assert.equal(relationships.summary.eligibleCandidateCount, 0);
  assert.equal(relationships.summary.lowConfidenceRejectedCount, 1);
  assert.equal(relationships.computations[0].eligible, false);
  assert.equal(relationships.computations[0].confidence, 'LOW');
  assert.deepEqual(relationships.candidates, []);
});
