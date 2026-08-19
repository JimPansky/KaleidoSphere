import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {
  SBA_INTENT_RESULT_SCHEMA,
  capabilityAttestationV2,
  executeExternalIntentV2,
  sha256Digest,
} from '../services/bi-agent/src/external-api-v2.mjs';
import {
  EXTERNAL_INTENT_CAPABILITY_MAP,
  EXTERNAL_INTENT_EVIDENCE_BRIDGE_VERSION,
  ExternalIntentEvidenceBridge,
  buildExternalIntentEvidence,
} from '../services/bi-agent/src/external-intent-evidence-bridge.mjs';
import {assertEventEnvelope, sha256Digest as evidenceDigest} from '../services/bi-control/src/assistant-foundation/core-contracts.mjs';

const fixture = JSON.parse(await readFile('tests/fixtures/external-intent-evidence-bridge-v1.json', 'utf8'));

function handlers() {
  return {
    async status() { return {status: 'READY', engine: 'mssql', catalogReady: true}; },
    async discovery(input) { return {schemaVersion: 'chimpmaera.bi/discovery-session/v1', state: 'READY', command: input.command}; },
    async analyze() { return {receiptId: 'mssql-abc', status: 'ANALYZED_READ_ONLY', sourceMode: 'fixture', engine: 'mssql', scope: {database: 'fixture'}, safety: {sourceReadOnly: true, queryPackSelectOnly: true}, analysis: {runtimeValidation: 'SYNTHETIC_UNVALIDATED', snapshotSha256: 'a'.repeat(64)}, projection: {sha256: 'b'.repeat(64)}}; },
    async plan() { return {schemaVersion: 'superset-bi-agent.external/plan/v2', graph: {acceptedIncumbent: 'adaptive-v1'}, proposalOnly: true}; },
    async preview() { return {schemaVersion: 'superset-bi-agent.external/preview/v2', proposalOnly: true, receiptId: 'mssql-abc'}; },
    async readback() { return {receiptId: 'mssql-abc', summary: {source_engine: 'mssql', source_mode: 'fixture', status: 'ANALYZED_READ_ONLY', snapshot_sha256: 'a'.repeat(64), source_read_only: 1}, catalogSnapshot: {receipt_id: 'mssql-abc'}, technicalOverview: {coverageCount: 2}}; },
  };
}

const contextFor = (request, index = 0) => ({
  ...fixture.context,
  eventId: `event-${request.action}-${index}`,
  correlationId: request.requestId,
  seq: index + 1,
  idempotencyKey: `fixture-${request.action}`,
});

async function successfulInput(request, index = 0) {
  return {
    request,
    response: await executeExternalIntentV2(request, handlers()),
    attestation: capabilityAttestationV2(),
    context: contextFor(request, index),
  };
}

test('K1 maps all six closed intents to exact existing capabilities and valid M6-00 receipts/events', async () => {
  assert.deepEqual(Object.keys(EXTERNAL_INTENT_CAPABILITY_MAP), ['status', 'discovery', 'analyze', 'plan', 'preview', 'readback']);
  for (const [index, request] of fixture.requests.entries()) {
    const evidence = buildExternalIntentEvidence(await successfulInput(request, index));
    assert.equal(evidence.event.payload.bridgeSchemaVersion, EXTERNAL_INTENT_EVIDENCE_BRIDGE_VERSION);
    assert.equal(evidence.receipt.capabilityId, EXTERNAL_INTENT_CAPABILITY_MAP[request.action].capabilityId);
    assert.equal(evidence.event.payload.authority, EXTERNAL_INTENT_CAPABILITY_MAP[request.action].authority);
    assert.equal(evidence.receipt.status, 'succeeded');
    assert.equal(assertEventEnvelope(structuredClone(evidence.event)).eventId, evidence.event.eventId);
    assert.equal(evidence.event.payload.resultIntegrityDigest, (await successfulInput(request, index)).response.integrity.digest);
  }
});

test('K1 builder is byte-deterministic and stores only verified identifiers, digests and the M6 receipt', async () => {
  const input = await successfulInput(fixture.requests[2], 2);
  const left = buildExternalIntentEvidence(input);
  const right = buildExternalIntentEvidence(structuredClone(input));
  assert.deepEqual(left, right);
  assert.equal(left.evidenceDigest, evidenceDigest({event: left.event, receipt: left.receipt}));
  const serialized = JSON.stringify(left);
  assert.doesNotMatch(serialized, /catalogSnapshot|technicalOverview|objective|sourceMode|runtimeValidation/);
});

