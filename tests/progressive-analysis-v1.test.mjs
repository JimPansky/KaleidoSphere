import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {buildPreflightEvidence, identitySha256} from '../services/bi-control/src/db-analyzer/core.mjs';
import {
  PROGRESSIVE_PHASES,
  advanceProgressivePhase,
  buildProgressiveCoverage,
  buildProgressiveMethodRegistry,
  createProgressiveRun,
} from '../services/bi-control/src/db-analyzer/progressive-controller.mjs';
import {
  advanceProgressiveAnalysisPhase,
  buildProgressiveAnalysisReport,
  buildProgressiveProbeCandidate,
  createProgressiveAnalysis,
  rankProgressiveProbeCandidates,
  reconcileProgressiveUnknownOutcome,
  recordProgressiveProbeOutcome,
  registerProgressiveHypothesis,
  reserveProgressiveProbeCandidate,
  resumeProgressiveAnalysis,
} from '../services/bi-control/src/db-analyzer/progressive-analysis-v1.mjs';
import {runAnalyzeProfile} from '../services/bi-control/src/db-analyzer/workflow.mjs';

const ROOT = 'services/bi-control';
const MSSQL_DIRECTORY = `${ROOT}/query-packs/db-analyzer/v1/mssql`;
const fixture = JSON.parse(await readFile(`${ROOT}/fixtures/progressive-analysis-v1.json`, 'utf8'));

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
    scope: structureEvidence.profile.scope,
    registry: buildProgressiveMethodRegistry({structureManifest, profilingManifest}),
    coverage: buildProgressiveCoverage(structureEvidence),
  };
}

function advanceControllerTo(run, target) {
  let current = run;
  while (current.phase !== target) {
    current = advanceProgressivePhase(current, PROGRESSIVE_PHASES[PROGRESSIVE_PHASES.indexOf(current.phase) + 1]);
  }
  return current;
}

function columnTargets(coverage) {
  return coverage.entries
    .filter(({objectRef}) => objectRef.kind === 'COLUMN')
    .map(({objectRef}) => ({
      kind: 'COLUMN', schemaName: objectRef.schemaName, relationName: objectRef.relationName, columnName: objectRef.columnName,
    }));
}

function method(registry, suffix) {
  const found = registry.methods.find(({methodRef}) => methodRef.includes(`profiling.${suffix}@`));
  assert(found, suffix);
  return found.methodRef;
}

async function baseAnalysis({runId = fixture.runId, budgets = fixture.budgets, policy = fixture.policy} = {}) {
  const inputs = await mssqlInputs();
  const controllerRun = advanceControllerTo(createProgressiveRun({
    runId,
    engine: 'mssql',
    scope: inputs.scope,
    methodRegistry: inputs.registry,
    coverage: inputs.coverage,
    budgets: {maxRunProbes: budgets.maxRunProbes, maxObjectProbes: budgets.maxObjectProbes},
  }), 'SAFE_AGGREGATES');
  let analysis = createProgressiveAnalysis({
    controllerRun,
    budgets: {maxTableProbes: budgets.maxTableProbes, maxHypothesisProbes: budgets.maxHypothesisProbes},
    policy,
  });
  const targets = columnTargets(inputs.coverage);
  assert(targets.length >= 2);
  const tableTarget = {kind: 'TABLE', schemaName: targets[0].schemaName, relationName: targets[0].relationName};
  for (const hypothesis of fixture.hypotheses) {
    analysis = registerProgressiveHypothesis(analysis, {
      hypothesisId: hypothesis.hypothesisId,
      hypothesisKind: hypothesis.hypothesisKind,
      target: tableTarget,
      confidenceBounds: hypothesis.confidenceBounds,
      sourceEvidenceRefs: [identitySha256({fixture: hypothesis.sourceEvidence})],
    });
  }
  return {analysis, inputs, targets};
}

function candidate(analysis, {hypothesisId = fixture.hypotheses[0].hypothesisId, methodRef, target, intentFeatures, gain = 'high', arguments: args = {}}) {
  return buildProgressiveProbeCandidate(analysis, {
    hypothesisId,
    phase: analysis.controllerRun.phase,
    methodRef,
    target,
    arguments: args,
    intentFeatures,
    gainInputs: {
      ...fixture.gainInputs[gain],
      evidenceRefs: [identitySha256({fixture: `${hypothesisId}-${gain}`})],
    },
  });
}

