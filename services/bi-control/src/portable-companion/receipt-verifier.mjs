import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { capabilityManifestV1 } from '../../../bi-agent/src/capability-manifest-v1.mjs';
import { canonicalJson } from '../canonical-json.js';
import {
  EXTERNAL_API_V2_RUNTIME_INTENTS,
  PORTABLE_COMPANION_CONTRACT_ID,
  PORTABLE_COMPANION_CONTRACT_SCHEMA,
  PORTABLE_COMPANION_CONTRACT_VERSION,
  PORTABLE_COMPANION_REQUEST_SCHEMA,
  sha256Bytes,
  sha256Canonical,
  validatePortableUtilityRequestV1,
} from './contract.mjs';

export const PORTABLE_RECEIPT_ENVELOPE_SCHEMA = 'kaleidosphere.portable-companion/receipt-envelope/v1';
export const PORTABLE_RECEIPT_PAYLOAD_SCHEMA = 'kaleidosphere.portable-companion/signed-receipt/v1';
export const PORTABLE_RECEIPT_VERIFICATION_SCHEMA = 'kaleidosphere.portable-companion/receipt-verification/v1';
export const PORTABLE_RECEIPT_VERIFICATION_CONTEXT_SCHEMA = 'kaleidosphere.portable-companion/receipt-verification-context/v1';
export const PORTABLE_RECEIPT_ACTION = 'receipt-envelope.verify';
export const PORTABLE_RECEIPT_MAX_BYTES = 16_384;
export const PORTABLE_RECEIPT_MAX_LIFETIME_MS = 15 * 60 * 1000;
export const PORTABLE_RECEIPT_MAX_FUTURE_SKEW_MS = 60 * 1000;

const CONTRACT_SCHEMA_PATH = new URL('../../../../contracts/portable-companion/v1/portable-companion.schema.json', import.meta.url);
const SOURCE_MAP_PATH = new URL('../../../../SOURCE-MAP.json', import.meta.url);
const CLAIM_SECTION_CLASSES = Object.freeze({
  observedFacts: 'observed-fact',
  computedFacts: 'computed-fact',
  inferredCandidates: 'inferred-candidate',
  nonClaims: 'non-claim',
});
const RECEIPT_KEYS = Object.freeze(['schemaVersion', 'receiptId', 'issuedAt', 'expiresAt', 'evidenceClass', 'liveObservationClaim', 'mutable', 'claims']);
const BINDING_KEYS = Object.freeze(['contract', 'capability', 'source']);
const CONTRACT_BINDING_KEYS = Object.freeze(['id', 'version', 'schemaVersion', 'schemaDigest']);
const CAPABILITY_BINDING_KEYS = Object.freeze(['contractId', 'contractVersion', 'capabilityId', 'runtimeIntent', 'manifestDigest']);
const SOURCE_BINDING_KEYS = Object.freeze(['repository', 'sourceMapSchemaVersion', 'sourceCommit', 'fixtureClass']);
const SIGNATURE_KEYS = Object.freeze(['algorithm', 'encoding', 'keyId', 'value']);
const CONTEXT_KEYS = Object.freeze(['schemaVersion', 'trustClass', 'keyId', 'publicKey']);
const PUBLIC_KEY_KEYS = Object.freeze(['format', 'encoding', 'value']);
const BOUNDARY_KEYS = Object.freeze([
  'runtimeEvidenceCreationAccepted',
  'signingAuthorityAccepted',
  'remoteVerificationAccepted',
  'networkLookupAccepted',
  'keyRetrievalAccepted',
  'credentialsAccepted',
  'rawProviderPayloadsAccepted',
  'liveObservationAccepted',
  'claimPromotionAccepted',
  'productionTrustAnchorAccepted',
]);
const CHECK_IDS = Object.freeze([
  'closed-envelope-surface',
  'algorithm-allowlisted',
  'payload-digest-match',
  'signature-valid',
  'contract-binding-match',
  'capability-binding-match',
  'source-binding-match',
  'freshness-valid',
  'synthetic-non-live',
]);
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID = /^[a-z][a-z0-9._:-]{2,96}$/;
const CLAIM_ID = /^[a-z][a-z0-9.-]{2,80}$/;
const KEY_ID = /^[a-z][a-z0-9.-]{2,80}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const FORBIDDEN_CLAIM = /(?:\b(?:select|insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|exec(?:ute)?)\b|\b(?:bearer\s+[a-z0-9._:-]{8,}|password|credential|secret|token|api[_ -]?key|private\s+key|raw\s+(?:source\s+)?rows?|provider\s+payload|https?:\/\/|wss?:\/\/|runtime\s+executed|analysis\s+succeeded|readback\s+succeeded|production\s+ready|customer\s+data\s+verified)\b)/i;

