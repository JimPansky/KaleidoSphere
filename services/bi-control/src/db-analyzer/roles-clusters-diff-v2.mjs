import {
  canonicalJson,
  identitySha256,
  normalizeJsonValue,
} from './core.mjs';
import {
  buildProgressiveAnalysisReport,
  resumeProgressiveAnalysis,
} from './progressive-analysis-v1.mjs';

export const ROLE_CLUSTER_SNAPSHOT_V2_SCHEMA = 'kaleidosphere.analysis/role-cluster-snapshot/v2';
export const EXTENDED_EVIDENCE_DIFF_V2_SCHEMA = 'kaleidosphere.analysis/extended-evidence-diff/v2';

const SAFE_EVIDENCE_SCHEMA = 'kaleidosphere.analysis/safe-method-evidence/v1';
const SHA256 = /^[a-f0-9]{64}$/;
const REASON_CODE = /^[A-Z][A-Z0-9_]{2,127}$/;
const ENGINES = new Set(['mssql', 'oracle']);
const EVIDENCE_STATES = new Set(['COMPLETE', 'PARTIAL', 'DENIED', 'UNSUPPORTED', 'UNKNOWN']);
const RECEIPT_STATES = new Set(['SUCCEEDED', 'PARTIAL', 'DENIED', 'UNSUPPORTED', 'TIMEOUT', 'CANCELLED', 'UNKNOWN']);
const ROLE_KINDS = new Set([
  'KEY_CANDIDATE',
  'TEMPORAL_AXIS_CANDIDATE',
  'QUALITY_REVIEW_CANDIDATE',
  'RELATIONSHIP_LINK_CANDIDATE',
]);
const DIFF_CLASSIFICATIONS = new Set(['ADDED', 'REMOVED', 'CHANGED', 'DENIED', 'UNSUPPORTED', 'UNKNOWN']);
const DIFF_SEMANTICS = new Set([
  'CURRENT_OBSERVATION', 'OBSERVED_REMOVAL', 'EVIDENCE_CHANGED', 'VISIBILITY_LOSS',
  'EVIDENCE_NOT_REOBSERVED', 'VISIBILITY_UNKNOWN',
]);
const SNAPSHOT_NON_CLAIMS = Object.freeze([
  'NO_AUTHORITATIVE_DOMAIN_MODEL',
  'NO_ORGANIZATION_OR_PERSON_ROLE_INFERENCE',
  'NO_CAUSAL_OR_ML_CLUSTERING',
  'NO_AUTOMATIC_BUSINESS_TRUTH',
  'NO_RAW_OR_SOURCE_VALUES',
  'NO_PRODUCTION_OR_CUSTOMER_DATABASE_ACCESS',
  'NO_UNIVERSAL_DIFF_COMPATIBILITY',
  'NO_PRODUCTION_PERFORMANCE_CLAIM',
]);
const DIFF_NON_CLAIMS = Object.freeze([
  'NO_DELETION_CLAIM_FROM_VISIBILITY_LOSS',
  'NO_AUTHORITATIVE_ROLE_OR_CLUSTER_TRUTH',
  'NO_RAW_OR_SOURCE_VALUES',
  'NO_CROSS_SCOPE_OR_CROSS_ENGINE_DIFF',
  'NO_UNIVERSAL_DIFF_COMPATIBILITY',
]);
const UNSAFE_EVIDENCE_KEYS = new Set([
  'password', 'passwd', 'credential', 'credentials', 'secret', 'token', 'api_key', 'connection_string', 'dsn',
  'sql', 'query', 'raw_value', 'raw_row', 'source_row', 'sample_value', 'example_value',
]);

const fail = (code) => {
  const error = new Error(code);
  error.code = code;
  throw error;
};

const compare = (left, right) => Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
const sha256Value = (value) => typeof value === 'string' && SHA256.test(value);
const exactKeys = (value, keys) => value
  && typeof value === 'object'
  && !Array.isArray(value)
  && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort());

function seal(body, hashKey) {
  const normalized = normalizeJsonValue(body);
  return {...normalized, [hashKey]: identitySha256(normalized)};
}

function assertSealed(value, hashKey, code) {
  if (!value || !sha256Value(value[hashKey])) fail(code);
  const {[hashKey]: expected, ...body} = value;
  if (identitySha256(body) !== expected) fail(code);
  return value;
}

function sortedUnique(values, code) {
  if (!Array.isArray(values) || new Set(values).size !== values.length) fail(code);
  return [...values].sort(compare);
}

function sortedUniqueHashes(values, code) {
  if (!Array.isArray(values) || values.some((value) => !sha256Value(value)) || new Set(values).size !== values.length) fail(code);
  return [...values].sort(compare);
}

function assertHashArray(values, code) {
  if (!Array.isArray(values) || values.some((value) => !sha256Value(value))
    || new Set(values).size !== values.length
    || canonicalJson(values) !== canonicalJson([...values].sort(compare))) fail(code);
}

function assertConfidence(value, code) {
  if (!exactKeys(value, ['lowerBps', 'upperBps'])
    || !Number.isSafeInteger(value.lowerBps) || !Number.isSafeInteger(value.upperBps)
    || value.lowerBps < 0 || value.upperBps > 10000 || value.lowerBps > value.upperBps) fail(code);
}

function assertVisibilityTargets(values, code) {
  if (!Array.isArray(values) || values.length === 0) fail(code);
  values.forEach(target);
  const hashes = values.map(identitySha256);
  if (new Set(hashes).size !== hashes.length || canonicalJson(hashes) !== canonicalJson([...hashes].sort(compare))) fail(code);
}

function normalizedKey(key) {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[ .-]+/g, '_').toLowerCase();
}

function denyUnsafeEvidenceKeys(value) {
  if (Array.isArray(value)) {
    value.forEach(denyUnsafeEvidenceKeys);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (UNSAFE_EVIDENCE_KEYS.has(normalizedKey(key))) fail('DB_ROLE_CLUSTER_UNSAFE_EVIDENCE_DENIED');
    denyUnsafeEvidenceKeys(item);
  }
}

