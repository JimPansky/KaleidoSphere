import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {identitySha256} from '../services/bi-control/src/db-analyzer/core.mjs';
import {
  PROGRESSIVE_PHASES,
  advanceProgressivePhase,
  buildProgressiveMethodRegistry,
  createProgressiveCoverage,
  createProgressiveRun,
} from '../services/bi-control/src/db-analyzer/progressive-controller.mjs';
import {
  advanceProgressiveAnalysisPhase,
  buildProgressiveProbeCandidate,
  createProgressiveAnalysis,
  recordProgressiveProbeOutcome,
  registerProgressiveHypothesis,
  reserveProgressiveProbeCandidate,
} from '../services/bi-control/src/db-analyzer/progressive-analysis-v1.mjs';
import {buildSafeAnalysisEvidence} from '../services/bi-control/src/db-analyzer/safe-analysis-methods.mjs';
import {
  buildExtendedEvidenceDiffV2,
  buildRoleClusterSnapshotV2,
  resumeExtendedEvidenceDiffV2,
  resumeRoleClusterSnapshotV2,
} from '../services/bi-control/src/db-analyzer/roles-clusters-diff-v2.mjs';

const ROOT = 'services/bi-control';
const fixture = JSON.parse(await readFile(`${ROOT}/fixtures/roles-clusters-diff-v2.json`, 'utf8'));
const targetValues = Object.values(fixture.targets).filter(({kind}) => kind === 'COLUMN');

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function pack(engine) {
  const directory = `${ROOT}/query-packs/db-analyzer/v1/${engine}`;
  const [structureManifest, safeManifest] = await Promise.all([
    readJson(`${directory}/manifest.json`), readJson(`${directory}/safe-analysis-manifest.json`),
  ]);
  return {structureManifest, safeManifest};
}

function coverage(engine, {visible = targetValues, queryState = 'SUCCEEDED', reasonCode = null} = {}) {
  const sourceQueryId = `${engine}.structure.columns`;
  return createProgressiveCoverage({
    engine,
    structureSnapshotSha256: identitySha256({fixture: `${engine}-roles-structure`, visible, queryState}),
    structureCoverageLedgerSha256: identitySha256({fixture: `${engine}-roles-ledger`, visible, queryState}),
    entries: visible.map((target) => ({
      objectRef: {...target, objectName: null, sourceObjectSha256: identitySha256({engine, target})},
      state: 'COMPLETE', reasonCode: null, sourceQueryId,
      evidenceRefs: [identitySha256({fixture: `${engine}-${target.relationName}-${target.columnName}`})],
    })),
    queryCoverage: [
      {queryId: `${engine}.preflight.identity`, category: 'preflight', state: 'SUCCEEDED', reasonCode: null, visibility: 'VISIBLE_COMPLETE', absenceClaim: 'NOT_CLAIMED'},
      {
        queryId: sourceQueryId, category: 'columns', state: queryState, reasonCode,
        visibility: queryState === 'SUCCEEDED' ? 'VISIBLE_COMPLETE' : 'INVISIBLE_UNKNOWN', absenceClaim: 'NOT_CLAIMED',
      },
    ],
  });
}

function advanceControllerTo(run, phase) {
  let current = run;
  while (current.phase !== phase) {
    current = advanceProgressivePhase(current, PROGRESSIVE_PHASES[PROGRESSIVE_PHASES.indexOf(current.phase) + 1]);
  }
  return current;
}

function method(registry, semanticMethod) {
  const slug = semanticMethod.toLowerCase().replaceAll('_', '-');
  const found = registry.methods.find(({methodRef}) => methodRef.includes(`safe.${slug}@`));
  assert(found, semanticMethod);
  return found;
}

function table(target) {
  const value = target.kind === 'RELATIONSHIP' ? target.source : target;
  return {kind: 'TABLE', schemaName: value.schemaName, relationName: value.relationName};
}

function intent(semanticMethod) {
  if (semanticMethod === 'RELATIONSHIP_OVERLAP') {
    return {probeClass: 'RELATIONSHIP_CHECK', signalKind: 'RELATIONSHIP', comparisonKind: 'NONE', grain: 'TABLE'};
  }
  if (semanticMethod === 'TEMPORAL_COVERAGE') {
    return {probeClass: 'TEMPORAL_CHECK', signalKind: 'TEMPORAL', comparisonKind: 'BASELINE', grain: 'COLUMN'};
  }
  if (semanticMethod === 'QUALITY_INDICATORS') {
    return {probeClass: 'QUALITY_CHECK', signalKind: 'NULLABILITY', comparisonKind: 'BASELINE', grain: 'COLUMN'};
  }
  return {probeClass: 'SAFE_AGGREGATE', signalKind: 'CARDINALITY', comparisonKind: 'BASELINE', grain: 'COLUMN'};
}

