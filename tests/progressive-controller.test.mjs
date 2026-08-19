import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {buildPreflightEvidence, identitySha256} from '../services/bi-control/src/db-analyzer/core.mjs';
import {
  PROGRESSIVE_COVERAGE_STATES,
  PROGRESSIVE_PHASES,
  advanceProgressivePhase,
  authorizeProgressiveProbe,
  buildProgressiveCoverage,
  buildProgressiveMethodRegistry,
  buildProgressiveReport,
  createProgressiveBreadthOverride,
  createProgressiveCoverage,
  createProgressiveRun,
  recordProgressiveReceipt,
  resumeProgressiveRun,
} from '../services/bi-control/src/db-analyzer/progressive-controller.mjs';
import {runAnalyzeProfile} from '../services/bi-control/src/db-analyzer/workflow.mjs';
import {buildLiveProfile} from '../services/bi-control/src/runtime-config.mjs';

const ROOT = 'services/bi-control';
const MSSQL_DIRECTORY = `${ROOT}/query-packs/db-analyzer/v1/mssql`;
const ORACLE_DIRECTORY = `${ROOT}/query-packs/db-analyzer/v1/oracle`;

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function mssqlInputs() {
  const [structureManifest, profilingManifest, structureEvidence] = await Promise.all([
    readJson(`${MSSQL_DIRECTORY}/manifest.json`),
    readJson(`${MSSQL_DIRECTORY}/profiling-manifest.json`),
    runAnalyzeProfile(`${ROOT}/fixtures/mssql-profile-v1.json`, {repositoryRoot: ROOT}),
  ]);
  return {
    engine: 'mssql',
    scope: structureEvidence.profile.scope,
    registry: buildProgressiveMethodRegistry({structureManifest, profilingManifest}),
    coverage: buildProgressiveCoverage(structureEvidence),
  };
}

const oracleEnv = {
  BI_ENGINE: 'oracle', ORACLE_HOST: 'oracle-test', ORACLE_PORT: '1521', ORACLE_DATABASE: 'FREE',
  ORACLE_SERVICE_NAME: 'FREEPDB1', ORACLE_USER: 'BI_ANALYZE', ORACLE_SCHEMAS: 'BI_DEMO',
  ORACLE_PROTOCOL: 'tcp', ORACLE_CONNECT_TIMEOUT_MS: '9000', ORACLE_QUERY_TIMEOUT_MS: '7000',
};

function rowFor(query, values) {
  return Object.fromEntries(query.outputColumns.map((column) => [column, Object.hasOwn(values, column) ? values[column] : null]));
}

