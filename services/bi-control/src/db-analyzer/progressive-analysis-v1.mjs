import {
  canonicalJson,
  identitySha256,
  normalizeJsonValue,
} from './core.mjs';
import {
  advanceProgressivePhase,
  authorizeProgressiveProbe,
  buildProgressiveReport,
  recordProgressiveReceipt,
  resumeProgressiveRun,
} from './progressive-controller.mjs';

export const PROGRESSIVE_ANALYSIS_SCHEMA = 'kaleidosphere.analysis/progressive-analysis/v1';
export const PROGRESSIVE_HYPOTHESIS_LEDGER_SCHEMA = 'kaleidosphere.analysis/progressive-hypothesis-ledger/v1';
export const PROGRESSIVE_HYPOTHESIS_SCHEMA = 'kaleidosphere.analysis/progressive-hypothesis/v1';
export const PROGRESSIVE_CANDIDATE_SCHEMA = 'kaleidosphere.analysis/progressive-probe-candidate/v1';
export const PROGRESSIVE_RESERVATION_SCHEMA = 'kaleidosphere.analysis/progressive-probe-reservation/v1';
export const PROGRESSIVE_OUTCOME_SCHEMA = 'kaleidosphere.analysis/progressive-probe-outcome/v1';
export const PROGRESSIVE_RECONCILIATION_SCHEMA = 'kaleidosphere.analysis/progressive-unknown-reconciliation/v1';
export const PROGRESSIVE_ANALYSIS_REPORT_SCHEMA = 'kaleidosphere.analysis/progressive-analysis-report/v1';

const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9][a-z0-9._-]{2,127}$/;
const REASON_CODE = /^[A-Z][A-Z0-9_]{2,127}$/;
const SECRET_SHAPE = /(?:password|passwd|credential|secret|token|api[_-]?key|connection[_-]?string|dsn)/i;
const HYPOTHESIS_KINDS = new Set(['DISTRIBUTION_ANOMALY', 'DATA_QUALITY', 'RELATIONSHIP_CANDIDATE', 'TEMPORAL_PATTERN']);
const HYPOTHESIS_STATES = new Set(['OPEN', 'SUPPORTED_CANDIDATE', 'COUNTEREVIDENCE_CANDIDATE', 'AWAITING_RECONCILIATION', 'STOPPED']);
const PROBE_CLASSES = new Set(['SAFE_AGGREGATE', 'RELATIONSHIP_CHECK', 'QUALITY_CHECK', 'TEMPORAL_CHECK']);
const SIGNAL_KINDS = new Set(['DISTRIBUTION', 'NULLABILITY', 'CARDINALITY', 'RELATIONSHIP', 'TEMPORAL']);
const COMPARISON_KINDS = new Set(['BASELINE', 'PEER', 'NONE']);
const GRAINS = new Set(['COLUMN', 'TABLE']);
const OUTCOME_STATES = new Set(['SUCCEEDED', 'PARTIAL', 'DENIED', 'UNSUPPORTED', 'TIMEOUT', 'CANCELLED', 'UNKNOWN']);
const SIGNALS = new Set(['SUPPORTS', 'COUNTERS', 'NO_GAIN', 'INCONCLUSIVE', 'UNKNOWN']);
const RESOLVED_STATES = new Set(['SUCCEEDED', 'PARTIAL', 'DENIED', 'UNSUPPORTED']);

const fail = (code) => {
  const error = new Error(code);
  error.code = code;
  throw error;
};

const compare = (left, right) => Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
const sha256Value = (value) => typeof value === 'string' && SHA256.test(value);
const safeText = (value, max = 128) => typeof value === 'string'
  && value.length > 0 && value.length <= max
  && value === value.normalize('NFC')
  && !/[\u0000-\u001f\u007f]/.test(value)
  && !SECRET_SHAPE.test(value);
const identifier = (value) => safeText(value) && !/[;]|--|\/\*|\*\//.test(value);
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

function replaceState(state, changes) {
  const {stateSha256: _oldState, ...body} = state;
  return seal({...body, ...changes}, 'stateSha256');
}

function sortedUniqueHashes(values, code) {
  if (!Array.isArray(values) || values.some((value) => !sha256Value(value)) || new Set(values).size !== values.length) fail(code);
  return [...values].sort(compare);
}

function confidenceBounds(value) {
  if (!exactKeys(value, ['lowerBps', 'upperBps'])
    || !Number.isInteger(value.lowerBps) || !Number.isInteger(value.upperBps)
    || value.lowerBps < 0 || value.upperBps > 10000 || value.lowerBps > value.upperBps) {
    fail('DB_PROGRESSIVE_CONFIDENCE_BOUNDS_INVALID');
  }
  return normalizeJsonValue(value);
}

function normalizeTableTarget(target, controllerRun) {
  if (!exactKeys(target, ['kind', 'schemaName', 'relationName']) || target.kind !== 'TABLE'
    || !identifier(target.schemaName) || !identifier(target.relationName)
    || !controllerRun.scope.schemas.includes(target.schemaName)
    || !controllerRun.coverage.entries.some(({objectRef}) => objectRef.schemaName === target.schemaName
      && objectRef.relationName === target.relationName)) fail('DB_PROGRESSIVE_HYPOTHESIS_SCOPE_DENIED');
  return normalizeJsonValue(target);
}

function tableTargetForProbe(target) {
  const endpoint = target?.kind === 'RELATIONSHIP' ? target.source : target;
  if (!endpoint || !identifier(endpoint.schemaName) || !identifier(endpoint.relationName)) fail('DB_PROGRESSIVE_CANDIDATE_TARGET_INVALID');
  return normalizeJsonValue({kind: 'TABLE', schemaName: endpoint.schemaName, relationName: endpoint.relationName});
}

function validateIntentFeatures(features) {
  if (!exactKeys(features, ['probeClass', 'signalKind', 'comparisonKind', 'grain'])
    || !PROBE_CLASSES.has(features.probeClass) || !SIGNAL_KINDS.has(features.signalKind)
    || !COMPARISON_KINDS.has(features.comparisonKind) || !GRAINS.has(features.grain)) {
    fail('DB_PROGRESSIVE_INTENT_FEATURES_INVALID');
  }
  return normalizeJsonValue(features);
}

