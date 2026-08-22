import { readFileSync } from 'node:fs';

import { canonicalJson } from '../canonical-json.js';
import {
  EXTERNAL_API_V2_RUNTIME_INTENTS,
  PORTABLE_COMPANION_CONTRACT_VERSION,
  sha256Canonical,
} from './contract.mjs';
import {
  checkPortableDoctorReadiness,
  validatePortableDoctorReadinessReport,
} from './doctor.mjs';
import {
  readPortableCapabilityExplorer,
  validatePortableCapabilityExplorerReport,
} from './capability-explorer.mjs';
import {
  validatePortableProfileTemplate,
  validatePortableProfileTemplateReport,
} from './template-validator.mjs';
import {
  validatePortableReceiptVerificationReport,
  verifyPortableReceiptEnvelope,
} from './receipt-verifier.mjs';

export const PORTABLE_SYNTHETIC_DEMO_FIXTURE_SCHEMA = 'kaleidosphere.portable-companion/synthetic-demo-fixture/v1';
export const PORTABLE_SYNTHETIC_DEMO_REPORT_SCHEMA = 'kaleidosphere.portable-companion/synthetic-demo-report/v1';
export const PORTABLE_SYNTHETIC_DEMO_ACTION = 'synthetic-demo.run';
export const PORTABLE_SYNTHETIC_DEMO_MAX_BYTES = 16_384;
export const PORTABLE_SYNTHETIC_HUMAN_LABEL = 'SYNTHETIC OFFLINE FIXTURE — NOT LIVE OR RUNTIME EVIDENCE';