test('K1 stateful consumer rejects a replay without changing the deterministic pure mapping', async () => {
  const bridge = new ExternalIntentEvidenceBridge();
  const input = await successfulInput(fixture.requests[0]);
  bridge.consume(input);
  assert.throws(() => bridge.consume(structuredClone(input)), /EVIDENCE_BRIDGE_REPLAY_DENIED/);
});

test('K1 represents bounded timeout, cancellation and discovery outcome-unknown without blind retry', () => {
  const attestation = capabilityAttestationV2();
  const cases = [
    {request: fixture.requests[0], terminal: {status: 'failed', code: 'TIMEOUT_BEFORE_DISPATCH'}},
    {request: fixture.requests[4], terminal: {status: 'cancelled', code: 'CANCELLED_BEFORE_DISPATCH'}},
    {request: fixture.requests[1], terminal: {status: 'outcome_unknown', code: 'DISCOVERY_OUTCOME_UNKNOWN'}},
  ];
  for (const [index, item] of cases.entries()) {
    const evidence = buildExternalIntentEvidence({...item, attestation, context: contextFor(item.request, index)});
    assert.equal(evidence.receipt.status, item.terminal.status);
    assert.equal(evidence.event.payload.resultIntegrityDigest, null);
    if (item.terminal.status === 'outcome_unknown') {
      assert.equal(evidence.receipt.rollback.automaticRetry, false);
      assert.equal(evidence.receipt.retryAllowed, false);
    }
  }
});

function reseal(response) {
  const body = Object.fromEntries(Object.entries(response).filter(([key]) => key !== 'integrity'));
  response.integrity = {algorithm: 'sha256-canonical-json', digest: sha256Digest(body)};
  return response;
}

test('K1 fails closed on attestation, result, request/action/correlation and unsafe-result drift', async () => {
  const baseline = await successfulInput(fixture.requests[0]);
  const cases = [];

  const attestationTamper = structuredClone(baseline);
  attestationTamper.attestation.product.version = 'v999.0.0';
  cases.push([attestationTamper, /EVIDENCE_BRIDGE_PRODUCT_IDENTITY_DENIED|EVIDENCE_BRIDGE_ATTESTATION_TAMPERED/]);

  const resultTamper = structuredClone(baseline);
  resultTamper.response.result.status = 'TAMPERED';
  cases.push([resultTamper, /EVIDENCE_BRIDGE_RESULT_TAMPERED/]);

  const actionMismatch = structuredClone(baseline);
  actionMismatch.response.action = 'readback';
  cases.push([actionMismatch, /EVIDENCE_BRIDGE_RESULT_CORRELATION_DENIED/]);

  const correlationMismatch = structuredClone(baseline);
  correlationMismatch.context.correlationId = 'different-request';
  cases.push([correlationMismatch, /EVIDENCE_BRIDGE_CORRELATION_DENIED/]);

  const unsafe = structuredClone(baseline);
  unsafe.response.result.rawRows = [{password: 'must-not-cross'}];
  reseal(unsafe.response);
  cases.push([unsafe, /EVIDENCE_BRIDGE_UNSAFE_RESULT_DENIED/]);

  const forgedContract = structuredClone(baseline);
  forgedContract.response.runtime.contract.version = '9.0.0';
  reseal(forgedContract.response);
  cases.push([forgedContract, /EVIDENCE_BRIDGE_RUNTIME_IDENTITY_DENIED/]);

  for (const [input, expected] of cases) assert.throws(() => buildExternalIntentEvidence(input), expected);
});

test('K1 denies unsupported actions, successful mappings without a verified result, and outcome-unknown for non-discovery intents', () => {
  const attestation = capabilityAttestationV2();
  const unknown = {...fixture.requests[0], action: 'trusted-apply'};
  assert.throws(() => buildExternalIntentEvidence({request: unknown, attestation, context: contextFor(unknown)}), /EXTERNAL_BI_ACTION_DENIED/);
  assert.throws(() => buildExternalIntentEvidence({request: fixture.requests[0], attestation, context: contextFor(fixture.requests[0])}), /EVIDENCE_BRIDGE_RESULT_PRESENCE_DENIED/);
  assert.throws(() => buildExternalIntentEvidence({request: fixture.requests[0], attestation, terminal: {status: 'outcome_unknown', code: 'DISCOVERY_OUTCOME_UNKNOWN'}, context: contextFor(fixture.requests[0])}), /EVIDENCE_BRIDGE_OUTCOME_UNKNOWN_SCOPE_DENIED/);
});

test('K1 fixture and generated result stay on the exact v2 wire contract', async () => {
  for (const request of fixture.requests) {
    const result = await executeExternalIntentV2(request, handlers());
    assert.equal(result.schemaVersion, SBA_INTENT_RESULT_SCHEMA);
    assert.equal(result.requestId, request.requestId);
  }
});
