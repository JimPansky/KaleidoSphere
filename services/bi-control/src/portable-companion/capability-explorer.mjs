import { readFileSync } from 'node:fs';

import { canonicalJson } from '../canonical-json.js';
import {
  KS_CAPABILITY_MANIFEST_VERSION,
  capabilityManifestV1,
  validateCapabilityManifestV1,
} from '../../../bi-agent/src/capability-manifest-v1.mjs';
import {
  EXTERNAL_API_V2_RUNTIME_INTENTS,
  PORTABLE_COMPANION_CONTRACT_VERSION,
  PORTABLE_COMPANION_REQUEST_SCHEMA,
  sha256Canonical,
  validatePortableUtilityRequestV1,
} from './contract.mjs';

export const PORTABLE_CAPABILITY_EXPLORER_SCHEMA = 'kaleidosphere.portable-companion/capability-explorer/v1';
export const PORTABLE_CAPABILITY_EXPLORER_ACTION = 'capability.explorer.read';

const SOURCE_MAP_PATH = new URL('../../../../SOURCE-MAP.json', import.meta.url);
const SAFE_CAPABILITY_KEY = /^[a-z][a-z0-9.-]{1,80}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const GUIDANCE_CODES = Object.freeze([
  'READ_BOUNDARY_FIRST',
  'REQUIRE_RECEIPT_BEFORE_EVIDENCE',
  'USE_TRUSTED_RUNTIME_OUTSIDE_UTILITY',
  'KEEP_LOCAL_GUIDANCE_ADVISORY',
]);
const LIVE_EVIDENCE_CLAIM = /(?:live\s+evidence|runtime\s+(?:executed|succeeded|verified|available)|analysis\s+succeeded|readback\s+succeeded|receipt\s+(?:accepted|verified)|production\s+ready|customer\s+data\s+verified)/i;
const RUNTIME_INVOCATION = /\b(?:invoke|dispatch|execute|call|run)\s+(?:status|discovery|analyze|plan|preview|readback|runtime\s+intent)\b/i;

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

function sourceMapCommit() {
  return JSON.parse(readFileSync(SOURCE_MAP_PATH, 'utf8')).sourceCommit;
}

function manifestBody(value) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'integrity'));
}

function validateManifestInput(manifest, expectedDigest) {
  const valid = validateCapabilityManifestV1(manifest);
  if (valid.manifestVersion !== KS_CAPABILITY_MANIFEST_VERSION) fail('PORTABLE_CAPABILITY_EXPLORER_STALE_MANIFEST_DENIED');
  if (expectedDigest !== undefined && (!DIGEST.test(expectedDigest) || valid.integrity.digest !== expectedDigest)) {
    fail('PORTABLE_CAPABILITY_EXPLORER_DIGEST_MISMATCH_DENIED');
  }
  return valid;
}

function normalizeCapabilityKey(capabilityKey) {
  if (capabilityKey === undefined || capabilityKey === null) return null;
  if (typeof capabilityKey !== 'string' || !SAFE_CAPABILITY_KEY.test(capabilityKey)) {
    fail('PORTABLE_CAPABILITY_EXPLORER_UNKNOWN_CAPABILITY_DENIED');
  }
  return capabilityKey;
}

function guidance(code, message) {
  if (!GUIDANCE_CODES.includes(code)) fail('PORTABLE_CAPABILITY_EXPLORER_GUIDANCE_DENIED');
  if (LIVE_EVIDENCE_CLAIM.test(message)) fail('PORTABLE_CAPABILITY_EXPLORER_LIVE_EVIDENCE_CLAIM_DENIED');
  if (RUNTIME_INVOCATION.test(message)) fail('PORTABLE_CAPABILITY_EXPLORER_RUNTIME_INVOCATION_DENIED');
  return Object.freeze({ code, message, dispatch: false, claimClass: 'inferred-candidate' });
}

function capabilityGuidance(capability) {
  return Object.freeze([
    guidance('READ_BOUNDARY_FIRST', `${capability.action} is described from the local manifest only; review authority and side-effect limits before using a runtime elsewhere.`),
    guidance('REQUIRE_RECEIPT_BEFORE_EVIDENCE', `${capability.id} cannot support an evidence claim until a separate verified receipt binds the runtime result to this manifest digest.`),
  ]);
}

function projectCapability(capability) {
  return Object.freeze({
    id: capability.id,
    action: capability.action,
    authority: capability.authority,
    sideEffect: capability.sideEffect,
    executableInRuntime: capability.executable,
    dispatch: false,
    evidenceRequirements: {
      attestationBindingRequired: capability.evidence.attestationBindingRequired,
      resultIntegrityDigestRequired: capability.evidence.resultIntegrityDigestRequired,
      executionReceiptRequired: capability.evidence.executionReceiptRequired,
    },
    guidance: capabilityGuidance(capability),
  });
}