const NUMERIC_INTENT = Object.freeze({
  probeClass: 'SAFE_AGGREGATE', signalKind: 'DISTRIBUTION', comparisonKind: 'BASELINE', grain: 'COLUMN',
});
const CARDINALITY_INTENT = Object.freeze({
  probeClass: 'SAFE_AGGREGATE', signalKind: 'CARDINALITY', comparisonKind: 'BASELINE', grain: 'COLUMN',
});
const TEMPORAL_INTENT = Object.freeze({
  probeClass: 'TEMPORAL_CHECK', signalKind: 'TEMPORAL', comparisonKind: 'BASELINE', grain: 'COLUMN',
});

async function noGainTerminal({advanceReport = true} = {}) {
  const {analysis: initial, inputs, targets} = await baseAnalysis();
  let state = initial;
  const first = candidate(state, {methodRef: method(inputs.registry, 'numeric-aggregate'), target: targets[0], intentFeatures: NUMERIC_INTENT});
  let reserved = reserveProgressiveProbeCandidate(state, first, {expectedStateSha256: state.stateSha256});
  state = recordProgressiveProbeOutcome(reserved.state, {
    reservationSha256: reserved.authorization.reservationSha256,
    resultState: 'SUCCEEDED',
    evidenceRefs: [identitySha256({fixture: 'first-no-gain'})],
    signal: 'NO_GAIN', informationGainBps: 0,
    confidenceBounds: {lowerBps: 1500, upperBps: 7500}, reasonCode: 'NO_MEASURABLE_GAIN',
  });
  const second = candidate(state, {methodRef: method(inputs.registry, 'numeric-aggregate'), target: targets[1], intentFeatures: CARDINALITY_INTENT, gain: 'medium'});
  reserved = reserveProgressiveProbeCandidate(state, second, {expectedStateSha256: state.stateSha256});
  state = recordProgressiveProbeOutcome(reserved.state, {
    reservationSha256: reserved.authorization.reservationSha256,
    resultState: 'SUCCEEDED',
    evidenceRefs: [identitySha256({fixture: 'second-no-gain'})],
    signal: 'NO_GAIN', informationGainBps: 0,
    confidenceBounds: {lowerBps: 1500, upperBps: 7500}, reasonCode: 'NO_MEASURABLE_GAIN',
  });
  while (advanceReport && state.controllerRun.phase !== 'REPORT') {
    state = advanceProgressiveAnalysisPhase(state, PROGRESSIVE_PHASES[PROGRESSIVE_PHASES.indexOf(state.controllerRun.phase) + 1]);
  }
  return state;
}

test('reservation-before-dispatch debits run, table and hypothesis budgets and deterministic rank persists calculated EIG', async () => {
  const {analysis: initial, inputs, targets} = await baseAnalysis();
  const numeric = candidate(initial, {methodRef: method(inputs.registry, 'numeric-aggregate'), target: targets[0], intentFeatures: NUMERIC_INTENT, gain: 'high'});
  const lower = candidate(initial, {methodRef: method(inputs.registry, 'temporal-aggregate'), target: targets[0], intentFeatures: TEMPORAL_INTENT, gain: 'medium'});
  const ranked = rankProgressiveProbeCandidates(initial, [lower, numeric]);
  assert.deepEqual(ranked.map(({candidateSha256}) => candidateSha256), [numeric.candidateSha256, lower.candidateSha256]);
  assert.equal(numeric.expectedGain.expectedInformationGainBps, 4320);

  let reserved = reserveProgressiveProbeCandidate(initial, numeric, {expectedStateSha256: initial.stateSha256});
  assert.equal(reserved.authorization.disposition, 'RESERVED');
  assert.equal(reserved.state.controllerRun.budget.authorizedProbeCount, 1);
  assert.deepEqual(reserved.state.budget.tableReservationCounts.map(({count}) => count), [1]);
  assert.deepEqual(reserved.state.budget.hypothesisReservationCounts.map(({count}) => count), [1]);

  const near = candidate(reserved.state, {
    methodRef: method(inputs.registry, 'temporal-aggregate'), target: targets[0], intentFeatures: NUMERIC_INTENT, gain: 'high',
  });
  const suppressed = reserveProgressiveProbeCandidate(reserved.state, near, {expectedStateSha256: reserved.state.stateSha256});
  assert.equal(suppressed.authorization.disposition, 'SUPPRESSED_NEAR_DUPLICATE');
  assert.equal(suppressed.state.stateSha256, reserved.state.stateSha256);

  const distinct = candidate(reserved.state, {
    methodRef: method(inputs.registry, 'temporal-aggregate'), target: targets[0], intentFeatures: TEMPORAL_INTENT, gain: 'medium',
  });
  reserved = reserveProgressiveProbeCandidate(reserved.state, distinct, {expectedStateSha256: reserved.state.stateSha256});
  assert.equal(reserved.authorization.disposition, 'RESERVED');
  assert.equal(reserved.state.budget.tableReservationCounts[0].count, 2);
});

