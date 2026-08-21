import { readFileSync } from 'node:fs';

import { canonicalJson } from '../canonical-json.js';
import {
  PORTABLE_COMPANION_CONTRACT_VERSION,
  PORTABLE_COMPANION_REQUEST_SCHEMA,
  portableCompanionManifestV1,
  sha256Canonical,
  validatePortableUtilityRequestV1,
} from './contract.mjs';

export const PORTABLE_DOCTOR_READINESS_SCHEMA = 'kaleidosphere.portable-companion/doctor-readiness/v1';
export const PORTABLE_DOCTOR_ACTION = 'doctor.readiness.check';

export const LOCAL_UTILITY_STATUSES = Object.freeze([
  'READY_LOCAL_UTILITY',
  'LOCAL_PARTIAL_CONFIGURATION',
  'LOCAL_BLOCKED',
]);

export const RUNTIME_STATUSES = Object.freeze([
  'RUNTIME_AVAILABLE',
  'RUNTIME_UNAVAILABLE',
  'RUNTIME_PARTIAL',
]);

export const DOCTOR_CHECK_STATUSES = Object.freeze([
  'PASS',
  'WARN',
  'FAIL',
  'MISSING',
  'PARTIAL',
  'STALE',
  'UNSUPPORTED',
]);

const PACKAGE_PATH = new URL('../../../../package.json', import.meta.url);
const SNAPSHOT_KEYS = Object.freeze(['hostBundle', 'runtime', 'transport', 'capabilityManifest', 'configuration']);
const HOST_BUNDLE_KEYS = Object.freeze(['id', 'version', 'supported']);
const STATE_KEYS = Object.freeze(['state']);
const CAPABILITY_MANIFEST_KEYS = Object.freeze(['state', 'observedDigest', 'expectedDigest']);
const CONFIGURATION_KEYS = Object.freeze(['state', 'missing']);
const RUNTIME_STATES = Object.freeze(['present', 'missing', 'partial']);
const TRANSPORT_STATES = Object.freeze(['configured', 'missing', 'partial']);
const MANIFEST_STATES = Object.freeze(['current', 'missing', 'stale']);
const CONFIGURATION_STATES = Object.freeze(['complete', 'partial', 'missing']);
const CONFIGURATION_ITEMS = Object.freeze([
  'runtime.identity',
  'transport.profile',
  'capability-manifest.file',
  'host-bundle.support',
]);
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const VERSION = /^v\d+\.\d+\.\d+$/;
const SECRET_KEY = /(?:authorization|api_?key|credential|password|secret|token|cookie|private_?key|connection(?:_?string)?|dsn)/i;
const UNSAFE_TEXT = /(?:\b(?:bearer\s+[a-z0-9._:-]{8,}|password|credential|secret|token|api[_ -]?key|private\s+key|connection\s*string|dsn|jdbc:|postgres(?:ql)?:\/\/|mysql:\/\/|mssql:\/\/|oracle:\/\/|mongodb(?:\+srv)?:\/\/|https?:\/\/|redirect|localhost|service\s*start|start\s+service|systemctl|curl|wget|analyze\s+succeeded|readback\s+succeeded|analysis\s+success|runtime\s+success)\b)/i;

function fail(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  throw error;
}

function packageVersion() {
  return `v${JSON.parse(readFileSync(PACKAGE_PATH, 'utf8')).version}`;
}

function assertPlainObject(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(code);
}

function assertExactKeys(value, allowed, code) {
  assertPlainObject(value, code);
  const keys = Object.keys(value);
  const unexpected = keys.filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) fail(code, { keys: unexpected });
}

function assertSafeInspectionValue(value, path = '$') {
  if (typeof value === 'string') {
    if (/[\u0000-\u001f\u007f]/.test(value) || value.length > 200 || UNSAFE_TEXT.test(value)) fail('PORTABLE_DOCTOR_UNSAFE_INSPECTION_DENIED', { path });
    return;
  }
  if (value === null || typeof value === 'boolean') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeInspectionValue(item, `${path}[${index}]`));
    return;
  }
  assertPlainObject(value, 'PORTABLE_DOCTOR_INSPECTION_SURFACE_DENIED');
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) fail('PORTABLE_DOCTOR_SECRET_FIELD_DENIED', { path: `${path}.${key}` });
    assertSafeInspectionValue(child, `${path}.${key}`);
  }
}