async function analysisFixture(engine, {
  runId = `fixture-${engine}-roles-clusters`,
  visible = targetValues,
  queryState = 'SUCCEEDED',
  reasonCode = null,
  includeEvidence = true,
  relationshipResult = fixture.results.relationship,
} = {}) {
  const packed = await pack(engine);
  const registry = buildProgressiveMethodRegistry({
    structureManifest: packed.structureManifest, safeAnalysisManifest: packed.safeManifest,
  });
  let analysis = createProgressiveAnalysis({
    controllerRun: advanceControllerTo(createProgressiveRun({
      runId, engine, scope: fixture.scope, methodRegistry: registry,
      coverage: coverage(engine, {visible, queryState, reasonCode}),
      budgets: {maxRunProbes: fixture.budgets.maxRunProbes, maxObjectProbes: fixture.budgets.maxObjectProbes},
    }), 'SAFE_AGGREGATES'),
    budgets: {maxTableProbes: fixture.budgets.maxTableProbes, maxHypothesisProbes: fixture.budgets.maxHypothesisProbes},
    policy: fixture.policy,
  });
  const tableTargets = [...new Map(visible.map((target) => [target.relationName, table(target)])).values()];
  for (const target of tableTargets) {
    analysis = registerProgressiveHypothesis(analysis, {
      hypothesisId: `${target.relationName.toLowerCase()}-structural-role`,
      hypothesisKind: target.relationName === 'ORDERS' ? 'RELATIONSHIP_CANDIDATE' : 'DATA_QUALITY',
      target, confidenceBounds: {lowerBps: 1000, upperBps: 8000},
      sourceEvidenceRefs: [identitySha256({fixture: `${engine}-${target.relationName}-hypothesis`})],
    });
  }
  const safeEvidence = [];

  function record(semanticMethod, target, typeFamily, row, hypothesisId) {
    const descriptor = method(registry, semanticMethod);
    const args = {maxSourceRows: 500, typeFamily};
    const candidate = buildProgressiveProbeCandidate(analysis, {
      hypothesisId, phase: analysis.controllerRun.phase, methodRef: descriptor.methodRef,
      target, arguments: args, intentFeatures: intent(semanticMethod),
      gainInputs: {
        uncertaintyBps: 6000, outcomeProbabilityBps: 7000, relevanceBps: 8000,
        rationaleCode: 'BOUNDED_ROLE_CLUSTER_EVIDENCE',
        evidenceRefs: [identitySha256({fixture: `${engine}-${semanticMethod}-${hypothesisId}`})],
      },
    });
    const reserved = reserveProgressiveProbeCandidate(analysis, candidate, {expectedStateSha256: analysis.stateSha256});
    const evidence = buildSafeAnalysisEvidence({
      controllerState: reserved.state, manifest: packed.safeManifest,
      methodId: descriptor.methodRef.split('@')[0], target, arguments: args,
      result: {state: 'SUCCEEDED', reasonCode: null, rows: [row]}, authorization: reserved.authorization,
    });
    analysis = recordProgressiveProbeOutcome(reserved.state, {
      reservationSha256: reserved.authorization.reservationSha256,
      resultState: 'SUCCEEDED', evidenceRefs: [evidence.evidenceSha256],
      signal: evidence.counterevidence.length > 0 ? 'COUNTERS' : 'SUPPORTS', informationGainBps: 2500,
      confidenceBounds: evidence.counterevidence.length > 0
        ? {lowerBps: 500, upperBps: 4500} : {lowerBps: 5000, upperBps: 9000},
      reasonCode: evidence.counterevidence.length > 0 ? 'SAFE_AGGREGATE_COUNTEREVIDENCE' : 'SAFE_AGGREGATE_SUPPORT',
    });
    safeEvidence.push(evidence);
  }

  if (includeEvidence) {
    record('COLUMN_SUMMARY', fixture.targets.orderId, 'NUMERIC', fixture.results.orderKey, 'orders-structural-role');
    record('COLUMN_SUMMARY', fixture.targets.customerKey, 'NUMERIC', fixture.results.customerKey, 'customers-structural-role');
    record('TEMPORAL_COVERAGE', fixture.targets.orderDate, 'TEMPORAL', fixture.results.temporal, 'orders-structural-role');
    analysis = advanceProgressiveAnalysisPhase(analysis, 'RELATIONSHIP_GRAPH');
    record('RELATIONSHIP_OVERLAP', fixture.targets.relationship, 'PAIR', relationshipResult, 'orders-structural-role');
    analysis = advanceProgressiveAnalysisPhase(analysis, 'HYPOTHESIS_VALIDATION');
    record('QUALITY_INDICATORS', fixture.targets.customerId, 'NUMERIC', fixture.results.quality, 'orders-structural-role');
  }
  while (analysis.controllerRun.phase !== 'REPORT') {
    analysis = advanceProgressiveAnalysisPhase(
      analysis,
      PROGRESSIVE_PHASES[PROGRESSIVE_PHASES.indexOf(analysis.controllerRun.phase) + 1],
    );
  }
  return {analysis, safeEvidence};
}