function validateDispatchShape(state, {phase, methodRef, target, arguments: args}) {
  const method = state.controllerRun.methodRegistry.methods.find((entry) => entry.methodRef === methodRef);
  if (!method || method.phase !== phase || phase !== state.controllerRun.phase || method.readOnly !== true
    || method.acceptsFreeSql !== false || method.acceptsRawValues !== false || method.acceptsCredentials !== false
    || !args || typeof args !== 'object' || Array.isArray(args)
    || canonicalJson(Object.keys(args).sort()) !== canonicalJson(method.allowedArgumentKeys)) {
    fail('DB_PROGRESSIVE_METHOD_DENIED');
  }
  if (Object.keys(args).some((key) => !safeText(key, 64) || SECRET_SHAPE.test(key))) fail('DB_PROGRESSIVE_PROBE_REQUEST_INVALID');
  if (method.targetKind === 'COLUMN') {
    if (!exactKeys(target, ['kind', 'schemaName', 'relationName', 'columnName']) || target.kind !== 'COLUMN'
      || ![target.schemaName, target.relationName, target.columnName].every(identifier)
      || !state.controllerRun.scope.schemas.includes(target.schemaName)) fail('DB_PROGRESSIVE_SCOPE_DENIED');
  } else if (method.targetKind === 'RELATIONSHIP') {
    if (!exactKeys(target, ['kind', 'source', 'target']) || target.kind !== 'RELATIONSHIP') fail('DB_PROGRESSIVE_SCOPE_DENIED');
    for (const endpoint of [target.source, target.target]) {
      if (!exactKeys(endpoint, ['schemaName', 'relationName', 'columnName'])
        || ![endpoint.schemaName, endpoint.relationName, endpoint.columnName].every(identifier)
        || !state.controllerRun.scope.schemas.includes(endpoint.schemaName)) fail('DB_PROGRESSIVE_SCOPE_DENIED');
    }
    if (canonicalJson(target.source) === canonicalJson(target.target)) fail('DB_PROGRESSIVE_SCOPE_DENIED');
  } else {
    fail('DB_PROGRESSIVE_SCOPE_DENIED');
  }
}

function expectedGain(gainInputs, bindingSha256) {
  if (!exactKeys(gainInputs, ['uncertaintyBps', 'outcomeProbabilityBps', 'relevanceBps', 'rationaleCode', 'evidenceRefs'])
    || ![gainInputs.uncertaintyBps, gainInputs.outcomeProbabilityBps, gainInputs.relevanceBps]
      .every((value) => Number.isInteger(value) && value >= 0 && value <= 10000)
    || !REASON_CODE.test(gainInputs.rationaleCode)) fail('DB_PROGRESSIVE_GAIN_INPUT_INVALID');
  const evidenceRefs = sortedUniqueHashes(gainInputs.evidenceRefs, 'DB_PROGRESSIVE_GAIN_INPUT_INVALID');
  const calculated = Number((BigInt(gainInputs.uncertaintyBps)
    * BigInt(gainInputs.outcomeProbabilityBps) * BigInt(gainInputs.relevanceBps)) / 100000000n);
  return seal({
    schemaVersion: 'kaleidosphere.analysis/expected-information-gain/v1',
    bindingSha256,
    uncertaintyBps: gainInputs.uncertaintyBps,
    outcomeProbabilityBps: gainInputs.outcomeProbabilityBps,
    relevanceBps: gainInputs.relevanceBps,
    expectedInformationGainBps: calculated,
    rationaleCode: gainInputs.rationaleCode,
    evidenceRefs,
    optimalityClaimed: false,
  }, 'expectedGainSha256');
}

function validateExpectedGain(value, bindingSha256) {
  assertSealed(value, 'expectedGainSha256', 'DB_PROGRESSIVE_GAIN_TAMPERED');
  if (!exactKeys(value, [
    'schemaVersion', 'bindingSha256', 'uncertaintyBps', 'outcomeProbabilityBps', 'relevanceBps',
    'expectedInformationGainBps', 'rationaleCode', 'evidenceRefs', 'optimalityClaimed', 'expectedGainSha256',
  ]) || value.schemaVersion !== 'kaleidosphere.analysis/expected-information-gain/v1'
    || value.bindingSha256 !== bindingSha256 || value.optimalityClaimed !== false) fail('DB_PROGRESSIVE_GAIN_INVALID');
  const rebuilt = expectedGain({
    uncertaintyBps: value.uncertaintyBps,
    outcomeProbabilityBps: value.outcomeProbabilityBps,
    relevanceBps: value.relevanceBps,
    rationaleCode: value.rationaleCode,
    evidenceRefs: value.evidenceRefs,
  }, bindingSha256);
  if (canonicalJson(rebuilt) !== canonicalJson(value)) fail('DB_PROGRESSIVE_GAIN_FORGED');
  return value;
}

function sealHypothesis(entry) {
  return seal(entry, 'hypothesisSha256');
}

function validateHypothesis(entry, state) {
  assertSealed(entry, 'hypothesisSha256', 'DB_PROGRESSIVE_HYPOTHESIS_TAMPERED');
  if (!exactKeys(entry, [
    'schemaVersion', 'hypothesisId', 'hypothesisKind', 'target', 'tableKey', 'definitionSha256', 'status',
    'initialConfidenceBounds', 'confidenceBounds', 'sourceEvidenceRefs', 'supportingEvidenceRefs', 'counterevidenceRefs', 'sourceReceiptRefs',
    'contradictions', 'consecutiveNoGain', 'consecutiveCounterevidence', 'terminalReason', 'automaticBusinessTruth',
    'hypothesisSha256',
  ]) || entry.schemaVersion !== PROGRESSIVE_HYPOTHESIS_SCHEMA || !ID.test(entry.hypothesisId)
    || !HYPOTHESIS_KINDS.has(entry.hypothesisKind) || !HYPOTHESIS_STATES.has(entry.status)
    || entry.tableKey !== identitySha256(entry.target) || !sha256Value(entry.definitionSha256)
    || entry.automaticBusinessTruth !== false
    || !Number.isInteger(entry.consecutiveNoGain) || entry.consecutiveNoGain < 0
    || !Number.isInteger(entry.consecutiveCounterevidence) || entry.consecutiveCounterevidence < 0
    || !(entry.terminalReason === null || REASON_CODE.test(entry.terminalReason))) fail('DB_PROGRESSIVE_HYPOTHESIS_INVALID');
  normalizeTableTarget(entry.target, state.controllerRun);
  confidenceBounds(entry.initialConfidenceBounds);
  confidenceBounds(entry.confidenceBounds);
  sortedUniqueHashes(entry.sourceEvidenceRefs, 'DB_PROGRESSIVE_HYPOTHESIS_INVALID');
  sortedUniqueHashes(entry.supportingEvidenceRefs, 'DB_PROGRESSIVE_HYPOTHESIS_INVALID');
  sortedUniqueHashes(entry.counterevidenceRefs, 'DB_PROGRESSIVE_HYPOTHESIS_INVALID');
  sortedUniqueHashes(entry.sourceReceiptRefs, 'DB_PROGRESSIVE_HYPOTHESIS_INVALID');
  if (!Array.isArray(entry.contradictions) || entry.contradictions.some((item) => !exactKeys(item, ['sourceReceiptSha256', 'reasonCode'])
    || !sha256Value(item.sourceReceiptSha256) || !REASON_CODE.test(item.reasonCode))) fail('DB_PROGRESSIVE_HYPOTHESIS_INVALID');
  const definition = {
    schemaVersion: entry.schemaVersion,
    hypothesisId: entry.hypothesisId,
    hypothesisKind: entry.hypothesisKind,
    target: entry.target,
    tableKey: entry.tableKey,
    initialConfidenceBounds: entry.initialConfidenceBounds,
    sourceEvidenceRefs: entry.sourceEvidenceRefs,
    automaticBusinessTruth: false,
  };
  if (identitySha256(definition) !== entry.definitionSha256) fail('DB_PROGRESSIVE_HYPOTHESIS_DEFINITION_INVALID');
  return entry;
}