const FIXTURE_PATH = new URL('../../fixtures/portable-companion/synthetic-demo-v1.json', import.meta.url);
const FIXTURE_KEYS = Object.freeze([
  'schemaVersion',
  'contractVersion',
  'demoId',
  'classification',
  'fixedNow',
  'boundaries',
  'flow',
]);
const CLASSIFICATION_KEYS = Object.freeze(['machine', 'human']);
const MACHINE_LABEL_KEYS = Object.freeze(['synthetic', 'fixtureClass', 'liveEvidence', 'runtimeObservation']);
const FIXTURE_BOUNDARY_KEYS = Object.freeze(['runtimeDispatch', 'network', 'liveEvidenceClaim', 'runtimeReadbackClaim', 'benchmarkClaim']);
const FLOW_KEYS = Object.freeze(['status', 'guidance', 'template', 'receipt']);
const STATUS_KEYS = Object.freeze(['snapshot']);
const GUIDANCE_KEYS = Object.freeze(['capabilityKey']);
const TEMPLATE_KEYS = Object.freeze(['profile']);
const RECEIPT_KEYS = Object.freeze(['envelope', 'context']);
const REPORT_BOUNDARY_KEYS = Object.freeze([
  'runtimeDispatchAccepted',
  'networkAccepted',
  'liveEvidenceClaimAccepted',
  'runtimeReadbackClaimAccepted',
  'benchmarkClaimAccepted',
  'signingAuthorityAccepted',
  'productionClaimAccepted',
]);
const LAYER_COMMON_KEYS = Object.freeze(['classification', 'claimsLiveEvidence', 'claimsRuntimeObservation']);
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_DEMO_ID = /^synthetic-[a-z0-9-]{3,72}$/;
const SECRET_LOOKING = /(?:\b(?:sk-[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9_]{20,})\b|bearer\s+[a-z0-9._:-]{8,}|(?:password|credential|secret|token|api[_ -]?key|private\s+key)\s*[:=]\s*["']?[^"',\s]{4,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:postgres(?:ql)?|mysql|mssql|oracle|mongodb(?:\+srv)?|jdbc):\/\/)/i;
const REAL_LOCATION = /\b(?:https?|wss?):\/\/|\blocalhost\b/i;
const CUSTOMER_LIKE_IDENTIFIER = /\b(?:customer|client|tenant|account|user)[-_ ]?(?:id[-_: ]*)?[a-z0-9]{4,}\b/i;
const FORBIDDEN_KEY = /^(?:authorization|api_?key|credential|password|secret_?value|token|cookie|private_?key|raw_?(?:rows?|records?)|customer_?(?:id|identifier)|client_?(?:id|identifier)|tenant_?(?:id|identifier)|account_?(?:id|identifier)|user_?(?:id|identifier)|provider_?payload|endpoint)$/i;
const AFFIRMATIVE_LIVE_CLAIM = /\b(?:live|runtime|customer)\s+(?:evidence|observation|readback)\s+(?:confirmed|observed|verified|succeeded|available)\b/i;

function fail(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  throw error;
}

function assertPlainObject(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(code);
}

function assertExactKeys(value, allowed, code) {
  assertPlainObject(value, code);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || allowed.some((key) => !keys.includes(key))) fail(code, { keys });
}

function classification() {
  return Object.freeze({
    machine: Object.freeze({
      synthetic: true,
      fixtureClass: 'synthetic-only',
      liveEvidence: false,
      runtimeObservation: false,
    }),
    human: PORTABLE_SYNTHETIC_HUMAN_LABEL,
  });
}

function assertClassification(value, code = 'PORTABLE_SYNTHETIC_DEMO_LABEL_DENIED') {
  assertExactKeys(value, CLASSIFICATION_KEYS, code);
  assertExactKeys(value.machine, MACHINE_LABEL_KEYS, code);
  const expected = classification();
  if (canonicalJson(value) !== canonicalJson(expected)) fail(code);
  return expected;
}

function assertSafeFixtureValue(value, path = '$') {
  if (typeof value === 'string') {
    if (value.length > 500 || /[\u0000-\u001f\u007f]/.test(value)) fail('PORTABLE_SYNTHETIC_DEMO_TEXT_BOUNDS_DENIED', { path });
    if (SECRET_LOOKING.test(value)) fail('PORTABLE_SYNTHETIC_DEMO_SECRET_VALUE_DENIED', { path });
    if (REAL_LOCATION.test(value)) fail('PORTABLE_SYNTHETIC_DEMO_NETWORK_DENIED', { path });
    if (CUSTOMER_LIKE_IDENTIFIER.test(value)) fail('PORTABLE_SYNTHETIC_DEMO_CUSTOMER_IDENTIFIER_DENIED', { path });
    return;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeFixtureValue(item, `${path}[${index}]`));
    return;
  }
  assertPlainObject(value, 'PORTABLE_SYNTHETIC_DEMO_FIXTURE_SURFACE_DENIED');
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replaceAll(/[^a-z0-9]+/gi, '_').toLowerCase();
    if (FORBIDDEN_KEY.test(normalized)) fail(normalized.startsWith('raw_') ? 'PORTABLE_SYNTHETIC_DEMO_RAW_ROW_DENIED' : normalized.includes('customer') || normalized.includes('client') || normalized.includes('tenant') || normalized.includes('account') || normalized.includes('user') ? 'PORTABLE_SYNTHETIC_DEMO_CUSTOMER_IDENTIFIER_DENIED' : 'PORTABLE_SYNTHETIC_DEMO_SECRET_FIELD_DENIED', { path: `${path}.${key}` });
    if ((normalized === 'dispatch' || normalized === 'runtime_dispatch' || normalized === 'network') && child !== false) {
      fail(normalized === 'network' ? 'PORTABLE_SYNTHETIC_DEMO_NETWORK_DENIED' : 'PORTABLE_SYNTHETIC_DEMO_RUNTIME_DISPATCH_DENIED', { path: `${path}.${key}` });
    }
    assertSafeFixtureValue(child, `${path}.${key}`);
  }
}

function parseFixture(input) {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(canonicalJson(input), 'utf8');
  if (bytes.byteLength > PORTABLE_SYNTHETIC_DEMO_MAX_BYTES) fail('PORTABLE_SYNTHETIC_DEMO_SIZE_LIMIT_DENIED');
  if (typeof input !== 'string') return structuredClone(input);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail('PORTABLE_SYNTHETIC_DEMO_MALFORMED_JSON_DENIED');
  }
}

export function loadPortableSyntheticDemoFixture() {
  return validatePortableSyntheticDemoFixture(readFileSync(FIXTURE_PATH, 'utf8'));
}