function fail(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  throw error;
}

function assertPlainObject(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(code);
}

function assertExactKeys(value, allowed, required = allowed, code) {
  assertPlainObject(value, code);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))) fail(code, { keys });
}

function parseEnvelope(input) {
  let bytes;
  let value;
  if (typeof input === 'string') {
    bytes = Buffer.from(input, 'utf8');
  } else if (input instanceof Uint8Array) {
    bytes = Buffer.from(input);
  } else {
    assertPlainObject(input, 'PORTABLE_RECEIPT_INPUT_DENIED');
    try {
      bytes = Buffer.from(canonicalJson(input), 'utf8');
    } catch {
      fail('PORTABLE_RECEIPT_INPUT_DENIED');
    }
    value = structuredClone(input);
  }
  if (bytes.byteLength > PORTABLE_RECEIPT_MAX_BYTES) fail('PORTABLE_RECEIPT_SIZE_LIMIT_DENIED');
  if (value === undefined) {
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      fail('PORTABLE_RECEIPT_ENCODING_DENIED');
    }
    try {
      value = JSON.parse(text);
    } catch {
      fail('PORTABLE_RECEIPT_MALFORMED_JSON_DENIED');
    }
  }
  assertPlainObject(value, 'PORTABLE_RECEIPT_INPUT_DENIED');
  return value;
}

function assertSafeStatement(value, path) {
  if (typeof value !== 'string' || value.length < 3 || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('PORTABLE_RECEIPT_CLAIM_BOUNDS_DENIED', { path });
  }
  if (FORBIDDEN_CLAIM.test(value)) fail('PORTABLE_RECEIPT_UNSAFE_CLAIM_DENIED', { path });
}

function normalizeClaims(claims) {
  assertExactKeys(claims, Object.keys(CLAIM_SECTION_CLASSES), Object.keys(CLAIM_SECTION_CLASSES), 'PORTABLE_RECEIPT_CLAIM_SECTIONS_DENIED');
  const normalized = {};
  for (const [section, claimClass] of Object.entries(CLAIM_SECTION_CLASSES)) {
    const items = claims[section];
    const minimum = section === 'inferredCandidates' ? 0 : section === 'nonClaims' ? 4 : 1;
    const maximum = section === 'nonClaims' ? 6 : 4;
    if (!Array.isArray(items) || items.length < minimum || items.length > maximum) fail('PORTABLE_RECEIPT_CLAIM_SECTIONS_DENIED', { section });
    normalized[section] = Object.freeze(items.map((item, index) => {
      assertExactKeys(item, ['id', 'claimClass', 'statement'], ['id', 'claimClass', 'statement'], 'PORTABLE_RECEIPT_CLAIM_SURFACE_DENIED');
      if (!CLAIM_ID.test(item.id)) fail('PORTABLE_RECEIPT_CLAIM_ID_DENIED', { section, index });
      if (item.claimClass !== claimClass) fail('PORTABLE_RECEIPT_CLAIM_PROMOTION_DENIED', { section, expected: claimClass });
      assertSafeStatement(item.statement, `$.receipt.claims.${section}[${index}].statement`);
      return Object.freeze({ id: item.id, claimClass, statement: item.statement });
    }));
  }
  return Object.freeze(normalized);
}