function sealLedger(entries) {
  return seal({
    schemaVersion: PROGRESSIVE_HYPOTHESIS_LEDGER_SCHEMA,
    entries: [...entries].sort((left, right) => compare(left.hypothesisId, right.hypothesisId)),
    inferencePromotedToFact: false,
    priorCounterevidenceDeleted: false,
  }, 'ledgerSha256');
}

function validateLedger(ledger, state) {
  assertSealed(ledger, 'ledgerSha256', 'DB_PROGRESSIVE_HYPOTHESIS_LEDGER_TAMPERED');
  if (ledger.schemaVersion !== PROGRESSIVE_HYPOTHESIS_LEDGER_SCHEMA || !Array.isArray(ledger.entries)
    || ledger.inferencePromotedToFact !== false || ledger.priorCounterevidenceDeleted !== false) {
    fail('DB_PROGRESSIVE_HYPOTHESIS_LEDGER_INVALID');
  }
  ledger.entries.forEach((entry) => validateHypothesis(entry, state));
  if (new Set(ledger.entries.map(({hypothesisId}) => hypothesisId)).size !== ledger.entries.length
    || canonicalJson(ledger) !== canonicalJson(sealLedger(ledger.entries))) fail('DB_PROGRESSIVE_HYPOTHESIS_LEDGER_INVALID');
  return ledger;
}

function counts(items, key) {
  const result = new Map();
  for (const item of items) result.set(item[key], (result.get(item[key]) ?? 0) + 1);
  return [...result.entries()].map(([id, count]) => ({[key]: id, count})).sort((left, right) => compare(left[key], right[key]));
}

function validateCandidate(candidate, state) {
  assertSealed(candidate, 'candidateSha256', 'DB_PROGRESSIVE_CANDIDATE_TAMPERED');
  if (!exactKeys(candidate, [
    'schemaVersion', 'runId', 'scopeSha256', 'coverageSha256', 'methodRegistrySha256', 'hypothesisId',
    'hypothesisDefinitionSha256', 'tableKey', 'phase', 'methodRef', 'target', 'arguments', 'intentFeatures',
    'nearDuplicateKey', 'gainBindingSha256', 'expectedGain', 'candidateSha256',
  ]) || candidate.schemaVersion !== PROGRESSIVE_CANDIDATE_SCHEMA
    || candidate.runId !== state.controllerRun.runId || candidate.scopeSha256 !== state.controllerRun.scopeSha256
    || candidate.coverageSha256 !== state.controllerRun.coverage.coverageSha256
    || candidate.methodRegistrySha256 !== state.controllerRun.methodRegistry.registrySha256) {
    fail('DB_PROGRESSIVE_CANDIDATE_BINDING_INVALID');
  }
  const hypothesis = state.hypothesisLedger.entries.find(({hypothesisId}) => hypothesisId === candidate.hypothesisId);
  if (!hypothesis || candidate.hypothesisDefinitionSha256 !== hypothesis.definitionSha256
    || candidate.tableKey !== hypothesis.tableKey
    || identitySha256(tableTargetForProbe(candidate.target)) !== candidate.tableKey) fail('DB_PROGRESSIVE_CANDIDATE_BINDING_INVALID');
  validateIntentFeatures(candidate.intentFeatures);
  if (!safeText(candidate.methodRef, 180) || !safeText(candidate.phase, 64)
    || !candidate.arguments || typeof candidate.arguments !== 'object' || Array.isArray(candidate.arguments)) {
    fail('DB_PROGRESSIVE_CANDIDATE_INVALID');
  }
  const gainBinding = identitySha256({
    runId: candidate.runId,
    scopeSha256: candidate.scopeSha256,
    hypothesisDefinitionSha256: candidate.hypothesisDefinitionSha256,
    phase: candidate.phase,
    methodRef: candidate.methodRef,
    target: candidate.target,
    arguments: candidate.arguments,
    intentFeatures: candidate.intentFeatures,
  });
  if (gainBinding !== candidate.gainBindingSha256) fail('DB_PROGRESSIVE_CANDIDATE_BINDING_INVALID');
  validateExpectedGain(candidate.expectedGain, gainBinding);
  const nearDuplicateKey = identitySha256({
    scopeSha256: candidate.scopeSha256,
    hypothesisDefinitionSha256: candidate.hypothesisDefinitionSha256,
    tableKey: candidate.tableKey,
    target: candidate.target,
    intentFeatures: candidate.intentFeatures,
  });
  if (nearDuplicateKey !== candidate.nearDuplicateKey) fail('DB_PROGRESSIVE_NEAR_DUPLICATE_KEY_INVALID');
  return candidate;
}

function validateReservation(reservation, state) {
  assertSealed(reservation, 'reservationSha256', 'DB_PROGRESSIVE_RESERVATION_TAMPERED');
  if (!exactKeys(reservation, [
    'schemaVersion', 'runId', 'scopeSha256', 'candidateSha256', 'nearDuplicateKey', 'controllerProbeKey',
    'hypothesisId', 'hypothesisDefinitionSha256', 'tableKey', 'methodRef', 'phase', 'target', 'intentFeatures',
    'gainBindingSha256', 'expectedGain', 'reservationDebit', 'dispatched', 'reservationSha256',
  ]) || reservation.schemaVersion !== PROGRESSIVE_RESERVATION_SCHEMA || !sha256Value(reservation.candidateSha256)
    || !sha256Value(reservation.controllerProbeKey) || !sha256Value(reservation.nearDuplicateKey)
    || !ID.test(reservation.hypothesisId) || !sha256Value(reservation.hypothesisDefinitionSha256)
    || !sha256Value(reservation.tableKey) || !sha256Value(reservation.gainBindingSha256)
    || reservation.reservationDebit !== 1 || reservation.dispatched !== false
    || !state.controllerRun.probes.some(({probeKey}) => probeKey === reservation.controllerProbeKey)) {
    fail('DB_PROGRESSIVE_RESERVATION_INVALID');
  }
  const hypothesis = state.hypothesisLedger.entries.find(({hypothesisId}) => hypothesisId === reservation.hypothesisId);
  const controllerProbe = state.controllerRun.probes.find(({probeKey}) => probeKey === reservation.controllerProbeKey);
  if (!hypothesis || reservation.hypothesisDefinitionSha256 !== hypothesis.definitionSha256
    || reservation.tableKey !== hypothesis.tableKey
    || controllerProbe.methodRef !== reservation.methodRef || controllerProbe.phase !== reservation.phase
    || canonicalJson(controllerProbe.target) !== canonicalJson(reservation.target)
    || identitySha256(tableTargetForProbe(reservation.target)) !== reservation.tableKey) {
    fail('DB_PROGRESSIVE_RESERVATION_INVALID');
  }
  validateIntentFeatures(reservation.intentFeatures);
  const gainBinding = identitySha256({
    runId: reservation.runId,
    scopeSha256: reservation.scopeSha256,
    hypothesisDefinitionSha256: reservation.hypothesisDefinitionSha256,
    phase: reservation.phase,
    methodRef: reservation.methodRef,
    target: reservation.target,
    arguments: controllerProbe.arguments,
    intentFeatures: reservation.intentFeatures,
  });
  if (gainBinding !== reservation.gainBindingSha256) fail('DB_PROGRESSIVE_RESERVATION_INVALID');
  validateExpectedGain(reservation.expectedGain, reservation.gainBindingSha256);
  const expectedNearDuplicateKey = identitySha256({
    scopeSha256: reservation.scopeSha256,
    hypothesisDefinitionSha256: reservation.hypothesisDefinitionSha256,
    tableKey: reservation.tableKey,
    target: reservation.target,
    intentFeatures: reservation.intentFeatures,
  });
  if (expectedNearDuplicateKey !== reservation.nearDuplicateKey) fail('DB_PROGRESSIVE_RESERVATION_INVALID');
  return reservation;
}