function target(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('DB_ROLE_CLUSTER_TARGET_INVALID');
  if (value.kind === 'COLUMN') {
    if (!exactKeys(value, ['kind', 'schemaName', 'relationName', 'columnName'])
      || ![value.schemaName, value.relationName, value.columnName].every((item) => typeof item === 'string' && item.length > 0)) {
      fail('DB_ROLE_CLUSTER_TARGET_INVALID');
    }
    return normalizeJsonValue(value);
  }
  if (value.kind === 'TABLE') {
    if (!exactKeys(value, ['kind', 'schemaName', 'relationName'])
      || ![value.schemaName, value.relationName].every((item) => typeof item === 'string' && item.length > 0)) {
      fail('DB_ROLE_CLUSTER_TARGET_INVALID');
    }
    return normalizeJsonValue(value);
  }
  if (value.kind === 'RELATIONSHIP') {
    if (!exactKeys(value, ['kind', 'source', 'target'])) fail('DB_ROLE_CLUSTER_TARGET_INVALID');
    const source = target({kind: 'COLUMN', ...value.source});
    const destination = target({kind: 'COLUMN', ...value.target});
    if (canonicalJson(source) === canonicalJson(destination)) fail('DB_ROLE_CLUSTER_TARGET_INVALID');
    const {kind: _sourceKind, ...sourceBody} = source;
    const {kind: _targetKind, ...targetBody} = destination;
    return normalizeJsonValue({kind: 'RELATIONSHIP', source: sourceBody, target: targetBody});
  }
  fail('DB_ROLE_CLUSTER_TARGET_INVALID');
}

function tableTarget(value) {
  const normalized = target(value);
  const item = normalized.kind === 'RELATIONSHIP' ? normalized.source : normalized;
  return normalizeJsonValue({kind: 'TABLE', schemaName: item.schemaName, relationName: item.relationName});
}

function visibilityTargets(value) {
  const normalized = target(value);
  if (normalized.kind !== 'RELATIONSHIP') return [normalized];
  return [
    target({kind: 'COLUMN', ...normalized.source}),
    target({kind: 'COLUMN', ...normalized.target}),
  ].sort((left, right) => compare(identitySha256(left), identitySha256(right)));
}

function targetInScope(value, run) {
  const normalized = target(value);
  const values = normalized.kind === 'RELATIONSHIP'
    ? [normalized.source, normalized.target]
    : [normalized];
  for (const item of values) {
    if (!run.scope.schemas.includes(item.schemaName)) fail('DB_ROLE_CLUSTER_SCOPE_DENIED');
    const visible = run.coverage.entries.some(({objectRef}) => objectRef.schemaName === item.schemaName
      && objectRef.relationName === item.relationName
      && (normalized.kind === 'TABLE' || item.columnName === undefined || objectRef.columnName === item.columnName));
    if (!visible) fail('DB_ROLE_CLUSTER_SCOPE_DENIED');
  }
  return normalized;
}

function counterRefs(evidence) {
  return evidence.counterevidence
    .map((item) => identitySha256({evidenceSha256: evidence.evidenceSha256, counterevidence: item}))
    .sort(compare);
}

function validateSafeEvidence(evidence, state) {
  denyUnsafeEvidenceKeys(evidence);
  assertSealed(evidence, 'evidenceSha256', 'DB_ROLE_CLUSTER_EVIDENCE_TAMPERED');
  if (!exactKeys(evidence, [
    'schemaVersion', 'engine', 'methodId', 'semanticMethod', 'target', 'arguments', 'state', 'receiptState',
    'reasonCode', 'controllerProbeKey', 'semanticEvidenceSha256', 'observedClaims', 'computedClaims', 'inferredClaims',
    'counterevidence', 'engineDifferences', 'bounds', 'absenceClaim', 'rawValuesPersisted', 'rowSamplesPersisted',
    'exampleValuesPersisted', 'automaticFactPromotion', 'automaticForeignKey', 'evidenceSha256',
  ]) || evidence.schemaVersion !== SAFE_EVIDENCE_SCHEMA || evidence.engine !== state.controllerRun.engine
    || !EVIDENCE_STATES.has(evidence.state) || !RECEIPT_STATES.has(evidence.receiptState)
    || !(evidence.reasonCode === null || REASON_CODE.test(evidence.reasonCode))
    || !sha256Value(evidence.controllerProbeKey) || !sha256Value(evidence.semanticEvidenceSha256)
    || !Array.isArray(evidence.observedClaims) || !Array.isArray(evidence.computedClaims)
    || !Array.isArray(evidence.inferredClaims) || !Array.isArray(evidence.counterevidence)
    || !Array.isArray(evidence.engineDifferences) || evidence.engineDifferences.some((item) => typeof item !== 'string' || item.length === 0)
    || evidence.absenceClaim !== 'NOT_CLAIMED' || evidence.rawValuesPersisted !== false
    || evidence.rowSamplesPersisted !== false || evidence.exampleValuesPersisted !== false
    || evidence.automaticFactPromotion !== false || evidence.automaticForeignKey !== false) {
    fail('DB_ROLE_CLUSTER_EVIDENCE_INVALID');
  }
  targetInScope(evidence.target, state.controllerRun);
  const outcome = state.outcomes.find(({evidenceRefs}) => evidenceRefs.includes(evidence.evidenceSha256));
  const reservation = outcome && state.reservations.find(({reservationSha256}) => reservationSha256 === outcome.reservationSha256);
  const controllerReceipt = outcome && state.controllerRun.receipts.find(
    ({receiptSha256}) => receiptSha256 === outcome.controllerReceiptSha256,
  );
  if (!outcome || !reservation || !controllerReceipt
    || reservation.controllerProbeKey !== evidence.controllerProbeKey
    || outcome.controllerProbeKey !== evidence.controllerProbeKey
    || controllerReceipt.probeKey !== evidence.controllerProbeKey
    || outcome.resultState !== evidence.receiptState) fail('DB_ROLE_CLUSTER_CONTROLLER_BINDING_INVALID');
  return {evidence, outcome, reservation, controllerReceipt};
}