export function validatePortableSyntheticDemoFixture(input) {
  const value = parseFixture(input);
  assertPlainObject(value, 'PORTABLE_SYNTHETIC_DEMO_FIXTURE_SURFACE_DENIED');
  assertSafeFixtureValue(value);
  if (!Object.hasOwn(value, 'classification')) fail('PORTABLE_SYNTHETIC_DEMO_LABEL_DENIED');
  assertExactKeys(value, FIXTURE_KEYS, 'PORTABLE_SYNTHETIC_DEMO_FIXTURE_SURFACE_DENIED');
  if (value.schemaVersion !== PORTABLE_SYNTHETIC_DEMO_FIXTURE_SCHEMA || value.contractVersion !== PORTABLE_COMPANION_CONTRACT_VERSION) fail('PORTABLE_SYNTHETIC_DEMO_FIXTURE_SCHEMA_DENIED');
  if (!SAFE_DEMO_ID.test(value.demoId)) fail('PORTABLE_SYNTHETIC_DEMO_ID_DENIED');
  assertClassification(value.classification);
  if (typeof value.fixedNow !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.fixedNow)) fail('PORTABLE_SYNTHETIC_DEMO_TIME_DENIED');
  assertExactKeys(value.boundaries, FIXTURE_BOUNDARY_KEYS, 'PORTABLE_SYNTHETIC_DEMO_BOUNDARY_SURFACE_DENIED');
  if (Object.values(value.boundaries).some((item) => item !== false)) fail('PORTABLE_SYNTHETIC_DEMO_BOUNDARY_DENIED');
  assertExactKeys(value.flow, FLOW_KEYS, 'PORTABLE_SYNTHETIC_DEMO_FLOW_SURFACE_DENIED');
  assertExactKeys(value.flow.status, STATUS_KEYS, 'PORTABLE_SYNTHETIC_DEMO_STATUS_SURFACE_DENIED');
  assertExactKeys(value.flow.guidance, GUIDANCE_KEYS, 'PORTABLE_SYNTHETIC_DEMO_GUIDANCE_SURFACE_DENIED');
  assertExactKeys(value.flow.template, TEMPLATE_KEYS, 'PORTABLE_SYNTHETIC_DEMO_TEMPLATE_SURFACE_DENIED');
  assertExactKeys(value.flow.receipt, RECEIPT_KEYS, 'PORTABLE_SYNTHETIC_DEMO_RECEIPT_SURFACE_DENIED');
  return Object.freeze(value);
}

function layerBase() {
  return {
    classification: classification(),
    claimsLiveEvidence: false,
    claimsRuntimeObservation: false,
  };
}

function boundaries() {
  return Object.freeze(Object.fromEntries(REPORT_BOUNDARY_KEYS.map((key) => [key, false])));
}