function validateOutcome(outcome, state) {
  assertSealed(outcome, 'outcomeReceiptSha256', 'DB_PROGRESSIVE_OUTCOME_TAMPERED');
  const reservation = state.reservations.find(({reservationSha256}) => reservationSha256 === outcome.reservationSha256);
  const controllerReceipt = state.controllerRun.receipts.find(({receiptSha256}) => receiptSha256 === outcome.controllerReceiptSha256);
  if (!exactKeys(outcome, [
    'schemaVersion', 'runId', 'scopeSha256', 'reservationSha256', 'controllerProbeKey', 'controllerReceiptSha256',
    'hypothesisId', 'resultState', 'evidenceRefs', 'signal', 'informationGainBps', 'confidenceBounds', 'reasonCode',
    'blindRetryAllowed', 'outcomeReceiptSha256',
  ]) || outcome.schemaVersion !== PROGRESSIVE_OUTCOME_SCHEMA || !reservation
    || outcome.runId !== state.controllerRun.runId || outcome.scopeSha256 !== state.controllerRun.scopeSha256
    || outcome.controllerProbeKey !== reservation.controllerProbeKey || !sha256Value(outcome.controllerReceiptSha256)
    || outcome.hypothesisId !== reservation.hypothesisId
    || !OUTCOME_STATES.has(outcome.resultState) || !SIGNALS.has(outcome.signal)
    || !Number.isInteger(outcome.informationGainBps) || outcome.informationGainBps < 0 || outcome.informationGainBps > 10000
    || !REASON_CODE.test(outcome.reasonCode) || outcome.blindRetryAllowed !== false
    || !controllerReceipt || controllerReceipt.probeKey !== outcome.controllerProbeKey
    || controllerReceipt.resultState !== outcome.resultState
    || canonicalJson(controllerReceipt.evidenceRefs) !== canonicalJson(outcome.evidenceRefs)) {
    fail('DB_PROGRESSIVE_OUTCOME_INVALID');
  }
  sortedUniqueHashes(outcome.evidenceRefs, 'DB_PROGRESSIVE_OUTCOME_INVALID');
  confidenceBounds(outcome.confidenceBounds);
  validateSignal(outcome.resultState, outcome.signal, outcome.informationGainBps, outcome.evidenceRefs);
  return outcome;
}

function validateReconciliation(reconciliation, state) {
  assertSealed(reconciliation, 'reconciliationSha256', 'DB_PROGRESSIVE_RECONCILIATION_TAMPERED');
  const outcome = state.outcomes.find(({outcomeReceiptSha256}) => outcomeReceiptSha256 === reconciliation.outcomeReceiptSha256);
  if (!exactKeys(reconciliation, [
    'schemaVersion', 'runId', 'scopeSha256', 'outcomeReceiptSha256', 'originalControllerReceiptSha256',
    'reservationSha256', 'hypothesisId', 'resolvedState', 'reconciliationEvidenceRefs', 'signal',
    'informationGainBps', 'confidenceBounds', 'reasonCode', 'blindRetryAllowed', 'reconciliationSha256',
  ]) || reconciliation.schemaVersion !== PROGRESSIVE_RECONCILIATION_SCHEMA || outcome?.resultState !== 'UNKNOWN'
    || reconciliation.runId !== state.controllerRun.runId || reconciliation.scopeSha256 !== state.controllerRun.scopeSha256
    || reconciliation.originalControllerReceiptSha256 !== outcome.controllerReceiptSha256
    || reconciliation.reservationSha256 !== outcome.reservationSha256 || reconciliation.hypothesisId !== outcome.hypothesisId
    || !RESOLVED_STATES.has(reconciliation.resolvedState) || !SIGNALS.has(reconciliation.signal)
    || !Number.isInteger(reconciliation.informationGainBps) || reconciliation.informationGainBps < 0 || reconciliation.informationGainBps > 10000
    || !REASON_CODE.test(reconciliation.reasonCode) || reconciliation.blindRetryAllowed !== false) fail('DB_PROGRESSIVE_RECONCILIATION_INVALID');
  sortedUniqueHashes(reconciliation.reconciliationEvidenceRefs, 'DB_PROGRESSIVE_RECONCILIATION_INVALID');
  confidenceBounds(reconciliation.confidenceBounds);
  validateSignal(
    reconciliation.resolvedState,
    reconciliation.signal,
    reconciliation.informationGainBps,
    reconciliation.reconciliationEvidenceRefs,
  );
  return reconciliation;
}

