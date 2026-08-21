import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  EXTERNAL_API_V2_RUNTIME_INTENTS,
  validatePortableUtilityRequestV1,
} from '../services/bi-control/src/portable-companion/contract.mjs';
import {
  PORTABLE_RECEIPT_ENVELOPE_SCHEMA,
  PORTABLE_RECEIPT_MAX_BYTES,
  PORTABLE_RECEIPT_VERIFICATION_SCHEMA,
  portableReceiptExpectedBindingsV1,
  portableReceiptVerificationRequest,
  validatePortableReceiptVerificationReport,
  validatePortableReceiptVerificationRequest,
  verifyPortableReceiptEnvelope,
} from '../services/bi-control/src/portable-companion/receipt-verifier.mjs';

const VALID_NOW = '2026-08-21T20:05:00.000Z';

async function fixture(name) {
  return JSON.parse(await readFile(`services/bi-control/fixtures/portable-companion/${name}.json`, 'utf8'));
}

async function validPair() {
  return {
    envelope: await fixture('receipt-valid-synthetic'),
    context: await fixture('receipt-synthetic-context'),
  };
}

async function verify(envelope, context, now = VALID_NOW) {
  return verifyPortableReceiptEnvelope(envelope, context, { now });
}

test('K4e.4 verifies a deterministic signed synthetic envelope as integrity only', async () => {
  const { envelope, context } = await validPair();
  const report = validatePortableReceiptVerificationReport(await verify(envelope, context));

  assert.equal(envelope.schemaVersion, PORTABLE_RECEIPT_ENVELOPE_SCHEMA);
  assert.equal(report.schemaVersion, PORTABLE_RECEIPT_VERIFICATION_SCHEMA);
  assert.equal(report.verification.status, 'VERIFIED_INTEGRITY_ONLY');
  assert.equal(report.verification.trustClass, 'synthetic-fixture-only');
  assert.equal(report.verification.checks.length, 9);
  assert.deepEqual(report.externalApiV2.runtimeIntents, EXTERNAL_API_V2_RUNTIME_INTENTS);
  assert.equal(report.externalApiV2.boundRuntimeIntent, 'readback');
  assert.equal(report.externalApiV2.dispatch, false);
  assert.deepEqual(envelope.bindings, portableReceiptExpectedBindingsV1());
});

test('K4e.4 explainer keeps observed, computed, inferred and non-claim classes separate', async () => {
  const { envelope, context } = await validPair();
  const { explanation, boundaries } = await verify(envelope, context);

  assert(explanation.observedFacts.every((item) => item.claimClass === 'observed-fact'));
  assert(explanation.computedFacts.every((item) => item.claimClass === 'computed-fact'));
  assert(explanation.inferredCandidates.every((item) => item.claimClass === 'inferred-candidate'));
  assert(explanation.nonClaims.every((item) => item.claimClass === 'non-claim'));
  assert.equal(explanation.observedFacts.some((item) => /live observation/i.test(item.statement)), false);
  assert.equal(explanation.inferredCandidates.some((item) => explanation.observedFacts.includes(item)), false);
  assert(Object.values(boundaries).every((value) => value === false));
});

test('K4e.4 verification request remains a reserved empty-input Portable Companion utility', () => {
  const request = portableReceiptVerificationRequest();
  assert.throws(() => validatePortableUtilityRequestV1(request), /PORTABLE_COMPANION_RESERVED_ACTION_DENIED/);
  assert.equal(validatePortableReceiptVerificationRequest(request).action, 'receipt-envelope.verify');
  assert.throws(() => validatePortableReceiptVerificationRequest({ ...request, input: { receiptId: 'x' } }), /PORTABLE_COMPANION_REQUEST_INPUT_DENIED/);
});

test('K4e.4 receipt schema is closed, immutable, Ed25519-only and synthetic-non-live', async () => {
  const schema = JSON.parse(await readFile('contracts/portable-companion/v1/receipt-envelope.schema.json', 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.signature.properties.algorithm.const, 'Ed25519');
  assert.equal(schema.properties.signature.properties.encoding.const, 'base64url');
  assert.equal(schema.properties.receipt.properties.liveObservationClaim.const, false);
  assert.equal(schema.properties.receipt.properties.mutable.const, false);
  assert.equal(schema.properties.receipt.properties.evidenceClass.const, 'synthetic-fixture');
  assert.equal(schema.properties.bindings.additionalProperties, false);
});

test('K4e.4 fixture verification context contains only a synthetic public key, never signing authority', async () => {
  const context = await fixture('receipt-synthetic-context');
  const serialized = JSON.stringify(context);
  assert.equal(context.trustClass, 'synthetic-fixture-only');
  assert.equal(context.publicKey.format, 'spki-der');
  assert.doesNotMatch(serialized, /private|BEGIN [A-Z ]*PRIVATE KEY|credential|password|bearer/i);
});

test('K4e.4 mandatory negative rejects missing signature', async () => {
  const { envelope, context } = await validPair();
  delete envelope.signature;
  assert.throws(() => verifyPortableReceiptEnvelope(envelope, context, { now: VALID_NOW }), /PORTABLE_RECEIPT_SIGNATURE_MISSING_DENIED/);
});

test('K4e.4 mandatory negative rejects invalid signature', async () => {
  const { envelope, context } = await validPair();
  const first = envelope.signature.value[0];
  envelope.signature.value = `${first === 'A' ? 'B' : 'A'}${envelope.signature.value.slice(1)}`;
  assert.throws(() => verifyPortableReceiptEnvelope(envelope, context, { now: VALID_NOW }), /PORTABLE_RECEIPT_SIGNATURE_INVALID_DENIED/);
});

test('K4e.4 mandatory negative rejects unsupported algorithm', async () => {
  const { envelope, context } = await validPair();
  envelope.signature.algorithm = 'RS256';
  assert.throws(() => verifyPortableReceiptEnvelope(envelope, context, { now: VALID_NOW }), /PORTABLE_RECEIPT_ALGORITHM_DENIED/);
});

test('K4e.4 mandatory negative rejects digest mismatch', async () => {
  const { envelope, context } = await validPair();
  envelope.payloadDigest = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => verifyPortableReceiptEnvelope(envelope, context, { now: VALID_NOW }), /PORTABLE_RECEIPT_DIGEST_MISMATCH_DENIED/);
});