test('two consecutive no-gain outcomes stop the hypothesis before another reservation and restart is byte-deterministic', async () => {
  const terminal = await noGainTerminal();
  const hypothesis = terminal.hypothesisLedger.entries.find(({hypothesisId}) => hypothesisId === fixture.hypotheses[0].hypothesisId);
  assert.equal(hypothesis.status, 'STOPPED');
  assert.equal(hypothesis.terminalReason, 'NO_GAIN_LIMIT');
  assert.equal(hypothesis.consecutiveNoGain, 2);
  const resumed = resumeProgressiveAnalysis(JSON.parse(JSON.stringify(terminal)));
  assert.equal(resumed.stateSha256, terminal.stateSha256);
  const firstReport = buildProgressiveAnalysisReport(terminal);
  const resumedReport = buildProgressiveAnalysisReport(resumed);
  assert.equal(firstReport.analysisEvidenceSha256, resumedReport.analysisEvidenceSha256);
  assert.equal(firstReport.hypothesisLedger.entries[0].automaticBusinessTruth, false);

  const stopped = await noGainTerminal({advanceReport: false});
  const {inputs, targets} = await baseAnalysis();
  const blocked = candidate(stopped, {methodRef: method(inputs.registry, 'numeric-aggregate'), target: targets[0], intentFeatures: TEMPORAL_INTENT});
  assert.throws(
    () => reserveProgressiveProbeCandidate(stopped, blocked, {expectedStateSha256: stopped.stateSha256}),
    /DB_PROGRESSIVE_HYPOTHESIS_STOPPED/,
  );
});

test('compare-and-swap rejects a stale concurrent reservation without overspending the one-slot table or hypothesis budget', async () => {
  const {analysis: initial, inputs, targets} = await baseAnalysis({
    runId: 'fixture-mssql-progressive-concurrent',
    budgets: {...fixture.budgets, maxTableProbes: 1, maxHypothesisProbes: 1},
  });
  const first = candidate(initial, {methodRef: method(inputs.registry, 'numeric-aggregate'), target: targets[0], intentFeatures: NUMERIC_INTENT});
  const second = candidate(initial, {methodRef: method(inputs.registry, 'temporal-aggregate'), target: targets[0], intentFeatures: TEMPORAL_INTENT});
  const committed = reserveProgressiveProbeCandidate(initial, first, {expectedStateSha256: initial.stateSha256});
  assert.throws(
    () => reserveProgressiveProbeCandidate(committed.state, second, {expectedStateSha256: initial.stateSha256}),
    /DB_PROGRESSIVE_STALE_RESERVATION/,
  );
  assert.equal(committed.state.controllerRun.budget.authorizedProbeCount, 1);
  assert.equal(committed.state.budget.tableReservationCounts[0].count, 1);
  assert.equal(committed.state.budget.hypothesisReservationCounts[0].count, 1);
});