function confidence(supportCount, counterCount) {
  const lowerBps = Math.max(0, Math.min(10000, 3000 + supportCount * 1500 - counterCount * 1250));
  const upperBps = Math.max(lowerBps, Math.min(10000, lowerBps + 3000));
  return {lowerBps, upperBps};
}

function coverageProjection(run) {
  const entries = run.coverage.entries.map((entry) => {
    const projectedTarget = entry.objectRef.columnName === null
      ? target({kind: 'TABLE', schemaName: entry.objectRef.schemaName, relationName: entry.objectRef.relationName})
      : target({
          kind: 'COLUMN', schemaName: entry.objectRef.schemaName,
          relationName: entry.objectRef.relationName, columnName: entry.objectRef.columnName,
        });
    const semantic = {
      objectId: identitySha256(projectedTarget), target: projectedTarget,
      state: entry.state, reasonCode: entry.reasonCode,
    };
    return seal({
      ...semantic,
      sourceQueryId: entry.sourceQueryId,
      evidenceRefs: sortedUniqueHashes(entry.evidenceRefs, 'DB_ROLE_CLUSTER_COVERAGE_INVALID'),
      visibilityTargets: [projectedTarget],
      semanticEntrySha256: identitySha256(semantic),
    }, 'entrySha256');
  }).sort((left, right) => compare(left.objectId, right.objectId));
  const queryCoverage = run.coverage.queryCoverage.map((entry) => seal(entry, 'queryCoverageSha256'))
    .sort((left, right) => compare(left.queryId, right.queryId));
  return {entries, queryCoverage};
}

function profileProjection(bindings) {
  return bindings.map(({evidence}) => {
    const normalizedTarget = target(evidence.target);
    const profileId = identitySha256({semanticMethod: evidence.semanticMethod, target: normalizedTarget});
    return seal({
      profileId,
      semanticMethod: evidence.semanticMethod,
      target: normalizedTarget,
      state: evidence.state,
      receiptState: evidence.receiptState,
      reasonCode: evidence.reasonCode,
      semanticEvidenceSha256: evidence.semanticEvidenceSha256,
      evidenceSha256: evidence.evidenceSha256,
      counterevidenceRefs: counterRefs(evidence),
      engineDifferences: [...evidence.engineDifferences].sort(compare),
      visibilityTargets: visibilityTargets(normalizedTarget),
    }, 'profileSha256');
  }).sort((left, right) => compare(left.profileId, right.profileId));
}

function relationshipProjection(bindings) {
  return bindings.filter(({evidence}) => evidence.semanticMethod === 'RELATIONSHIP_OVERLAP').map(({evidence}) => {
    const normalizedTarget = target(evidence.target);
    const inferred = evidence.inferredClaims.some(({inferenceKind, claimStatus}) =>
      inferenceKind === 'RELATIONSHIP_CANDIDATE' && claimStatus === 'PROPOSAL_ONLY');
    const relationshipId = identitySha256(normalizedTarget);
    return seal({
      relationshipId,
      target: normalizedTarget,
      status: inferred ? 'PROPOSAL_ONLY' : 'COUNTEREVIDENCE_ONLY',
      supportEvidenceRefs: inferred ? [evidence.evidenceSha256] : [],
      counterevidenceRefs: counterRefs(evidence),
      confidenceBounds: confidence(inferred ? 1 : 0, evidence.counterevidence.length),
      automaticForeignKey: false,
      visibilityTargets: visibilityTargets(normalizedTarget),
    }, 'relationshipSha256');
  }).sort((left, right) => compare(left.relationshipId, right.relationshipId));
}

function hypothesisProjection(state) {
  return state.hypothesisLedger.entries.map((entry) => seal({
    hypothesisId: entry.hypothesisId,
    hypothesisKind: entry.hypothesisKind,
    target: target(entry.target),
    status: entry.status,
    confidenceBounds: entry.confidenceBounds,
    sourceEvidenceRefs: entry.sourceEvidenceRefs,
    supportingEvidenceRefs: entry.supportingEvidenceRefs,
    counterevidenceRefs: entry.counterevidenceRefs,
    sourceReceiptRefs: entry.sourceReceiptRefs,
    sourceHypothesisSha256: entry.hypothesisSha256,
    proposalOnly: true,
    automaticBusinessTruth: false,
    visibilityTargets: visibilityTargets(entry.target),
  }, 'hypothesisProjectionSha256')).sort((left, right) => compare(left.hypothesisId, right.hypothesisId));
}