test('identical fixtures produce deterministic proposal-only roles, structural clusters and restart hashes', async () => {
  const source = await analysisFixture('mssql');
  const input = {analysisState: source.analysis, safeEvidence: source.safeEvidence, snapshotOrdinal: 1, previousSnapshotSha256: null};
  const first = buildRoleClusterSnapshotV2(input);
  const second = buildRoleClusterSnapshotV2(structuredClone(input));
  assert.deepEqual(second, first);
  assert.equal(resumeRoleClusterSnapshotV2(JSON.parse(JSON.stringify(first))).snapshotSha256, first.snapshotSha256);
  assert.deepEqual(first.roles.map(({roleKind}) => roleKind).sort(), [
    'KEY_CANDIDATE', 'KEY_CANDIDATE', 'QUALITY_REVIEW_CANDIDATE',
    'RELATIONSHIP_LINK_CANDIDATE', 'RELATIONSHIP_LINK_CANDIDATE', 'TEMPORAL_AXIS_CANDIDATE',
  ]);
  assert(first.roles.every(({proposalOnly, automaticBusinessTruth}) => proposalOnly && !automaticBusinessTruth));
  assert.equal(first.clusters.filter(({members}) => members.length === 2).length, 1);
  assert(first.clusters.every(({proposalOnly, causalClaim}) => proposalOnly && !causalClaim));
  assert(first.roles.find(({roleKind}) => roleKind === 'QUALITY_REVIEW_CANDIDATE').counterevidenceRefs.length > 0);
  assert.equal(first.snapshotSha256, fixture.expected.mssqlSnapshotSha256);
  assert.equal(first.semanticProjectionSha256, fixture.expected.semanticProjectionSha256);
  assert.equal(first.clusters.find(({members}) => members.length === 2).clusterSha256, fixture.expected.connectedClusterSha256);
  if (process.env.KS_PRINT_ROLE_CLUSTER_HASHES === '1') {
    console.log(JSON.stringify({
      mssqlSnapshotSha256: first.snapshotSha256,
      semanticProjectionSha256: first.semanticProjectionSha256,
      connectedClusterSha256: first.clusters.find(({members}) => members.length === 2).clusterSha256,
    }));
  }
});

test('equivalent MSSQL and Oracle evidence shares semantic projection while retaining explicit engine differences', async () => {
  const snapshots = [];
  for (const engine of ['mssql', 'oracle']) {
    const source = await analysisFixture(engine);
    snapshots.push(buildRoleClusterSnapshotV2({
      analysisState: source.analysis, safeEvidence: source.safeEvidence, snapshotOrdinal: 1, previousSnapshotSha256: null,
    }));
  }
  assert.equal(snapshots[0].semanticProjectionSha256, snapshots[1].semanticProjectionSha256);
  assert.notEqual(snapshots[0].snapshotSha256, snapshots[1].snapshotSha256);
  assert.deepEqual(snapshots[0].roles.map(({semanticRoleSha256}) => semanticRoleSha256), snapshots[1].roles.map(({semanticRoleSha256}) => semanticRoleSha256));
  assert(snapshots.every(({engineDifferences}) => engineDifferences.length > 0));
  assert.notDeepEqual(snapshots[0].engineDifferences, snapshots[1].engineDifferences);
  assert.equal(snapshots[1].snapshotSha256, fixture.expected.oracleSnapshotSha256);
  if (process.env.KS_PRINT_ROLE_CLUSTER_HASHES === '1') {
    console.log(JSON.stringify({oracleSnapshotSha256: snapshots[1].snapshotSha256}));
  }
});