function readEnum(value, allowed, code, path) {
  if (!allowed.includes(value)) fail(code, { path, value });
  return value;
}

function normalizeSnapshot(snapshot = {}) {
  assertExactKeys(snapshot, SNAPSHOT_KEYS, 'PORTABLE_DOCTOR_INSPECTION_SURFACE_DENIED');
  assertSafeInspectionValue(snapshot);
  const manifest = portableCompanionManifestV1();
  const currentVersion = packageVersion();
  const normalized = {
    hostBundle: { id: 'kaleidosphere', version: currentVersion, supported: true },
    runtime: { state: 'missing' },
    transport: { state: 'missing' },
    capabilityManifest: { state: 'missing', observedDigest: null, expectedDigest: manifest.integrity.digest },
    configuration: { state: 'complete', missing: [] },
  };

  if (snapshot.hostBundle !== undefined) {
    assertExactKeys(snapshot.hostBundle, HOST_BUNDLE_KEYS, 'PORTABLE_DOCTOR_HOST_BUNDLE_SURFACE_DENIED');
    if (snapshot.hostBundle.id !== 'kaleidosphere') fail('PORTABLE_DOCTOR_HOST_BUNDLE_DENIED');
    if (!VERSION.test(snapshot.hostBundle.version)) fail('PORTABLE_DOCTOR_HOST_BUNDLE_VERSION_DENIED');
    if (typeof snapshot.hostBundle.supported !== 'boolean') fail('PORTABLE_DOCTOR_HOST_BUNDLE_SUPPORT_DENIED');
    normalized.hostBundle = { ...snapshot.hostBundle };
  }

  if (snapshot.runtime !== undefined) {
    assertExactKeys(snapshot.runtime, STATE_KEYS, 'PORTABLE_DOCTOR_RUNTIME_SURFACE_DENIED');
    normalized.runtime = { state: readEnum(snapshot.runtime.state, RUNTIME_STATES, 'PORTABLE_DOCTOR_RUNTIME_STATE_DENIED', '$.runtime.state') };
  }

  if (snapshot.transport !== undefined) {
    assertExactKeys(snapshot.transport, STATE_KEYS, 'PORTABLE_DOCTOR_TRANSPORT_SURFACE_DENIED');
    normalized.transport = { state: readEnum(snapshot.transport.state, TRANSPORT_STATES, 'PORTABLE_DOCTOR_TRANSPORT_STATE_DENIED', '$.transport.state') };
  }

  if (snapshot.capabilityManifest !== undefined) {
    assertExactKeys(snapshot.capabilityManifest, CAPABILITY_MANIFEST_KEYS, 'PORTABLE_DOCTOR_MANIFEST_SURFACE_DENIED');
    const state = readEnum(snapshot.capabilityManifest.state, MANIFEST_STATES, 'PORTABLE_DOCTOR_MANIFEST_STATE_DENIED', '$.capabilityManifest.state');
    const expectedDigest = snapshot.capabilityManifest.expectedDigest ?? manifest.integrity.digest;
    const observedDigest = snapshot.capabilityManifest.observedDigest ?? null;
    if (!SHA256_DIGEST.test(expectedDigest)) fail('PORTABLE_DOCTOR_MANIFEST_DIGEST_DENIED');
    if (observedDigest !== null && !SHA256_DIGEST.test(observedDigest)) fail('PORTABLE_DOCTOR_MANIFEST_DIGEST_DENIED');
    if (state === 'current' && observedDigest !== expectedDigest) fail('PORTABLE_DOCTOR_MANIFEST_STALE_DENIED');
    if (state === 'missing' && observedDigest !== null) fail('PORTABLE_DOCTOR_MANIFEST_DIGEST_DENIED');
    normalized.capabilityManifest = { state, observedDigest, expectedDigest };
  }

  if (snapshot.configuration !== undefined) {
    assertExactKeys(snapshot.configuration, CONFIGURATION_KEYS, 'PORTABLE_DOCTOR_CONFIGURATION_SURFACE_DENIED');
    const state = readEnum(snapshot.configuration.state, CONFIGURATION_STATES, 'PORTABLE_DOCTOR_CONFIGURATION_STATE_DENIED', '$.configuration.state');
    if (!Array.isArray(snapshot.configuration.missing)) fail('PORTABLE_DOCTOR_CONFIGURATION_MISSING_DENIED');
    const missing = [...snapshot.configuration.missing].sort();
    if (missing.some((item) => !CONFIGURATION_ITEMS.includes(item))) fail('PORTABLE_DOCTOR_CONFIGURATION_MISSING_DENIED');
    normalized.configuration = { state, missing };
  }

  return normalized;
}