function validateState(state) {
  assertSealed(state, 'stateSha256', 'DB_PROGRESSIVE_ANALYSIS_STATE_TAMPERED');
  if (!exactKeys(state, [
    'schemaVersion', 'controllerRun', 'binding', 'policy', 'budget', 'hypothesisLedger', 'reservations', 'outcomes',
    'reconciliations', 'safety', 'stateSha256',
  ]) || state.schemaVersion !== PROGRESSIVE_ANALYSIS_SCHEMA) fail('DB_PROGRESSIVE_ANALYSIS_STATE_INVALID');
  resumeProgressiveRun(state.controllerRun);
  if (!exactKeys(state.binding, ['runId', 'scopeSha256', 'coverageSha256', 'methodRegistrySha256'])
    || state.binding.runId !== state.controllerRun.runId || state.binding.scopeSha256 !== state.controllerRun.scopeSha256
    || state.binding.coverageSha256 !== state.controllerRun.coverage.coverageSha256
    || state.binding.methodRegistrySha256 !== state.controllerRun.methodRegistry.registrySha256) fail('DB_PROGRESSIVE_ANALYSIS_BINDING_INVALID');
  if (!exactKeys(state.policy, ['maxConsecutiveNoGain', 'maxConsecutiveCounterevidence', 'minExpectedGainBps'])
    || ![state.policy.maxConsecutiveNoGain, state.policy.maxConsecutiveCounterevidence].every((value) => Number.isInteger(value) && value >= 1)
    || !Number.isInteger(state.policy.minExpectedGainBps) || state.policy.minExpectedGainBps < 1 || state.policy.minExpectedGainBps > 10000) {
    fail('DB_PROGRESSIVE_POLICY_INVALID');
  }
  if (!exactKeys(state.budget, ['maxTableProbes', 'maxHypothesisProbes', 'tableReservationCounts', 'hypothesisReservationCounts'])
    || !Number.isInteger(state.budget.maxTableProbes) || state.budget.maxTableProbes < 1
    || !Number.isInteger(state.budget.maxHypothesisProbes) || state.budget.maxHypothesisProbes < 1) fail('DB_PROGRESSIVE_BUDGET_STATE_INVALID');
  if (!Array.isArray(state.reservations) || !Array.isArray(state.outcomes) || !Array.isArray(state.reconciliations)) fail('DB_PROGRESSIVE_ANALYSIS_STATE_INVALID');
  validateLedger(state.hypothesisLedger, state);
  state.reservations.forEach((entry) => validateReservation(entry, state));
  state.outcomes.forEach((entry) => validateOutcome(entry, state));
  state.reconciliations.forEach((entry) => validateReconciliation(entry, state));
  for (const hypothesis of state.hypothesisLedger.entries) {
    const outcomeEvents = state.outcomes.filter(({hypothesisId}) => hypothesisId === hypothesis.hypothesisId)
      .map((event) => ({
        sourceReceiptSha256: event.outcomeReceiptSha256,
        signal: event.signal,
        evidenceRefs: event.evidenceRefs,
        reasonCode: event.reasonCode,
      }));
    const reconciliationEvents = state.reconciliations.filter(({hypothesisId}) => hypothesisId === hypothesis.hypothesisId)
      .map((event) => ({
        sourceReceiptSha256: event.reconciliationSha256,
        signal: event.signal,
        evidenceRefs: event.reconciliationEvidenceRefs,
        reasonCode: event.reasonCode,
      }));
    const events = [...outcomeEvents, ...reconciliationEvents];
    const sourceReceiptRefs = events.map(({sourceReceiptSha256}) => sourceReceiptSha256).sort(compare);
    const supportingEvidenceRefs = [...new Set(events.filter(({signal}) => signal === 'SUPPORTS').flatMap(({evidenceRefs}) => evidenceRefs))].sort(compare);
    const counterevidenceRefs = [...new Set(events.filter(({signal}) => signal === 'COUNTERS').flatMap(({evidenceRefs}) => evidenceRefs))].sort(compare);
    const contradictions = events.filter(({signal}) => signal === 'COUNTERS')
      .map(({sourceReceiptSha256, reasonCode}) => ({sourceReceiptSha256, reasonCode}))
      .sort((left, right) => compare(left.sourceReceiptSha256, right.sourceReceiptSha256));
    if (canonicalJson(sourceReceiptRefs) !== canonicalJson(hypothesis.sourceReceiptRefs)
      || canonicalJson(supportingEvidenceRefs) !== canonicalJson(hypothesis.supportingEvidenceRefs)
      || canonicalJson(counterevidenceRefs) !== canonicalJson(hypothesis.counterevidenceRefs)
      || canonicalJson(contradictions) !== canonicalJson(hypothesis.contradictions)) {
      fail('DB_PROGRESSIVE_HYPOTHESIS_LEDGER_INCONSISTENT');
    }
  }
  if (new Set(state.reservations.map(({reservationSha256}) => reservationSha256)).size !== state.reservations.length
    || new Set(state.outcomes.map(({reservationSha256}) => reservationSha256)).size !== state.outcomes.length
    || new Set(state.reconciliations.map(({outcomeReceiptSha256}) => outcomeReceiptSha256)).size !== state.reconciliations.length
    || canonicalJson(counts(state.reservations, 'tableKey')) !== canonicalJson(state.budget.tableReservationCounts)
    || canonicalJson(counts(state.reservations, 'hypothesisId')) !== canonicalJson(state.budget.hypothesisReservationCounts)
    || state.budget.tableReservationCounts.some(({count}) => count > state.budget.maxTableProbes)
    || state.budget.hypothesisReservationCounts.some(({count}) => count > state.budget.maxHypothesisProbes)) {
    fail('DB_PROGRESSIVE_BUDGET_STATE_INVALID');
  }
  if (!exactKeys(state.safety, [
    'reservationBeforeDispatch', 'compareAndSwapRequired', 'allowlistedMethodsOnly', 'typedParametersOnly',
    'freeSqlAccepted', 'rawValuesPersisted', 'credentialsPersisted', 'blindRetryAllowed', 'automaticBusinessTruth',
  ]) || state.safety.reservationBeforeDispatch !== true || state.safety.compareAndSwapRequired !== true
    || state.safety.allowlistedMethodsOnly !== true || state.safety.typedParametersOnly !== true
    || state.safety.freeSqlAccepted !== false || state.safety.rawValuesPersisted !== false
    || state.safety.credentialsPersisted !== false || state.safety.blindRetryAllowed !== false
    || state.safety.automaticBusinessTruth !== false) fail('DB_PROGRESSIVE_SAFETY_INVALID');
  return state;
}

export function createProgressiveAnalysis({controllerRun, budgets, policy}) {
  resumeProgressiveRun(controllerRun);
  if (!exactKeys(budgets, ['maxTableProbes', 'maxHypothesisProbes'])
    || !Number.isInteger(budgets.maxTableProbes) || budgets.maxTableProbes < 1
    || !Number.isInteger(budgets.maxHypothesisProbes) || budgets.maxHypothesisProbes < 1
    || budgets.maxTableProbes > controllerRun.budget.maxRunProbes
    || budgets.maxHypothesisProbes > controllerRun.budget.maxRunProbes) fail('DB_PROGRESSIVE_BUDGET_INVALID');
  if (!exactKeys(policy, ['maxConsecutiveNoGain', 'maxConsecutiveCounterevidence', 'minExpectedGainBps'])
    || ![policy.maxConsecutiveNoGain, policy.maxConsecutiveCounterevidence].every((value) => Number.isInteger(value) && value >= 1)
    || !Number.isInteger(policy.minExpectedGainBps) || policy.minExpectedGainBps < 1 || policy.minExpectedGainBps > 10000) {
    fail('DB_PROGRESSIVE_POLICY_INVALID');
  }
  return seal({
    schemaVersion: PROGRESSIVE_ANALYSIS_SCHEMA,
    controllerRun,
    binding: {
      runId: controllerRun.runId,
      scopeSha256: controllerRun.scopeSha256,
      coverageSha256: controllerRun.coverage.coverageSha256,
      methodRegistrySha256: controllerRun.methodRegistry.registrySha256,
    },
    policy,
    budget: {...budgets, tableReservationCounts: [], hypothesisReservationCounts: []},
    hypothesisLedger: sealLedger([]),
    reservations: [],
    outcomes: [],
    reconciliations: [],
    safety: {
      reservationBeforeDispatch: true,
      compareAndSwapRequired: true,
      allowlistedMethodsOnly: true,
      typedParametersOnly: true,
      freeSqlAccepted: false,
      rawValuesPersisted: false,
      credentialsPersisted: false,
      blindRetryAllowed: false,
      automaticBusinessTruth: false,
    },
  }, 'stateSha256');
}