test('relationship counterevidence cannot promote link roles or merge table clusters', async () => {
  const source = await analysisFixture('mssql', {relationshipResult: fixture.results.relationshipCounter});
  const snapshot = buildRoleClusterSnapshotV2({
    analysisState: source.analysis, safeEvidence: source.safeEvidence,
    snapshotOrdinal: 1, previousSnapshotSha256: null,
  });
  assert.equal(snapshot.relationships.length, 1);
  assert.equal(snapshot.relationships[0].status, 'COUNTEREVIDENCE_ONLY');
  assert.equal(snapshot.relationships[0].supportEvidenceRefs.length, 0);
  assert(snapshot.relationships[0].counterevidenceRefs.length >= 2);
  assert.equal(snapshot.roles.filter(({roleKind}) => roleKind === 'RELATIONSHIP_LINK_CANDIDATE').length, 0);
  assert.equal(snapshot.clusters.filter(({members}) => members.length > 1).length, 0);
});

test('extended diff distinguishes observed removal from denied visibility loss across all evidence surfaces', async () => {
  const baselineSource = await analysisFixture('mssql');
  const baseline = buildRoleClusterSnapshotV2({
    analysisState: baselineSource.analysis, safeEvidence: baselineSource.safeEvidence,
    snapshotOrdinal: 1, previousSnapshotSha256: null,
  });
  const visibleOrders = targetValues.filter(({relationName}) => relationName === 'ORDERS');
  const observedSource = await analysisFixture('mssql', {
    runId: 'fixture-mssql-observed-removal', visible: visibleOrders, includeEvidence: false,
  });
  const observed = buildRoleClusterSnapshotV2({
    analysisState: observedSource.analysis, safeEvidence: [], snapshotOrdinal: 2,
    previousSnapshotSha256: baseline.snapshotSha256,
  });
  const observedDiff = buildExtendedEvidenceDiffV2({baseline, current: observed});
  assert.deepEqual(resumeExtendedEvidenceDiffV2(JSON.parse(JSON.stringify(observedDiff))), observedDiff);
  assert(observedDiff.coverage.changes.some(({classification, semantics}) => classification === 'REMOVED' && semantics === 'OBSERVED_REMOVAL'));
  assert.equal(observedDiff.safety.visibilityLossConvertedToRemoval, false);

  const deniedSource = await analysisFixture('mssql', {
    runId: 'fixture-mssql-visibility-loss', visible: visibleOrders, queryState: 'DENIED',
    reasonCode: 'SELECT_PRIVILEGE_DENIED', includeEvidence: false,
  });
  const denied = buildRoleClusterSnapshotV2({
    analysisState: deniedSource.analysis, safeEvidence: [], snapshotOrdinal: 2,
    previousSnapshotSha256: baseline.snapshotSha256,
  });
  const deniedDiff = buildExtendedEvidenceDiffV2({baseline, current: denied});
  assert(deniedDiff.coverage.changes.some(({classification, semantics}) => classification === 'DENIED' && semantics === 'VISIBILITY_LOSS'));
  assert(!deniedDiff.coverage.changes.some(({classification}) => classification === 'REMOVED'));
  for (const surface of ['profiles', 'relationships', 'hypotheses', 'roles', 'clusters']) {
    assert(deniedDiff[surface].changes.every(({semantics}) => semantics !== 'OBSERVED_REMOVAL'));
  }
  assert.equal(observedDiff.diffSha256, fixture.expected.observedRemovalDiffSha256);
  assert.equal(deniedDiff.diffSha256, fixture.expected.visibilityLossDiffSha256);
  if (process.env.KS_PRINT_ROLE_CLUSTER_HASHES === '1') {
    console.log(JSON.stringify({
      observedRemovalDiffSha256: observedDiff.diffSha256,
      visibilityLossDiffSha256: deniedDiff.diffSha256,
    }));
  }
});