function roleProjection(bindings) {
  const roles = new Map();
  function add(roleKind, roleTarget, binding, hasSupport = true) {
    const normalizedTarget = target(roleTarget);
    const roleId = identitySha256({roleKind, target: normalizedTarget});
    const current = roles.get(roleId) ?? {
      roleId, roleKind, target: normalizedTarget, supportEvidenceRefs: [], counterevidenceRefs: [], sourceReceiptRefs: [],
    };
    if (hasSupport) current.supportEvidenceRefs.push(binding.evidence.evidenceSha256);
    current.counterevidenceRefs.push(...counterRefs(binding.evidence));
    current.sourceReceiptRefs.push(binding.outcome.controllerReceiptSha256);
    roles.set(roleId, current);
  }
  for (const binding of bindings) {
    const {evidence} = binding;
    if (evidence.semanticMethod === 'COLUMN_SUMMARY'
      && evidence.inferredClaims.some(({inferenceKind, claimStatus}) => inferenceKind === 'KEY_CANDIDATE' && claimStatus === 'PROPOSAL_ONLY')) {
      add('KEY_CANDIDATE', evidence.target, binding);
    }
    if (evidence.semanticMethod === 'TEMPORAL_COVERAGE' && ['COMPLETE', 'PARTIAL'].includes(evidence.state)) {
      add('TEMPORAL_AXIS_CANDIDATE', evidence.target, binding);
    }
    if (evidence.semanticMethod === 'QUALITY_INDICATORS' && evidence.counterevidence.length > 0) {
      add('QUALITY_REVIEW_CANDIDATE', evidence.target, binding);
    }
    if (evidence.semanticMethod === 'RELATIONSHIP_OVERLAP'
      && evidence.inferredClaims.some(({inferenceKind, claimStatus}) => inferenceKind === 'RELATIONSHIP_CANDIDATE' && claimStatus === 'PROPOSAL_ONLY')) {
      add('RELATIONSHIP_LINK_CANDIDATE', {kind: 'COLUMN', ...evidence.target.source}, binding);
      add('RELATIONSHIP_LINK_CANDIDATE', {kind: 'COLUMN', ...evidence.target.target}, binding);
    }
  }
  return [...roles.values()].map((entry) => {
    const supportEvidenceRefs = [...new Set(entry.supportEvidenceRefs)].sort(compare);
    const counterevidenceRefs = [...new Set(entry.counterevidenceRefs)].sort(compare);
    const sourceReceiptRefs = [...new Set(entry.sourceReceiptRefs)].sort(compare);
    const semanticBody = {
      roleId: entry.roleId, roleKind: entry.roleKind, target: entry.target,
      proposalOnly: true, automaticBusinessTruth: false,
    };
    return seal({
      ...semanticBody,
      semanticRoleSha256: identitySha256(semanticBody),
      supportEvidenceRefs,
      counterevidenceRefs,
      sourceReceiptRefs,
      confidenceBounds: confidence(supportEvidenceRefs.length, counterevidenceRefs.length),
      visibilityTargets: visibilityTargets(entry.target),
    }, 'roleSha256');
  }).sort((left, right) => compare(left.roleId, right.roleId));
}

function clusterProjection(run, relationships) {
  const tableMap = new Map();
  for (const entry of run.coverage.entries) {
    if (entry.objectRef.schemaName === null || entry.objectRef.relationName === null) continue;
    const item = target({kind: 'TABLE', schemaName: entry.objectRef.schemaName, relationName: entry.objectRef.relationName});
    tableMap.set(identitySha256(item), item);
  }
  const parent = new Map([...tableMap.keys()].map((key) => [key, key]));
  const find = (key) => {
    let current = key;
    while (parent.get(current) !== current) current = parent.get(current);
    let path = key;
    while (parent.get(path) !== current) {
      const next = parent.get(path);
      parent.set(path, current);
      path = next;
    }
    return current;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    const [first, second] = [leftRoot, rightRoot].sort(compare);
    parent.set(second, first);
  };
  for (const relationship of relationships.filter(({status}) => status === 'PROPOSAL_ONLY')) {
    const source = tableTarget(relationship.target.source ? {kind: 'COLUMN', ...relationship.target.source} : relationship.target);
    const destination = tableTarget({kind: 'COLUMN', ...relationship.target.target});
    const sourceKey = identitySha256(source);
    const targetKey = identitySha256(destination);
    if (parent.has(sourceKey) && parent.has(targetKey)) union(sourceKey, targetKey);
  }
  const components = new Map();
  for (const [key, item] of tableMap) {
    const root = find(key);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(item);
  }
  return [...components.values()].map((members) => {
    const sortedMembers = [...members].sort((left, right) => compare(identitySha256(left), identitySha256(right)));
    const memberKeys = sortedMembers.map(identitySha256);
    const related = relationships.filter(({target: relationshipTarget}) => {
      const sourceKey = identitySha256(tableTarget({kind: 'COLUMN', ...relationshipTarget.source}));
      const targetKey = identitySha256(tableTarget({kind: 'COLUMN', ...relationshipTarget.target}));
      return memberKeys.includes(sourceKey) && memberKeys.includes(targetKey);
    });
    const supportEvidenceRefs = [...new Set(related.flatMap(({supportEvidenceRefs}) => supportEvidenceRefs))].sort(compare);
    const counterevidenceRefs = [...new Set(related.flatMap(({counterevidenceRefs}) => counterevidenceRefs))].sort(compare);
    const clusterId = identitySha256({members: sortedMembers});
    const semanticBody = {
      clusterId, members: sortedMembers, algorithm: 'DETERMINISTIC_CONNECTED_COMPONENTS',
      proposalOnly: true, causalClaim: false,
    };
    return seal({
      ...semanticBody,
      semanticClusterSha256: identitySha256(semanticBody),
      supportEvidenceRefs,
      counterevidenceRefs,
      confidenceBounds: confidence(supportEvidenceRefs.length, counterevidenceRefs.length),
      visibilityTargets: sortedMembers,
    }, 'clusterSha256');
  }).sort((left, right) => compare(left.clusterId, right.clusterId));
}

function semanticProjection({coverage, profiles, relationships, hypotheses, roles, clusters}) {
  return normalizeJsonValue({
    coverage: coverage.entries.map(({objectId, target: itemTarget, state, reasonCode, semanticEntrySha256}) =>
      ({objectId, target: itemTarget, state, reasonCode, semanticEntrySha256})),
    profiles: profiles.map(({profileId, semanticMethod, target: itemTarget, state, reasonCode, semanticEvidenceSha256}) =>
      ({profileId, semanticMethod, target: itemTarget, state, reasonCode, semanticEvidenceSha256})),
    relationships: relationships.map(({relationshipId, target: itemTarget, status}) => ({relationshipId, target: itemTarget, status})),
    hypotheses: hypotheses.map(({hypothesisId, hypothesisKind, target: itemTarget, status, confidenceBounds}) =>
      ({hypothesisId, hypothesisKind, target: itemTarget, status, confidenceBounds})),
    roles: roles.map(({roleId, semanticRoleSha256}) => ({roleId, semanticRoleSha256})),
    clusters: clusters.map(({clusterId, semanticClusterSha256}) => ({clusterId, semanticClusterSha256})),
  });
}