export function registerProgressiveHypothesis(state, {
  hypothesisId, hypothesisKind, target, confidenceBounds: bounds, sourceEvidenceRefs,
}) {
  validateState(state);
  if (!ID.test(hypothesisId) || !HYPOTHESIS_KINDS.has(hypothesisKind)
    || state.hypothesisLedger.entries.some((entry) => entry.hypothesisId === hypothesisId)) fail('DB_PROGRESSIVE_HYPOTHESIS_INVALID');
  const normalizedTarget = normalizeTableTarget(target, state.controllerRun);
  const normalizedBounds = confidenceBounds(bounds);
  const normalizedSources = sortedUniqueHashes(sourceEvidenceRefs, 'DB_PROGRESSIVE_HYPOTHESIS_INVALID');
  if (normalizedSources.length === 0) fail('DB_PROGRESSIVE_HYPOTHESIS_INVALID');
  const tableKey = identitySha256(normalizedTarget);
  const definition = {
    schemaVersion: PROGRESSIVE_HYPOTHESIS_SCHEMA,
    hypothesisId,
    hypothesisKind,
    target: normalizedTarget,
    tableKey,
    initialConfidenceBounds: normalizedBounds,
    sourceEvidenceRefs: normalizedSources,
    automaticBusinessTruth: false,
  };
  const entry = sealHypothesis({
    schemaVersion: PROGRESSIVE_HYPOTHESIS_SCHEMA,
    hypothesisId,
    hypothesisKind,
    target: normalizedTarget,
    tableKey,
    definitionSha256: identitySha256(definition),
    status: 'OPEN',
    initialConfidenceBounds: normalizedBounds,
    confidenceBounds: normalizedBounds,
    sourceEvidenceRefs: normalizedSources,
    supportingEvidenceRefs: [],
    counterevidenceRefs: [],
    sourceReceiptRefs: [],
    contradictions: [],
    consecutiveNoGain: 0,
    consecutiveCounterevidence: 0,
    terminalReason: null,
    automaticBusinessTruth: false,
  });
  return replaceState(state, {hypothesisLedger: sealLedger([...state.hypothesisLedger.entries, entry])});
}

export function buildProgressiveProbeCandidate(state, {
  hypothesisId, phase, methodRef, target, arguments: args, intentFeatures, gainInputs,
}) {
  validateState(state);
  const hypothesis = state.hypothesisLedger.entries.find((entry) => entry.hypothesisId === hypothesisId);
  if (!hypothesis) fail('DB_PROGRESSIVE_HYPOTHESIS_UNKNOWN');
  validateDispatchShape(state, {phase, methodRef, target, arguments: args});
  const normalizedIntent = validateIntentFeatures(intentFeatures);
  const normalizedTarget = normalizeJsonValue(target);
  const normalizedArguments = normalizeJsonValue(args);
  const candidateTable = tableTargetForProbe(normalizedTarget);
  if (identitySha256(candidateTable) !== hypothesis.tableKey) fail('DB_PROGRESSIVE_CANDIDATE_BINDING_INVALID');
  const base = normalizeJsonValue({
    schemaVersion: PROGRESSIVE_CANDIDATE_SCHEMA,
    runId: state.controllerRun.runId,
    scopeSha256: state.controllerRun.scopeSha256,
    coverageSha256: state.controllerRun.coverage.coverageSha256,
    methodRegistrySha256: state.controllerRun.methodRegistry.registrySha256,
    hypothesisId,
    hypothesisDefinitionSha256: hypothesis.definitionSha256,
    tableKey: hypothesis.tableKey,
    phase,
    methodRef,
    target: normalizedTarget,
    arguments: normalizedArguments,
    intentFeatures: normalizedIntent,
  });
  const gainBindingSha256 = identitySha256({
    runId: base.runId,
    scopeSha256: base.scopeSha256,
    hypothesisDefinitionSha256: base.hypothesisDefinitionSha256,
    phase: base.phase,
    methodRef: base.methodRef,
    target: base.target,
    arguments: base.arguments,
    intentFeatures: base.intentFeatures,
  });
  const nearDuplicateKey = identitySha256({
    scopeSha256: base.scopeSha256,
    hypothesisDefinitionSha256: base.hypothesisDefinitionSha256,
    tableKey: base.tableKey,
    target: base.target,
    intentFeatures: base.intentFeatures,
  });
  return seal({...base, nearDuplicateKey, gainBindingSha256, expectedGain: expectedGain(gainInputs, gainBindingSha256)}, 'candidateSha256');
}

export function rankProgressiveProbeCandidates(state, candidates) {
  validateState(state);
  if (!Array.isArray(candidates)) fail('DB_PROGRESSIVE_CANDIDATE_INVALID');
  candidates.forEach((candidate) => validateCandidate(candidate, state));
  if (new Set(candidates.map(({candidateSha256}) => candidateSha256)).size !== candidates.length) fail('DB_PROGRESSIVE_CANDIDATE_DUPLICATE');
  return [...candidates].sort((left, right) => right.expectedGain.expectedInformationGainBps - left.expectedGain.expectedInformationGainBps
    || compare(left.candidateSha256, right.candidateSha256));
}

function dispositionForExisting(state, reservation) {
  const outcome = state.outcomes.find((entry) => entry.reservationSha256 === reservation.reservationSha256);
  if (!outcome) return 'SUPPRESSED_RESERVED';
  if (outcome.resultState === 'UNKNOWN') {
    const reconciliation = state.reconciliations.find((entry) => entry.outcomeReceiptSha256 === outcome.outcomeReceiptSha256);
    if (!reconciliation) return 'SUPPRESSED_UNKNOWN_OUTCOME';
    return reconciliation.resolvedState === 'SUCCEEDED' ? 'REUSED_RECONCILED_SUCCESS' : 'SUPPRESSED_RECONCILED_OUTCOME';
  }
  return outcome.resultState === 'SUCCEEDED' ? 'REUSED_SUCCESS' : 'SUPPRESSED_TERMINAL_OUTCOME';
}