test('sequential table and hypothesis reservation limits each fail closed before controller dispatch', async () => {
  for (const budgetCase of [
    {name: 'table', budgets: {...fixture.budgets, maxTableProbes: 1, maxHypothesisProbes: 3}, expected: /DB_PROGRESSIVE_TABLE_BUDGET_EXCEEDED/},
    {name: 'hypothesis', budgets: {...fixture.budgets, maxTableProbes: 3, maxHypothesisProbes: 1}, expected: /DB_PROGRESSIVE_HYPOTHESIS_BUDGET_EXCEEDED/},
  ]) {
    const {analysis: initial, inputs, targets} = await baseAnalysis({
      runId: `fixture-mssql-progressive-${budgetCase.name}-budget`, budgets: budgetCase.budgets,
    });
    const first = candidate(initial, {methodRef: method(inputs.registry, 'numeric-aggregate'), target: targets[0], intentFeatures: NUMERIC_INTENT});
    const committed = reserveProgressiveProbeCandidate(initial, first, {expectedStateSha256: initial.stateSha256});
    const second = candidate(committed.state, {
      methodRef: method(inputs.registry, 'numeric-aggregate'), target: targets[1], intentFeatures: CARDINALITY_INTENT,
    });
    assert.throws(
      () => reserveProgressiveProbeCandidate(committed.state, second, {expectedStateSha256: committed.state.stateSha256}),
      budgetCase.expected,
    );
    assert.equal(committed.state.controllerRun.budget.authorizedProbeCount, 1);
  }
});

test('unknown outcome remains debited and non-retryable, then append-only reconciliation is deterministic across restart', async () => {
  const {analysis: initial, inputs, targets} = await baseAnalysis({runId: 'fixture-mssql-progressive-unknown'});
  const probe = candidate(initial, {methodRef: method(inputs.registry, 'numeric-aggregate'), target: targets[0], intentFeatures: NUMERIC_INTENT});
  const reserved = reserveProgressiveProbeCandidate(initial, probe, {expectedStateSha256: initial.stateSha256});
  const unknown = recordProgressiveProbeOutcome(reserved.state, {
    reservationSha256: reserved.authorization.reservationSha256,
    resultState: 'UNKNOWN', evidenceRefs: [], signal: 'UNKNOWN', informationGainBps: 0,
    confidenceBounds: {lowerBps: 1500, upperBps: 7500}, reasonCode: 'DISPATCH_OUTCOME_UNKNOWN',
  });
  const suppressed = reserveProgressiveProbeCandidate(unknown, probe, {expectedStateSha256: unknown.stateSha256});
  assert.equal(suppressed.authorization.disposition, 'SUPPRESSED_UNKNOWN_OUTCOME');
  assert.equal(suppressed.state.controllerRun.budget.authorizedProbeCount, 1);
  const restarted = resumeProgressiveAnalysis(JSON.parse(JSON.stringify(unknown)));
  const reconciliation = {
    outcomeReceiptSha256: unknown.outcomes[0].outcomeReceiptSha256,
    resolvedState: 'SUCCEEDED',
    reconciliationEvidenceRefs: [identitySha256({fixture: 'unknown-readback-confirmed'})],
    signal: 'SUPPORTS', informationGainBps: 2100,
    confidenceBounds: {lowerBps: 4000, upperBps: 8500}, reasonCode: 'READBACK_CONFIRMED_SUCCESS',
  };
  const direct = reconcileProgressiveUnknownOutcome(unknown, reconciliation);
  const afterRestart = reconcileProgressiveUnknownOutcome(restarted, reconciliation);
  assert.equal(direct.stateSha256, afterRestart.stateSha256);
  assert.equal(direct.reconciliations.length, 1);
  assert.equal(direct.controllerRun.receipts[0].resultState, 'UNKNOWN');
  assert.equal(reserveProgressiveProbeCandidate(direct, probe, {expectedStateSha256: direct.stateSha256}).authorization.disposition, 'REUSED_RECONCILED_SUCCESS');
});

test('counterevidence is retained without fact promotion and repeated counterevidence stops the branch', async () => {
  const {analysis: initial, inputs, targets} = await baseAnalysis({runId: 'fixture-mssql-progressive-counter'});
  let state = initial;
  for (const [index, intentFeatures] of [NUMERIC_INTENT, CARDINALITY_INTENT].entries()) {
    const probe = candidate(state, {methodRef: method(inputs.registry, 'numeric-aggregate'), target: targets[index], intentFeatures, gain: index === 0 ? 'high' : 'medium'});
    const reserved = reserveProgressiveProbeCandidate(state, probe, {expectedStateSha256: state.stateSha256});
    state = recordProgressiveProbeOutcome(reserved.state, {
      reservationSha256: reserved.authorization.reservationSha256,
      resultState: 'SUCCEEDED', evidenceRefs: [identitySha256({fixture: `counter-${index}`})],
      signal: 'COUNTERS', informationGainBps: 1700,
      confidenceBounds: {lowerBps: 500, upperBps: 3500}, reasonCode: 'AGGREGATE_COUNTEREVIDENCE',
    });
  }
  const hypothesis = state.hypothesisLedger.entries.find(({hypothesisId}) => hypothesisId === fixture.hypotheses[0].hypothesisId);
  assert.equal(hypothesis.status, 'STOPPED');
  assert.equal(hypothesis.terminalReason, 'REPEATED_COUNTEREVIDENCE');
  assert.equal(hypothesis.counterevidenceRefs.length, 2);
  assert.equal(hypothesis.contradictions.length, 2);
  assert.equal(hypothesis.automaticBusinessTruth, false);
});

