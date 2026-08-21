import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { canonicalJson } from '../canonical-json.js';

export const PORTABLE_COMPANION_CONTRACT_ID = 'kaleidosphere.portable-companion';
export const PORTABLE_COMPANION_CONTRACT_VERSION = '1.0.0';
export const PORTABLE_COMPANION_CONTRACT_SCHEMA = 'kaleidosphere.portable-companion/contract/v1';
export const PORTABLE_COMPANION_REQUEST_SCHEMA = 'kaleidosphere.portable-companion/utility-request/v1';
export const PORTABLE_COMPANION_COMPATIBILITY_SCHEMA = 'kaleidosphere.portable-companion/compatibility-matrix/v1';

export const EXTERNAL_API_V2_RUNTIME_INTENTS = Object.freeze(['status', 'discovery', 'analyze', 'plan', 'preview', 'readback']);
export const PORTABLE_COMPANION_MAX_REQUEST_BYTES = 8192;
export const PORTABLE_COMPANION_MAX_JSON_DEPTH = 8;

export const PORTABLE_COMPANION_CLAIM_CLASSES = Object.freeze([
  'observed-fact',
  'computed-fact',
  'inferred-candidate',
  'human-decision',
  'non-claim',
]);

export const PORTABLE_COMPANION_BOUNDARIES = Object.freeze({
  offlinePortableUtilitiesOnly: true,
  runtimeDispatchAccepted: false,
  arbitraryEndpointDiscoveryAccepted: false,
  credentialsAccepted: false,
  freeSqlAccepted: false,
  rawSourceRowsAccepted: false,
  providerPayloadsAccepted: false,
  mutationAuthority: false,
  deployAuthority: false,
  evidenceClaimAuthority: false,
  hostedSaasAccepted: false,
  remoteMcpAccepted: false,
});

export const PORTABLE_COMPANION_UTILITY_ACTIONS = Object.freeze([
  Object.freeze({ id: 'contract.describe', ownerIssue: 81, lifecycle: 'foundation', runtimeIntent: null, authority: 'offline-utility-only', sideEffect: 'none', claimClass: 'computed-fact', dispatch: false }),
  Object.freeze({ id: 'compatibility.matrix.read', ownerIssue: 81, lifecycle: 'foundation', runtimeIntent: null, authority: 'offline-utility-only', sideEffect: 'none', claimClass: 'computed-fact', dispatch: false }),
  Object.freeze({ id: 'threat-model.read', ownerIssue: 81, lifecycle: 'foundation', runtimeIntent: null, authority: 'offline-utility-only', sideEffect: 'none', claimClass: 'non-claim', dispatch: false }),
  Object.freeze({ id: 'source-map.verify', ownerIssue: 81, lifecycle: 'foundation', runtimeIntent: null, authority: 'offline-utility-only', sideEffect: 'local-validation-only', claimClass: 'computed-fact', dispatch: false }),
  Object.freeze({ id: 'doctor.readiness.check', ownerIssue: 82, lifecycle: 'reserved', runtimeIntent: 'status', authority: 'offline-utility-only', sideEffect: 'local-validation-only', claimClass: 'computed-fact', dispatch: false }),
  Object.freeze({ id: 'capability.explorer.read', ownerIssue: 83, lifecycle: 'reserved', runtimeIntent: 'discovery', authority: 'offline-utility-only', sideEffect: 'none', claimClass: 'inferred-candidate', dispatch: false }),
  Object.freeze({ id: 'profile-template.validate', ownerIssue: 84, lifecycle: 'reserved', runtimeIntent: 'analyze', authority: 'offline-utility-only', sideEffect: 'local-validation-only', claimClass: 'computed-fact', dispatch: false }),
  Object.freeze({ id: 'receipt-envelope.verify', ownerIssue: 85, lifecycle: 'reserved', runtimeIntent: 'readback', authority: 'offline-utility-only', sideEffect: 'local-validation-only', claimClass: 'computed-fact', dispatch: false }),
  Object.freeze({ id: 'synthetic-demo.run', ownerIssue: 86, lifecycle: 'reserved', runtimeIntent: 'preview', authority: 'offline-utility-only', sideEffect: 'local-fixture-only', claimClass: 'observed-fact', dispatch: false }),
  Object.freeze({ id: 'evidence-inspector.inspect', ownerIssue: 87, lifecycle: 'reserved', runtimeIntent: 'readback', authority: 'offline-utility-only', sideEffect: 'local-validation-only', claimClass: 'computed-fact', dispatch: false }),
  Object.freeze({ id: 'cross-harness.verify', ownerIssue: 88, lifecycle: 'reserved', runtimeIntent: null, authority: 'offline-utility-only', sideEffect: 'local-validation-only', claimClass: 'computed-fact', dispatch: false }),
]);