function guidance(code, message) {
  return Object.freeze({ code, message, dispatch: false });
}

function check(id, status, summary) {
  return Object.freeze({ id, status, summary });
}

function deriveRuntimeStatus(snapshot) {
  if (snapshot.runtime.state === 'missing') return 'RUNTIME_UNAVAILABLE';
  if (
    snapshot.runtime.state === 'present'
    && snapshot.transport.state === 'configured'
    && snapshot.capabilityManifest.state === 'current'
  ) {
    return 'RUNTIME_AVAILABLE';
  }
  return 'RUNTIME_PARTIAL';
}

function deriveLocalUtilityStatus(snapshot) {
  if (!snapshot.hostBundle.supported) return 'LOCAL_BLOCKED';
  if (snapshot.configuration.state !== 'complete') return 'LOCAL_PARTIAL_CONFIGURATION';
  return 'READY_LOCAL_UTILITY';
}

function buildChecks(snapshot) {
  return Object.freeze([
    check('host-bundle', snapshot.hostBundle.supported ? 'PASS' : 'UNSUPPORTED', snapshot.hostBundle.supported ? 'Host bundle is supported for Portable Companion v1.' : 'Host bundle is not supported for Portable Companion v1.'),
    check('local-configuration', snapshot.configuration.state === 'complete' ? 'PASS' : snapshot.configuration.state === 'partial' ? 'PARTIAL' : 'MISSING', snapshot.configuration.state === 'complete' ? 'Local utility configuration is complete.' : 'Local utility configuration is incomplete.'),
    check('runtime-presence', snapshot.runtime.state === 'present' ? 'PASS' : snapshot.runtime.state === 'partial' ? 'PARTIAL' : 'MISSING', snapshot.runtime.state === 'present' ? 'Runtime was reported present by the caller-provided local snapshot.' : 'Runtime is not available for execution claims.'),
    check('transport', snapshot.transport.state === 'configured' ? 'PASS' : snapshot.transport.state === 'partial' ? 'PARTIAL' : 'MISSING', snapshot.transport.state === 'configured' ? 'Transport was reported configured by the caller-provided local snapshot.' : 'Transport is not configured for runtime dispatch.'),
    check('capability-manifest', snapshot.capabilityManifest.state === 'current' ? 'PASS' : snapshot.capabilityManifest.state === 'stale' ? 'STALE' : 'MISSING', snapshot.capabilityManifest.state === 'current' ? 'Capability manifest is current for local readiness reporting.' : 'Capability manifest cannot support a runtime-available claim.'),
  ]);
}