export function runPortableSyntheticDemo(input = loadPortableSyntheticDemoFixture()) {
  const fixture = validatePortableSyntheticDemoFixture(input);

  const statusReport = checkPortableDoctorReadiness(undefined, fixture.flow.status.snapshot);
  validatePortableDoctorReadinessReport(statusReport);
  const guidanceReport = readPortableCapabilityExplorer(undefined, { capabilityKey: fixture.flow.guidance.capabilityKey });
  validatePortableCapabilityExplorerReport(guidanceReport);
  const templateReport = validatePortableProfileTemplate(fixture.flow.template.profile);
  validatePortableProfileTemplateReport(templateReport);
  const receiptReport = verifyPortableReceiptEnvelope(
    fixture.flow.receipt.envelope,
    fixture.flow.receipt.context,
    { now: fixture.fixedNow },
  );
  validatePortableReceiptVerificationReport(receiptReport);

  const reportBody = {
    schemaVersion: PORTABLE_SYNTHETIC_DEMO_REPORT_SCHEMA,
    contractVersion: PORTABLE_COMPANION_CONTRACT_VERSION,
    action: PORTABLE_SYNTHETIC_DEMO_ACTION,
    demoId: fixture.demoId,
    classification: classification(),
    externalApiV2: {
      contractId: 'superset-bi-agent.external',
      contractVersion: '2.0.0',
      runtimeIntents: EXTERNAL_API_V2_RUNTIME_INTENTS,
    },
    layers: {
      status: Object.freeze({
        ...layerBase(),
        action: statusReport.action,
        localUtilityStatus: statusReport.localUtilityStatus,
        runtimeStatus: statusReport.runtimeStatus,
        analysisSucceeded: false,
        readbackSucceeded: false,
        dispatch: false,
        reportDigest: statusReport.integrity.digest,
      }),
      guidance: Object.freeze({
        ...layerBase(),
        action: guidanceReport.action,
        selectedCapabilityKey: fixture.flow.guidance.capabilityKey,
        selectedCapabilityId: guidanceReport.capabilities[0].id,
        advisoryOnly: true,
        dispatch: false,
        reportDigest: guidanceReport.integrity.digest,
      }),
      template: Object.freeze({
        ...layerBase(),
        action: templateReport.action,
        validationStatus: templateReport.validation.status,
        selectedRuntimeIntent: templateReport.externalApiV2.selectedRuntimeIntent,
        placeholderOnly: true,
        dispatch: false,
        reportDigest: templateReport.integrity.digest,
      }),
      receipt: Object.freeze({
        ...layerBase(),
        action: receiptReport.action,
        verificationStatus: receiptReport.verification.status,
        trustClass: receiptReport.verification.trustClass,
        liveObservationClaim: false,
        dispatch: false,
        reportDigest: receiptReport.integrity.digest,
      }),
    },
    boundaries: boundaries(),
    nonClaims: [
      'No runtime dispatch, network request or runtime readback occurred.',
      'No live database, raw rows, provider payloads, credentials or customer records were used.',
      'No observed or live runtime evidence is claimed.',
      'No benchmark, BI correctness, signing authority or evidence authority is claimed.',
      'No hosted service, remote MCP, marketplace or production readiness is claimed.',
      'Every report layer is a deterministic synthetic offline fixture projection.',
    ],
  };
  const report = Object.freeze({
    ...reportBody,
    integrity: Object.freeze({ algorithm: 'sha256-canonical-json', digest: sha256Canonical(reportBody) }),
  });
  return validatePortableSyntheticDemoReport(report);
}

function validateLayerCommon(value, allowed, code) {
  assertExactKeys(value, [...LAYER_COMMON_KEYS, ...allowed], code);
  assertClassification(value.classification);
  if (value.claimsLiveEvidence !== false || value.claimsRuntimeObservation !== false) fail('PORTABLE_SYNTHETIC_DEMO_LIVE_EVIDENCE_CLAIM_DENIED');
  if (value.dispatch !== false) fail('PORTABLE_SYNTHETIC_DEMO_RUNTIME_DISPATCH_DENIED');
  if (!DIGEST.test(value.reportDigest)) fail('PORTABLE_SYNTHETIC_DEMO_LAYER_DIGEST_DENIED');
}