async function oracleInputs({denySizes = false} = {}) {
  const structureManifest = await readJson(`${ORACLE_DIRECTORY}/manifest.json`);
  const sqlByQueryId = Object.fromEntries(await Promise.all(structureManifest.queries.map(async (query) => [
    query.id, await readFile(`${ORACLE_DIRECTORY}/${query.file}`, 'utf8'),
  ])));
  const results = Object.fromEntries(structureManifest.queries.map((query) => [query.id, {state: 'SUCCEEDED', reasonCode: null, rows: []}]));
  const query = (id) => structureManifest.queries.find((entry) => entry.id === id);
  results['oracle.preflight.identity'].rows = [rowFor(query('oracle.preflight.identity'), {
    engine: 'oracle', engine_version: '26ai-fixture', database_name: 'FREE', container_name: 'FREEPDB1',
  })];
  results['oracle.preflight.rights'].rows = [rowFor(query('oracle.preflight.rights'), {
    permission_name: 'SYSTEM:CREATE SESSION', has_permission: 1,
  })];
  results['oracle.preflight.capabilities'].rows = [rowFor(query('oracle.preflight.capabilities'), {
    collector_id: 'oracle.structure.relations', capability_name: 'ALL_OBJECTS', visibility_state: 'VISIBLE',
    minimum_privilege: 'CREATE SESSION', fallback_semantics: 'DENIED_IS_NOT_ABSENT',
  })];
  results['oracle.structure.schemas'].rows = [rowFor(query('oracle.structure.schemas'), {schema_name: 'BI_DEMO'})];
  results['oracle.structure.relations'].rows = [rowFor(query('oracle.structure.relations'), {
    schema_name: 'BI_DEMO', relation_name: 'ORDERS', relation_kind: 'TABLE', object_id: 101,
    status: 'VALID', temporary: false,
  })];
  results['oracle.structure.columns'].rows = [rowFor(query('oracle.structure.columns'), {
    schema_name: 'BI_DEMO', relation_name: 'ORDERS', relation_kind: 'TABLE', column_name: 'ORDER_ID',
    ordinal_position: 1, data_type_schema: 'SYS', data_type: 'NUMBER', is_nullable: false,
  })];
  if (denySizes) results['oracle.size.segments'] = {state: 'DENIED', reasonCode: 'ORA_01031', rows: []};
  const profile = buildLiveProfile(oracleEnv, 'CM_ORACLE_PASSWORD');
  const structureEvidence = buildPreflightEvidence({
    manifest: structureManifest,
    sqlByQueryId,
    resultSets: {schemaVersion: 'chimpmaera.db/runtime-query-results/v1', engine: 'oracle', runtimeValidated: true, results},
    profileContext: {profileId: profile.profileId, mode: profile.mode, scope: profile.scope, policy: profile.policy, adapter: profile.adapter.kind},
  });
  return {
    engine: 'oracle',
    scope: profile.scope,
    registry: buildProgressiveMethodRegistry({structureManifest}),
    coverage: buildProgressiveCoverage(structureEvidence),
  };
}

function newRun(inputs, options = {}) {
  return createProgressiveRun({
    runId: options.runId ?? `fixture-${inputs.engine}-progressive-v1`,
    engine: inputs.engine,
    scope: inputs.scope,
    methodRegistry: inputs.registry,
    coverage: options.coverage ?? inputs.coverage,
    budgets: options.budgets ?? {maxRunProbes: 4, maxObjectProbes: 2},
    breadthOverride: options.breadthOverride ?? null,
  });
}

function advanceTo(run, target) {
  let current = run;
  while (current.phase !== target) {
    const index = PROGRESSIVE_PHASES.indexOf(current.phase);
    current = advanceProgressivePhase(current, PROGRESSIVE_PHASES[index + 1]);
  }
  return current;
}

function mssqlColumnTarget(coverage, offset = 0) {
  const entry = coverage.entries.filter(({objectRef}) => objectRef.kind === 'COLUMN')[offset];
  assert(entry);
  return {
    entry,
    target: {
      kind: 'COLUMN',
      schemaName: entry.objectRef.schemaName,
      relationName: entry.objectRef.relationName,
      columnName: entry.objectRef.columnName,
    },
  };
}

function profileMethod(registry, suffix = 'numeric-aggregate') {
  const method = registry.methods.find(({methodRef}) => methodRef.includes(`profiling.${suffix}@`));
  assert(method);
  return method.methodRef;
}

function request(run, methodRef, target, extra = {}) {
  return {phase: run.phase, methodRef, target, arguments: extra};
}

test('controller derives explicit per-visible-object coverage from existing evidence without absence inference', async () => {
  const mssql = await mssqlInputs();
  assert(mssql.coverage.entries.length > 0);
  assert.equal(new Set(mssql.coverage.entries.map(({objectKey}) => objectKey)).size, mssql.coverage.entries.length);
  assert(mssql.coverage.entries.every(({state}) => PROGRESSIVE_COVERAGE_STATES.includes(state)));
  assert(mssql.coverage.entries.every(({absenceClaim}) => absenceClaim === 'NOT_CLAIMED'));
  assert.equal(mssql.coverage.missingPrivilegeMeansAbsent, false);
  assert.equal(mssql.coverage.summary.coverageBps, 10000);

  const oracle = await oracleInputs({denySizes: true});
  const denied = oracle.coverage.queryCoverage.find(({queryId}) => queryId === 'oracle.size.segments');
  assert.equal(denied.state, 'DENIED');
  assert.equal(denied.absenceClaim, 'NOT_CLAIMED');
  assert.equal(oracle.coverage.missingPrivilegeMeansAbsent, false);
});