const SCHEMA_PATH = new URL('../../../../contracts/portable-companion/v1/portable-companion.schema.json', import.meta.url);
const MATRIX_PATH = new URL('../../../../contracts/portable-companion/v1/compatibility-matrix.json', import.meta.url);
const SOURCE_MAP_PATH = new URL('../../../../SOURCE-MAP.json', import.meta.url);
const PACKAGE_PATH = new URL('../../../../package.json', import.meta.url);

const FORBIDDEN_KEY = /(?:^|_)(?:authorization|api_?key|credential|password|secret|token|cookie|private_?key|sql|query|raw|rows?|record|provider|payload|url|uri|endpoint|host|port|mutation|deploy|apply|write|delete|publish|claim)(?:$|_)/i;
const FORBIDDEN_TEXT = /(?:\b(?:select|insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|exec(?:ute)?|dbcc|backup|restore)\b|\b(?:raw\s+sql|sql\s+lab|free\s+sql|bearer\s+[a-z0-9._:-]{8,}|password|credential|secret|token|api[_ -]?key|private\s+key|raw\s+(?:source\s+)?rows?|provider\s+payload|endpoint|localhost|https?:\/\/|deploy|mutation|mutate|apply|publish|live\s+evidence|production\s+readiness|customer\s+data|marketplace|remote\s+mcp|hosted\s+saas)\b)/i;
const NORMALIZE_KEY = /([a-z0-9])([A-Z])/g;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;

function fail(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  throw error;
}

export function sha256Canonical(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function sha256Bytes(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function readJson(url) {
  return JSON.parse(readFileSync(url, 'utf8'));
}

export function loadPortableCompanionSchema() {
  return readJson(SCHEMA_PATH);
}

export function loadPortableCompanionCompatibilityMatrix() {
  return readJson(MATRIX_PATH);
}

function assertPlainObject(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(code);
}

function assertExactKeys(value, allowed, required, code) {
  assertPlainObject(value, code);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))) fail(code, { keys });
}

function jsonDepth(value) {
  if (value === null || typeof value !== 'object') return 0;
  if (Array.isArray(value)) return 1 + Math.max(0, ...value.map(jsonDepth));
  assertPlainObject(value, 'PORTABLE_COMPANION_NON_JSON_VALUE_DENIED');
  return 1 + Math.max(0, ...Object.values(value).map(jsonDepth));
}

function assertJsonBounds(value) {
  const serialized = canonicalJson(value);
  if (Buffer.byteLength(serialized, 'utf8') > PORTABLE_COMPANION_MAX_REQUEST_BYTES) fail('PORTABLE_COMPANION_SIZE_LIMIT_DENIED');
  if (jsonDepth(value) > PORTABLE_COMPANION_MAX_JSON_DEPTH) fail('PORTABLE_COMPANION_DEPTH_LIMIT_DENIED');
}

function assertNoUnsafeSurface(value, path = '$') {
  if (typeof value === 'string') {
    if (FORBIDDEN_TEXT.test(value)) fail('PORTABLE_COMPANION_UNSAFE_SURFACE_DENIED', { path });
    if (/[\u0000-\u001f\u007f]/.test(value) || value.length > 500) fail('PORTABLE_COMPANION_TEXT_BOUNDS_DENIED', { path });
    return;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoUnsafeSurface(item, `${path}[${index}]`));
    return;
  }
  assertPlainObject(value, 'PORTABLE_COMPANION_NON_JSON_VALUE_DENIED');
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(NORMALIZE_KEY, '$1_$2').replaceAll(/[^a-z0-9]+/gi, '_').toLowerCase();
    if (FORBIDDEN_KEY.test(normalized)) fail('PORTABLE_COMPANION_FORBIDDEN_FIELD_DENIED', { path: `${path}.${key}` });
    assertNoUnsafeSurface(child, `${path}.${key}`);
  }
}