test('hash tamper, stale baseline, scope drift, raw/credential fields, controller mismatch and unsupported versions fail closed', async () => {
  const source = await analysisFixture('mssql');
  const baseline = buildRoleClusterSnapshotV2({
    analysisState: source.analysis, safeEvidence: source.safeEvidence, snapshotOrdinal: 1, previousSnapshotSha256: null,
  });
  const current = buildRoleClusterSnapshotV2({
    analysisState: source.analysis, safeEvidence: source.safeEvidence, snapshotOrdinal: 2,
    previousSnapshotSha256: baseline.snapshotSha256,
  });

  const tampered = structuredClone(baseline);
  tampered.roles[0].roleKind = 'AUTHORITATIVE_BUSINESS_ROLE';
  assert.throws(() => resumeRoleClusterSnapshotV2(tampered), /DB_ROLE_CLUSTER_SNAPSHOT_TAMPERED/);

  const widened = structuredClone(baseline);
  widened.safety.unreviewedPromotionAllowed = true;
  const {snapshotSha256: _widenedHash, ...widenedBody} = widened;
  widened.snapshotSha256 = identitySha256(widenedBody);
  assert.throws(() => resumeRoleClusterSnapshotV2(widened), /DB_ROLE_CLUSTER_SAFETY_INVALID/);

  const invalidRole = structuredClone(baseline);
  invalidRole.roles[0].confidenceBounds.lowerBps = -1;
  const {roleSha256: _invalidRoleHash, ...invalidRoleBody} = invalidRole.roles[0];
  invalidRole.roles[0].roleSha256 = identitySha256(invalidRoleBody);
  const {snapshotSha256: _invalidRoleSnapshotHash, ...invalidRoleSnapshotBody} = invalidRole;
  invalidRole.snapshotSha256 = identitySha256(invalidRoleSnapshotBody);
  assert.throws(() => resumeRoleClusterSnapshotV2(invalidRole), /DB_ROLE_CLUSTER_ROLE_INVALID/);

  const stale = structuredClone(current);
  stale.previousSnapshotSha256 = identitySha256({fixture: 'stale'});
  const {snapshotSha256: _staleHash, ...staleBody} = stale;
  stale.snapshotSha256 = identitySha256(staleBody);
  assert.throws(() => buildExtendedEvidenceDiffV2({baseline, current: stale}), /DB_EVIDENCE_DIFF_STALE_BASELINE/);

  const drift = structuredClone(current);
  drift.scope = {...drift.scope, database: 'OTHER_FIXTURE'};
  drift.scopeSha256 = identitySha256(drift.scope);
  const {snapshotSha256: _driftHash, ...driftBody} = drift;
  drift.snapshotSha256 = identitySha256(driftBody);
  assert.throws(() => buildExtendedEvidenceDiffV2({baseline, current: drift}), /DB_EVIDENCE_DIFF_SCOPE_DRIFT/);

  const unsupported = structuredClone(current);
  unsupported.schemaVersion = 'kaleidosphere.analysis/role-cluster-snapshot/v999';
  const {snapshotSha256: _unsupportedHash, ...unsupportedBody} = unsupported;
  unsupported.snapshotSha256 = identitySha256(unsupportedBody);
  assert.throws(() => buildExtendedEvidenceDiffV2({baseline, current: unsupported}), /DB_ROLE_CLUSTER_SNAPSHOT_VERSION_UNSUPPORTED/);

  const validDiff = buildExtendedEvidenceDiffV2({baseline, current});
  const tamperedDiff = structuredClone(validDiff);
  tamperedDiff.safety.visibilityLossConvertedToRemoval = true;
  const {diffSha256: _tamperedDiffHash, ...tamperedDiffBody} = tamperedDiff;
  tamperedDiff.diffSha256 = identitySha256(tamperedDiffBody);
  assert.throws(() => resumeExtendedEvidenceDiffV2(tamperedDiff), /DB_EVIDENCE_DIFF_SAFETY_INVALID/);

  for (const key of ['password', 'rawValue']) {
    const unsafeEvidence = structuredClone(source.safeEvidence);
    unsafeEvidence[0][key] = 'private-fixture-value';
    const {evidenceSha256: _oldHash, ...unsafeBody} = unsafeEvidence[0];
    unsafeEvidence[0].evidenceSha256 = identitySha256(unsafeBody);
    assert.throws(() => buildRoleClusterSnapshotV2({
      analysisState: source.analysis, safeEvidence: unsafeEvidence, snapshotOrdinal: 1, previousSnapshotSha256: null,
    }), /DB_ROLE_CLUSTER_UNSAFE_EVIDENCE_DENIED/);
  }

  const foreign = await analysisFixture('mssql', {runId: 'fixture-mssql-foreign-controller'});
  assert.throws(() => buildRoleClusterSnapshotV2({
    analysisState: source.analysis, safeEvidence: foreign.safeEvidence, snapshotOrdinal: 1, previousSnapshotSha256: null,
  }), /DB_ROLE_CLUSTER_CONTROLLER_BINDING_INVALID/);

  const preReport = structuredClone(source.analysis);
  preReport.controllerRun.phase = 'HYPOTHESIS_VALIDATION';
  assert.throws(() => buildRoleClusterSnapshotV2({
    analysisState: preReport, safeEvidence: source.safeEvidence, snapshotOrdinal: 1, previousSnapshotSha256: null,
  }));
});