function buildGuidance(snapshot, localUtilityStatus, runtimeStatus) {
  const items = [];
  if (!snapshot.hostBundle.supported) items.push(guidance('UNSUPPORTED_HOST_BUNDLE', 'Use a supported KaleidoSphere release bundle before relying on the portable utility.'));
  if (snapshot.configuration.state !== 'complete') items.push(guidance('COMPLETE_LOCAL_CONFIGURATION', 'Complete the named local configuration prerequisites, then rerun the offline doctor.'));
  if (snapshot.runtime.state === 'missing') items.push(guidance('RUNTIME_MISSING', 'Runtime-dependent analysis and readback remain unavailable until a trusted runtime is supplied outside this utility.'));
  if (snapshot.runtime.state === 'partial') items.push(guidance('RUNTIME_PARTIAL', 'Resolve the partial runtime state outside this utility before making runtime availability claims.'));
  if (snapshot.transport.state === 'missing') items.push(guidance('TRANSPORT_MISSING', 'Configure a trusted transport outside this utility before making runtime availability claims.'));
  if (snapshot.transport.state === 'partial') items.push(guidance('TRANSPORT_PARTIAL', 'Complete trusted transport configuration outside this utility before making runtime availability claims.'));
  if (snapshot.capabilityManifest.state === 'stale') items.push(guidance('STALE_CAPABILITY_MANIFEST', 'Refresh the capability manifest from the current release bytes before claiming runtime availability.'));
  if (snapshot.capabilityManifest.state === 'missing') items.push(guidance('CAPABILITY_MANIFEST_MISSING', 'Provide the current local capability manifest digest before claiming runtime availability.'));
  if (items.length === 0 && localUtilityStatus === 'READY_LOCAL_UTILITY' && runtimeStatus === 'RUNTIME_AVAILABLE') {
    items.push(guidance('READY_WITH_RUNTIME', 'Local utility checks and runtime-availability prerequisites are satisfied by the caller-provided snapshot.'));
  }
  if (items.length === 0) items.push(guidance('READY_LOCAL_ONLY', 'The portable utility is ready locally; runtime-dependent actions remain separately gated.'));
  return Object.freeze(items.slice(0, 6));
}

export function portableDoctorRequest() {
  return Object.freeze({
    schemaVersion: PORTABLE_COMPANION_REQUEST_SCHEMA,
    contractVersion: PORTABLE_COMPANION_CONTRACT_VERSION,
    action: PORTABLE_DOCTOR_ACTION,
  });
}

export function validatePortableDoctorRequest(value) {
  const request = validatePortableUtilityRequestV1(value, { allowReserved: true });
  if (request.action !== PORTABLE_DOCTOR_ACTION) fail('PORTABLE_DOCTOR_ACTION_DENIED');
  return request;
}

export function evaluatePortableDoctorReadiness(snapshot = {}) {
  const normalized = normalizeSnapshot(snapshot);
  const localUtilityStatus = deriveLocalUtilityStatus(normalized);
  const runtimeStatus = deriveRuntimeStatus(normalized);
  const reportBody = {
    schemaVersion: PORTABLE_DOCTOR_READINESS_SCHEMA,
    contractVersion: PORTABLE_COMPANION_CONTRACT_VERSION,
    action: PORTABLE_DOCTOR_ACTION,
    localUtilityStatus,
    runtimeStatus,
    statuses: {
      readyLocalUtility: localUtilityStatus === 'READY_LOCAL_UTILITY',
      runtimeAvailable: runtimeStatus === 'RUNTIME_AVAILABLE',
      analysisSucceeded: false,
      readbackSucceeded: false,
    },
    inspected: normalized,
    checks: buildChecks(normalized),
    guidance: buildGuidance(normalized, localUtilityStatus, runtimeStatus),
    nonClaims: [
      'No runtime dispatch.',
      'No network probing, web-location following, endpoint discovery or service activation.',
      'No credentials, connection strings, raw rows or provider payloads inspected.',
      'No analysis, readback, live evidence, hosted/SaaS or production readiness success is claimed.',
    ],
  };
  return Object.freeze({
    ...reportBody,
    integrity: Object.freeze({ algorithm: 'sha256-canonical-json', digest: sha256Canonical(reportBody) }),
  });
}

export function checkPortableDoctorReadiness(request = portableDoctorRequest(), snapshot = {}) {
  validatePortableDoctorRequest(request);
  return evaluatePortableDoctorReadiness(snapshot);
}

