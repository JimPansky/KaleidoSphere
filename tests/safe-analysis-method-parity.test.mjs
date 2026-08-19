import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {canonicalJson, identitySha256} from '../services/bi-control/src/db-analyzer/core.mjs';
import {
  PROGRESSIVE_PHASES,
  advanceProgressivePhase,
  authorizeProgressiveProbe,
  buildProgressiveMethodRegistry,
  createProgressiveCoverage,
  createProgressiveRun,
} from '../services/bi-control/src/db-analyzer/progressive-controller.mjs';
import {
  buildProgressiveProbeCandidate,
  createProgressiveAnalysis,
  registerProgressiveHypothesis,
  reserveProgressiveProbeCandidate,
} from '../services/bi-control/src/db-analyzer/progressive-analysis-v1.mjs';
import {
  auditSafeAnalysisQuery,
  buildSafeAnalysisEvidence,
  compileSafeAnalysisMethod,
  executeSafeAnalysisMethod,
  validateSafeAnalysisMethodManifest,
} from '../services/bi-control/src/db-analyzer/safe-analysis-methods.mjs';

const ROOT = 'services/bi-control/query-packs/db-analyzer/v1';
const scope = {database: 'FIXTURE', container: null, schemas: ['APP']};
const targets = {
  orderId: {kind: 'COLUMN', schemaName: 'APP', relationName: 'ORDERS', columnName: 'ORDER_ID'},
  customerId: {kind: 'COLUMN', schemaName: 'APP', relationName: 'ORDERS', columnName: 'CUSTOMER_ID'},
  customerKey: {kind: 'COLUMN', schemaName: 'APP', relationName: 'CUSTOMERS', columnName: 'CUSTOMER_ID'},
  orderDate: {kind: 'COLUMN', schemaName: 'APP', relationName: 'ORDERS', columnName: 'ORDER_DATE'},
};
targets.relationship = {
  kind: 'RELATIONSHIP',
  source: {schemaName: 'APP', relationName: 'ORDERS', columnName: 'CUSTOMER_ID'},
  target: {schemaName: 'APP', relationName: 'CUSTOMERS', columnName: 'CUSTOMER_ID'},
};

