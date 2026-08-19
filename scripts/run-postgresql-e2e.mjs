import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir, open, readFile, rename, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';

import {canonicalJson} from '../services/bi-control/src/db-analyzer/core.mjs';
import {buildPostgresqlConnectionOptions, compilePostgresqlProfileQuery} from '../services/bi-control/src/db-analyzer/postgresql-adapter.mjs';
import {readPostgresqlSessionProof, runPostgresqlControlledProbe} from '../services/bi-control/src/db-analyzer/postgresql-runtime.mjs';
import {auditCatalogQuery} from '../services/bi-control/src/db-analyzer/query-safety.mjs';
import {buildStructureMapOutputs} from '../services/bi-control/src/db-analyzer/outputs.mjs';
import {runPostgresqlAnalysisWave2} from '../services/bi-control/src/db-analyzer/postgresql-wave2-workflow.mjs';
import {renderAnalyzeEvidence, runAnalyzeProfile} from '../services/bi-control/src/db-analyzer/workflow.mjs';
import {validateOrThrow} from '../services/bi-control/src/graph-pilot/schema-validator.mjs';

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const requireFromControl = createRequire(path.join(repositoryRoot, 'services/bi-control/package.json'));
const {Client} = requireFromControl('pg');
const IMAGE_DIGEST = 'sha256:94f23d40fdaf5e60cb2fd8a98c22f02a7b8724949f310d95a0ddf075e8c8b208';
const IMAGE_REFERENCE = `docker.io/library/postgres@${IMAGE_DIGEST}`;
const RAW_ROW_CANARY = 'KS23_RAW_ROW_CANARY_17F2C3';
const OUTSIDE_CANARY = 'KS23_OUTSIDE_DECOY_91A7B4';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const env = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`KS23_REQUIRED_ENV_MISSING:${name}`);
  return value;
};
const readSecret = async (name) => (await readFile(env(name), 'utf8')).trim();

async function assertSecretFile(file) {
  const metadata = await stat(file);
  assert.equal(metadata.mode & 0o777, 0o600, 'secret file mode');
  assert.equal(metadata.isFile(), true, 'secret path must be a file');
}

async function atomicWrite(file, bytes) {
  await mkdir(path.dirname(file), {recursive: true, mode: 0o700});
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  await writeFile(temporary, bytes, {mode: 0o600, flag: 'wx'});
  const handle = await open(temporary, 'r');
  await handle.sync();
  await handle.close();
  await rename(temporary, file);
  const directory = await open(path.dirname(file), 'r');
  await directory.sync();
  await directory.close();
}

const profileFor = (port, timeoutMs = 5000) => ({
  schemaVersion: 'chimpmaera.db/analyze-profile/v1',
  profileId: 'ks23-postgres-e2e-v1',
  engine: 'postgresql',
  mode: 'RUNTIME',
  queryPack: {version: 'v1'},
  scope: {database: 'ks23_e2e', container: null, schemas: ['ks23_app']},
  policy: {
    access: 'READ_ONLY',
    allowRowSamples: false,
    maxQueryTimeoutMs: timeoutMs,
    catalogScan: {
      schemaVersion: 'chimpmaera.db/catalog-scan-policy/v1',
      allowedQueryIds: [
        'postgresql.preflight.identity',
        'postgresql.structure.schemas',
        'postgresql.structure.relations',
        'postgresql.structure.columns',
        'postgresql.structure.constraints',
        'postgresql.structure.dependencies'
      ],
      maxQueries: 6,
      maxRowsPerQuery: 100,
      maxTotalRows: 500
    }
  },
  adapter: {
    kind: 'postgresql', host: '127.0.0.1', port, user: 'ks23_scan',
    passwordEnv: 'KS23_SCAN_PASSWORD', ssl: false, connectTimeoutMs: 5000
  }
});