test('K4e.4 mandatory negative rejects stale timestamp', async () => {
  const { envelope, context } = await validPair();
  await assert.rejects(verify(envelope, context, '2026-08-21T20:15:00.001Z'), /PORTABLE_RECEIPT_STALE_TIMESTAMP_DENIED/);
});

test('K4e.4 mandatory negative rejects future timestamp', async () => {
  const { envelope, context } = await validPair();
  envelope.receipt.issuedAt = '2026-08-21T20:10:00.000Z';
  envelope.receipt.expiresAt = '2026-08-21T20:15:00.000Z';
  assert.throws(() => verifyPortableReceiptEnvelope(envelope, context, { now: '2026-08-21T20:05:00.000Z' }), /PORTABLE_RECEIPT_FUTURE_TIMESTAMP_DENIED/);
});

for (const [name, mutate, expected] of [
  ['contract binding', (envelope) => { envelope.bindings.contract.schemaDigest = `sha256:${'1'.repeat(64)}`; }, /PORTABLE_RECEIPT_CONTRACT_BINDING_DENIED/],
  ['capability binding', (envelope) => { envelope.bindings.capability.manifestDigest = `sha256:${'2'.repeat(64)}`; }, /PORTABLE_RECEIPT_CAPABILITY_BINDING_DENIED/],
  ['source binding', (envelope) => { envelope.bindings.source.sourceCommit = '3'.repeat(40); }, /PORTABLE_RECEIPT_SOURCE_BINDING_DENIED/],
]) {
  test(`K4e.4 mandatory negative rejects wrong ${name}`, async () => {
    const { envelope, context } = await validPair();
    mutate(envelope);
    assert.throws(() => verifyPortableReceiptEnvelope(envelope, context, { now: VALID_NOW }), expected);
  });
}

test('K4e.4 mandatory negative rejects oversized input before parsing', async () => {
  const { envelope, context } = await validPair();
  const oversized = `${JSON.stringify(envelope)}${' '.repeat(PORTABLE_RECEIPT_MAX_BYTES)}`;
  assert.throws(() => verifyPortableReceiptEnvelope(oversized, context, { now: VALID_NOW }), /PORTABLE_RECEIPT_SIZE_LIMIT_DENIED/);
});

test('K4e.4 mandatory negative rejects malformed signature and UTF-8 encodings', async () => {
  const { envelope, context } = await validPair();
  envelope.signature.value = `${'A'.repeat(85)}=`;
  assert.throws(() => verifyPortableReceiptEnvelope(envelope, context, { now: VALID_NOW }), /PORTABLE_RECEIPT_ENCODING_DENIED/);
  assert.throws(() => verifyPortableReceiptEnvelope(Buffer.from([0xc3, 0x28]), context, { now: VALID_NOW }), /PORTABLE_RECEIPT_ENCODING_DENIED/);
});

test('K4e.4 mandatory negative rejects a synthetic fixture claimed as live', async () => {
  const { envelope, context } = await validPair();
  envelope.receipt.liveObservationClaim = true;
  assert.throws(() => verifyPortableReceiptEnvelope(envelope, context, { now: VALID_NOW }), /PORTABLE_RECEIPT_SYNTHETIC_LIVE_CLAIM_DENIED/);
});

test('K4e.4 rejects mutable receipts and claim-class promotion', async () => {
  const pair = await validPair();
  pair.envelope.receipt.mutable = true;
  assert.throws(() => verifyPortableReceiptEnvelope(pair.envelope, pair.context, { now: VALID_NOW }), /PORTABLE_RECEIPT_MUTABLE_DENIED/);

  const promoted = await validPair();
  promoted.envelope.receipt.claims.inferredCandidates[0].claimClass = 'observed-fact';
  assert.throws(() => verifyPortableReceiptEnvelope(promoted.envelope, promoted.context, { now: VALID_NOW }), /PORTABLE_RECEIPT_CLAIM_PROMOTION_DENIED/);
});

test('K4e.4 source contains no network, key-retrieval or signing path', async () => {
  const source = await readFile('services/bi-control/src/portable-companion/receipt-verifier.mjs', 'utf8');
  assert.doesNotMatch(source, /\bfetch\s*\(|https\.request|http\.request|createPrivateKey|generateKeyPair|\bsign\s*\(/);
  assert.match(source, /createPublicKey/);
  assert.match(source, /verify\(/);
});