function assertActionDescriptors(actions) {
  if (!Array.isArray(actions) || actions.length !== PORTABLE_COMPANION_UTILITY_ACTIONS.length) fail('PORTABLE_COMPANION_ACTION_SET_DENIED');
  const ids = new Set();
  for (const [index, action] of actions.entries()) {
    assertExactKeys(action, ['id', 'ownerIssue', 'lifecycle', 'runtimeIntent', 'authority', 'sideEffect', 'claimClass', 'dispatch'], ['id', 'ownerIssue', 'lifecycle', 'runtimeIntent', 'authority', 'sideEffect', 'claimClass', 'dispatch'], 'PORTABLE_COMPANION_ACTION_DESCRIPTOR_DENIED');
    const expected = PORTABLE_COMPANION_UTILITY_ACTIONS[index];
    if (JSON.stringify(action) !== JSON.stringify(expected)) fail('PORTABLE_COMPANION_ACTION_DRIFT_DENIED', { action: action.id, expected: expected.id });
    if (ids.has(action.id)) fail('PORTABLE_COMPANION_DUPLICATE_ACTION_DENIED', { action: action.id });
    ids.add(action.id);
    if (action.dispatch !== false || action.authority !== 'offline-utility-only') fail('PORTABLE_COMPANION_RUNTIME_DISPATCH_DENIED', { action: action.id });
    if (action.runtimeIntent !== null && !EXTERNAL_API_V2_RUNTIME_INTENTS.includes(action.runtimeIntent)) fail('PORTABLE_COMPANION_RUNTIME_INTENT_DENIED', { action: action.id });
  }
}

export function validateCompatibilityMatrixV1(matrix = loadPortableCompanionCompatibilityMatrix()) {
  assertExactKeys(matrix, ['schemaVersion', 'contract', 'externalApiV2', 'portableUtilityActions', 'claimClasses', 'boundaries', 'threatModel', 'nonClaims'], ['schemaVersion', 'contract', 'externalApiV2', 'portableUtilityActions', 'claimClasses', 'boundaries', 'threatModel', 'nonClaims'], 'PORTABLE_COMPANION_MATRIX_SURFACE_DENIED');
  if (matrix.schemaVersion !== PORTABLE_COMPANION_COMPATIBILITY_SCHEMA) fail('PORTABLE_COMPANION_MATRIX_SCHEMA_DENIED');
  if (matrix.contract?.id !== PORTABLE_COMPANION_CONTRACT_ID || matrix.contract?.version !== PORTABLE_COMPANION_CONTRACT_VERSION) fail('PORTABLE_COMPANION_CONTRACT_VERSION_DENIED');
  if (matrix.externalApiV2?.contractVersion !== '2.0.0') fail('PORTABLE_COMPANION_EXTERNAL_API_VERSION_DENIED');
  if (matrix.externalApiV2?.wideningAllowed !== false) fail('PORTABLE_COMPANION_RUNTIME_INTENT_WIDENING_DENIED');
  if (matrix.externalApiV2?.runtimeIntentCount !== 6) fail('PORTABLE_COMPANION_RUNTIME_INTENT_WIDENING_DENIED');
  if (JSON.stringify(matrix.externalApiV2?.runtimeIntents) !== JSON.stringify(EXTERNAL_API_V2_RUNTIME_INTENTS)) fail('PORTABLE_COMPANION_RUNTIME_INTENT_WIDENING_DENIED');
  assertActionDescriptors(matrix.portableUtilityActions);
  if (JSON.stringify(matrix.claimClasses.map((item) => item.id)) !== JSON.stringify(PORTABLE_COMPANION_CLAIM_CLASSES)) fail('PORTABLE_COMPANION_CLAIM_CLASS_DENIED');
  if (JSON.stringify(matrix.boundaries) !== JSON.stringify(PORTABLE_COMPANION_BOUNDARIES)) fail('PORTABLE_COMPANION_BOUNDARY_DRIFT_DENIED');
  return matrix;
}

export function portableCompanionManifestV1(matrix = loadPortableCompanionCompatibilityMatrix()) {
  const validMatrix = validateCompatibilityMatrixV1(matrix);
  const sourceMap = readJson(SOURCE_MAP_PATH);
  const pkg = readJson(PACKAGE_PATH);
  const body = {
    schemaVersion: PORTABLE_COMPANION_CONTRACT_SCHEMA,
    product: { id: 'kaleidosphere', version: `v${pkg.version}`, repository: 'JoFe2/KaleidoSphere' },
    contract: { id: PORTABLE_COMPANION_CONTRACT_ID, version: PORTABLE_COMPANION_CONTRACT_VERSION, stability: 'foundation', authority: 'offline-utility-only' },
    externalApiV2: { contractId: 'superset-bi-agent.external', contractVersion: '2.0.0', runtimeIntents: EXTERNAL_API_V2_RUNTIME_INTENTS },
    utilityActions: PORTABLE_COMPANION_UTILITY_ACTIONS,
    boundaries: PORTABLE_COMPANION_BOUNDARIES,
    claimClasses: PORTABLE_COMPANION_CLAIM_CLASSES,
    compatibility: {
      matrixSchemaVersion: PORTABLE_COMPANION_COMPATIBILITY_SCHEMA,
      matrixDigest: sha256Canonical(validMatrix),
      sourceMapDigest: sha256Canonical(sourceMap),
      schemaDigest: sha256Bytes(readFileSync(SCHEMA_PATH)),
    },
  };
  return Object.freeze({ ...body, integrity: { algorithm: 'sha256-canonical-json', digest: sha256Canonical(body) } });
}