const wave2ProfileFor = (port) => {
  const base = profileFor(port);
  return {
    ...base,
    profileId: 'ks-analysis-wave2-e2e-v1',
    policy: {
      ...base.policy,
      postgresqlAnalysis: {
        schemaVersion: 'kaleidosphere.analysis/postgresql-wave2-policy/v1',
        enabled: true,
        profileTargets: [
          {schemaName: 'ks23_app', relationName: 'accounts', columnName: 'account_id'},
          {schemaName: 'ks23_app', relationName: 'orders', columnName: 'account_id'},
          {schemaName: 'ks23_app', relationName: 'staging_events', columnName: 'account_id'}
        ],
        sensitiveTargets: [],
        relationshipCandidates: {enabled: true, nameMatch: 'EXACT_COLUMN_NAME', minimumConfidenceBasisPoints: 7500},
        budgets: {maxProfileTargets: 3, maxRelationshipCandidates: 2, maxQueries: 5, maxQueryTimeoutMs: 5000},
        disclosure: {allowRawValues: false, allowExampleValues: false, allowDistributions: false}
      }
    }
  };
};

const safePassword = (value) => {
  if (!/^[A-Za-z0-9_]{32,96}$/.test(value)) throw new Error('KS23_PASSWORD_SHAPE_INVALID');
  return value;
};

async function connect(profile, password, user = profile.adapter.user, readOnly = true) {
  const options = buildPostgresqlConnectionOptions({...profile, adapter: {...profile.adapter, user}}, password);
  if (!readOnly) {
    delete options.options;
    options.application_name = 'kaleidosphere-ks23-fixture-owner';
  }
  const client = new Client(options);
  await client.connect();
  return client;
}

async function materializeFixture({profile, ownerPassword, scanPassword}) {
  const owner = await connect(profile, ownerPassword, 'ks23_owner', false);
  try {
    await owner.query(await readFile(path.join(repositoryRoot, 'tests/fixtures/postgresql-e2e/fixture.sql'), 'utf8'));
    await owner.query(`ALTER ROLE ks23_scan PASSWORD '${safePassword(scanPassword)}';`);
  } finally {
    await owner.end();
  }
}

async function rotateScanPassword({profile, ownerPassword, scanPassword}) {
  const owner = await connect(profile, ownerPassword, 'ks23_owner', false);
  try {
    await owner.query(`ALTER ROLE ks23_scan PASSWORD '${safePassword(scanPassword)}';`);
  } finally {
    await owner.end();
  }
}

async function groundTruth(profile, ownerPassword) {
  const owner = await connect(profile, ownerPassword, 'ks23_owner');
  try {
    const result = await owner.query(`SELECT
      (SELECT count(*)::integer FROM pg_catalog.pg_namespace WHERE nspname = 'ks23_app') AS schemas,
      (SELECT count(*)::integer FROM pg_catalog.pg_class AS relation JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = 'ks23_app' AND relation.relkind = 'r') AS relations,
      (SELECT count(*)::integer FROM pg_catalog.pg_attribute AS attribute JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = 'ks23_app' AND relation.relkind = 'r' AND attribute.attnum > 0 AND NOT attribute.attisdropped) AS columns,
      (SELECT count(*)::integer FROM pg_catalog.pg_constraint AS constraint_row JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_row.conrelid JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = 'ks23_app') AS constraints,
      (SELECT count(*)::integer FROM pg_catalog.pg_constraint AS constraint_row JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_row.conrelid JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = 'ks23_app' AND constraint_row.contype = 'f') AS foreign_keys,
      (SELECT count(*)::integer FROM pg_catalog.pg_constraint AS constraint_row JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_row.conrelid JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = 'ks23_app' AND constraint_row.contype = 'c' AND NOT constraint_row.convalidated) AS not_validated_checks,
      (SELECT count(*)::integer FROM pg_catalog.pg_indexes WHERE schemaname = 'ks23_app' AND indexname = 'ks23_staging_event_positive_uix' AND indexdef LIKE '% WHERE %') AS partial_unique_indexes,
      (SELECT count(*)::integer FROM ks23_app.accounts) AS account_rows,
      (SELECT count(*)::integer FROM ks23_app.orders) AS order_rows,
      (SELECT count(*)::integer FROM ks23_app.staging_events) AS staging_rows,
      (SELECT count(*)::integer FROM ks23_outside.secret_decoy) AS outside_rows;`);
    return result.rows[0];
  } finally {
    await owner.end();
  }
}