test('phase state machine is monotonic and the 95% breadth gate blocks depth without a bound persisted override', async () => {
  const inputs = await mssqlInputs();
  const {entry: column} = mssqlColumnTarget(inputs.coverage);
  const entries = inputs.coverage.entries.map((entry) => ({
    objectRef: entry.objectRef,
    state: entry.objectKey === column.objectKey ? 'UNKNOWN' : entry.state,
    reasonCode: entry.objectKey === column.objectKey ? 'FIXTURE_UNKNOWN' : entry.reasonCode,
    sourceQueryId: entry.sourceQueryId,
    evidenceRefs: entry.evidenceRefs,
  }));
  const coverage = createProgressiveCoverage({
    engine: 'mssql',
    structureSnapshotSha256: inputs.coverage.structureSnapshotSha256,
    structureCoverageLedgerSha256: inputs.coverage.structureCoverageLedgerSha256,
    entries,
    queryCoverage: inputs.coverage.queryCoverage,
  });
  assert(coverage.summary.coverageBps < 9500);
  let blocked = newRun(inputs, {coverage});
  assert.throws(() => advanceProgressivePhase(blocked, 'PRIORITIZATION'), /DB_PROGRESSIVE_PHASE_TRANSITION_DENIED/);
  blocked = advanceTo(blocked, 'PRIORITIZATION');
  assert.throws(() => advanceProgressivePhase(blocked, 'SAFE_AGGREGATES'), /DB_PROGRESSIVE_BREADTH_GATE_BLOCKED/);

  const runId = 'fixture-mssql-progressive-override';
  const scopeSha256 = identitySha256(inputs.scope);
  const override = createProgressiveBreadthOverride({
    runId,
    scopeSha256,
    coverageSha256: coverage.coverageSha256,
    reasonCode: 'FIXTURE_KNOWN_BLIND_SPOT',
    actorId: 'fixture-reviewer',
    recordedAt: '2026-08-19T00:00:00.000Z',
    allowedObjectKeys: [column.objectKey],
    maxDepthProbeCount: 1,
  });
  let allowed = advanceTo(newRun(inputs, {runId, coverage, breadthOverride: override}), 'SAFE_AGGREGATES');
  const target = {kind: 'COLUMN', schemaName: column.objectRef.schemaName, relationName: column.objectRef.relationName, columnName: column.objectRef.columnName};
  const authorization = authorizeProgressiveProbe(allowed, request(allowed, profileMethod(inputs.registry), target));
  assert.equal(authorization.authorization.disposition, 'AUTHORIZED');
  allowed = authorization.state;
  assert.throws(() => authorizeProgressiveProbe(allowed, request(allowed, profileMethod(inputs.registry, 'temporal-aggregate'), target)), /DB_PROGRESSIVE_OVERRIDE_BUDGET_EXCEEDED|DB_PROGRESSIVE_OBJECT_BUDGET_EXCEEDED/);

  const stale = structuredClone(override);
  stale.coverageSha256 = '0'.repeat(64);
  assert.throws(() => newRun(inputs, {runId, coverage, breadthOverride: stale}), /DB_PROGRESSIVE_OVERRIDE_TAMPERED|DB_PROGRESSIVE_OVERRIDE_STALE/);
});

