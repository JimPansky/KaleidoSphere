import { canonicalJson } from '../canonical-json.js';
import {
  EXTERNAL_API_V2_RUNTIME_INTENTS,
  PORTABLE_COMPANION_CONTRACT_VERSION,
  PORTABLE_COMPANION_REQUEST_SCHEMA,
  sha256Canonical,
  validatePortableUtilityRequestV1,
} from './contract.mjs';

export const PORTABLE_PROFILE_TEMPLATE_SCHEMA = 'kaleidosphere.portable-companion/profile-template/v1';
export const PORTABLE_PROFILE_TEMPLATE_VALIDATION_SCHEMA = 'kaleidosphere.portable-companion/profile-template-validation/v1';
export const PORTABLE_PROFILE_TEMPLATE_ACTION = 'profile-template.validate';

export const PORTABLE_PROFILE_TEMPLATE_KINDS = Object.freeze([
  'analysis-profile',
  'preview-profile',
  'readback-profile',
]);

const TEMPLATE_KEYS = Object.freeze([
  'schemaVersion',
  'contractVersion',
  'templateId',
  'templateKind',
  'selectedRuntimeIntent',
  'placeholders',
  'secretReferences',
  'constraints',
]);
const PLACEHOLDER_KEYS = Object.freeze(['identityRef', 'dataScopeRef', 'objectiveRef', 'evidenceRef']);
const SECRET_REFERENCE_KEYS = Object.freeze(['id', 'ref']);
const CONSTRAINT_KEYS = Object.freeze([
  'dispatch',
  'allowRuntimeDispatch',
  'allowCredentialValues',
  'allowArbitraryEndpoints',
  'allowFreeSql',
  'allowRawRows',
]);
const BOUNDARY_KEYS = Object.freeze([
  'runtimeDispatchAccepted',
  'arbitraryEndpointDiscoveryAccepted',
  'credentialsAccepted',
  'freeSqlAccepted',
  'rawSourceRowsAccepted',
  'providerPayloadsAccepted',
  'liveReadinessClaimAccepted',
]);
const CHECK_IDS = Object.freeze([
  'closed-profile-surface',
  'placeholder-only-values',
  'secret-free-values',
  'no-runtime-dispatch',
  'no-free-sql',
  'no-arbitrary-endpoint',
]);

const SAFE_ID = /^[a-z][a-z0-9.-]{1,80}$/;
const PLACEHOLDER = /^\$\{[A-Z][A-Z0-9_]{2,80}\}$/;
const SECRET_REFERENCE_ID = /^[a-z][a-z0-9.-]{1,60}$/;
const SECRET_VALUE = /(?:\b(?:sk-[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9_]{20,})\b|bearer\s+[a-z0-9._:-]{8,}|(?:password|credential|secret|token|api[_ -]?key|private\s+key|dsn|connection\s*string)\s*[:=]\s*["']?[^"',\s]{4,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:postgres(?:ql)?|mysql|mssql|oracle|mongodb(?:\+srv)?|jdbc):\/\/)/i;
const URL_VALUE = /\b(?:https?|wss?):\/\/[^\s"']+/i;
const FREE_SQL = /\b(?:select|insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|exec(?:ute)?|dbcc|backup|restore)\b|(?:raw\s+sql|free\s+sql|sql\s+lab)/i;
const RUNTIME_DISPATCH_TEXT = /\b(?:dispatch|invoke|execute|call|run|probe)\s+(?:status|discovery|analyze|plan|preview|readback|runtime\s+intent)\b/i;

function fail(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  throw error;
}

function assertPlainObject(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(code);
}

function assertExactKeys(value, allowed, required, code) {
  assertPlainObject(value, code);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))) fail(code, { keys });
}