async function databaseDeniedProbe(profile, password, statement) {
  const client = await connect(profile, password);
  let code;
  try {
    await client.query('BEGIN READ ONLY');
    try {
      await client.query(statement);
    } catch (error) {
      code = error.code;
    }
    await client.query('ROLLBACK');
  } finally {
    await client.end();
  }
  assert.ok(['25006', '42501'].includes(code), `unexpected database denial SQLSTATE ${code}`);
  return code;
}

function policyDeniedProbe(statement) {
  let dispatches = 0;
  let code;
  try {
    auditCatalogQuery({engine: 'postgresql', queryId: 'ks23.closed-probe', sql: statement});
    dispatches += 1;
  } catch (error) {
    code = error.code;
  }
  assert.match(code ?? '', /^DB_QUERY_/);
  assert.equal(dispatches, 0);
  return dispatches;
}

function assertPositiveEvidence(evidence) {
  assert.equal(evidence.runtimeValidation, 'RUNTIME_VALIDATED');
  assert.equal(evidence.coverageLedger.allComplete, true);
  const byCategory = Object.fromEntries(evidence.extracts.map((entry) => [entry.category, entry.rows]));
  assert.equal(byCategory.schemas.length, 1);
  assert.equal(byCategory.relations.length, 3);
  assert.equal(byCategory.columns.length, 13);
  assert.equal(byCategory.constraints.length, 9);
  assert.equal(byCategory.constraints.filter((row) => row.constraint_kind === 'FOREIGN_KEY').length, 1);
  assert.equal(byCategory.constraints.filter((row) => row.is_validated === false).length, 1);
  assert.equal(byCategory.constraints.some((row) => row.constraint_name === 'ks23_staging_event_positive_uix'), false);
  assert.equal(byCategory.constraints.some((row) => row.relation_name === 'staging_events' && row.constraint_kind === 'FOREIGN_KEY'), false);
  assert.equal(JSON.stringify(evidence).includes('ks23_outside'), false);
}

function assertPositiveWave2(result) {
  assert.equal(result.runtimeValidation, 'RUNTIME_VALIDATED');
  assert.equal(result.profileEvidence.factCount, 3);
  assert.equal(result.relationshipEvidence.summary.evaluatedPairCount, 1);
  assert.equal(result.relationshipEvidence.summary.eligibleCandidateCount, 1);
  assert.equal(result.relationshipEvidence.summary.lowConfidenceRejectedCount, 0);
  assert.equal(result.relationshipEvidence.observations.length, 1);
  assert.equal(result.relationshipEvidence.observations[0].observationKind, 'OBSERVED');
  assert.equal(result.relationshipEvidence.computations.length, 1);
  assert.equal(result.relationshipEvidence.computations[0].observationKind, 'COMPUTED');
  assert.equal(result.relationshipEvidence.computations[0].metrics.overlapBasisPoints, 10000);
  assert.equal(result.relationshipEvidence.candidates.length, 1);
  const candidate = result.relationshipEvidence.candidates[0];
  assert.equal(candidate.observationKind, 'INFERRED');
  assert.equal(candidate.claimStatus, 'PROPOSAL_ONLY');
  assert.equal(candidate.confidence, 'HIGH');
  assert.deepEqual(candidate.source, {schemaName: 'ks23_app', relationName: 'staging_events', columnName: 'account_id'});
  assert.deepEqual(candidate.target, {schemaName: 'ks23_app', relationName: 'accounts', columnName: 'account_id'});
  assert.equal(result.evidenceStore.factCount, 6);
  assert.equal(result.plan.stepCount, 4);
  assert.equal(result.plan.steps.some((step) => step.source?.relationName === 'orders'), false);
  assert.equal(result.providerCallPerformed, false);
  assert.equal(result.freeSqlAccepted, false);
}

async function loadPack() {
  const directory = path.join(repositoryRoot, 'services/bi-control/query-packs/db-analyzer/v1/postgresql');
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  const sqlByQueryId = Object.fromEntries(await Promise.all(manifest.queries.map(async (query) => [
    query.id, await readFile(path.join(directory, query.file), 'utf8')
  ])));
  return {manifest, sqlByQueryId};
}