export function reserveProgressiveProbeCandidate(state, candidate, {expectedStateSha256}) {
  validateState(state);
  if (!sha256Value(expectedStateSha256) || expectedStateSha256 !== state.stateSha256) fail('DB_PROGRESSIVE_STALE_RESERVATION');
  validateCandidate(candidate, state);
  const hypothesis = state.hypothesisLedger.entries.find(({hypothesisId}) => hypothesisId === candidate.hypothesisId);
  const existing = state.reservations.find(({candidateSha256}) => candidateSha256 === candidate.candidateSha256);
  if (existing) return {state, authorization: normalizeJsonValue({
    disposition: dispositionForExisting(state, existing), candidateSha256: candidate.candidateSha256,
    reservationSha256: existing.reservationSha256, controllerProbeKey: existing.controllerProbeKey,
  })};
  if (hypothesis.status === 'STOPPED' || hypothesis.status === 'AWAITING_RECONCILIATION') fail('DB_PROGRESSIVE_HYPOTHESIS_STOPPED');
  const near = state.reservations.find(({nearDuplicateKey}) => nearDuplicateKey === candidate.nearDuplicateKey);
  if (near) return {state, authorization: normalizeJsonValue({
    disposition: 'SUPPRESSED_NEAR_DUPLICATE', candidateSha256: candidate.candidateSha256,
    reservationSha256: near.reservationSha256, controllerProbeKey: near.controllerProbeKey,
  })};
  if (candidate.expectedGain.expectedInformationGainBps < state.policy.minExpectedGainBps) fail('DB_PROGRESSIVE_EXPECTED_GAIN_TOO_LOW');
  const tableCount = state.budget.tableReservationCounts.find(({tableKey}) => tableKey === candidate.tableKey)?.count ?? 0;
  const hypothesisCount = state.budget.hypothesisReservationCounts.find(({hypothesisId}) => hypothesisId === candidate.hypothesisId)?.count ?? 0;
  if (tableCount >= state.budget.maxTableProbes) fail('DB_PROGRESSIVE_TABLE_BUDGET_EXCEEDED');
  if (hypothesisCount >= state.budget.maxHypothesisProbes) fail('DB_PROGRESSIVE_HYPOTHESIS_BUDGET_EXCEEDED');
  const controllerAuthorization = authorizeProgressiveProbe(state.controllerRun, {
    phase: candidate.phase, methodRef: candidate.methodRef, target: candidate.target, arguments: candidate.arguments,
  });
  if (controllerAuthorization.authorization.disposition !== 'AUTHORIZED') return {state, authorization: normalizeJsonValue({
    disposition: `CONTROLLER_${controllerAuthorization.authorization.disposition}`,
    candidateSha256: candidate.candidateSha256,
    reservationSha256: null,
    controllerProbeKey: controllerAuthorization.authorization.probeKey,
  })};
  const reservation = seal({
    schemaVersion: PROGRESSIVE_RESERVATION_SCHEMA,
    runId: state.controllerRun.runId,
    scopeSha256: state.controllerRun.scopeSha256,
    candidateSha256: candidate.candidateSha256,
    nearDuplicateKey: candidate.nearDuplicateKey,
    controllerProbeKey: controllerAuthorization.authorization.probeKey,
    hypothesisId: candidate.hypothesisId,
    hypothesisDefinitionSha256: candidate.hypothesisDefinitionSha256,
    tableKey: candidate.tableKey,
    methodRef: candidate.methodRef,
    phase: candidate.phase,
    target: candidate.target,
    intentFeatures: candidate.intentFeatures,
    gainBindingSha256: candidate.gainBindingSha256,
    expectedGain: candidate.expectedGain,
    reservationDebit: 1,
    dispatched: false,
  }, 'reservationSha256');
  const reservations = [...state.reservations, reservation].sort((left, right) => compare(left.reservationSha256, right.reservationSha256));
  const nextState = replaceState(state, {
    controllerRun: controllerAuthorization.state,
    reservations,
    budget: {
      ...state.budget,
      tableReservationCounts: counts(reservations, 'tableKey'),
      hypothesisReservationCounts: counts(reservations, 'hypothesisId'),
    },
  });
  return {state: nextState, authorization: normalizeJsonValue({
    disposition: 'RESERVED', candidateSha256: candidate.candidateSha256,
    reservationSha256: reservation.reservationSha256, controllerProbeKey: reservation.controllerProbeKey,
  })};
}

function validateSignal(resultState, signal, informationGainBps, evidenceRefs) {
  if (!OUTCOME_STATES.has(resultState) || !SIGNALS.has(signal)
    || !Number.isInteger(informationGainBps) || informationGainBps < 0 || informationGainBps > 10000) {
    fail('DB_PROGRESSIVE_OUTCOME_INVALID');
  }
  if (['UNKNOWN', 'TIMEOUT', 'CANCELLED', 'DENIED', 'UNSUPPORTED'].includes(resultState)
    && (signal !== 'UNKNOWN' || informationGainBps !== 0)) fail('DB_PROGRESSIVE_OUTCOME_SIGNAL_INVALID');
  if (['SUCCEEDED', 'PARTIAL'].includes(resultState) && signal === 'UNKNOWN') fail('DB_PROGRESSIVE_OUTCOME_SIGNAL_INVALID');
  if (signal === 'NO_GAIN' && informationGainBps !== 0) fail('DB_PROGRESSIVE_OUTCOME_SIGNAL_INVALID');
  if (['SUCCEEDED', 'PARTIAL'].includes(resultState) && evidenceRefs.length === 0) fail('DB_PROGRESSIVE_OUTCOME_EVIDENCE_REQUIRED');
}

function updateHypothesis(entry, event, policy) {
  const evidenceRefs = event.evidenceRefs ?? event.reconciliationEvidenceRefs;
  let status = 'OPEN';
  let terminalReason = null;
  let consecutiveNoGain = 0;
  let consecutiveCounterevidence = 0;
  let supportingEvidenceRefs = entry.supportingEvidenceRefs;
  let counterevidenceRefs = entry.counterevidenceRefs;
  let contradictions = entry.contradictions;
  if (['UNKNOWN', 'TIMEOUT', 'CANCELLED', 'DENIED', 'UNSUPPORTED'].includes(event.resultState ?? event.resolvedState)) {
    status = (event.resultState ?? event.resolvedState) === 'UNKNOWN' ? 'AWAITING_RECONCILIATION' : 'STOPPED';
    terminalReason = (event.resultState ?? event.resolvedState) === 'UNKNOWN' ? 'UNKNOWN_OUTCOME' : (event.resultState ?? event.resolvedState);
  } else if (event.signal === 'SUPPORTS') {
    status = 'SUPPORTED_CANDIDATE';
    supportingEvidenceRefs = [...new Set([...supportingEvidenceRefs, ...evidenceRefs])].sort(compare);
  } else if (event.signal === 'COUNTERS') {
    consecutiveCounterevidence = entry.consecutiveCounterevidence + 1;
    counterevidenceRefs = [...new Set([...counterevidenceRefs, ...evidenceRefs])].sort(compare);
    contradictions = [...entry.contradictions, {sourceReceiptSha256: event.sourceReceiptSha256, reasonCode: event.reasonCode}]
      .sort((left, right) => compare(left.sourceReceiptSha256, right.sourceReceiptSha256));
    if (consecutiveCounterevidence >= policy.maxConsecutiveCounterevidence) {
      status = 'STOPPED';
      terminalReason = 'REPEATED_COUNTEREVIDENCE';
    } else status = 'COUNTEREVIDENCE_CANDIDATE';
  } else if (event.signal === 'NO_GAIN') {
    consecutiveNoGain = entry.consecutiveNoGain + 1;
    if (consecutiveNoGain >= policy.maxConsecutiveNoGain) {
      status = 'STOPPED';
      terminalReason = 'NO_GAIN_LIMIT';
    }
  }
  const {hypothesisSha256: _previousHypothesisHash, ...entryBody} = entry;
  return sealHypothesis({
    ...entryBody,
    status,
    confidenceBounds: event.confidenceBounds,
    supportingEvidenceRefs,
    counterevidenceRefs,
    sourceReceiptRefs: [...new Set([...entry.sourceReceiptRefs, event.sourceReceiptSha256])].sort(compare),
    contradictions,
    consecutiveNoGain,
    consecutiveCounterevidence,
    terminalReason,
  });
}

function replaceHypothesis(state, hypothesis) {
  return sealLedger(state.hypothesisLedger.entries.map((entry) => entry.hypothesisId === hypothesis.hypothesisId ? hypothesis : entry));
}