export function buildRoleClusterSnapshotV2({analysisState, safeEvidence, snapshotOrdinal, previousSnapshotSha256 = null}) {
  const state = resumeProgressiveAnalysis(analysisState);
  if (state.controllerRun.phase !== 'REPORT') fail('DB_ROLE_CLUSTER_CONTROLLER_PHASE_INVALID');
  const controllerReport = buildProgressiveAnalysisReport(state);
  if (!Number.isSafeInteger(snapshotOrdinal) || snapshotOrdinal < 1
    || !(previousSnapshotSha256 === null || sha256Value(previousSnapshotSha256))
    || !Array.isArray(safeEvidence)) fail('DB_ROLE_CLUSTER_SNAPSHOT_INPUT_INVALID');
  const bindings = safeEvidence.map((evidence) => validateSafeEvidence(evidence, state));
  if (new Set(bindings.map(({evidence}) => evidence.evidenceSha256)).size !== bindings.length) {
    fail('DB_ROLE_CLUSTER_EVIDENCE_DUPLICATE');
  }
  const coverage = coverageProjection(state.controllerRun);
  const profiles = profileProjection(bindings);
  const relationships = relationshipProjection(bindings);
  const hypotheses = hypothesisProjection(state);
  const roles = roleProjection(bindings);
  const clusters = clusterProjection(state.controllerRun, relationships);
  const projection = semanticProjection({coverage, profiles, relationships, hypotheses, roles, clusters});
  const body = {
    schemaVersion: ROLE_CLUSTER_SNAPSHOT_V2_SCHEMA,
    snapshotOrdinal,
    previousSnapshotSha256,
    runId: state.controllerRun.runId,
    engine: state.controllerRun.engine,
    scope: state.controllerRun.scope,
    scopeSha256: state.controllerRun.scopeSha256,
    controllerStateSha256: state.stateSha256,
    controllerEvidenceSha256: controllerReport.analysisEvidenceSha256,
    coverage,
    profiles,
    relationships,
    hypotheses,
    roles,
    clusters,
    engineDifferences: [...new Set(bindings.flatMap(({evidence}) => evidence.engineDifferences))].sort(compare),
    semanticProjectionSha256: identitySha256(projection),
    safety: {
      controllerReportRequired: true,
      reservationAndReceiptBindingRequired: true,
      proposalOnly: true,
      rawValuesPersisted: false,
      credentialsPersisted: false,
      automaticBusinessTruth: false,
      causalClusterClaim: false,
    },
    nonClaims: SNAPSHOT_NON_CLAIMS,
  };
  return seal(body, 'snapshotSha256');
}

function validateProjectionHash(item, hashKey, code) {
  assertSealed(item, hashKey, code);
  assertVisibilityTargets(item.visibilityTargets, code);
}