test('hard budgets, exact duplicate suppression and successful receipt resume are deterministic', async () => {
  const inputs = await mssqlInputs();
  const first = mssqlColumnTarget(inputs.coverage, 0);
  const second = mssqlColumnTarget(inputs.coverage, 1);
  let run = advanceTo(newRun(inputs, {budgets: {maxRunProbes: 2, maxObjectProbes: 1}}), 'SAFE_AGGREGATES');
  const methodRef = profileMethod(inputs.registry);
  const authorized = authorizeProgressiveProbe(run, request(run, methodRef, first.target));
  assert.equal(authorized.authorization.disposition, 'AUTHORIZED');
  run = authorized.state;
  const duplicate = authorizeProgressiveProbe(run, request(run, methodRef, first.target));
  assert.equal(duplicate.authorization.disposition, 'SUPPRESSED_DUPLICATE');
  assert.equal(duplicate.state.stateSha256, run.stateSha256);
  run = recordProgressiveReceipt(run, {
    probeKey: authorized.authorization.probeKey,
    resultState: 'SUCCEEDED',
    evidenceRefs: [identitySha256({kind: 'SAFE_AGGREGATE_FIXTURE', target: first.target})],
  });
  const resumed = resumeProgressiveRun(JSON.parse(JSON.stringify(run)));
  const replay = authorizeProgressiveProbe(resumed, request(resumed, methodRef, first.target));
  assert.equal(replay.authorization.disposition, 'REUSED_SUCCESS');
  assert.equal(replay.state.budget.authorizedProbeCount, 1);
  assert.throws(() => authorizeProgressiveProbe(resumed, request(resumed, profileMethod(inputs.registry, 'temporal-aggregate'), first.target)), /DB_PROGRESSIVE_OBJECT_BUDGET_EXCEEDED/);

  let runBudget = advanceTo(newRun(inputs, {runId: 'fixture-mssql-run-budget', budgets: {maxRunProbes: 1, maxObjectProbes: 1}}), 'SAFE_AGGREGATES');
  runBudget = authorizeProgressiveProbe(runBudget, request(runBudget, methodRef, first.target)).state;
  assert.throws(() => authorizeProgressiveProbe(runBudget, request(runBudget, methodRef, second.target)), /DB_PROGRESSIVE_RUN_BUDGET_EXCEEDED/);

  const tampered = JSON.parse(JSON.stringify(resumed));
  tampered.receipts[0].resultState = 'DENIED';
  assert.throws(() => resumeProgressiveRun(tampered), /DB_PROGRESSIVE_STATE_TAMPERED|DB_PROGRESSIVE_RECEIPT_TAMPERED/);
});

test('only existing allowlisted methods and typed scoped identifiers cross the dispatch boundary', async () => {
  const inputs = await mssqlInputs();
  const first = mssqlColumnTarget(inputs.coverage, 0);
  let run = advanceTo(newRun(inputs), 'SAFE_AGGREGATES');
  const methodRef = profileMethod(inputs.registry);
  assert.throws(() => authorizeProgressiveProbe(run, request(run, 'mssql.ddl.drop-table@1.0.0', first.target)), /DB_PROGRESSIVE_METHOD_DENIED/);
  assert.throws(() => authorizeProgressiveProbe(run, request(run, 'mssql.dml.update@1.0.0', first.target)), /DB_PROGRESSIVE_METHOD_DENIED/);
  assert.throws(() => authorizeProgressiveProbe(run, request(run, methodRef, {...first.target, relationName: 'orders; DROP TABLE x'})), /DB_PROGRESSIVE_SCOPE_DENIED/);
  assert.throws(() => authorizeProgressiveProbe(run, request(run, methodRef, {...first.target, schemaName: 'OTHER'})), /DB_PROGRESSIVE_SCOPE_DENIED/);
  assert.throws(() => authorizeProgressiveProbe(run, request(run, methodRef, first.target, {sql: 'SELECT * FROM secret'})), /DB_PROGRESSIVE_PROBE_REQUEST_INVALID/);
  assert.throws(() => authorizeProgressiveProbe(run, request(run, methodRef, first.target, {rawValues: ['customer@example.invalid']})), /DB_PROGRESSIVE_PROBE_REQUEST_INVALID/);
  assert.throws(() => authorizeProgressiveProbe(run, request(run, methodRef, first.target, {password: 'fixture-only'})), /DB_PROGRESSIVE_PROBE_REQUEST_INVALID/);

  const timeout = authorizeProgressiveProbe(run, request(run, methodRef, first.target));
  run = recordProgressiveReceipt(timeout.state, {probeKey: timeout.authorization.probeKey, resultState: 'TIMEOUT', evidenceRefs: []});
  assert.equal(authorizeProgressiveProbe(run, request(run, methodRef, first.target)).authorization.disposition, 'SUPPRESSED_DUPLICATE');
  const second = mssqlColumnTarget(inputs.coverage, 1);
  const cancel = authorizeProgressiveProbe(run, request(run, methodRef, second.target));
  run = recordProgressiveReceipt(cancel.state, {probeKey: cancel.authorization.probeKey, resultState: 'CANCELLED', evidenceRefs: []});
  assert.equal(authorizeProgressiveProbe(run, request(run, methodRef, second.target)).authorization.disposition, 'SUPPRESSED_DUPLICATE');
  assert.equal(run.safety.blindRetryAllowed, false);
});