export function validatePortableSyntheticDemoReport(value) {
  assertExactKeys(value, ['schemaVersion', 'contractVersion', 'action', 'demoId', 'classification', 'externalApiV2', 'layers', 'boundaries', 'nonClaims', 'integrity'], 'PORTABLE_SYNTHETIC_DEMO_REPORT_SURFACE_DENIED');
  if (value.schemaVersion !== PORTABLE_SYNTHETIC_DEMO_REPORT_SCHEMA || value.contractVersion !== PORTABLE_COMPANION_CONTRACT_VERSION || value.action !== PORTABLE_SYNTHETIC_DEMO_ACTION) fail('PORTABLE_SYNTHETIC_DEMO_REPORT_SCHEMA_DENIED');
  if (!SAFE_DEMO_ID.test(value.demoId)) fail('PORTABLE_SYNTHETIC_DEMO_ID_DENIED');
  assertClassification(value.classification);
  assertExactKeys(value.externalApiV2, ['contractId', 'contractVersion', 'runtimeIntents'], 'PORTABLE_SYNTHETIC_DEMO_EXTERNAL_API_SURFACE_DENIED');
  if (value.externalApiV2.contractId !== 'superset-bi-agent.external' || value.externalApiV2.contractVersion !== '2.0.0' || canonicalJson(value.externalApiV2.runtimeIntents) !== canonicalJson(EXTERNAL_API_V2_RUNTIME_INTENTS)) fail('PORTABLE_SYNTHETIC_DEMO_RUNTIME_INTENT_WIDENING_DENIED');
  assertExactKeys(value.layers, FLOW_KEYS, 'PORTABLE_SYNTHETIC_DEMO_LAYERS_SURFACE_DENIED');
  validateLayerCommon(value.layers.status, ['action', 'localUtilityStatus', 'runtimeStatus', 'analysisSucceeded', 'readbackSucceeded', 'dispatch', 'reportDigest'], 'PORTABLE_SYNTHETIC_DEMO_STATUS_LAYER_DENIED');
  if (value.layers.status.action !== 'doctor.readiness.check' || value.layers.status.localUtilityStatus !== 'READY_LOCAL_UTILITY' || value.layers.status.runtimeStatus !== 'RUNTIME_UNAVAILABLE' || value.layers.status.analysisSucceeded !== false || value.layers.status.readbackSucceeded !== false) fail('PORTABLE_SYNTHETIC_DEMO_FALSE_RUNTIME_STATUS_DENIED');
  validateLayerCommon(value.layers.guidance, ['action', 'selectedCapabilityKey', 'selectedCapabilityId', 'advisoryOnly', 'dispatch', 'reportDigest'], 'PORTABLE_SYNTHETIC_DEMO_GUIDANCE_LAYER_DENIED');
  if (value.layers.guidance.action !== 'capability.explorer.read' || value.layers.guidance.selectedCapabilityKey !== 'bi.preview.create' || value.layers.guidance.selectedCapabilityId !== 'bi.preview.create' || value.layers.guidance.advisoryOnly !== true) fail('PORTABLE_SYNTHETIC_DEMO_GUIDANCE_LAYER_DENIED');
  validateLayerCommon(value.layers.template, ['action', 'validationStatus', 'selectedRuntimeIntent', 'placeholderOnly', 'dispatch', 'reportDigest'], 'PORTABLE_SYNTHETIC_DEMO_TEMPLATE_LAYER_DENIED');
  if (value.layers.template.action !== 'profile-template.validate' || value.layers.template.validationStatus !== 'VALID_PLACEHOLDER_ONLY' || value.layers.template.selectedRuntimeIntent !== 'preview' || value.layers.template.placeholderOnly !== true) fail('PORTABLE_SYNTHETIC_DEMO_TEMPLATE_LAYER_DENIED');
  validateLayerCommon(value.layers.receipt, ['action', 'verificationStatus', 'trustClass', 'liveObservationClaim', 'dispatch', 'reportDigest'], 'PORTABLE_SYNTHETIC_DEMO_RECEIPT_LAYER_DENIED');
  if (value.layers.receipt.action !== 'receipt-envelope.verify' || value.layers.receipt.verificationStatus !== 'VERIFIED_INTEGRITY_ONLY' || value.layers.receipt.trustClass !== 'synthetic-fixture-only' || value.layers.receipt.liveObservationClaim !== false) fail('PORTABLE_SYNTHETIC_DEMO_LIVE_EVIDENCE_CLAIM_DENIED');
  assertExactKeys(value.boundaries, REPORT_BOUNDARY_KEYS, 'PORTABLE_SYNTHETIC_DEMO_REPORT_BOUNDARY_SURFACE_DENIED');
  if (Object.values(value.boundaries).some((item) => item !== false)) fail('PORTABLE_SYNTHETIC_DEMO_REPORT_BOUNDARY_DENIED');
  if (!Array.isArray(value.nonClaims) || value.nonClaims.length !== 6 || value.nonClaims.some((item) => typeof item !== 'string' || item.length > 220 || AFFIRMATIVE_LIVE_CLAIM.test(item))) fail('PORTABLE_SYNTHETIC_DEMO_NONCLAIMS_DENIED');
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'integrity'));
  if (value.integrity?.algorithm !== 'sha256-canonical-json' || value.integrity.digest !== sha256Canonical(body)) fail('PORTABLE_SYNTHETIC_DEMO_REPORT_INTEGRITY_DENIED');
  return value;
}

export function renderPortableSyntheticDemo(input = loadPortableSyntheticDemoFixture()) {
  return `${canonicalJson(runPortableSyntheticDemo(input))}\n`;
}