async function pack(engine) {
  const directory = `${ROOT}/${engine}`;
  const [structureManifest, manifest] = await Promise.all([
    readJson(`${directory}/manifest.json`), readJson(`${directory}/safe-analysis-manifest.json`),
  ]);
  const sqlByMethodId = Object.fromEntries(await Promise.all(manifest.methods.map(async (method) => [
    method.id, await readFile(`${directory}/${method.file}`, 'utf8'),
  ])));
  return {engine, structureManifest, manifest, sqlByMethodId};
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function coverage(engine) {
  const sourceQueryId = `${engine}.structure.columns`;
  const evidence = identitySha256({fixture: `${engine}-safe-analysis-coverage`});
  return createProgressiveCoverage({
    engine,
    structureSnapshotSha256: identitySha256({fixture: `${engine}-structure-snapshot`}),
    structureCoverageLedgerSha256: identitySha256({fixture: `${engine}-coverage-ledger`}),
    entries: Object.values(targets).filter((target) => target.kind === 'COLUMN').map((target) => ({
      objectRef: {
        kind: 'COLUMN', schemaName: target.schemaName, relationName: target.relationName,
        columnName: target.columnName, objectName: null, sourceObjectSha256: identitySha256({engine, target}),
      },
      state: 'COMPLETE', reasonCode: null, sourceQueryId, evidenceRefs: [evidence],
    })),
    queryCoverage: [
      {queryId: `${engine}.preflight.identity`, category: 'preflight', state: 'SUCCEEDED', reasonCode: null, visibility: 'VISIBLE_COMPLETE', absenceClaim: 'NOT_CLAIMED'},
      {queryId: sourceQueryId, category: 'columns', state: 'SUCCEEDED', reasonCode: null, visibility: 'VISIBLE_COMPLETE', absenceClaim: 'NOT_CLAIMED'},
    ],
  });
}

function advanceTo(run, phase) {
  let state = run;
  while (state.phase !== phase) state = advanceProgressivePhase(state, PROGRESSIVE_PHASES[PROGRESSIVE_PHASES.indexOf(state.phase) + 1]);
  return state;
}

async function controller(engine, phase, budgets = {maxRunProbes: 8, maxObjectProbes: 3}) {
  const packed = await pack(engine);
  const registry = buildProgressiveMethodRegistry({
    structureManifest: packed.structureManifest, safeAnalysisManifest: packed.manifest,
  });
  const run = advanceTo(createProgressiveRun({
    runId: `fixture-${engine}-${phase.toLowerCase().replaceAll('_', '-')}`,
    engine, scope, methodRegistry: registry, coverage: coverage(engine), budgets,
  }), phase);
  return {...packed, registry, run};
}

function methodRef(registry, semanticMethod) {
  const found = registry.methods.find((method) => method.methodRef.includes(`safe.${semanticMethod.toLowerCase().replaceAll('_', '-')}@`));
  assert(found, semanticMethod);
  return found.methodRef;
}

function authorize(run, registry, semanticMethod, target, typeFamily) {
  return authorizeProgressiveProbe(run, {
    phase: run.phase, methodRef: methodRef(registry, semanticMethod), target,
    arguments: {maxSourceRows: 500, typeFamily},
  });
}

const session = (engine, rows, capture = []) => ({
  engine,
  readOnly: true,
  async execute(request) {
    capture.push(request);
    return {state: 'SUCCEEDED', reasonCode: null, rows};
  },
});

test('MSSQL and Oracle packs contain the same four semantic methods and audit as bounded SELECT-only aggregates', async () => {
  const [mssql, oracle] = await Promise.all([pack('mssql'), pack('oracle')]);
  for (const packed of [mssql, oracle]) {
    assert.equal(validateSafeAnalysisMethodManifest(packed.manifest, packed.sqlByMethodId), packed.manifest);
    for (const method of packed.manifest.methods) {
      assert.equal(auditSafeAnalysisQuery({manifest: packed.manifest, method, sql: packed.sqlByMethodId[method.id]}), true);
      assert.equal(method.readOnly, true);
      assert.equal(method.aggregateOnly, true);
      assert.equal(method.rowSamples, false);
      assert.equal(method.exampleValues, false);
      assert.equal(method.maxOutputRows, 1);
      assert(method.maxSourceRows <= 10000);
      assert(method.timeoutMs <= 10000);
    }
  }
  assert.deepEqual(mssql.manifest.methods.map(({semanticMethod}) => semanticMethod).sort(), oracle.manifest.methods.map(({semanticMethod}) => semanticMethod).sort());
  const oracleBoolean = oracle.manifest.methods.find(({semanticMethod}) => semanticMethod === 'COLUMN_SUMMARY')
    .capabilities.find(({typeFamily}) => typeFamily === 'BOOLEAN');
  assert.deepEqual(oracleBoolean, {typeFamily: 'BOOLEAN', state: 'UNSUPPORTED', reasonCode: 'ORACLE_NATIVE_BOOLEAN_COLUMN_UNSUPPORTED'});
});

test('equivalent MSSQL and Oracle column aggregates produce one engine-neutral semantic hash and proposal-only key evidence', async () => {
  const evidences = [];
  for (const engine of ['mssql', 'oracle']) {
    const state = await controller(engine, 'SAFE_AGGREGATES');
    const authorized = authorize(state.run, state.registry, 'COLUMN_SUMMARY', targets.orderId, 'NUMERIC');
    const capture = [];
    const evidence = await executeSafeAnalysisMethod({
      run: authorized.state, authorization: authorized.authorization, manifest: state.manifest,
      sqlByMethodId: state.sqlByMethodId, session: session(engine, [{rowCount: '4', nullCount: 0, distinctCount: 4}], capture),
    });
    assert.equal(capture.length, 1);
    assert.deepEqual(capture[0].binds, {maxSourceRows: 500});
    assert.equal(capture[0].maxRows, 1);
    assert.equal(evidence.state, 'COMPLETE');
    assert.equal(evidence.inferredClaims[0].inferenceKind, 'KEY_CANDIDATE');
    assert.equal(evidence.inferredClaims[0].claimStatus, 'PROPOSAL_ONLY');
    assert.equal(evidence.automaticFactPromotion, false);
    assert.equal(evidence.rawValuesPersisted, false);
    evidences.push(evidence);
  }
  assert.equal(evidences[0].semanticEvidenceSha256, evidences[1].semanticEvidenceSha256);
  assert.notEqual(evidences[0].evidenceSha256, evidences[1].evidenceSha256);
  if (process.env.KS_PRINT_SAFE_ANALYSIS_HASHES === '1') {
    console.log(JSON.stringify({columnSummarySemanticSha256: evidences[0].semanticEvidenceSha256}));
  }
});

test('relationship overlap debits both visible objects and preserves observed, computed, inferred and counterevidence classes', async () => {
  const semanticHashes = [];
  for (const engine of ['mssql', 'oracle']) {
    const state = await controller(engine, 'RELATIONSHIP_GRAPH', {maxRunProbes: 3, maxObjectProbes: 1});
    const authorized = authorize(state.run, state.registry, 'RELATIONSHIP_OVERLAP', targets.relationship, 'PAIR');
    assert.equal(authorized.state.budget.authorizedProbeCount, 1);
    assert.equal(authorized.state.budget.objectProbeCounts.length, 2);
    assert(authorized.state.budget.objectProbeCounts.every(({count}) => count === 1));
    const evidence = await executeSafeAnalysisMethod({
      run: authorized.state, authorization: authorized.authorization, manifest: state.manifest,
      sqlByMethodId: state.sqlByMethodId,
      session: session(engine, [{sourceNonNullCount: 4, sourceDistinctCount: 3, targetNonNullCount: 3, targetDistinctCount: 3, matchedDistinctCount: 3}]),
    });
    assert.equal(evidence.observedClaims[0].observationKind, 'OBSERVED');
    assert.equal(evidence.computedClaims[0].observationKind, 'COMPUTED');
    assert.equal(evidence.inferredClaims[0].observationKind, 'INFERRED');
    assert.equal(evidence.inferredClaims[0].claimStatus, 'PROPOSAL_ONLY');
    assert.deepEqual(evidence.counterevidence, []);
    semanticHashes.push(evidence.semanticEvidenceSha256);
    assert.throws(() => authorize(authorized.state, state.registry, 'RELATIONSHIP_OVERLAP', {
      kind: 'RELATIONSHIP', source: targets.relationship.target, target: targets.relationship.source,
    }, 'PAIR'), /DB_PROGRESSIVE_OBJECT_BUDGET_EXCEEDED/);
  }
  assert.equal(semanticHashes[0], semanticHashes[1]);
  if (process.env.KS_PRINT_SAFE_ANALYSIS_HASHES === '1') {
    console.log(JSON.stringify({relationshipOverlapSemanticSha256: semanticHashes[0]}));
  }

  const misleadingState = await controller('mssql', 'RELATIONSHIP_GRAPH');
  const misleadingAuthorization = authorize(misleadingState.run, misleadingState.registry, 'RELATIONSHIP_OVERLAP', targets.relationship, 'PAIR');
  const method = misleadingState.manifest.methods.find(({semanticMethod}) => semanticMethod === 'RELATIONSHIP_OVERLAP');
  const misleading = buildSafeAnalysisEvidence({
    controllerState: misleadingAuthorization.state, manifest: misleadingState.manifest, methodId: method.id, target: targets.relationship,
    arguments: {maxSourceRows: 500, typeFamily: 'PAIR'},
    result: {state: 'SUCCEEDED', reasonCode: null, rows: [{sourceNonNullCount: 4, sourceDistinctCount: 3, targetNonNullCount: 4, targetDistinctCount: 3, matchedDistinctCount: 2}]},
    authorization: misleadingAuthorization.authorization,
  });
  assert.deepEqual(misleading.inferredClaims, []);
  assert.deepEqual(misleading.counterevidence.map(({reasonCode}) => reasonCode), ['TARGET_NOT_UNIQUE', 'SOURCE_VALUES_UNMATCHED']);
  assert.equal(misleading.automaticForeignKey, false);
});

test('#37 reservation gate constrains relationship dispatch before the read-only session is called', async () => {
  const state = await controller('mssql', 'RELATIONSHIP_GRAPH');
  let analysis = createProgressiveAnalysis({
    controllerRun: state.run,
    budgets: {maxTableProbes: 1, maxHypothesisProbes: 1},
    policy: {maxConsecutiveNoGain: 2, maxConsecutiveCounterevidence: 2, minExpectedGainBps: 1},
  });
  analysis = registerProgressiveHypothesis(analysis, {
    hypothesisId: 'orders-customer-link', hypothesisKind: 'RELATIONSHIP_CANDIDATE',
    target: {kind: 'TABLE', schemaName: 'APP', relationName: 'ORDERS'},
    confidenceBounds: {lowerBps: 1000, upperBps: 7000},
    sourceEvidenceRefs: [identitySha256({fixture: 'relationship-source'})],
  });
  const candidate = buildProgressiveProbeCandidate(analysis, {
    hypothesisId: 'orders-customer-link', phase: 'RELATIONSHIP_GRAPH',
    methodRef: methodRef(state.registry, 'RELATIONSHIP_OVERLAP'), target: targets.relationship,
    arguments: {maxSourceRows: 500, typeFamily: 'PAIR'},
    intentFeatures: {probeClass: 'RELATIONSHIP_CHECK', signalKind: 'RELATIONSHIP', comparisonKind: 'NONE', grain: 'TABLE'},
    gainInputs: {uncertaintyBps: 6000, outcomeProbabilityBps: 7000, relevanceBps: 8000, rationaleCode: 'BOUNDED_RELATIONSHIP_VALIDATION', evidenceRefs: [identitySha256({fixture: 'gain'})]},
  });
  const reserved = reserveProgressiveProbeCandidate(analysis, candidate, {expectedStateSha256: analysis.stateSha256});
  assert.equal(reserved.authorization.disposition, 'RESERVED');
  assert.deepEqual(reserved.state.budget.tableReservationCounts.map(({count}) => count), [1]);
  assert.deepEqual(reserved.state.budget.hypothesisReservationCounts.map(({count}) => count), [1]);
  assert.equal(reserved.state.controllerRun.budget.objectProbeCounts.length, 2);
  const capture = [];
  const evidence = await executeSafeAnalysisMethod({
    run: reserved.state, authorization: reserved.authorization, manifest: state.manifest, sqlByMethodId: state.sqlByMethodId,
    session: session('mssql', [{sourceNonNullCount: 2, sourceDistinctCount: 2, targetNonNullCount: 2, targetDistinctCount: 2, matchedDistinctCount: 2}], capture),
  });
  assert.equal(capture.length, 1);
  assert.equal(evidence.controllerProbeKey, reserved.authorization.controllerProbeKey);
  assert.throws(() => reserveProgressiveProbeCandidate(reserved.state, candidate, {expectedStateSha256: analysis.stateSha256}), /DB_PROGRESSIVE_STALE_RESERVATION/);
});

test('quality and temporal methods expose aggregates only and reject source/sample/example-shaped output', async () => {
  const state = await controller('oracle', 'SAFE_AGGREGATES');
  const temporal = authorize(state.run, state.registry, 'TEMPORAL_COVERAGE', targets.orderDate, 'TEMPORAL');
  const evidence = await executeSafeAnalysisMethod({
    run: temporal.state, authorization: temporal.authorization, manifest: state.manifest, sqlByMethodId: state.sqlByMethodId,
    session: session('oracle', [{rowCount: 5, nullCount: 1, distinctCount: 4, minimum: '2026-01-01T00:00:00.000000', maximum: '2026-01-05T00:00:00.000000', freshnessMaximum: '2026-01-05T00:00:00.000000'}]),
  });
  assert.equal(evidence.observedClaims[0].aggregateKind, 'TEMPORAL_COVERAGE');
  assert.equal(evidence.rowSamplesPersisted, false);
  assert.equal(evidence.exampleValuesPersisted, false);

  const qualityState = await controller('oracle', 'HYPOTHESIS_VALIDATION');
  const quality = authorize(qualityState.run, qualityState.registry, 'QUALITY_INDICATORS', targets.customerId, 'NUMERIC');
  const qualityEvidence = await executeSafeAnalysisMethod({
    run: quality.state, authorization: quality.authorization, manifest: qualityState.manifest, sqlByMethodId: qualityState.sqlByMethodId,
    session: session('oracle', [{rowCount: 5, nullCount: 1, distinctCount: 3}]),
  });
  assert.equal(qualityEvidence.observedClaims[0].aggregateKind, 'QUALITY_INDICATORS');
  assert.equal(qualityEvidence.computedClaims[0].metrics.duplicateCount, 1);
  assert.deepEqual(qualityEvidence.inferredClaims, []);
  assert.deepEqual(qualityEvidence.counterevidence.map(({reasonCode}) => reasonCode), ['NULLS_OBSERVED', 'DUPLICATES_OBSERVED']);

  const method = state.manifest.methods.find(({semanticMethod}) => semanticMethod === 'TEMPORAL_COVERAGE');
  for (const forbidden of [
    {sampleValue: 'person@example.invalid'}, {rawValue: 'private'}, {exampleValue: 'private'}, {password: 'private'},
  ]) {
    assert.throws(() => buildSafeAnalysisEvidence({
      controllerState: temporal.state, manifest: state.manifest, methodId: method.id, target: targets.orderDate,
      arguments: {maxSourceRows: 500, typeFamily: 'TEMPORAL'},
      result: {state: 'SUCCEEDED', reasonCode: null, rows: [{rowCount: 1, nullCount: 0, distinctCount: 1, minimum: '2026-01-01', maximum: '2026-01-01', freshnessMaximum: '2026-01-01', ...forbidden}]},
      authorization: temporal.authorization,
    }), /DB_SAFE_METHOD_RAW_VALUE_DENIED/);
  }
});

test('denied, unsupported, partial, timeout and unknown remain explicit capability states and never become absence', async () => {
  const state = await controller('mssql', 'SAFE_AGGREGATES');
  const authorized = authorize(state.run, state.registry, 'COLUMN_SUMMARY', targets.orderId, 'NUMERIC');
  const method = state.manifest.methods.find(({semanticMethod}) => semanticMethod === 'COLUMN_SUMMARY');
  const states = [
    [{state: 'DENIED', reasonCode: 'SELECT_PRIVILEGE_DENIED', rows: []}, 'DENIED', 'DENIED'],
    [{state: 'UNSUPPORTED', reasonCode: 'TYPE_NOT_SUPPORTED', rows: []}, 'UNSUPPORTED', 'UNSUPPORTED'],
    [{state: 'PARTIAL', reasonCode: 'BOUNDED_PARTIAL_RESULT', rows: [{rowCount: 2, nullCount: 0, distinctCount: 2}]}, 'PARTIAL', 'PARTIAL'],
    [{state: 'TIMEOUT', reasonCode: 'QUERY_TIMEOUT', rows: []}, 'UNKNOWN', 'TIMEOUT'],
    [{state: 'CANCELLED', reasonCode: 'QUERY_CANCELLED', rows: []}, 'UNKNOWN', 'CANCELLED'],
    [{state: 'UNKNOWN', reasonCode: 'DISPATCH_OUTCOME_UNKNOWN', rows: []}, 'UNKNOWN', 'UNKNOWN'],
  ];
  for (const [result, expectedState, receiptState] of states) {
    const evidence = buildSafeAnalysisEvidence({
      controllerState: authorized.state, manifest: state.manifest, methodId: method.id, target: targets.orderId,
      arguments: {maxSourceRows: 500, typeFamily: 'NUMERIC'}, result,
      authorization: authorized.authorization,
    });
    assert.equal(evidence.state, expectedState);
    assert.equal(evidence.receiptState, receiptState);
    assert.equal(evidence.absenceClaim, 'NOT_CLAIMED');
  }
});

test('negative matrix fails closed for free SQL, DDL/DML, scope, credentials, raw rows, bounds, cancellation and forged packs', async () => {
  const state = await controller('mssql', 'SAFE_AGGREGATES');
  const method = state.manifest.methods.find(({semanticMethod}) => semanticMethod === 'COLUMN_SUMMARY');
  const ref = methodRef(state.registry, 'COLUMN_SUMMARY');
  const authorized = authorize(state.run, state.registry, 'COLUMN_SUMMARY', targets.orderId, 'NUMERIC');
  const cases = [
    () => authorizeProgressiveProbe(state.run, {phase: state.run.phase, methodRef: ref, target: targets.orderId, arguments: {sql: 'SELECT 1'}}),
    () => authorizeProgressiveProbe(state.run, {phase: state.run.phase, methodRef: ref, target: targets.orderId, arguments: {maxSourceRows: 0, typeFamily: 'NUMERIC'}}),
    () => authorizeProgressiveProbe(state.run, {phase: state.run.phase, methodRef: ref, target: targets.orderId, arguments: {maxSourceRows: 10001, typeFamily: 'NUMERIC'}}),
    () => authorizeProgressiveProbe(state.run, {phase: state.run.phase, methodRef: ref, target: {...targets.orderId, schemaName: 'OUTSIDE'}, arguments: {maxSourceRows: 10, typeFamily: 'NUMERIC'}}),
    () => authorizeProgressiveProbe(state.run, {phase: state.run.phase, methodRef: ref, target: {...targets.orderId, columnName: 'ID; DROP TABLE X'}, arguments: {maxSourceRows: 10, typeFamily: 'NUMERIC'}}),
    () => compileSafeAnalysisMethod({manifest: state.manifest, sqlByMethodId: state.sqlByMethodId, methodId: method.id, target: targets.orderId, arguments: {maxSourceRows: 10, typeFamily: 'PAIR'}}),
    () => buildSafeAnalysisEvidence({controllerState: authorized.state, manifest: state.manifest, methodId: method.id, target: targets.orderId, arguments: {maxSourceRows: 500, typeFamily: 'NUMERIC'}, result: {state: 'SUCCEEDED', reasonCode: null, rows: [{rowCount: 1, nullCount: 2, distinctCount: 0}]}, authorization: authorized.authorization}),
    () => buildSafeAnalysisEvidence({controllerState: authorized.state, manifest: state.manifest, methodId: method.id, target: targets.orderId, arguments: {maxSourceRows: 500, typeFamily: 'NUMERIC'}, result: {state: 'SUCCEEDED', reasonCode: null, rows: [{rowCount: 1, nullCount: 0, distinctCount: 2}]}, authorization: authorized.authorization}),
  ];
  for (const negative of cases) assert.throws(negative);

  const forgedSql = {...state.sqlByMethodId, [method.id]: 'DROP TABLE private_data;'};
  assert.throws(() => validateSafeAnalysisMethodManifest(state.manifest, forgedSql), /DB_SAFE_METHOD_QUERY_PACK_DENIED/);
  const tampered = structuredClone(state.manifest);
  tampered.methods[0].rowSamples = true;
  assert.throws(() => validateSafeAnalysisMethodManifest(tampered), /DB_SAFE_METHOD_MANIFEST_INVALID/);

  await assert.rejects(() => executeSafeAnalysisMethod({
    run: authorized.state, authorization: authorized.authorization, manifest: state.manifest, sqlByMethodId: state.sqlByMethodId,
    session: {engine: 'mssql', readOnly: false, execute: async () => ({})},
  }), /DB_SAFE_METHOD_READ_ONLY_SESSION_REQUIRED/);
  await assert.rejects(() => executeSafeAnalysisMethod({
    run: authorized.state, authorization: authorized.authorization, manifest: state.manifest, sqlByMethodId: state.sqlByMethodId,
    session: {engine: 'mssql', readOnly: true, password: 'fixture', execute: async () => ({})},
  }), /DB_SAFE_METHOD_READ_ONLY_SESSION_REQUIRED/);
  const timedOut = await executeSafeAnalysisMethod({
    run: authorized.state, authorization: authorized.authorization, manifest: state.manifest, sqlByMethodId: state.sqlByMethodId,
    session: {engine: 'mssql', readOnly: true, execute: async () => { const error = new Error('timeout'); error.code = 'ETIMEOUT'; throw error; }},
  });
  assert.equal(timedOut.state, 'UNKNOWN');
  assert.equal(timedOut.receiptState, 'TIMEOUT');
  assert.equal(timedOut.absenceClaim, 'NOT_CLAIMED');

  const oracleState = await controller('oracle', 'SAFE_AGGREGATES');
  const unsupported = authorize(oracleState.run, oracleState.registry, 'COLUMN_SUMMARY', targets.orderId, 'BOOLEAN');
  let executed = false;
  const unsupportedEvidence = await executeSafeAnalysisMethod({
    run: unsupported.state, authorization: unsupported.authorization, manifest: oracleState.manifest, sqlByMethodId: oracleState.sqlByMethodId,
    session: {engine: 'oracle', readOnly: true, execute: async () => { executed = true; return {}; }},
  });
  assert.equal(executed, false);
  assert.equal(unsupportedEvidence.state, 'UNSUPPORTED');
  assert.equal(unsupportedEvidence.reasonCode, 'ORACLE_NATIVE_BOOLEAN_COLUMN_UNSUPPORTED');
});

test('compiled packs are deterministic, typed and contain no credential/raw/sample fields', async () => {
  for (const engine of ['mssql', 'oracle']) {
    const packed = await pack(engine);
    for (const [semanticMethod, target, typeFamily] of [
      ['COLUMN_SUMMARY', targets.orderId, 'NUMERIC'],
      ['TEMPORAL_COVERAGE', targets.orderDate, 'TEMPORAL'],
      ['QUALITY_INDICATORS', targets.orderId, 'NUMERIC'],
      ['RELATIONSHIP_OVERLAP', targets.relationship, 'PAIR'],
    ]) {
      const method = packed.manifest.methods.find((entry) => entry.semanticMethod === semanticMethod);
      const first = compileSafeAnalysisMethod({manifest: packed.manifest, sqlByMethodId: packed.sqlByMethodId, methodId: method.id, target, arguments: {maxSourceRows: 500, typeFamily}});
      const second = compileSafeAnalysisMethod({manifest: packed.manifest, sqlByMethodId: packed.sqlByMethodId, methodId: method.id, target, arguments: {maxSourceRows: 500, typeFamily}});
      assert.equal(canonicalJson(first), canonicalJson(second));
      assert.deepEqual(first.binds, {maxSourceRows: 500});
      assert(!/password|credential|secret|rawValue|sampleValue/i.test(canonicalJson(first)));
      assert(/^(?:WITH|SELECT)\b/.test(first.statement));
    }
  }
});