async function scanArtifacts(files, secrets) {
  const buffers = await Promise.all(files.map((file) => readFile(file)));
  const text = Buffer.concat(buffers).toString('utf8');
  const contentWithoutCounter = text.replaceAll('"rawValueFields":0', '');
  return {
    rawRowCanaryMatches: text.split(RAW_ROW_CANARY).length - 1,
    outsideCanaryMatches: text.split(OUTSIDE_CANARY).length - 1,
    credentialCanaryMatches: secrets.reduce((count, secret) => count + text.split(secret).length - 1, 0),
    dsnMatches: (text.match(/postgres(?:ql)?:\/\//gi) ?? []).length,
    rawValueFields: (contentWithoutCounter.match(/(?:raw|sample|example|top)[_-]?values?/gi) ?? []).length,
  };
}

async function main() {
  const port = Number(env('KS23_POSTGRES_PORT'));
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535 && ![18789, 8000, 8081].includes(port));
  const secretFiles = [env('KS23_OWNER_PASSWORD_FILE'), env('KS23_SCAN_PASSWORD_1_FILE'), env('KS23_SCAN_PASSWORD_2_FILE')];
  await Promise.all(secretFiles.map(assertSecretFile));
  const [ownerPassword, scanPassword1, scanPassword2] = await Promise.all([
    readSecret('KS23_OWNER_PASSWORD_FILE'), readSecret('KS23_SCAN_PASSWORD_1_FILE'), readSecret('KS23_SCAN_PASSWORD_2_FILE')
  ]);
  assert.notEqual(scanPassword1, scanPassword2);
  safePassword(ownerPassword); safePassword(scanPassword1); safePassword(scanPassword2);

  const profile = profileFor(port);
  const wave2Profile = wave2ProfileFor(port);
  const runtimeDirectory = path.resolve(env('KS23_RUNTIME_DIRECTORY'));
  const outputRoot = path.join(repositoryRoot, 'docs/evidence/postgresql-e2e');
  const wave2OutputRoot = path.join(repositoryRoot, 'docs/evidence/postgresql-wave2-e2e');
  await mkdir(runtimeDirectory, {recursive: true, mode: 0o700});
  const profileFile = path.join(runtimeDirectory, 'profile.json');
  const wave2ProfileFile = path.join(runtimeDirectory, 'wave2-profile.json');
  await atomicWrite(profileFile, canonicalJson(profile));
  await atomicWrite(wave2ProfileFile, canonicalJson(wave2Profile));

  await materializeFixture({profile, ownerPassword, scanPassword: scanPassword1});
  const before = await groundTruth(profile, ownerPassword);
  assert.deepEqual(before, {
    schemas: 1, relations: 3, columns: 13, constraints: 9, foreign_keys: 1,
    not_validated_checks: 1, partial_unique_indexes: 1,
    account_rows: 1, order_rows: 1, staging_rows: 1, outside_rows: 1
  });
  const beforeSha256 = sha256(canonicalJson(before));
  const session = await readPostgresqlSessionProof({profile, password: scanPassword1});

  process.env.KS23_SCAN_PASSWORD = scanPassword1;
  const evidence1 = await runAnalyzeProfile(profileFile, {repositoryRoot: path.join(repositoryRoot, 'services/bi-control')});
  assertPositiveEvidence(evidence1);
  const run1File = path.join(outputRoot, 'run-1/evidence.canonical.json');
  await atomicWrite(run1File, renderAnalyzeEvidence(evidence1));
  const wave2Result1 = await runPostgresqlAnalysisWave2(wave2ProfileFile, {repositoryRoot: path.join(repositoryRoot, 'services/bi-control')});
  assertPositiveWave2(wave2Result1);
  const wave2Run1File = path.join(wave2OutputRoot, 'run-1/result.canonical.json');
  await atomicWrite(wave2Run1File, canonicalJson(wave2Result1));

  await rotateScanPassword({profile, ownerPassword, scanPassword: scanPassword2});
  process.env.KS23_SCAN_PASSWORD = scanPassword2;
  const evidence2 = await runAnalyzeProfile(profileFile, {repositoryRoot: path.join(repositoryRoot, 'services/bi-control')});
  assertPositiveEvidence(evidence2);
  const run2File = path.join(outputRoot, 'run-2/evidence.canonical.json');
  await atomicWrite(run2File, renderAnalyzeEvidence(evidence2));
  const wave2Result2 = await runPostgresqlAnalysisWave2(wave2ProfileFile, {repositoryRoot: path.join(repositoryRoot, 'services/bi-control')});
  assertPositiveWave2(wave2Result2);
  const wave2Run2File = path.join(wave2OutputRoot, 'run-2/result.canonical.json');
  await atomicWrite(wave2Run2File, canonicalJson(wave2Result2));
  delete process.env.KS23_SCAN_PASSWORD;

  const [run1Bytes, run2Bytes] = await Promise.all([readFile(run1File), readFile(run2File)]);
  assert.deepEqual(run2Bytes, run1Bytes);
  const run1Readback = JSON.parse(run1Bytes);
  const run2Readback = JSON.parse(run2Bytes);
  assertPositiveEvidence(run1Readback);
  assertPositiveEvidence(run2Readback);
  const run1Sha256 = sha256(run1Bytes);
  const run2Sha256 = sha256(run2Bytes);
  assert.equal(run1Sha256, run2Sha256);

  const [wave2Run1Bytes, wave2Run2Bytes] = await Promise.all([readFile(wave2Run1File), readFile(wave2Run2File)]);
  assert.deepEqual(wave2Run2Bytes, wave2Run1Bytes);
  const wave2Run1Readback = JSON.parse(wave2Run1Bytes);
  const wave2Run2Readback = JSON.parse(wave2Run2Bytes);
  assertPositiveWave2(wave2Run1Readback);
  assertPositiveWave2(wave2Run2Readback);
  const wave2Run1Sha256 = sha256(wave2Run1Bytes);
  const wave2Run2Sha256 = sha256(wave2Run2Bytes);
  assert.equal(wave2Run1Sha256, wave2Run2Sha256);

  const {manifest, sqlByQueryId} = await loadPack();
  const projections = buildStructureMapOutputs({evidence: run1Readback, manifest, sqlByQueryId}).projections;
  assert.equal(projections.relationships.rows.filter((row) => row.relationshipKind === 'FOREIGN_KEY').length, 1);
  assert.equal(projections.relationships.rows.every((row) => row.relationshipAuthority === 'CATALOG_DECLARED' && row.inferred === false), true);

  const mutationPolicyDispatches = policyDeniedProbe('INSERT INTO ks23_app.accounts VALUES (2, \'x\', \'EU\');');
  const rawRowPolicyDispatches = policyDeniedProbe('SELECT row_canary FROM ks23_app.orders;');
  let scopeOverrideDispatches = 0;
  assert.throws(() => {
    const query = manifest.queries.find((entry) => entry.id === 'postgresql.structure.schemas');
    compilePostgresqlProfileQuery({profile, query, statement: sqlByQueryId[query.id], requestedSchemas: ['ks23_outside']});
    scopeOverrideDispatches += 1;
  }, /DB_ANALYZE_SCOPE_OVERRIDE_DENIED/);

  const databaseMutationSqlState = await databaseDeniedProbe(profile, scanPassword2, "INSERT INTO ks23_app.accounts VALUES (2, 'SYNTH-ACCOUNT-2', 'NA');");
  const databaseDdlSqlState = await databaseDeniedProbe(profile, scanPassword2, 'CREATE TEMP TABLE ks23_forbidden(value integer);');
  const probeProfile = profileFor(port, 1000);
  const timeout = await runPostgresqlControlledProbe({profile: probeProfile, password: scanPassword2, probeId: 'timeout'});
  const cancel = await runPostgresqlControlledProbe({profile: probeProfile, password: scanPassword2, probeId: 'cancel', abortAfterMs: 100});
  assert.ok(timeout.elapsedMs >= 850 && timeout.elapsedMs < 2500, `timeout elapsed ${timeout.elapsedMs}`);
  assert.ok(cancel.elapsedMs >= 50 && cancel.elapsedMs < 1500, `cancel elapsed ${cancel.elapsedMs}`);

  const after = await groundTruth(profile, ownerPassword);
  const afterSha256 = sha256(canonicalJson(after));
  assert.equal(afterSha256, beforeSha256);

  const evidenceFiles = [run1File, run2File];
  const privacy = await scanArtifacts(evidenceFiles, [ownerPassword, scanPassword1, scanPassword2]);
  assert.deepEqual(privacy, {rawRowCanaryMatches: 0, outsideCanaryMatches: 0, credentialCanaryMatches: 0, dsnMatches: 0, rawValueFields: 0});
  const noPartialEvidence = evidenceFiles.every((file) => !file.includes('.partial'));
  const readback = {
    schemaVersion: 'kaleidosphere.db/postgresql-e2e-readback/v1',
    fixtureId: 'ks23-postgres-e2e-v1',
    image: {reference: IMAGE_REFERENCE, platform: 'linux/amd64', manifestDigest: IMAGE_DIGEST},
    canonicalEvidence: {run1Sha256, run2Sha256, byteIdentical: true, diskReadbackValidated: true, runtimeValidated: true},
    groundTruth: {
      beforeSha256, afterSha256, unchanged: true, schemas: before.schemas, relations: before.relations,
      columns: before.columns, constraints: before.constraints, foreignKeys: before.foreign_keys,
      notValidatedChecks: before.not_validated_checks, partialUniqueIndexes: before.partial_unique_indexes
    },
    session: {
      transactionReadOnly: session.transactionReadOnly,
      defaultTransactionReadOnly: session.defaultTransactionReadOnly,
      roleName: session.roleName,
      adminCapabilities: session.adminCapabilities,
      boundedTimeouts: session.statementTimeout === '5s' && session.lockTimeout === '1s'
    },
    negativeProbes: {
      mutationPolicyDispatches, rawRowPolicyDispatches, scopeOverrideDispatches,
      databaseMutationSqlState, databaseDdlSqlState,
      timeoutState: timeout.state, timeoutSqlState: timeout.sqlState,
      cancelState: cancel.state, cancelSqlState: cancel.sqlState,
      activeFollowers: timeout.activeFollowers + cancel.activeFollowers,
      postProbeHealthy: timeout.postProbeHealthy && cancel.postProbeHealthy,
      noPartialEvidence
    },
    privacy,
    nonClaims: [
      'Local synthetic PostgreSQL 16.10 evidence only; no production, customer-data, HA, extension or version-breadth claim.',
      'The partial unique index is fixture ground truth and an explicit query-pack blind spot, not a modeled unique constraint.',
      'Container transport is loopback-only and intentionally does not claim production TLS behavior.'
    ]
  };
  const readbackSchema = JSON.parse(await readFile(path.join(repositoryRoot, 'contracts/postgresql-e2e/v1/readback.schema.json'), 'utf8'));
  validateOrThrow(readback, readbackSchema, 'postgresql-e2e-readback');
  const readbackFile = path.join(outputRoot, 'readback.json');
  await atomicWrite(readbackFile, canonicalJson(readback));
  const humanFile = path.join(outputRoot, 'README.md');
  await atomicWrite(humanFile, `# PostgreSQL #23 local end-to-end readback\n\n`+
    `Fixture \`ks23-postgres-e2e-v1\` ran twice through fresh read-only sessions against the digest-pinned official PostgreSQL 16.10 image. `+
    `Both canonical artifacts are byte-identical at SHA-256 \`${run1Sha256}\`.\n\n`+
    `Observed scope: 1 schema, 3 relations, 13 columns, 9 constraints and 1 declared foreign key. `+
    `The NOT VALID check remains unvalidated; the partial unique index is explicitly outside the #22 constraint model.\n\n`+
    `Policy mutation, raw-row and scope-override probes dispatched zero database calls. Independent database mutation/DDL, timeout and cancellation probes failed closed; ground truth remained unchanged and post-probe health passed. No raw values are reproduced here.\n`);
  const finalPrivacy = await scanArtifacts([run1File, run2File, readbackFile, humanFile], [ownerPassword, scanPassword1, scanPassword2]);
  assert.deepEqual(finalPrivacy, privacy);

  const wave2Privacy = await scanArtifacts([wave2Run1File, wave2Run2File], [ownerPassword, scanPassword1, scanPassword2]);
  assert.deepEqual(wave2Privacy, privacy);
  const wave2Readback = {
    schemaVersion: 'kaleidosphere.analysis/postgresql-wave2-e2e-readback/v1',
    fixtureId: 'ks-analysis-wave2-e2e-v1',
    image: {reference: IMAGE_REFERENCE, platform: 'linux/amd64', manifestDigest: IMAGE_DIGEST},
    canonicalResult: {
      run1Sha256: wave2Run1Sha256,
      run2Sha256: wave2Run2Sha256,
      byteIdentical: true,
      diskReadbackValidated: true,
      runtimeValidated: true
    },
    groundTruth: {beforeSha256, afterSha256, unchanged: true},
    summary: {
      profiledColumns: 3,
      observedFacts: 4,
      computedFacts: 1,
      inferredCandidates: 1,
      evaluatedPairs: 1,
      highConfidenceCandidates: 1,
      declaredForeignKeysExcluded: true,
      evidenceStoreFacts: 6,
      planSteps: 4
    },
    authority: {
      proposalOnly: true,
      executionAuthority: 'NONE',
      mutationAuthority: 'NONE',
      providerCallPerformed: false,
      freeSqlAccepted: false
    },
    privacy: wave2Privacy,
    nonClaims: [
      'Local synthetic PostgreSQL 16.10 evidence only; no production, customer-data, HA, performance, TLS or version-breadth claim.',
      'The inferred relationship is a review-required proposal based on one local aggregate snapshot, not semantic FK truth.',
      'Composite, expression and partial unique targets are outside this Wave 2 candidate model.'
    ]
  };
  const wave2ReadbackSchema = JSON.parse(await readFile(path.join(repositoryRoot, 'contracts/postgresql-wave2-e2e/v1/readback.schema.json'), 'utf8'));
  validateOrThrow(wave2Readback, wave2ReadbackSchema, 'postgresql-wave2-e2e-readback');
  const wave2ReadbackFile = path.join(wave2OutputRoot, 'readback.json');
  await atomicWrite(wave2ReadbackFile, canonicalJson(wave2Readback));
  const wave2HumanFile = path.join(wave2OutputRoot, 'README.md');
  await atomicWrite(wave2HumanFile, `# PostgreSQL Analysis Wave 2 local readback\n\n`+
    `The allowlisted Wave 2 flow ran twice through fresh read-only sessions against the digest-pinned PostgreSQL 16.10 fixture. `+
    `Both canonical results are byte-identical at SHA-256 \`${wave2Run1Sha256}\`.\n\n`+
    `Three columns were profiled with count-only evidence. One candidate pair was evaluated and produced the review-required high-confidence proposal `+
    `\`ks23_app.staging_events.account_id\` → \`ks23_app.accounts.account_id\`; the declared orders foreign key was excluded rather than duplicated.\n\n`+
    `Observed, computed and inferred records are separated and content-addressed. No source-row material, credentials, connection strings, provider calls, free SQL or mutation authority are included.\n`);
  const wave2FinalPrivacy = await scanArtifacts(
    [wave2Run1File, wave2Run2File, wave2ReadbackFile, wave2HumanFile],
    [ownerPassword, scanPassword1, scanPassword2]
  );
  assert.deepEqual(wave2FinalPrivacy, wave2Privacy);

  console.log(JSON.stringify({
    fixtureId: readback.fixtureId,
    evidenceSha256: run1Sha256,
    byteIdentical: true,
    timeout: {state: timeout.state, sqlState: timeout.sqlState, elapsedMs: timeout.elapsedMs},
    cancel: {state: cancel.state, sqlState: cancel.sqlState, elapsedMs: cancel.elapsedMs},
    groundTruthUnchanged: true,
    privacy,
    diskReadbackValidated: true,
    wave2: {
      resultSha256: wave2Run1Sha256,
      byteIdentical: true,
      profiledColumns: 3,
      evaluatedPairs: 1,
      highConfidenceCandidates: 1,
      observedComputedInferred: [4, 1, 1]
    }
  }));
}

await main();