export function validatePortableDoctorReadinessReport(value) {
  assertExactKeys(value, ['schemaVersion', 'contractVersion', 'action', 'localUtilityStatus', 'runtimeStatus', 'statuses', 'inspected', 'checks', 'guidance', 'nonClaims', 'integrity'], 'PORTABLE_DOCTOR_REPORT_SURFACE_DENIED');
  if (value.schemaVersion !== PORTABLE_DOCTOR_READINESS_SCHEMA) fail('PORTABLE_DOCTOR_REPORT_SCHEMA_DENIED');
  if (value.contractVersion !== PORTABLE_COMPANION_CONTRACT_VERSION) fail('PORTABLE_DOCTOR_CONTRACT_VERSION_DENIED');
  if (value.action !== PORTABLE_DOCTOR_ACTION) fail('PORTABLE_DOCTOR_ACTION_DENIED');
  if (!LOCAL_UTILITY_STATUSES.includes(value.localUtilityStatus)) fail('PORTABLE_DOCTOR_LOCAL_STATUS_DENIED');
  if (!RUNTIME_STATUSES.includes(value.runtimeStatus)) fail('PORTABLE_DOCTOR_RUNTIME_STATUS_DENIED');
  assertExactKeys(value.statuses, ['readyLocalUtility', 'runtimeAvailable', 'analysisSucceeded', 'readbackSucceeded'], 'PORTABLE_DOCTOR_STATUS_SURFACE_DENIED');
  if (typeof value.statuses.readyLocalUtility !== 'boolean' || typeof value.statuses.runtimeAvailable !== 'boolean') fail('PORTABLE_DOCTOR_STATUS_DENIED');
  if (value.statuses.analysisSucceeded !== false || value.statuses.readbackSucceeded !== false) fail('PORTABLE_DOCTOR_FALSE_RUNTIME_SUCCESS_DENIED');
  if (value.runtimeStatus !== 'RUNTIME_AVAILABLE' && value.statuses.runtimeAvailable !== false) fail('PORTABLE_DOCTOR_FALSE_RUNTIME_SUCCESS_DENIED');
  normalizeSnapshot(value.inspected);
  if (!Array.isArray(value.checks) || value.checks.length !== 5) fail('PORTABLE_DOCTOR_CHECKS_DENIED');
  for (const item of value.checks) {
    assertExactKeys(item, ['id', 'status', 'summary'], 'PORTABLE_DOCTOR_CHECK_SURFACE_DENIED');
    if (!DOCTOR_CHECK_STATUSES.includes(item.status)) fail('PORTABLE_DOCTOR_CHECK_STATUS_DENIED');
    assertSafeInspectionValue(item);
  }
  if (!Array.isArray(value.guidance) || value.guidance.length < 1 || value.guidance.length > 6) fail('PORTABLE_DOCTOR_GUIDANCE_DENIED');
  for (const item of value.guidance) {
    assertExactKeys(item, ['code', 'message', 'dispatch'], 'PORTABLE_DOCTOR_GUIDANCE_SURFACE_DENIED');
    if (item.dispatch !== false) fail('PORTABLE_DOCTOR_DISPATCH_DENIED');
    assertSafeInspectionValue(item);
  }
  if (!Array.isArray(value.nonClaims) || value.nonClaims.length !== 4) fail('PORTABLE_DOCTOR_NONCLAIMS_DENIED');
  assertSafeInspectionValue(value.nonClaims);
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'integrity'));
  if (value.integrity?.algorithm !== 'sha256-canonical-json' || value.integrity.digest !== sha256Canonical(body)) fail('PORTABLE_DOCTOR_REPORT_INTEGRITY_DENIED');
  if (canonicalJson(value).includes('RUNTIME_AVAILABLE') && value.runtimeStatus !== 'RUNTIME_AVAILABLE') fail('PORTABLE_DOCTOR_FALSE_RUNTIME_SUCCESS_DENIED');
  return value;
}