function assertSafeValue(value, path = '$') {
  if (typeof value === 'string') {
    if (/[\u0000-\u001f\u007f]/.test(value) || value.length > 500) fail('PORTABLE_PROFILE_TEMPLATE_TEXT_BOUNDS_DENIED', { path });
    if (SECRET_VALUE.test(value)) fail('PORTABLE_PROFILE_TEMPLATE_SECRET_VALUE_DENIED', { path });
    if (URL_VALUE.test(value)) fail('PORTABLE_PROFILE_TEMPLATE_ARBITRARY_ENDPOINT_DENIED', { path });
    if (FREE_SQL.test(value)) fail('PORTABLE_PROFILE_TEMPLATE_FREE_SQL_DENIED', { path });
    if (RUNTIME_DISPATCH_TEXT.test(value)) fail('PORTABLE_PROFILE_TEMPLATE_RUNTIME_DISPATCH_DENIED', { path });
    return;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeValue(item, `${path}[${index}]`));
    return;
  }
  assertPlainObject(value, 'PORTABLE_PROFILE_TEMPLATE_SURFACE_DENIED');
  for (const [key, child] of Object.entries(value)) {
    assertSafeValue(child, `${path}.${key}`);
  }
}

function assertPlaceholder(value, code, path) {
  if (typeof value !== 'string' || !PLACEHOLDER.test(value)) fail(code, { path });
  return value;
}

function normalizePlaceholders(placeholders) {
  assertExactKeys(placeholders, PLACEHOLDER_KEYS, PLACEHOLDER_KEYS, 'PORTABLE_PROFILE_TEMPLATE_PLACEHOLDERS_DENIED');
  return Object.freeze(Object.fromEntries(PLACEHOLDER_KEYS.map((key) => [
    key,
    assertPlaceholder(placeholders[key], 'PORTABLE_PROFILE_TEMPLATE_PLACEHOLDER_VALUE_DENIED', `$.placeholders.${key}`),
  ])));
}

function normalizeSecretReferences(secretReferences) {
  if (!Array.isArray(secretReferences) || secretReferences.length < 1 || secretReferences.length > 3) {
    fail('PORTABLE_PROFILE_TEMPLATE_SECRET_REFERENCES_DENIED');
  }
  return Object.freeze(secretReferences.map((item, index) => {
    assertExactKeys(item, SECRET_REFERENCE_KEYS, SECRET_REFERENCE_KEYS, 'PORTABLE_PROFILE_TEMPLATE_SECRET_REFERENCE_SURFACE_DENIED');
    if (!SECRET_REFERENCE_ID.test(item.id)) fail('PORTABLE_PROFILE_TEMPLATE_SECRET_REFERENCE_ID_DENIED', { path: `$.secretReferences[${index}].id` });
    return Object.freeze({
      id: item.id,
      ref: assertPlaceholder(item.ref, 'PORTABLE_PROFILE_TEMPLATE_SECRET_REFERENCE_VALUE_DENIED', `$.secretReferences[${index}].ref`),
    });
  }));
}

function normalizeConstraints(constraints) {
  assertExactKeys(constraints, CONSTRAINT_KEYS, CONSTRAINT_KEYS, 'PORTABLE_PROFILE_TEMPLATE_CONSTRAINTS_DENIED');
  const normalized = {};
  for (const key of CONSTRAINT_KEYS) {
    if (constraints[key] !== false) fail('PORTABLE_PROFILE_TEMPLATE_BOUNDARY_DENIED', { key });
    normalized[key] = false;
  }
  return Object.freeze(normalized);
}

function boundaryFlags() {
  return Object.freeze({
    runtimeDispatchAccepted: false,
    arbitraryEndpointDiscoveryAccepted: false,
    credentialsAccepted: false,
    freeSqlAccepted: false,
    rawSourceRowsAccepted: false,
    providerPayloadsAccepted: false,
    liveReadinessClaimAccepted: false,
  });
}

function check(id) {
  return Object.freeze({ id, status: 'PASS' });
}

function manifestBody(value) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'integrity'));
}