test('forged gain, counter rollback, replay, cross-scope, unsafe parameters and terminal timeout/cancel fail closed', async () => {
  const {analysis: initial, inputs, targets} = await baseAnalysis({runId: 'fixture-mssql-progressive-negative'});
  const valid = candidate(initial, {methodRef: method(inputs.registry, 'numeric-aggregate'), target: targets[0], intentFeatures: NUMERIC_INTENT});
  const forged = structuredClone(valid);
  forged.expectedGain.expectedInformationGainBps += 1;
  const {expectedGainSha256: _oldGainHash, ...forgedGainBody} = forged.expectedGain;
  forged.expectedGain.expectedGainSha256 = identitySha256(forgedGainBody);
  const {candidateSha256: _oldCandidateHash, ...forgedBody} = forged;
  forged.candidateSha256 = identitySha256(forgedBody);
  assert.throws(() => reserveProgressiveProbeCandidate(initial, forged, {expectedStateSha256: initial.stateSha256}), /DB_PROGRESSIVE_GAIN_FORGED/);

  const unsafeCases = [
    () => candidate(initial, {methodRef: 'mssql.ddl.drop-table@1.0.0', target: targets[0], intentFeatures: NUMERIC_INTENT}),
    () => candidate(initial, {methodRef: method(inputs.registry, 'numeric-aggregate'), target: targets[0], intentFeatures: NUMERIC_INTENT, arguments: {sql: 'SELECT * FROM secret'}}),
    () => candidate(initial, {methodRef: method(inputs.registry, 'numeric-aggregate'), target: targets[0], intentFeatures: NUMERIC_INTENT, arguments: {rawValues: ['private-value']}}),
    () => candidate(initial, {methodRef: method(inputs.registry, 'numeric-aggregate'), target: targets[0], intentFeatures: NUMERIC_INTENT, arguments: {credential: 'fixture-secret'}}),
  ];
  for (const unsafe of unsafeCases) {
    assert.throws(
      unsafe,
      /DB_PROGRESSIVE_METHOD_DENIED|DB_PROGRESSIVE_PROBE_REQUEST_INVALID/,
    );
  }

  const reserved = reserveProgressiveProbeCandidate(initial, valid, {expectedStateSha256: initial.stateSha256});
  const rolledBack = structuredClone(reserved.state);
  rolledBack.budget.tableReservationCounts[0].count = 0;
  const {stateSha256: _oldStateHash, ...rolledBackBody} = rolledBack;
  rolledBack.stateSha256 = identitySha256(rolledBackBody);
  assert.throws(() => resumeProgressiveAnalysis(rolledBack), /DB_PROGRESSIVE_BUDGET_STATE_INVALID/);

  const crossScope = await baseAnalysis({runId: 'fixture-mssql-progressive-other-scope'});
  assert.throws(
    () => reserveProgressiveProbeCandidate(crossScope.analysis, valid, {expectedStateSha256: crossScope.analysis.stateSha256}),
    /DB_PROGRESSIVE_CANDIDATE_BINDING_INVALID/,
  );
  const timedOut = recordProgressiveProbeOutcome(reserved.state, {
    reservationSha256: reserved.authorization.reservationSha256,
    resultState: 'TIMEOUT', evidenceRefs: [], signal: 'UNKNOWN', informationGainBps: 0,
    confidenceBounds: {lowerBps: 1500, upperBps: 7500}, reasonCode: 'QUERY_TIMEOUT',
  });
  assert.equal(timedOut.hypothesisLedger.entries.find(({hypothesisId}) => hypothesisId === fixture.hypotheses[0].hypothesisId).terminalReason, 'TIMEOUT');
  assert.equal(timedOut.safety.blindRetryAllowed, false);
  assert.throws(() => recordProgressiveProbeOutcome(timedOut, {
    reservationSha256: reserved.authorization.reservationSha256,
    resultState: 'CANCELLED', evidenceRefs: [], signal: 'UNKNOWN', informationGainBps: 0,
    confidenceBounds: {lowerBps: 1500, upperBps: 7500}, reasonCode: 'QUERY_CANCELLED',
  }), /DB_PROGRESSIVE_OUTCOME_DUPLICATE_OR_UNKNOWN/);

  const cancelBase = await baseAnalysis({runId: 'fixture-mssql-progressive-cancel'});
  const cancelCandidate = candidate(cancelBase.analysis, {
    methodRef: method(cancelBase.inputs.registry, 'numeric-aggregate'), target: cancelBase.targets[0], intentFeatures: NUMERIC_INTENT,
  });
  const cancelReservation = reserveProgressiveProbeCandidate(cancelBase.analysis, cancelCandidate, {expectedStateSha256: cancelBase.analysis.stateSha256});
  const cancelled = recordProgressiveProbeOutcome(cancelReservation.state, {
    reservationSha256: cancelReservation.authorization.reservationSha256,
    resultState: 'CANCELLED', evidenceRefs: [], signal: 'UNKNOWN', informationGainBps: 0,
    confidenceBounds: {lowerBps: 1500, upperBps: 7500}, reasonCode: 'QUERY_CANCELLED',
  });
  assert.equal(cancelled.hypothesisLedger.entries.find(({hypothesisId}) => hypothesisId === fixture.hypotheses[0].hypothesisId).terminalReason, 'CANCELLED');
  assert.equal(reserveProgressiveProbeCandidate(cancelled, cancelCandidate, {expectedStateSha256: cancelled.stateSha256}).authorization.disposition, 'SUPPRESSED_TERMINAL_OUTCOME');
});