export function resumeRoleClusterSnapshotV2(snapshot) {
  const value = normalizeJsonValue(snapshot);
  assertSealed(value, 'snapshotSha256', 'DB_ROLE_CLUSTER_SNAPSHOT_TAMPERED');
  if (value.schemaVersion !== ROLE_CLUSTER_SNAPSHOT_V2_SCHEMA) fail('DB_ROLE_CLUSTER_SNAPSHOT_VERSION_UNSUPPORTED');
  if (!exactKeys(value, [
    'schemaVersion', 'snapshotOrdinal', 'previousSnapshotSha256', 'runId', 'engine', 'scope', 'scopeSha256',
    'controllerStateSha256', 'controllerEvidenceSha256', 'coverage', 'profiles', 'relationships', 'hypotheses',
    'roles', 'clusters', 'engineDifferences', 'semanticProjectionSha256', 'safety', 'nonClaims', 'snapshotSha256',
  ]) || !Number.isSafeInteger(value.snapshotOrdinal) || value.snapshotOrdinal < 1
    || !(value.previousSnapshotSha256 === null || sha256Value(value.previousSnapshotSha256))
    || !ENGINES.has(value.engine) || identitySha256(value.scope) !== value.scopeSha256
    || !sha256Value(value.controllerStateSha256) || !sha256Value(value.controllerEvidenceSha256)
    || !sha256Value(value.semanticProjectionSha256) || typeof value.runId !== 'string' || value.runId.length === 0
    || !exactKeys(value.scope, ['database', 'container', 'schemas'])
    || typeof value.scope.database !== 'string'
    || !(value.scope.container === null || typeof value.scope.container === 'string')
    || !Array.isArray(value.scope.schemas) || value.scope.schemas.length === 0
    || value.scope.schemas.some((schema) => typeof schema !== 'string' || schema.length === 0)
    || canonicalJson(value.scope.schemas) !== canonicalJson([...new Set(value.scope.schemas)].sort(compare))
    || !Array.isArray(value.engineDifferences)
    || value.engineDifferences.some((item) => typeof item !== 'string' || item.length === 0)
    || canonicalJson(value.engineDifferences) !== canonicalJson([...new Set(value.engineDifferences)].sort(compare))
    || canonicalJson(value.nonClaims) !== canonicalJson(SNAPSHOT_NON_CLAIMS)) fail('DB_ROLE_CLUSTER_SNAPSHOT_INVALID');
  if (!exactKeys(value.safety, [
    'controllerReportRequired', 'reservationAndReceiptBindingRequired', 'proposalOnly', 'rawValuesPersisted',
    'credentialsPersisted', 'automaticBusinessTruth', 'causalClusterClaim',
  ]) || value.safety.controllerReportRequired !== true
    || value.safety.reservationAndReceiptBindingRequired !== true || value.safety.proposalOnly !== true
    || value.safety.rawValuesPersisted !== false || value.safety.credentialsPersisted !== false
    || value.safety.automaticBusinessTruth !== false || value.safety.causalClusterClaim !== false) {
    fail('DB_ROLE_CLUSTER_SAFETY_INVALID');
  }
  if (!exactKeys(value.coverage, ['entries', 'queryCoverage'])
    || !Array.isArray(value.coverage.entries) || !Array.isArray(value.coverage.queryCoverage)
    || !Array.isArray(value.profiles) || !Array.isArray(value.relationships) || !Array.isArray(value.hypotheses)
    || !Array.isArray(value.roles) || !Array.isArray(value.clusters)) fail('DB_ROLE_CLUSTER_SNAPSHOT_INVALID');
  value.coverage.entries.forEach((item) => {
    const code = 'DB_ROLE_CLUSTER_COVERAGE_INVALID';
    validateProjectionHash(item, 'entrySha256', code);
    if (!exactKeys(item, ['objectId', 'target', 'state', 'reasonCode', 'sourceQueryId', 'evidenceRefs', 'visibilityTargets', 'semanticEntrySha256', 'entrySha256'])
      || !sha256Value(item.objectId) || identitySha256(item.target) !== item.objectId
      || !EVIDENCE_STATES.has(item.state) || !(item.reasonCode === null || REASON_CODE.test(item.reasonCode))
      || typeof item.sourceQueryId !== 'string' || item.sourceQueryId.length === 0
      || !sha256Value(item.semanticEntrySha256)) fail(code);
    assertHashArray(item.evidenceRefs, code);
  });
  value.coverage.queryCoverage.forEach((item) => {
    const code = 'DB_ROLE_CLUSTER_COVERAGE_INVALID';
    assertSealed(item, 'queryCoverageSha256', code);
    if (!exactKeys(item, ['queryId', 'category', 'state', 'reasonCode', 'visibility', 'absenceClaim', 'queryCoverageSha256'])
      || !['queryId', 'category', 'state', 'visibility'].every((key) => typeof item[key] === 'string' && item[key].length > 0)
      || !['SUCCEEDED', 'PARTIAL', 'DENIED', 'UNSUPPORTED', 'TIMEOUT', 'ERROR'].includes(item.state)
      || !(item.reasonCode === null || REASON_CODE.test(item.reasonCode)) || item.absenceClaim !== 'NOT_CLAIMED') fail(code);
  });
  value.profiles.forEach((item) => {
    const code = 'DB_ROLE_CLUSTER_PROFILE_INVALID';
    validateProjectionHash(item, 'profileSha256', code);
    if (!exactKeys(item, ['profileId', 'semanticMethod', 'target', 'state', 'receiptState', 'reasonCode', 'semanticEvidenceSha256', 'evidenceSha256', 'counterevidenceRefs', 'engineDifferences', 'visibilityTargets', 'profileSha256'])
      || !sha256Value(item.profileId) || !sha256Value(item.semanticEvidenceSha256) || !sha256Value(item.evidenceSha256)
      || typeof item.semanticMethod !== 'string' || item.semanticMethod.length === 0
      || !EVIDENCE_STATES.has(item.state) || !RECEIPT_STATES.has(item.receiptState)
      || !(item.reasonCode === null || REASON_CODE.test(item.reasonCode))) fail(code);
    assertHashArray(item.counterevidenceRefs, code);
    if (!Array.isArray(item.engineDifferences)
      || item.engineDifferences.some((value) => typeof value !== 'string' || value.length === 0)) fail(code);
  });
  value.relationships.forEach((item) => {
    const code = 'DB_ROLE_CLUSTER_RELATIONSHIP_INVALID';
    validateProjectionHash(item, 'relationshipSha256', code);
    if (!exactKeys(item, ['relationshipId', 'target', 'status', 'supportEvidenceRefs', 'counterevidenceRefs', 'confidenceBounds', 'automaticForeignKey', 'visibilityTargets', 'relationshipSha256'])
      || !sha256Value(item.relationshipId) || !['PROPOSAL_ONLY', 'COUNTEREVIDENCE_ONLY'].includes(item.status)
      || item.automaticForeignKey !== false) fail(code);
    assertHashArray(item.supportEvidenceRefs, code);
    assertHashArray(item.counterevidenceRefs, code);
    assertConfidence(item.confidenceBounds, code);
  });
  value.hypotheses.forEach((item) => {
    const code = 'DB_ROLE_CLUSTER_HYPOTHESIS_INVALID';
    validateProjectionHash(item, 'hypothesisProjectionSha256', code);
    if (!exactKeys(item, ['hypothesisId', 'hypothesisKind', 'target', 'status', 'confidenceBounds', 'sourceEvidenceRefs', 'supportingEvidenceRefs', 'counterevidenceRefs', 'sourceReceiptRefs', 'sourceHypothesisSha256', 'proposalOnly', 'automaticBusinessTruth', 'visibilityTargets', 'hypothesisProjectionSha256'])
      || !['hypothesisId', 'hypothesisKind', 'status'].every((key) => typeof item[key] === 'string' && item[key].length > 0)
      || !sha256Value(item.sourceHypothesisSha256) || item.proposalOnly !== true || item.automaticBusinessTruth !== false) fail(code);
    assertConfidence(item.confidenceBounds, code);
    for (const key of ['sourceEvidenceRefs', 'supportingEvidenceRefs', 'counterevidenceRefs', 'sourceReceiptRefs']) assertHashArray(item[key], code);
  });
  value.roles.forEach((item) => {
    const code = 'DB_ROLE_CLUSTER_ROLE_INVALID';
    validateProjectionHash(item, 'roleSha256', code);
    if (!exactKeys(item, ['roleId', 'roleKind', 'target', 'semanticRoleSha256', 'supportEvidenceRefs', 'counterevidenceRefs', 'sourceReceiptRefs', 'confidenceBounds', 'proposalOnly', 'automaticBusinessTruth', 'visibilityTargets', 'roleSha256'])
      || !sha256Value(item.roleId) || !ROLE_KINDS.has(item.roleKind) || item.proposalOnly !== true
      || item.automaticBusinessTruth !== false || !sha256Value(item.semanticRoleSha256)) fail(code);
    for (const key of ['supportEvidenceRefs', 'counterevidenceRefs', 'sourceReceiptRefs']) assertHashArray(item[key], code);
    assertConfidence(item.confidenceBounds, code);
  });
  value.clusters.forEach((item) => {
    const code = 'DB_ROLE_CLUSTER_CLUSTER_INVALID';
    validateProjectionHash(item, 'clusterSha256', code);
    if (!exactKeys(item, ['clusterId', 'members', 'algorithm', 'proposalOnly', 'causalClaim', 'semanticClusterSha256', 'supportEvidenceRefs', 'counterevidenceRefs', 'confidenceBounds', 'visibilityTargets', 'clusterSha256'])
      || !sha256Value(item.clusterId) || !Array.isArray(item.members) || item.members.length === 0
      || item.algorithm !== 'DETERMINISTIC_CONNECTED_COMPONENTS' || item.proposalOnly !== true
      || item.causalClaim !== false || !sha256Value(item.semanticClusterSha256)) fail(code);
    item.members.forEach(target);
    for (const key of ['supportEvidenceRefs', 'counterevidenceRefs']) assertHashArray(item[key], code);
    assertConfidence(item.confidenceBounds, code);
  });
  const semantic = semanticProjection(value);
  if (identitySha256(semantic) !== value.semanticProjectionSha256) fail('DB_ROLE_CLUSTER_SEMANTIC_PROJECTION_INVALID');
  denyUnsafeEvidenceKeys(value);
  return value;
}