export function recordProgressiveProbeOutcome(state, input) {
  validateState(state);
  if (!exactKeys(input, [
    'reservationSha256', 'resultState', 'evidenceRefs', 'signal', 'informationGainBps', 'confidenceBounds', 'reasonCode',
  ]) || !sha256Value(input.reservationSha256) || !REASON_CODE.test(input.reasonCode)) fail('DB_PROGRESSIVE_OUTCOME_INVALID');
  const evidenceRefs = sortedUniqueHashes(input.evidenceRefs, 'DB_PROGRESSIVE_OUTCOME_INVALID');
  const bounds = confidenceBounds(input.confidenceBounds);
  validateSignal(input.resultState, input.signal, input.informationGainBps, evidenceRefs);
  const reservation = state.reservations.find(({reservationSha256}) => reservationSha256 === input.reservationSha256);
  if (!reservation || state.outcomes.some(({reservationSha256}) => reservationSha256 === input.reservationSha256)) {
    fail('DB_PROGRESSIVE_OUTCOME_DUPLICATE_OR_UNKNOWN');
  }
  const controllerRun = recordProgressiveReceipt(state.controllerRun, {
    probeKey: reservation.controllerProbeKey,
    resultState: input.resultState,
    evidenceRefs,
  });
  const controllerReceipt = controllerRun.receipts.find(({probeKey}) => probeKey === reservation.controllerProbeKey);
  const outcome = seal({
    schemaVersion: PROGRESSIVE_OUTCOME_SCHEMA,
    runId: state.controllerRun.runId,
    scopeSha256: state.controllerRun.scopeSha256,
    reservationSha256: reservation.reservationSha256,
    controllerProbeKey: reservation.controllerProbeKey,
    controllerReceiptSha256: controllerReceipt.receiptSha256,
    hypothesisId: reservation.hypothesisId,
    resultState: input.resultState,
    evidenceRefs,
    signal: input.signal,
    informationGainBps: input.informationGainBps,
    confidenceBounds: bounds,
    reasonCode: input.reasonCode,
    blindRetryAllowed: false,
  }, 'outcomeReceiptSha256');
  const hypothesis = state.hypothesisLedger.entries.find(({hypothesisId}) => hypothesisId === reservation.hypothesisId);
  const updated = updateHypothesis(hypothesis, {...outcome, sourceReceiptSha256: outcome.outcomeReceiptSha256}, state.policy);
  return replaceState(state, {
    controllerRun,
    outcomes: [...state.outcomes, outcome].sort((left, right) => compare(left.outcomeReceiptSha256, right.outcomeReceiptSha256)),
    hypothesisLedger: replaceHypothesis(state, updated),
  });
}

export function reconcileProgressiveUnknownOutcome(state, input) {
  validateState(state);
  if (!exactKeys(input, [
    'outcomeReceiptSha256', 'resolvedState', 'reconciliationEvidenceRefs', 'signal', 'informationGainBps',
    'confidenceBounds', 'reasonCode',
  ]) || !sha256Value(input.outcomeReceiptSha256) || !RESOLVED_STATES.has(input.resolvedState)
    || !REASON_CODE.test(input.reasonCode)) fail('DB_PROGRESSIVE_RECONCILIATION_INVALID');
  const outcome = state.outcomes.find(({outcomeReceiptSha256}) => outcomeReceiptSha256 === input.outcomeReceiptSha256);
  if (outcome?.resultState !== 'UNKNOWN' || state.reconciliations.some(({outcomeReceiptSha256}) => outcomeReceiptSha256 === input.outcomeReceiptSha256)) {
    fail('DB_PROGRESSIVE_RECONCILIATION_DUPLICATE_OR_UNKNOWN');
  }
  const evidenceRefs = sortedUniqueHashes(input.reconciliationEvidenceRefs, 'DB_PROGRESSIVE_RECONCILIATION_INVALID');
  const bounds = confidenceBounds(input.confidenceBounds);
  validateSignal(input.resolvedState, input.signal, input.informationGainBps, evidenceRefs);
  const reconciliation = seal({
    schemaVersion: PROGRESSIVE_RECONCILIATION_SCHEMA,
    runId: state.controllerRun.runId,
    scopeSha256: state.controllerRun.scopeSha256,
    outcomeReceiptSha256: outcome.outcomeReceiptSha256,
    originalControllerReceiptSha256: outcome.controllerReceiptSha256,
    reservationSha256: outcome.reservationSha256,
    hypothesisId: outcome.hypothesisId,
    resolvedState: input.resolvedState,
    reconciliationEvidenceRefs: evidenceRefs,
    signal: input.signal,
    informationGainBps: input.informationGainBps,
    confidenceBounds: bounds,
    reasonCode: input.reasonCode,
    blindRetryAllowed: false,
  }, 'reconciliationSha256');
  const hypothesis = state.hypothesisLedger.entries.find(({hypothesisId}) => hypothesisId === outcome.hypothesisId);
  const updated = updateHypothesis(hypothesis, {
    ...reconciliation,
    sourceReceiptSha256: reconciliation.reconciliationSha256,
    resultState: reconciliation.resolvedState,
  }, state.policy);
  return replaceState(state, {
    reconciliations: [...state.reconciliations, reconciliation].sort((left, right) => compare(left.reconciliationSha256, right.reconciliationSha256)),
    hypothesisLedger: replaceHypothesis(state, updated),
  });
}

export function advanceProgressiveAnalysisPhase(state, nextPhase) {
  validateState(state);
  return replaceState(state, {controllerRun: advanceProgressivePhase(state.controllerRun, nextPhase)});
}

export function resumeProgressiveAnalysis(snapshot) {
  const state = normalizeJsonValue(snapshot);
  validateState(state);
  return state;
}

export function buildProgressiveAnalysisReport(state) {
  validateState(state);
  const controllerReport = buildProgressiveReport(state.controllerRun);
  return seal({
    schemaVersion: PROGRESSIVE_ANALYSIS_REPORT_SCHEMA,
    runId: state.controllerRun.runId,
    engine: state.controllerRun.engine,
    controllerEvidenceSha256: controllerReport.controllerEvidenceSha256,
    binding: state.binding,
    policy: state.policy,
    budget: {
      maxRunProbes: state.controllerRun.budget.maxRunProbes,
      reservedRunProbes: state.controllerRun.budget.authorizedProbeCount,
      maxObjectProbes: state.controllerRun.budget.maxObjectProbes,
      objectReservationCounts: state.controllerRun.budget.objectProbeCounts,
      maxTableProbes: state.budget.maxTableProbes,
      tableReservationCounts: state.budget.tableReservationCounts,
      maxHypothesisProbes: state.budget.maxHypothesisProbes,
      hypothesisReservationCounts: state.budget.hypothesisReservationCounts,
      debitsRefunded: 0,
    },
    hypothesisLedger: state.hypothesisLedger,
    reservations: state.reservations,
    outcomes: state.outcomes,
    reconciliations: state.reconciliations,
    safety: state.safety,
    disclosure: {rawValuesPersisted: false, credentialsPersisted: false, freeSqlAccepted: false},
    authority: {readOnlyEvidenceOnly: true, automaticBusinessTruth: false, executionAuthority: 'ALLOWLISTED_METHODS_ONLY'},
    nonClaims: [
      'NO_FREE_MODEL_SQL',
      'NO_RAW_ROW_TRANSFER',
      'NO_AUTOMATIC_BUSINESS_TRUTH',
      'NO_PRODUCTION_OR_CUSTOMER_DATABASE_ACCESS',
      'NO_DEPLOYMENT_OR_RUNTIME_ACTIVATION',
      'NO_INFERRED_FOREIGN_KEY_TRUTH',
      'NO_UNIVERSAL_COMPLETENESS',
      'NO_OPTIMAL_INFORMATION_THEORY_CLAIM',
      'NO_UNPROVEN_PERFORMANCE_CLAIM',
    ],
  }, 'analysisEvidenceSha256');
}