function normalizeReceipt(receipt) {
  assertExactKeys(receipt, RECEIPT_KEYS, RECEIPT_KEYS, 'PORTABLE_RECEIPT_PAYLOAD_SURFACE_DENIED');
  if (receipt.schemaVersion !== PORTABLE_RECEIPT_PAYLOAD_SCHEMA) fail('PORTABLE_RECEIPT_PAYLOAD_SCHEMA_DENIED');
  if (!ID.test(receipt.receiptId)) fail('PORTABLE_RECEIPT_ID_DENIED');
  if (receipt.evidenceClass !== 'synthetic-fixture' || receipt.liveObservationClaim !== false) fail('PORTABLE_RECEIPT_SYNTHETIC_LIVE_CLAIM_DENIED');
  if (receipt.mutable !== false) fail('PORTABLE_RECEIPT_MUTABLE_DENIED');
  return Object.freeze({
    schemaVersion: receipt.schemaVersion,
    receiptId: receipt.receiptId,
    issuedAt: receipt.issuedAt,
    expiresAt: receipt.expiresAt,
    evidenceClass: receipt.evidenceClass,
    liveObservationClaim: false,
    mutable: false,
    claims: normalizeClaims(receipt.claims),
  });
}

function expectedBindings() {
  const sourceMap = JSON.parse(readFileSync(SOURCE_MAP_PATH, 'utf8'));
  const capabilityManifest = capabilityManifestV1();
  return Object.freeze({
    contract: Object.freeze({
      id: PORTABLE_COMPANION_CONTRACT_ID,
      version: PORTABLE_COMPANION_CONTRACT_VERSION,
      schemaVersion: PORTABLE_COMPANION_CONTRACT_SCHEMA,
      schemaDigest: sha256Bytes(readFileSync(CONTRACT_SCHEMA_PATH)),
    }),
    capability: Object.freeze({
      contractId: 'superset-bi-agent.external',
      contractVersion: '2.0.0',
      capabilityId: 'bi.readback.read',
      runtimeIntent: 'readback',
      manifestDigest: capabilityManifest.integrity.digest,
    }),
    source: Object.freeze({
      repository: 'JoFe2/KaleidoSphere',
      sourceMapSchemaVersion: sourceMap.schemaVersion,
      sourceCommit: sourceMap.sourceCommit,
      fixtureClass: 'synthetic-only',
    }),
  });
}

export function portableReceiptExpectedBindingsV1() {
  return structuredClone(expectedBindings());
}

function normalizeBindings(bindings) {
  assertExactKeys(bindings, BINDING_KEYS, BINDING_KEYS, 'PORTABLE_RECEIPT_BINDING_SURFACE_DENIED');
  assertExactKeys(bindings.contract, CONTRACT_BINDING_KEYS, CONTRACT_BINDING_KEYS, 'PORTABLE_RECEIPT_CONTRACT_BINDING_DENIED');
  assertExactKeys(bindings.capability, CAPABILITY_BINDING_KEYS, CAPABILITY_BINDING_KEYS, 'PORTABLE_RECEIPT_CAPABILITY_BINDING_DENIED');
  assertExactKeys(bindings.source, SOURCE_BINDING_KEYS, SOURCE_BINDING_KEYS, 'PORTABLE_RECEIPT_SOURCE_BINDING_DENIED');
  const expected = expectedBindings();
  if (JSON.stringify(bindings.contract) !== JSON.stringify(expected.contract)) fail('PORTABLE_RECEIPT_CONTRACT_BINDING_DENIED');
  if (JSON.stringify(bindings.capability) !== JSON.stringify(expected.capability)) fail('PORTABLE_RECEIPT_CAPABILITY_BINDING_DENIED');
  if (JSON.stringify(bindings.source) !== JSON.stringify(expected.source)) fail('PORTABLE_RECEIPT_SOURCE_BINDING_DENIED');
  return expected;
}

function parseTimestamp(value, code) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) fail(code);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail(code);
  return milliseconds;
}

function validateFreshness(receipt, now) {
  const issuedAt = parseTimestamp(receipt.issuedAt, 'PORTABLE_RECEIPT_TIMESTAMP_DENIED');
  const expiresAt = parseTimestamp(receipt.expiresAt, 'PORTABLE_RECEIPT_TIMESTAMP_DENIED');
  const current = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(current)) fail('PORTABLE_RECEIPT_NOW_DENIED');
  if (expiresAt <= issuedAt || expiresAt - issuedAt > PORTABLE_RECEIPT_MAX_LIFETIME_MS) fail('PORTABLE_RECEIPT_LIFETIME_DENIED');
  if (issuedAt - current > PORTABLE_RECEIPT_MAX_FUTURE_SKEW_MS) fail('PORTABLE_RECEIPT_FUTURE_TIMESTAMP_DENIED');
  if (current > expiresAt) fail('PORTABLE_RECEIPT_STALE_TIMESTAMP_DENIED');
}