test('sequential, restart, concurrent-reservation and unknown-outcome fixture hashes are deterministic', async () => {
  const sequential = await noGainTerminal();
  const restart = resumeProgressiveAnalysis(JSON.parse(JSON.stringify(sequential)));
  const sequentialHash = buildProgressiveAnalysisReport(sequential).analysisEvidenceSha256;
  const restartHash = buildProgressiveAnalysisReport(restart).analysisEvidenceSha256;
  assert.equal(sequentialHash, restartHash);

  const concurrent = await baseAnalysis({
    runId: 'fixture-mssql-progressive-hash-concurrent',
    budgets: {...fixture.budgets, maxTableProbes: 1, maxHypothesisProbes: 1},
  });
  const concurrentCandidate = candidate(concurrent.analysis, {
    methodRef: method(concurrent.inputs.registry, 'numeric-aggregate'), target: concurrent.targets[0], intentFeatures: NUMERIC_INTENT,
  });
  const concurrentState = reserveProgressiveProbeCandidate(concurrent.analysis, concurrentCandidate, {expectedStateSha256: concurrent.analysis.stateSha256}).state;

  const unknownBase = await baseAnalysis({runId: 'fixture-mssql-progressive-hash-unknown'});
  const unknownCandidate = candidate(unknownBase.analysis, {
    methodRef: method(unknownBase.inputs.registry, 'numeric-aggregate'), target: unknownBase.targets[0], intentFeatures: NUMERIC_INTENT,
  });
  const unknownReservation = reserveProgressiveProbeCandidate(unknownBase.analysis, unknownCandidate, {expectedStateSha256: unknownBase.analysis.stateSha256});
  const unknownState = recordProgressiveProbeOutcome(unknownReservation.state, {
    reservationSha256: unknownReservation.authorization.reservationSha256,
    resultState: 'UNKNOWN', evidenceRefs: [], signal: 'UNKNOWN', informationGainBps: 0,
    confidenceBounds: {lowerBps: 1500, upperBps: 7500}, reasonCode: 'DISPATCH_OUTCOME_UNKNOWN',
  });
  const hashes = {
    sequentialTerminal: sequentialHash,
    restartTerminal: restartHash,
    concurrentReservationState: concurrentState.stateSha256,
    unknownOutcomeState: unknownState.stateSha256,
  };
  assert.deepEqual(hashes, JSON.parse(JSON.stringify(hashes)));
  if (process.env.KS_PRINT_PROGRESSIVE_ANALYSIS_HASHES === '1') console.log(JSON.stringify(hashes));
});