async function terminalMssqlReport() {
  const inputs = await mssqlInputs();
  const first = mssqlColumnTarget(inputs.coverage, 0);
  let run = advanceTo(newRun(inputs), 'SAFE_AGGREGATES');
  const authorization = authorizeProgressiveProbe(run, request(run, profileMethod(inputs.registry), first.target));
  run = recordProgressiveReceipt(authorization.state, {
    probeKey: authorization.authorization.probeKey,
    resultState: 'SUCCEEDED',
    evidenceRefs: [identitySha256({kind: 'SAFE_AGGREGATE_FIXTURE', target: first.target})],
  });
  run = advanceTo(run, 'REPORT');
  return buildProgressiveReport(run);
}

async function terminalOracleReport() {
  const inputs = await oracleInputs();
  const run = advanceTo(newRun(inputs), 'REPORT');
  return buildProgressiveReport(run);
}

test('identical MSSQL and Oracle fixture runs produce identical canonical controller evidence hashes', async () => {
  const [mssqlOne, mssqlTwo, oracleOne, oracleTwo] = await Promise.all([
    terminalMssqlReport(), terminalMssqlReport(), terminalOracleReport(), terminalOracleReport(),
  ]);
  assert.equal(mssqlOne.controllerEvidenceSha256, mssqlTwo.controllerEvidenceSha256);
  assert.equal(oracleOne.controllerEvidenceSha256, oracleTwo.controllerEvidenceSha256);
  if (process.env.KS_PRINT_PROGRESSIVE_HASHES === '1') {
    console.log(JSON.stringify({
      mssqlControllerEvidenceSha256: mssqlOne.controllerEvidenceSha256,
      oracleControllerEvidenceSha256: oracleOne.controllerEvidenceSha256,
    }));
  }
  assert.equal(mssqlOne.coverage.summary.visibleObjectCount, mssqlOne.coverage.entries.length);
  assert.equal(oracleOne.coverage.summary.visibleObjectCount, oracleOne.coverage.entries.length);
  assert.equal(oracleOne.phaseCapabilities.find(({phase}) => phase === 'SAFE_AGGREGATES').state, 'UNSUPPORTED');
  assert.equal(JSON.stringify(mssqlOne).includes('fixture-only'), false);
  assert.deepEqual(mssqlOne.phases, PROGRESSIVE_PHASES);
  assert.equal(mssqlOne.disclosure.rawValuesPersisted, false);
  assert.equal(mssqlOne.disclosure.credentialsPersisted, false);
  assert.equal(mssqlOne.disclosure.freeSqlAccepted, false);
});