function normalizeProfileTemplate(template) {
  assertExactKeys(template, TEMPLATE_KEYS, TEMPLATE_KEYS, 'PORTABLE_PROFILE_TEMPLATE_SURFACE_DENIED');
  assertSafeValue(template);
  if (template.schemaVersion !== PORTABLE_PROFILE_TEMPLATE_SCHEMA) fail('PORTABLE_PROFILE_TEMPLATE_SCHEMA_DENIED');
  if (template.contractVersion !== PORTABLE_COMPANION_CONTRACT_VERSION) fail('PORTABLE_PROFILE_TEMPLATE_CONTRACT_VERSION_DENIED');
  if (!SAFE_ID.test(template.templateId)) fail('PORTABLE_PROFILE_TEMPLATE_ID_DENIED');
  if (!PORTABLE_PROFILE_TEMPLATE_KINDS.includes(template.templateKind)) fail('PORTABLE_PROFILE_TEMPLATE_KIND_DENIED');
  if (!EXTERNAL_API_V2_RUNTIME_INTENTS.includes(template.selectedRuntimeIntent)) fail('PORTABLE_PROFILE_TEMPLATE_RUNTIME_INTENT_DENIED');

  return Object.freeze({
    schemaVersion: PORTABLE_PROFILE_TEMPLATE_SCHEMA,
    contractVersion: PORTABLE_COMPANION_CONTRACT_VERSION,
    templateId: template.templateId,
    templateKind: template.templateKind,
    selectedRuntimeIntent: template.selectedRuntimeIntent,
    placeholders: normalizePlaceholders(template.placeholders),
    secretReferences: normalizeSecretReferences(template.secretReferences),
    constraints: normalizeConstraints(template.constraints),
  });
}

export function portableProfileTemplateRequest() {
  return Object.freeze({
    schemaVersion: PORTABLE_COMPANION_REQUEST_SCHEMA,
    contractVersion: PORTABLE_COMPANION_CONTRACT_VERSION,
    action: PORTABLE_PROFILE_TEMPLATE_ACTION,
  });
}

export function validatePortableProfileTemplateRequest(value) {
  const request = validatePortableUtilityRequestV1(value, { allowReserved: true });
  if (request.action !== PORTABLE_PROFILE_TEMPLATE_ACTION) fail('PORTABLE_PROFILE_TEMPLATE_ACTION_DENIED');
  return request;
}

export function validatePortableProfileTemplate(template, request = portableProfileTemplateRequest()) {
  validatePortableProfileTemplateRequest(request);
  const normalizedTemplate = normalizeProfileTemplate(template);
  const reportBody = {
    schemaVersion: PORTABLE_PROFILE_TEMPLATE_VALIDATION_SCHEMA,
    contractVersion: PORTABLE_COMPANION_CONTRACT_VERSION,
    action: PORTABLE_PROFILE_TEMPLATE_ACTION,
    template: normalizedTemplate,
    externalApiV2: {
      contractId: 'superset-bi-agent.external',
      contractVersion: '2.0.0',
      runtimeIntents: EXTERNAL_API_V2_RUNTIME_INTENTS,
      selectedRuntimeIntent: normalizedTemplate.selectedRuntimeIntent,
    },
    validation: {
      status: 'VALID_PLACEHOLDER_ONLY',
      checks: CHECK_IDS.map(check),
    },
    boundaries: boundaryFlags(),
    nonClaims: [
      'No runtime dispatch.',
      'No credential storage, OAuth, endpoint lookup or live connection test.',
      'No arbitrary URL, database endpoint, free SQL, raw rows, customer payloads or provider payloads.',
      'No auth broker, hosted/SaaS, remote-MCP, marketplace or production-readiness claim.',
    ],
  };
  return Object.freeze({
    ...reportBody,
    integrity: Object.freeze({ algorithm: 'sha256-canonical-json', digest: sha256Canonical(reportBody) }),
  });
}