function coverageRemoval(item, current) {
  const query = current.coverage.queryCoverage.find(({queryId}) => queryId === item.sourceQueryId);
  if (query?.state === 'SUCCEEDED' && query.visibility === 'VISIBLE_COMPLETE') {
    return {classification: 'REMOVED', semantics: 'OBSERVED_REMOVAL', reasonCode: null};
  }
  if (query?.state === 'DENIED') {
    return {classification: 'DENIED', semantics: 'VISIBILITY_LOSS', reasonCode: query.reasonCode};
  }
  if (query?.state === 'UNSUPPORTED') {
    return {classification: 'UNSUPPORTED', semantics: 'VISIBILITY_LOSS', reasonCode: query.reasonCode};
  }
  return {classification: 'UNKNOWN', semantics: 'VISIBILITY_LOSS', reasonCode: query?.reasonCode ?? 'CURRENT_VISIBILITY_UNKNOWN'};
}

function targetVisible(itemTarget, current) {
  const normalized = target(itemTarget);
  return current.coverage.entries.some(({target: currentTarget}) => {
    if (normalized.kind === 'TABLE') {
      return currentTarget.schemaName === normalized.schemaName && currentTarget.relationName === normalized.relationName;
    }
    return canonicalJson(currentTarget) === canonicalJson(normalized);
  });
}

function evidenceRemoval(item, current, baseline) {
  const targets = item.visibilityTargets ?? [];
  const baselineCoverage = baseline.coverage.entries.filter((entry) => targets.some((itemTarget) => {
    const normalized = target(itemTarget);
    if (normalized.kind === 'TABLE') {
      return entry.target.schemaName === normalized.schemaName && entry.target.relationName === normalized.relationName;
    }
    return canonicalJson(entry.target) === canonicalJson(normalized);
  }));
  const lost = baselineCoverage.map((entry) => coverageRemoval(entry, current)).filter(({classification}) => classification !== 'REMOVED');
  if (lost.some(({classification}) => classification === 'DENIED')) return lost.find(({classification}) => classification === 'DENIED');
  if (lost.some(({classification}) => classification === 'UNSUPPORTED')) return lost.find(({classification}) => classification === 'UNSUPPORTED');
  if (lost.length > 0) return lost[0];
  if (targets.length > 0 && targets.every((itemTarget) => targetVisible(itemTarget, current))) {
    return {classification: 'UNKNOWN', semantics: 'EVIDENCE_NOT_REOBSERVED', reasonCode: 'CURRENT_EVIDENCE_INCOMPLETE'};
  }
  return {classification: 'UNKNOWN', semantics: 'VISIBILITY_UNKNOWN', reasonCode: 'CURRENT_VISIBILITY_UNKNOWN'};
}

function diffSurface({baselineItems, currentItems, idKey, hashKey, baseline, current, coverage = false}) {
  const baselineMap = new Map(baselineItems.map((item) => [item[idKey], item]));
  const currentMap = new Map(currentItems.map((item) => [item[idKey], item]));
  const changes = [];
  for (const [id, item] of currentMap) {
    const previous = baselineMap.get(id);
    if (!previous) {
      changes.push({id, classification: 'ADDED', semantics: 'CURRENT_OBSERVATION', reasonCode: null, beforeSha256: null, afterSha256: item[hashKey]});
    } else if (previous[hashKey] !== item[hashKey]) {
      changes.push({id, classification: 'CHANGED', semantics: 'EVIDENCE_CHANGED', reasonCode: null, beforeSha256: previous[hashKey], afterSha256: item[hashKey]});
    }
  }
  for (const [id, item] of baselineMap) {
    if (currentMap.has(id)) continue;
    const classification = coverage ? coverageRemoval(item, current) : evidenceRemoval(item, current, baseline);
    changes.push({
      id,
      ...classification,
      beforeSha256: item[hashKey],
      afterSha256: null,
    });
  }
  changes.sort((left, right) => compare(`${left.id}:${left.classification}`, `${right.id}:${right.classification}`));
  const counts = Object.fromEntries(['ADDED', 'REMOVED', 'CHANGED', 'DENIED', 'UNSUPPORTED', 'UNKNOWN']
    .map((classification) => [classification, changes.filter((item) => item.classification === classification).length]));
  return seal({changes, counts}, 'surfaceDiffSha256');
}