export function portableCapabilityExplorerRequest() {
  return Object.freeze({
    schemaVersion: PORTABLE_COMPANION_REQUEST_SCHEMA,
    contractVersion: PORTABLE_COMPANION_CONTRACT_VERSION,
    action: PORTABLE_CAPABILITY_EXPLORER_ACTION,
  });
}

export function validatePortableCapabilityExplorerRequest(value) {
  const request = validatePortableUtilityRequestV1(value, { allowReserved: true });
  if (request.action !== PORTABLE_CAPABILITY_EXPLORER_ACTION) fail('PORTABLE_CAPABILITY_EXPLORER_ACTION_DENIED');
  return request;
}

export function readPortableCapabilityExplorer(request = portableCapabilityExplorerRequest(), options = {}) {
  validatePortableCapabilityExplorerRequest(request);
  assertPlainObject(options, 'PORTABLE_CAPABILITY_EXPLORER_OPTIONS_DENIED');
  const keys = Object.keys(options);
  if (keys.some((key) => !['manifest', 'expectedDigest', 'capabilityKey'].includes(key))) fail('PORTABLE_CAPABILITY_EXPLORER_OPTIONS_DENIED');

  const manifest = validateManifestInput(options.manifest ?? capabilityManifestV1(), options.expectedDigest);
  const capabilityKey = normalizeCapabilityKey(options.capabilityKey);
  const capabilities = manifest.capabilities.map(projectCapability);
  const selected = capabilityKey === null
    ? capabilities
    : capabilities.filter((capability) => capability.id === capabilityKey || capability.action === capabilityKey);
  if (selected.length === 0) fail('PORTABLE_CAPABILITY_EXPLORER_UNKNOWN_CAPABILITY_DENIED', { capabilityKey });

  const reportBody = {
    schemaVersion: PORTABLE_CAPABILITY_EXPLORER_SCHEMA,
    contractVersion: PORTABLE_COMPANION_CONTRACT_VERSION,
    action: PORTABLE_CAPABILITY_EXPLORER_ACTION,
    manifestBinding: {
      schemaVersion: manifest.schemaVersion,
      manifestVersion: manifest.manifestVersion,
      digest: manifest.integrity.digest,
      sourceCommit: sourceMapCommit(),
    },
    externalApiV2: {
      contractId: manifest.contract.id,
      contractVersion: manifest.contract.version,
      runtimeIntents: EXTERNAL_API_V2_RUNTIME_INTENTS,
    },
    selectedCapabilityKey: capabilityKey,
    capabilities: selected,
    boundaries: {
      runtimeDispatchAccepted: false,
      arbitraryEndpointDiscoveryAccepted: false,
      credentialsAccepted: false,
      freeSqlAccepted: false,
      rawSourceRowsAccepted: false,
      liveEvidenceClaimAcceptedWithoutReceipt: false,
    },
    guidance: [
      guidance('USE_TRUSTED_RUNTIME_OUTSIDE_UTILITY', 'Use any runtime transport outside this offline utility and only through the closed External API v2 contract.'),
      guidance('KEEP_LOCAL_GUIDANCE_ADVISORY', 'Treat this output as local advisory guidance, not runtime evidence, BI correctness or production readiness.'),
    ],
    nonClaims: [
      'No runtime dispatch.',
      'No arbitrary endpoint discovery, remote fetch or hosted catalog.',
      'No credentials, free SQL, raw rows, customer payloads or provider payloads.',
      'No live evidence, BI correctness, marketplace, hosted/SaaS, remote-MCP, customer-data or production-readiness claim.',
    ],
  };
  return Object.freeze({
    ...reportBody,
    integrity: Object.freeze({ algorithm: 'sha256-canonical-json', digest: sha256Canonical(reportBody) }),
  });
}

function validateGuidanceItem(item) {
  assertExactKeys(item, ['code', 'message', 'dispatch', 'claimClass'], 'PORTABLE_CAPABILITY_EXPLORER_GUIDANCE_SURFACE_DENIED');
  if (!GUIDANCE_CODES.includes(item.code) || item.dispatch !== false || item.claimClass !== 'inferred-candidate') {
    fail('PORTABLE_CAPABILITY_EXPLORER_GUIDANCE_DENIED');
  }
  if (typeof item.message !== 'string' || item.message.length > 240) fail('PORTABLE_CAPABILITY_EXPLORER_GUIDANCE_DENIED');
  if (LIVE_EVIDENCE_CLAIM.test(item.message)) fail('PORTABLE_CAPABILITY_EXPLORER_LIVE_EVIDENCE_CLAIM_DENIED');
  if (RUNTIME_INVOCATION.test(item.message)) fail('PORTABLE_CAPABILITY_EXPLORER_RUNTIME_INVOCATION_DENIED');
}