export function validatePortableProfileTemplateReport(value) {
  assertExactKeys(value, ['schemaVersion', 'contractVersion', 'action', 'template', 'externalApiV2', 'validation', 'boundaries', 'nonClaims', 'integrity'], ['schemaVersion', 'contractVersion', 'action', 'template', 'externalApiV2', 'validation', 'boundaries', 'nonClaims', 'integrity'], 'PORTABLE_PROFILE_TEMPLATE_REPORT_SURFACE_DENIED');
  if (value.schemaVersion !== PORTABLE_PROFILE_TEMPLATE_VALIDATION_SCHEMA) fail('PORTABLE_PROFILE_TEMPLATE_VALIDATION_SCHEMA_DENIED');
  if (value.contractVersion !== PORTABLE_COMPANION_CONTRACT_VERSION || value.action !== PORTABLE_PROFILE_TEMPLATE_ACTION) fail('PORTABLE_PROFILE_TEMPLATE_ACTION_DENIED');
  normalizeProfileTemplate(value.template);
  assertExactKeys(value.externalApiV2, ['contractId', 'contractVersion', 'runtimeIntents', 'selectedRuntimeIntent'], ['contractId', 'contractVersion', 'runtimeIntents', 'selectedRuntimeIntent'], 'PORTABLE_PROFILE_TEMPLATE_EXTERNAL_API_SURFACE_DENIED');
  if (value.externalApiV2.contractId !== 'superset-bi-agent.external' || value.externalApiV2.contractVersion !== '2.0.0') fail('PORTABLE_PROFILE_TEMPLATE_EXTERNAL_API_DENIED');
  if (JSON.stringify(value.externalApiV2.runtimeIntents) !== JSON.stringify(EXTERNAL_API_V2_RUNTIME_INTENTS)) fail('PORTABLE_PROFILE_TEMPLATE_RUNTIME_INTENT_WIDENING_DENIED');
  if (value.externalApiV2.selectedRuntimeIntent !== value.template.selectedRuntimeIntent) fail('PORTABLE_PROFILE_TEMPLATE_RUNTIME_INTENT_DENIED');
  assertExactKeys(value.validation, ['status', 'checks'], ['status', 'checks'], 'PORTABLE_PROFILE_TEMPLATE_VALIDATION_SURFACE_DENIED');
  if (value.validation.status !== 'VALID_PLACEHOLDER_ONLY') fail('PORTABLE_PROFILE_TEMPLATE_VALIDATION_STATUS_DENIED');
  if (!Array.isArray(value.validation.checks) || JSON.stringify(value.validation.checks.map((item) => item.id)) !== JSON.stringify(CHECK_IDS)) fail('PORTABLE_PROFILE_TEMPLATE_CHECKS_DENIED');
  for (const item of value.validation.checks) {
    assertExactKeys(item, ['id', 'status'], ['id', 'status'], 'PORTABLE_PROFILE_TEMPLATE_CHECK_SURFACE_DENIED');
    if (!CHECK_IDS.includes(item.id) || item.status !== 'PASS') fail('PORTABLE_PROFILE_TEMPLATE_CHECKS_DENIED');
  }
  assertExactKeys(value.boundaries, BOUNDARY_KEYS, BOUNDARY_KEYS, 'PORTABLE_PROFILE_TEMPLATE_BOUNDARY_SURFACE_DENIED');
  if (Object.values(value.boundaries).some((item) => item !== false)) fail('PORTABLE_PROFILE_TEMPLATE_BOUNDARY_DENIED');
  if (!Array.isArray(value.nonClaims) || value.nonClaims.length !== 4) fail('PORTABLE_PROFILE_TEMPLATE_NONCLAIMS_DENIED');
  if (value.nonClaims.some((item) => typeof item !== 'string' || item.length > 240 || /[\u0000-\u001f\u007f]/.test(item))) fail('PORTABLE_PROFILE_TEMPLATE_NONCLAIMS_DENIED');
  assertSafeValue({
    template: value.template,
    externalApiV2: value.externalApiV2,
    validation: value.validation,
    boundaries: value.boundaries,
  });
  if (canonicalJson(value).includes('"dispatch":true')) fail('PORTABLE_PROFILE_TEMPLATE_RUNTIME_DISPATCH_DENIED');
  const body = manifestBody(value);
  if (value.integrity?.algorithm !== 'sha256-canonical-json' || value.integrity.digest !== sha256Canonical(body)) fail('PORTABLE_PROFILE_TEMPLATE_REPORT_INTEGRITY_DENIED');
  return value;
}