export function buildExtendedEvidenceDiffV2({baseline, current}) {
  const previous = resumeRoleClusterSnapshotV2(baseline);
  const next = resumeRoleClusterSnapshotV2(current);
  if (next.previousSnapshotSha256 !== previous.snapshotSha256) fail('DB_EVIDENCE_DIFF_STALE_BASELINE');
  if (next.snapshotOrdinal <= previous.snapshotOrdinal) fail('DB_EVIDENCE_DIFF_STALE_BASELINE');
  if (next.scopeSha256 !== previous.scopeSha256) fail('DB_EVIDENCE_DIFF_SCOPE_DRIFT');
  if (next.engine !== previous.engine) fail('DB_EVIDENCE_DIFF_ENGINE_DRIFT');
  const body = {
    schemaVersion: EXTENDED_EVIDENCE_DIFF_V2_SCHEMA,
    engine: next.engine,
    scopeSha256: next.scopeSha256,
    baselineSnapshotSha256: previous.snapshotSha256,
    currentSnapshotSha256: next.snapshotSha256,
    baselineOrdinal: previous.snapshotOrdinal,
    currentOrdinal: next.snapshotOrdinal,
    coverage: diffSurface({baselineItems: previous.coverage.entries, currentItems: next.coverage.entries, idKey: 'objectId', hashKey: 'entrySha256', baseline: previous, current: next, coverage: true}),
    profiles: diffSurface({baselineItems: previous.profiles, currentItems: next.profiles, idKey: 'profileId', hashKey: 'profileSha256', baseline: previous, current: next}),
    relationships: diffSurface({baselineItems: previous.relationships, currentItems: next.relationships, idKey: 'relationshipId', hashKey: 'relationshipSha256', baseline: previous, current: next}),
    hypotheses: diffSurface({baselineItems: previous.hypotheses, currentItems: next.hypotheses, idKey: 'hypothesisId', hashKey: 'hypothesisProjectionSha256', baseline: previous, current: next}),
    roles: diffSurface({baselineItems: previous.roles, currentItems: next.roles, idKey: 'roleId', hashKey: 'roleSha256', baseline: previous, current: next}),
    clusters: diffSurface({baselineItems: previous.clusters, currentItems: next.clusters, idKey: 'clusterId', hashKey: 'clusterSha256', baseline: previous, current: next}),
    safety: {
      visibilityLossConvertedToRemoval: false,
      rawValuesPersisted: false,
      credentialsPersisted: false,
      automaticBusinessTruth: false,
    },
    nonClaims: DIFF_NON_CLAIMS,
  };
  return seal(body, 'diffSha256');
}

function validateSurfaceDiff(surface) {
  const code = 'DB_EVIDENCE_DIFF_SURFACE_INVALID';
  assertSealed(surface, 'surfaceDiffSha256', code);
  if (!exactKeys(surface, ['changes', 'counts', 'surfaceDiffSha256']) || !Array.isArray(surface.changes)
    || !exactKeys(surface.counts, [...DIFF_CLASSIFICATIONS])) fail(code);
  surface.changes.forEach((change) => {
    if (!exactKeys(change, ['id', 'classification', 'semantics', 'reasonCode', 'beforeSha256', 'afterSha256'])
      || typeof change.id !== 'string' || change.id.length === 0 || change.id.length > 256
      || !DIFF_CLASSIFICATIONS.has(change.classification)
      || !DIFF_SEMANTICS.has(change.semantics) || !(change.reasonCode === null || REASON_CODE.test(change.reasonCode))
      || !(change.beforeSha256 === null || sha256Value(change.beforeSha256))
      || !(change.afterSha256 === null || sha256Value(change.afterSha256))) fail(code);
  });
  for (const classification of DIFF_CLASSIFICATIONS) {
    if (!Number.isSafeInteger(surface.counts[classification]) || surface.counts[classification] < 0
      || surface.counts[classification] !== surface.changes.filter((item) => item.classification === classification).length) fail(code);
  }
  return surface;
}

export function resumeExtendedEvidenceDiffV2(diff) {
  const value = normalizeJsonValue(diff);
  assertSealed(value, 'diffSha256', 'DB_EVIDENCE_DIFF_TAMPERED');
  if (value.schemaVersion !== EXTENDED_EVIDENCE_DIFF_V2_SCHEMA) fail('DB_EVIDENCE_DIFF_VERSION_UNSUPPORTED');
  if (!exactKeys(value, [
    'schemaVersion', 'engine', 'scopeSha256', 'baselineSnapshotSha256', 'currentSnapshotSha256',
    'baselineOrdinal', 'currentOrdinal', 'coverage', 'profiles', 'relationships', 'hypotheses', 'roles',
    'clusters', 'safety', 'nonClaims', 'diffSha256',
  ]) || !ENGINES.has(value.engine) || !sha256Value(value.scopeSha256)
    || !sha256Value(value.baselineSnapshotSha256) || !sha256Value(value.currentSnapshotSha256)
    || !Number.isSafeInteger(value.baselineOrdinal) || !Number.isSafeInteger(value.currentOrdinal)
    || value.baselineOrdinal < 1 || value.currentOrdinal <= value.baselineOrdinal
    || canonicalJson(value.nonClaims) !== canonicalJson(DIFF_NON_CLAIMS)) fail('DB_EVIDENCE_DIFF_INVALID');
  for (const key of ['coverage', 'profiles', 'relationships', 'hypotheses', 'roles', 'clusters']) validateSurfaceDiff(value[key]);
  if (!exactKeys(value.safety, ['visibilityLossConvertedToRemoval', 'rawValuesPersisted', 'credentialsPersisted', 'automaticBusinessTruth'])
    || value.safety.visibilityLossConvertedToRemoval !== false || value.safety.rawValuesPersisted !== false
    || value.safety.credentialsPersisted !== false || value.safety.automaticBusinessTruth !== false) {
    fail('DB_EVIDENCE_DIFF_SAFETY_INVALID');
  }
  denyUnsafeEvidenceKeys(value);
  return value;
}
