import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {
  runPostgresqlWave2Profiles,
  runPostgresqlWave2Relationships,
} from '../services/bi-control/src/db-analyzer/postgresql-wave2.mjs';
import {
  buildPostgresqlWave2ProblemReceipt,
  buildPostgresqlWave2Result,
  validatePostgresqlWave2ReactionProposal,
} from '../services/bi-control/src/db-analyzer/postgresql-wave2-workflow.mjs';
import {validateOrThrow} from '../services/bi-control/src/graph-pilot/schema-validator.mjs';

const profile = {
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
    passwordEnv: 'KS_WAVE2_WORKFLOW_TEST_PASSWORD', ssl: false, connectTimeoutMs: 5000,
  },
};

async function pack() {
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

const driver = (relationshipMatch = 2) => {
  class Client {
    async query(input) {
      const text = typeof input === 'string' ? input : input.text;
      if (text.includes("current_setting('transaction_read_only')")) {
        return {rows: [{transaction_read_only: 'on', default_transaction_read_only: 'on'}]};
      }
      if (typeof input !== 'object') return {rows: []};
      if (text.includes('source_non_null_count')) return {rows: [{
        source_non_null_count: '2', source_distinct_count: '2', target_distinct_count: '2',
        matched_distinct_count: String(relationshipMatch),
      }]};
      if (text.includes('"accounts"')) return {rows: [{row_count: '2', null_count: '0', distinct_count: '2'}]};
      if (text.includes('"orders"')) return {rows: [{row_count: '3', null_count: '0', distinct_count: '2'}]};
      return {rows: [{row_count: '3', null_count: '1', distinct_count: '2'}]};
    }
    release() {}
  }
  return {Pool: class { async connect() { return new Client(); } async end() {} }};
};

async function resultFixture() {
  const input = await pack();
  process.env.KS_WAVE2_WORKFLOW_TEST_PASSWORD = 'fixture-only-password';
  const profileEvidence = await runPostgresqlWave2Profiles({...input, profile, driver: driver()});
  const relationshipEvidence = await runPostgresqlWave2Relationships({
    ...input, profile, profileEvidence, driver: driver(),
  });
  delete process.env.KS_WAVE2_WORKFLOW_TEST_PASSWORD;
  return {
    ...input,
    profileEvidence,
    relationshipEvidence,
    result: buildPostgresqlWave2Result({...input, profile, profileEvidence, relationshipEvidence}),
  };
}

test('Wave 2 composes a deterministic content-addressed Evidence Store, rule plan and two reports', async () => {
  const input = await resultFixture();
  const repeated = buildPostgresqlWave2Result({...input, profile});
  assert.deepEqual(repeated, input.result);
  const {result} = input;
  assert.equal(result.runtimeValidation, 'RUNTIME_VALIDATED');
  assert.equal(result.evidenceStore.factCount, 6);
  assert.match(result.evidenceStore.evidenceStoreId, /^ks_store_[a-f0-9]{24}$/);
  assert.equal(result.evidenceStore.coverage.structureComplete, true);
  assert.equal(result.evidenceStore.coverage.profileComplete, true);
  assert.equal(result.evidenceStore.coverage.relationshipComplete, true);
  assert.equal(result.plan.stepCount, 4);
  assert.equal(result.plan.evidenceStoreRef.evidenceStoreSha256, result.evidenceStore.evidenceStoreSha256);
  assert.equal(result.reports.machine.summary.profiledColumnCount, 3);
  assert.equal(result.reports.machine.summary.relationshipCandidateCount, 1);
  assert.match(result.reports.human, /staging_events\.account_id.*accounts\.account_id/);
  assert.equal(result.providerCallPerformed, false);
  assert.equal(result.freeSqlAccepted, false);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /KS23_RAW_ROW_CANARY|fixture-only-password|postgres(?:ql)?:\/\//i);
  assert.doesNotMatch(serialized, /sampleValue|exampleValue|rawValue/i);
});

test('problem reactions are closed, evidence-bound, budgeted and proposal-only', async () => {
  const {result} = await resultFixture();
  const candidate = result.relationshipEvidence.candidates[0];
  const methodRef = 'postgresql.wave2.relationship-overlap@1.0.0';
  const problemReceipt = buildPostgresqlWave2ProblemReceipt({
    methodRef,
    reasonCode: 'TIMEOUT',
    evidenceRefs: [candidate.candidateSha256],
    retryable: true,
  });
  const proposal = {
    schemaVersion: 'kaleidosphere.analysis/agent-reaction-proposal/v1',
    action: 'RETRY_METHOD',
    methodRef,
    reasonCode: 'TIMEOUT',
    evidenceRefs: [candidate.candidateSha256],
    retryAttempt: 1,
  };
  const validated = validatePostgresqlWave2ReactionProposal({
    proposal, problemReceipt, evidenceStore: result.evidenceStore, retryBudget: 1,
  });
  assert.equal(validated.validationState, 'PROPOSAL_VALIDATED');
  assert.equal(validated.queryAuthority, 'REGISTERED_METHOD_ONLY');
  assert.equal(validated.executionAuthority, 'NONE');
  assert.equal(validated.mutationAuthority, 'NONE');
  assert.equal(validated.providerCallPerformed, false);

  assert.throws(() => validatePostgresqlWave2ReactionProposal({
    proposal: {...proposal, sql: 'SELECT 1'}, problemReceipt, evidenceStore: result.evidenceStore, retryBudget: 1,
  }), /DB_WAVE2_REACTION_INVALID/);
  assert.throws(() => validatePostgresqlWave2ReactionProposal({
    proposal: {...proposal, retryAttempt: 2}, problemReceipt, evidenceStore: result.evidenceStore, retryBudget: 1,
  }), /DB_WAVE2_REACTION_RETRY_DENIED/);
  assert.throws(() => validatePostgresqlWave2ReactionProposal({
    proposal: {...proposal, evidenceRefs: ['f'.repeat(64)]}, problemReceipt, evidenceStore: result.evidenceStore, retryBudget: 1,
  }), /DB_WAVE2_PROBLEM_TAMPERED/);
});

test('Wave 2 E2E readback contract is closed and hash-bound', async () => {
  const schema = JSON.parse(await readFile('contracts/postgresql-wave2-e2e/v1/readback.schema.json', 'utf8'));
  const hash = 'a'.repeat(64);
  const valid = {
    schemaVersion: 'kaleidosphere.analysis/postgresql-wave2-e2e-readback/v1',
    fixtureId: 'ks-analysis-wave2-e2e-v1',
    image: {
      reference: 'docker.io/library/postgres@sha256:94f23d40fdaf5e60cb2fd8a98c22f02a7b8724949f310d95a0ddf075e8c8b208',
      platform: 'linux/amd64',
      manifestDigest: 'sha256:94f23d40fdaf5e60cb2fd8a98c22f02a7b8724949f310d95a0ddf075e8c8b208',
    },
    canonicalResult: {run1Sha256: hash, run2Sha256: hash, byteIdentical: true, diskReadbackValidated: true, runtimeValidated: true},
    groundTruth: {beforeSha256: hash, afterSha256: hash, unchanged: true},
    summary: {
      profiledColumns: 3, observedFacts: 4, computedFacts: 1, inferredCandidates: 1,
      evaluatedPairs: 1, highConfidenceCandidates: 1, declaredForeignKeysExcluded: true,
      evidenceStoreFacts: 6, planSteps: 4,
    },
    authority: {
      proposalOnly: true, executionAuthority: 'NONE', mutationAuthority: 'NONE',
      providerCallPerformed: false, freeSqlAccepted: false,
    },
    privacy: {rawRowCanaryMatches: 0, outsideCanaryMatches: 0, credentialCanaryMatches: 0, dsnMatches: 0, rawValueFields: 0},
    nonClaims: ['local synthetic evidence only'],
  };
  assert.equal(validateOrThrow(valid, schema), true);
  assert.throws(() => validateOrThrow({...valid, rows: []}, schema), /SCHEMA_VALIDATION_FAILED/);
});