export function validatePortableCompanionManifestV1(value) {
  assertExactKeys(value, ['schemaVersion', 'product', 'contract', 'externalApiV2', 'utilityActions', 'boundaries', 'claimClasses', 'compatibility', 'integrity'], ['schemaVersion', 'product', 'contract', 'externalApiV2', 'utilityActions', 'boundaries', 'claimClasses', 'compatibility', 'integrity'], 'PORTABLE_COMPANION_MANIFEST_SURFACE_DENIED');
  const expected = portableCompanionManifestV1();
  if (value.schemaVersion !== expected.schemaVersion) fail('PORTABLE_COMPANION_MANIFEST_SCHEMA_DENIED');
  if (value.product?.version !== expected.product.version) fail('PORTABLE_COMPANION_MANIFEST_STALE_DENIED');
  if (value.contract?.id !== PORTABLE_COMPANION_CONTRACT_ID || value.contract?.version !== PORTABLE_COMPANION_CONTRACT_VERSION) fail('PORTABLE_COMPANION_CONTRACT_VERSION_DENIED');
  if (JSON.stringify(value.externalApiV2?.runtimeIntents) !== JSON.stringify(EXTERNAL_API_V2_RUNTIME_INTENTS)) fail('PORTABLE_COMPANION_RUNTIME_INTENT_WIDENING_DENIED');
  assertActionDescriptors(value.utilityActions);
  if (JSON.stringify(value.boundaries) !== JSON.stringify(PORTABLE_COMPANION_BOUNDARIES)) fail('PORTABLE_COMPANION_BOUNDARY_DRIFT_DENIED');
  if (JSON.stringify(value.claimClasses) !== JSON.stringify(PORTABLE_COMPANION_CLAIM_CLASSES)) fail('PORTABLE_COMPANION_CLAIM_CLASS_DENIED');
  if (!SHA256_DIGEST.test(value.compatibility?.matrixDigest ?? '') || value.compatibility.matrixDigest !== expected.compatibility.matrixDigest) fail('PORTABLE_COMPANION_MATRIX_DIGEST_DRIFT_DENIED');
  if (value.compatibility.sourceMapDigest !== expected.compatibility.sourceMapDigest) fail('PORTABLE_COMPANION_SOURCE_MAP_DIGEST_DRIFT_DENIED');
  if (value.compatibility.schemaDigest !== expected.compatibility.schemaDigest) fail('PORTABLE_COMPANION_SCHEMA_DIGEST_DRIFT_DENIED');
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'integrity'));
  if (value.integrity?.algorithm !== 'sha256-canonical-json' || value.integrity.digest !== sha256Canonical(body)) fail('PORTABLE_COMPANION_MANIFEST_INTEGRITY_DENIED');
  return value;
}

export function validatePortableUtilityRequestV1(value, options = {}) {
  assertExactKeys(value, ['schemaVersion', 'contractVersion', 'action', 'input'], ['schemaVersion', 'contractVersion', 'action'], 'PORTABLE_COMPANION_REQUEST_SURFACE_DENIED');
  assertJsonBounds(value);
  if (value.schemaVersion !== PORTABLE_COMPANION_REQUEST_SCHEMA) fail('PORTABLE_COMPANION_REQUEST_SCHEMA_DENIED');
  if (value.contractVersion !== PORTABLE_COMPANION_CONTRACT_VERSION) fail('PORTABLE_COMPANION_CONTRACT_VERSION_DENIED');
  const action = PORTABLE_COMPANION_UTILITY_ACTIONS.find((item) => item.id === value.action);
  if (!action) fail('PORTABLE_COMPANION_ACTION_DENIED');
  if (action.lifecycle === 'reserved' && options.allowReserved !== true) fail('PORTABLE_COMPANION_RESERVED_ACTION_DENIED', { action: action.id, ownerIssue: action.ownerIssue });
  const input = value.input ?? {};
  assertExactKeys(input, [], [], 'PORTABLE_COMPANION_REQUEST_INPUT_DENIED');
  assertNoUnsafeSurface(value);
  return { schemaVersion: value.schemaVersion, contractVersion: value.contractVersion, action: value.action, input, acceptedAction: action };
}

export function explainPortableCompanionFoundation() {
  const manifest = portableCompanionManifestV1();
  return Object.freeze({
    manifest,
    nonClaims: [
      'No runtime dispatch.',
      'No arbitrary endpoint discovery.',
      'No credentials, free SQL, raw rows or provider payloads.',
      'No mutation, deploy, evidence, production, hosted/SaaS, remote-MCP or marketplace claim.',
    ],
  });
}