function normalizeVerificationContext(context) {
  assertExactKeys(context, CONTEXT_KEYS, CONTEXT_KEYS, 'PORTABLE_RECEIPT_CONTEXT_DENIED');
  if (context.schemaVersion !== PORTABLE_RECEIPT_VERIFICATION_CONTEXT_SCHEMA || context.trustClass !== 'synthetic-fixture-only') fail('PORTABLE_RECEIPT_CONTEXT_DENIED');
  if (!KEY_ID.test(context.keyId)) fail('PORTABLE_RECEIPT_KEY_ID_DENIED');
  assertExactKeys(context.publicKey, PUBLIC_KEY_KEYS, PUBLIC_KEY_KEYS, 'PORTABLE_RECEIPT_PUBLIC_KEY_DENIED');
  if (context.publicKey.format !== 'spki-der' || context.publicKey.encoding !== 'base64') fail('PORTABLE_RECEIPT_PUBLIC_KEY_DENIED');
  if (typeof context.publicKey.value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(context.publicKey.value)) fail('PORTABLE_RECEIPT_PUBLIC_KEY_DENIED');
  let key;
  try {
    key = createPublicKey({ key: Buffer.from(context.publicKey.value, 'base64'), format: 'der', type: 'spki' });
  } catch {
    fail('PORTABLE_RECEIPT_PUBLIC_KEY_DENIED');
  }
  if (key.asymmetricKeyType !== 'ed25519') fail('PORTABLE_RECEIPT_PUBLIC_KEY_DENIED');
  return { keyId: context.keyId, key };
}

function decodeSignature(value) {
  if (typeof value !== 'string' || value.length !== 86 || !BASE64URL.test(value)) fail('PORTABLE_RECEIPT_ENCODING_DENIED');
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.byteLength !== 64 || decoded.toString('base64url') !== value) fail('PORTABLE_RECEIPT_ENCODING_DENIED');
  return decoded;
}

function verificationCheck(id) {
  return Object.freeze({ id, status: 'PASS', claimClass: 'computed-fact' });
}

function nonClaim(id, statement) {
  return Object.freeze({ id, claimClass: 'non-claim', statement });
}

function boundaryFlags() {
  return Object.freeze(Object.fromEntries(BOUNDARY_KEYS.map((key) => [key, false])));
}

function manifestBody(value) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'integrity'));
}

export function portableReceiptVerificationRequest() {
  return Object.freeze({
    schemaVersion: PORTABLE_COMPANION_REQUEST_SCHEMA,
    contractVersion: PORTABLE_COMPANION_CONTRACT_VERSION,
    action: PORTABLE_RECEIPT_ACTION,
  });
}

export function validatePortableReceiptVerificationRequest(value) {
  const request = validatePortableUtilityRequestV1(value, { allowReserved: true });
  if (request.action !== PORTABLE_RECEIPT_ACTION) fail('PORTABLE_RECEIPT_ACTION_DENIED');
  return request;
}