export function validatePortableCapabilityExplorerReport(value) {
  assertExactKeys(value, ['schemaVersion', 'contractVersion', 'action', 'manifestBinding', 'externalApiV2', 'selectedCapabilityKey', 'capabilities', 'boundaries', 'guidance', 'nonClaims', 'integrity'], 'PORTABLE_CAPABILITY_EXPLORER_REPORT_SURFACE_DENIED');
  if (value.schemaVersion !== PORTABLE_CAPABILITY_EXPLORER_SCHEMA) fail('PORTABLE_CAPABILITY_EXPLORER_SCHEMA_DENIED');
  if (value.contractVersion !== PORTABLE_COMPANION_CONTRACT_VERSION || value.action !== PORTABLE_CAPABILITY_EXPLORER_ACTION) fail('PORTABLE_CAPABILITY_EXPLORER_ACTION_DENIED');
  assertExactKeys(value.manifestBinding, ['schemaVersion', 'manifestVersion', 'digest', 'sourceCommit'], 'PORTABLE_CAPABILITY_EXPLORER_BINDING_SURFACE_DENIED');
  if (value.manifestBinding.manifestVersion !== KS_CAPABILITY_MANIFEST_VERSION || !DIGEST.test(value.manifestBinding.digest)) fail('PORTABLE_CAPABILITY_EXPLORER_STALE_MANIFEST_DENIED');
  if (!/^[a-f0-9]{40}$/.test(value.manifestBinding.sourceCommit)) fail('PORTABLE_CAPABILITY_EXPLORER_SOURCE_COMMIT_DENIED');
  assertExactKeys(value.externalApiV2, ['contractId', 'contractVersion', 'runtimeIntents'], 'PORTABLE_CAPABILITY_EXPLORER_EXTERNAL_API_SURFACE_DENIED');
  if (JSON.stringify(value.externalApiV2.runtimeIntents) !== JSON.stringify(EXTERNAL_API_V2_RUNTIME_INTENTS)) fail('PORTABLE_CAPABILITY_EXPLORER_RUNTIME_INTENT_WIDENING_DENIED');
  if (value.selectedCapabilityKey !== null) normalizeCapabilityKey(value.selectedCapabilityKey);
  if (!Array.isArray(value.capabilities) || value.capabilities.length < 1 || value.capabilities.length > 6) fail('PORTABLE_CAPABILITY_EXPLORER_CAPABILITIES_DENIED');
  const manifest = validateManifestInput(capabilityManifestV1(), value.manifestBinding.digest);
  for (const capability of value.capabilities) {
    assertExactKeys(capability, ['id', 'action', 'authority', 'sideEffect', 'executableInRuntime', 'dispatch', 'evidenceRequirements', 'guidance'], 'PORTABLE_CAPABILITY_EXPLORER_CAPABILITY_SURFACE_DENIED');
    if (!manifest.capabilities.some((item) => item.id === capability.id && item.action === capability.action)) fail('PORTABLE_CAPABILITY_EXPLORER_UNKNOWN_CAPABILITY_DENIED');
    if (capability.dispatch !== false) fail('PORTABLE_CAPABILITY_EXPLORER_RUNTIME_INVOCATION_DENIED');
    assertExactKeys(capability.evidenceRequirements, ['attestationBindingRequired', 'resultIntegrityDigestRequired', 'executionReceiptRequired'], 'PORTABLE_CAPABILITY_EXPLORER_EVIDENCE_SURFACE_DENIED');
    if (Object.values(capability.evidenceRequirements).some((item) => item !== true)) fail('PORTABLE_CAPABILITY_EXPLORER_EVIDENCE_REQUIREMENT_DENIED');
    if (!Array.isArray(capability.guidance) || capability.guidance.length !== 2) fail('PORTABLE_CAPABILITY_EXPLORER_GUIDANCE_DENIED');
    capability.guidance.forEach(validateGuidanceItem);
  }
  assertExactKeys(value.boundaries, ['runtimeDispatchAccepted', 'arbitraryEndpointDiscoveryAccepted', 'credentialsAccepted', 'freeSqlAccepted', 'rawSourceRowsAccepted', 'liveEvidenceClaimAcceptedWithoutReceipt'], 'PORTABLE_CAPABILITY_EXPLORER_BOUNDARY_SURFACE_DENIED');
  if (Object.values(value.boundaries).some((item) => item !== false)) fail('PORTABLE_CAPABILITY_EXPLORER_BOUNDARY_DENIED');
  if (!Array.isArray(value.guidance) || value.guidance.length !== 2) fail('PORTABLE_CAPABILITY_EXPLORER_GUIDANCE_DENIED');
  value.guidance.forEach(validateGuidanceItem);
  if (!Array.isArray(value.nonClaims) || value.nonClaims.length !== 4) fail('PORTABLE_CAPABILITY_EXPLORER_NONCLAIMS_DENIED');
  if (canonicalJson(value).includes('"dispatch":true')) fail('PORTABLE_CAPABILITY_EXPLORER_RUNTIME_INVOCATION_DENIED');
  const body = manifestBody(value);
  if (value.integrity?.algorithm !== 'sha256-canonical-json' || value.integrity.digest !== sha256Canonical(body)) fail('PORTABLE_CAPABILITY_EXPLORER_REPORT_INTEGRITY_DENIED');
  return value;
}