export function verifyPortableReceiptEnvelope(input, context, options = {}) {
  validatePortableReceiptVerificationRequest(options.request ?? portableReceiptVerificationRequest());
  assertExactKeys(options, ['request', 'now'], [], 'PORTABLE_RECEIPT_OPTIONS_DENIED');
  const envelope = parseEnvelope(input);
  if (!Object.hasOwn(envelope, 'signature')) fail('PORTABLE_RECEIPT_SIGNATURE_MISSING_DENIED');
  assertExactKeys(envelope, ['schemaVersion', 'contractVersion', 'receipt', 'bindings', 'payloadDigest', 'signature'], ['schemaVersion', 'contractVersion', 'receipt', 'bindings', 'payloadDigest', 'signature'], 'PORTABLE_RECEIPT_ENVELOPE_SURFACE_DENIED');
  if (envelope.schemaVersion !== PORTABLE_RECEIPT_ENVELOPE_SCHEMA) fail('PORTABLE_RECEIPT_ENVELOPE_SCHEMA_DENIED');
  if (envelope.contractVersion !== PORTABLE_COMPANION_CONTRACT_VERSION) fail('PORTABLE_RECEIPT_CONTRACT_VERSION_DENIED');
  assertExactKeys(envelope.signature, SIGNATURE_KEYS, SIGNATURE_KEYS, 'PORTABLE_RECEIPT_SIGNATURE_MISSING_DENIED');
  if (envelope.signature.algorithm !== 'Ed25519') fail('PORTABLE_RECEIPT_ALGORITHM_DENIED');
  if (envelope.signature.encoding !== 'base64url') fail('PORTABLE_RECEIPT_ENCODING_DENIED');
  if (!KEY_ID.test(envelope.signature.keyId)) fail('PORTABLE_RECEIPT_KEY_ID_DENIED');
  const normalizedReceipt = normalizeReceipt(envelope.receipt);
  const bindings = normalizeBindings(envelope.bindings);
  validateFreshness(normalizedReceipt, options.now ?? new Date());
  if (!DIGEST.test(envelope.payloadDigest) || envelope.payloadDigest !== sha256Canonical(normalizedReceipt)) fail('PORTABLE_RECEIPT_DIGEST_MISMATCH_DENIED');
  const verificationContext = normalizeVerificationContext(context);
  if (envelope.signature.keyId !== verificationContext.keyId) fail('PORTABLE_RECEIPT_KEY_ID_DENIED');
  const signature = decodeSignature(envelope.signature.value);
  const signedBody = Object.fromEntries(Object.entries(envelope).filter(([key]) => key !== 'signature'));
  if (!verify(null, Buffer.from(canonicalJson(signedBody)), verificationContext.key, signature)) fail('PORTABLE_RECEIPT_SIGNATURE_INVALID_DENIED');

  const checks = CHECK_IDS.map(verificationCheck);
  const reportBody = {
    schemaVersion: PORTABLE_RECEIPT_VERIFICATION_SCHEMA,
    contractVersion: PORTABLE_COMPANION_CONTRACT_VERSION,
    action: PORTABLE_RECEIPT_ACTION,
    receiptId: normalizedReceipt.receiptId,
    verification: {
      status: 'VERIFIED_INTEGRITY_ONLY',
      trustClass: 'synthetic-fixture-only',
      checks,
    },
    bindings,
    externalApiV2: {
      contractId: 'superset-bi-agent.external',
      contractVersion: '2.0.0',
      runtimeIntents: EXTERNAL_API_V2_RUNTIME_INTENTS,
      boundRuntimeIntent: 'readback',
      dispatch: false,
    },
    explanation: {
      observedFacts: normalizedReceipt.claims.observedFacts,
      computedFacts: Object.freeze([...normalizedReceipt.claims.computedFacts, ...checks]),
      inferredCandidates: normalizedReceipt.claims.inferredCandidates,
      nonClaims: Object.freeze([
        ...normalizedReceipt.claims.nonClaims,
        nonClaim('verification-is-not-evidence', 'Signature verification proves local envelope integrity, not runtime evidence or BI truth.'),
        nonClaim('no-signing-authority', 'The verifier contains no private key and grants no signing authority.'),
        nonClaim('no-remote-trust', 'No network lookup, key retrieval, remote service or production trust anchor was used.'),
        nonClaim('no-live-observation', 'The verified fixture is synthetic and is not a live observation.'),
      ]),
    },
    boundaries: boundaryFlags(),
  };
  return Object.freeze({
    ...reportBody,
    integrity: Object.freeze({ algorithm: 'sha256-canonical-json', digest: sha256Canonical(reportBody) }),
  });
}

function validateClaimSection(items, expectedClass, minimum, maximum, code) {
  if (!Array.isArray(items) || items.length < minimum || items.length > maximum) fail(code);
  for (const item of items) {
    assertExactKeys(item, expectedClass === 'computed-fact' && Object.hasOwn(item, 'status') ? ['id', 'status', 'claimClass'] : ['id', 'claimClass', 'statement'], undefined, code);
    if (item.claimClass !== expectedClass) fail('PORTABLE_RECEIPT_CLAIM_PROMOTION_DENIED');
  }
}

export function validatePortableReceiptVerificationReport(value) {
  assertExactKeys(value, ['schemaVersion', 'contractVersion', 'action', 'receiptId', 'verification', 'bindings', 'externalApiV2', 'explanation', 'boundaries', 'integrity'], undefined, 'PORTABLE_RECEIPT_REPORT_SURFACE_DENIED');
  if (value.schemaVersion !== PORTABLE_RECEIPT_VERIFICATION_SCHEMA || value.contractVersion !== PORTABLE_COMPANION_CONTRACT_VERSION || value.action !== PORTABLE_RECEIPT_ACTION) fail('PORTABLE_RECEIPT_REPORT_SCHEMA_DENIED');
  if (!ID.test(value.receiptId)) fail('PORTABLE_RECEIPT_ID_DENIED');
  assertExactKeys(value.verification, ['status', 'trustClass', 'checks'], undefined, 'PORTABLE_RECEIPT_REPORT_VERIFICATION_DENIED');
  if (value.verification.status !== 'VERIFIED_INTEGRITY_ONLY' || value.verification.trustClass !== 'synthetic-fixture-only') fail('PORTABLE_RECEIPT_REPORT_VERIFICATION_DENIED');
  if (!Array.isArray(value.verification.checks) || JSON.stringify(value.verification.checks.map((item) => item.id)) !== JSON.stringify(CHECK_IDS)) fail('PORTABLE_RECEIPT_REPORT_CHECKS_DENIED');
  validateClaimSection(value.verification.checks, 'computed-fact', CHECK_IDS.length, CHECK_IDS.length, 'PORTABLE_RECEIPT_REPORT_CHECKS_DENIED');
  normalizeBindings(value.bindings);
  assertExactKeys(value.externalApiV2, ['contractId', 'contractVersion', 'runtimeIntents', 'boundRuntimeIntent', 'dispatch'], undefined, 'PORTABLE_RECEIPT_REPORT_EXTERNAL_API_DENIED');
  if (JSON.stringify(value.externalApiV2.runtimeIntents) !== JSON.stringify(EXTERNAL_API_V2_RUNTIME_INTENTS) || value.externalApiV2.boundRuntimeIntent !== 'readback' || value.externalApiV2.dispatch !== false) fail('PORTABLE_RECEIPT_RUNTIME_INTENT_WIDENING_DENIED');
  assertExactKeys(value.explanation, Object.keys(CLAIM_SECTION_CLASSES), undefined, 'PORTABLE_RECEIPT_REPORT_EXPLANATION_DENIED');
  validateClaimSection(value.explanation.observedFacts, 'observed-fact', 1, 4, 'PORTABLE_RECEIPT_REPORT_EXPLANATION_DENIED');
  validateClaimSection(value.explanation.computedFacts, 'computed-fact', 10, 13, 'PORTABLE_RECEIPT_REPORT_EXPLANATION_DENIED');
  validateClaimSection(value.explanation.inferredCandidates, 'inferred-candidate', 0, 4, 'PORTABLE_RECEIPT_REPORT_EXPLANATION_DENIED');
  validateClaimSection(value.explanation.nonClaims, 'non-claim', 8, 10, 'PORTABLE_RECEIPT_REPORT_EXPLANATION_DENIED');
  assertExactKeys(value.boundaries, BOUNDARY_KEYS, BOUNDARY_KEYS, 'PORTABLE_RECEIPT_REPORT_BOUNDARY_DENIED');
  if (Object.values(value.boundaries).some((item) => item !== false)) fail('PORTABLE_RECEIPT_REPORT_BOUNDARY_DENIED');
  const body = manifestBody(value);
  if (value.integrity?.algorithm !== 'sha256-canonical-json' || value.integrity.digest !== sha256Canonical(body)) fail('PORTABLE_RECEIPT_REPORT_INTEGRITY_DENIED');
  return value;
}
