import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson } from './canonical-json.js';
import { coded } from './policy.mjs';

export const SUPERSET_FINGERPRINT_CONTRACT = 'chimpmaera.bi/superset-fingerprint/v1';
export const SUPERSET_RUNTIME_EVIDENCE_CONTRACT = 'chimpmaera.bi/superset-runtime-evidence/v1';
export const SUPERSET_PLANNING_GATE_CONTRACT = 'chimpmaera.bi/superset-planning-gate/v1';
export const DEFAULT_FRESHNESS_SECONDS = 24 * 60 * 60;
export const DEFAULT_MAX_OPENAPI_BYTES = 5 * 1024 * 1024;

const REQUIRED_SECURITY_FLAGS = new Map([
  ['ENABLE_TEMPLATE_PROCESSING', false],
  ['ALERT_REPORTS', false],
  ['EMBEDDED_SUPERSET', false],
]);
const RELEVANT_FLAGS = [...REQUIRED_SECURITY_FLAGS.keys(), 'HORIZONTAL_FILTER_BAR'];
const SECRET_VALUE = /(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9_]{20,}|hf_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._~+/-]{16,}|Basic\s+[A-Za-z0-9+/=]{16,}|BEGIN (?:RSA |EC )?PRIVATE KEY)/i;
const SECRET_KEY = /(?:authorization|cookie|set-cookie|password|passwd|secret|token|api[_-]?key|credential|client[_-]?secret)/i;
const QUERY_SECRET = /(?:token|secret|password|passwd|api[_-]?key|credential|client[_-]?secret|session|auth)/i;
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:[+.-][A-Za-z0-9.-]+)?$/;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function fail(code) {
  throw coded(code);
}

function nowIso(now = new Date()) {
  const value = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(value.getTime())) fail('SUPERSET_FINGERPRINT_TIME_INVALID');
  return value.toISOString();
}

export function sanitizeSupersetBaseUrl(value, { allowInsecureLocal = true } = {}) {
  let parsed;
  try { parsed = new URL(value); }
  catch { fail('SUPERSET_TARGET_URL_INVALID'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) fail('SUPERSET_TARGET_SCHEME_DENIED');
  if (parsed.username || parsed.password) fail('SUPERSET_TARGET_USERINFO_DENIED');
  if (parsed.search) {
    for (const key of parsed.searchParams.keys()) {
      if (QUERY_SECRET.test(key)) fail('SUPERSET_TARGET_QUERY_SECRET_DENIED');
    }
    fail('SUPERSET_TARGET_QUERY_DENIED');
  }
  if (parsed.hash) fail('SUPERSET_TARGET_FRAGMENT_DENIED');
  const host = parsed.hostname.toLowerCase();
  const local = ['localhost', '127.0.0.1', '::1', 'superset'].includes(host) || host.endsWith('.localhost');
  if (parsed.protocol === 'http:' && !(allowInsecureLocal && local)) fail('SUPERSET_TARGET_TLS_REQUIRED');
  const pathname = parsed.pathname.replace(/\/+$/, '');
  const baseUrl = `${parsed.protocol}//${parsed.host}${pathname}`;
  return {
    base_url: baseUrl,
    origin: parsed.origin,
    host,
    protocol: parsed.protocol.replace(':', ''),
    localhost_or_internal: local,
    identity_sha256: sha256(baseUrl),
  };
}

function sameHostOrFixture(source, target) {
  if (!source || source.kind === 'offline-fixture') return true;
  if (typeof source.url !== 'string') return true;
  let sourceUrl;
  try { sourceUrl = new URL(source.url); }
  catch { return false; }
  return sourceUrl.hostname.toLowerCase() === target.host;
}

function assertNoSecretLike(value, pathName = '$', { allowSecretKeys = false } = {}) {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (SECRET_VALUE.test(value)) fail('SUPERSET_FINGERPRINT_SECRET_VALUE_DENIED');
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) assertNoSecretLike(value[index], `${pathName}[${index}]`);
    return;
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) fail('SUPERSET_FINGERPRINT_SCHEMA_INVALID');
  for (const [key, child] of Object.entries(value)) {
    if (!allowSecretKeys && SECRET_KEY.test(key)) fail('SUPERSET_FINGERPRINT_SECRET_KEY_DENIED');
    assertNoSecretLike(child, `${pathName}.${key}`, { allowSecretKeys });
  }
}

function parseScalar(raw) {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value.replace(/^['"]|['"]$/g, '');
}

function parseSimpleYaml(text) {
  const root = {};
  const stack = [{ indent: -1, value: root }];
  for (const [lineIndex, rawLine] of text.split(/\r?\n/).entries()) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;
    const match = /^(\s*)([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(rawLine);
    if (!match) fail('SUPERSET_OPENAPI_YAML_INVALID');
    const indent = match[1].length;
    if (indent % 2 !== 0) fail('SUPERSET_OPENAPI_YAML_INVALID');
    while (stack.at(-1).indent >= indent) stack.pop();
    const parent = stack.at(-1)?.value;
    if (!parent || typeof parent !== 'object' || Array.isArray(parent)) fail('SUPERSET_OPENAPI_YAML_INVALID');
    const key = match[2];
    if (Object.hasOwn(parent, key)) fail('SUPERSET_OPENAPI_YAML_INVALID');
    const value = match[3] === undefined ? {} : parseScalar(match[3]);
    parent[key] = value;
    if (match[3] === undefined) stack.push({ indent, value });
    if (lineIndex > 20000) fail('SUPERSET_OPENAPI_YAML_INVALID');
  }
  return root;
}

export function parseOpenApiDocument(text, contentType = 'application/json', source = '') {
  if (Buffer.byteLength(text) > DEFAULT_MAX_OPENAPI_BYTES) fail('SUPERSET_OPENAPI_OVERSIZED');
  const looksYaml = /ya?ml/i.test(contentType) || /\.ya?ml$/i.test(source);
  if (!looksYaml && !/(?:^|[;\s/])json(?:[;\s]|$)|openapi\+json/i.test(contentType)) fail('SUPERSET_OPENAPI_CONTENT_TYPE_DENIED');
  let value;
  try {
    value = looksYaml ? parseSimpleYaml(text) : JSON.parse(text);
  } catch (error) {
    if (String(error.code ?? error.message).includes('YAML')) throw error;
    fail(looksYaml ? 'SUPERSET_OPENAPI_YAML_INVALID' : 'SUPERSET_OPENAPI_JSON_INVALID');
  }
  validateOpenApiDocument(value);
  return { value, parser: looksYaml ? 'simple-yaml/v1' : 'json/v1' };
}

export function validateOpenApiDocument(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('SUPERSET_OPENAPI_SCHEMA_INVALID');
  if (typeof value.openapi !== 'string' && typeof value.swagger !== 'string') fail('SUPERSET_OPENAPI_SCHEMA_INVALID');
  if (!value.info || typeof value.info !== 'object' || typeof value.info.title !== 'string') fail('SUPERSET_OPENAPI_SCHEMA_INVALID');
  if (!value.paths || typeof value.paths !== 'object' || Array.isArray(value.paths)) fail('SUPERSET_OPENAPI_SCHEMA_INVALID');
  assertNoSecretLike(value, '$.openapi', { allowSecretKeys: true });
  return value;
}

function assertRuntimeEvidenceNoSecrets(evidence) {
  const shallow = { ...evidence, openapi: { ...evidence.openapi, document: undefined } };
  delete shallow.openapi.document;
  assertNoSecretLike(shallow);
  if (evidence.openapi?.document !== undefined) assertNoSecretLike(evidence.openapi.document, '$.openapi.document', { allowSecretKeys: true });
}

function validateRuntimeEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) fail('SUPERSET_RUNTIME_EVIDENCE_INVALID');
  if (evidence.schemaVersion !== SUPERSET_RUNTIME_EVIDENCE_CONTRACT) fail('SUPERSET_RUNTIME_EVIDENCE_VERSION_DENIED');
  if (typeof evidence.observedAt !== 'string' || Number.isNaN(new Date(evidence.observedAt).getTime())) fail('SUPERSET_RUNTIME_EVIDENCE_TIME_INVALID');
  if (!evidence.product || typeof evidence.product.version !== 'string') fail('SUPERSET_VERSION_MISSING');
  if (!evidence.openapi || typeof evidence.openapi !== 'object') fail('SUPERSET_OPENAPI_MISSING');
  if (!evidence.featureFlags || typeof evidence.featureFlags.values !== 'object') fail('SUPERSET_FEATURE_FLAGS_MISSING');
  assertRuntimeEvidenceNoSecrets(evidence);
  return evidence;
}

function compatibilityForVersion(version) {
  const match = VERSION.exec(version);
  if (!match) return { status: 'block', code: 'SUPERSET_VERSION_MALFORMED', supported_range: '>=6.1.0 <7.0.0' };
  const major = Number(match[1]);
  if (major !== 6 || Number(match[2]) < 1) return { status: 'defer', code: 'SUPERSET_VERSION_UNVALIDATED', supported_range: '>=6.1.0 <7.0.0' };
  return { status: 'compatible', code: 'SUPERSET_VERSION_COMPATIBLE', supported_range: '>=6.1.0 <7.0.0' };
}

function featureCapabilities(values) {
  const capabilities = [];
  for (const name of RELEVANT_FLAGS) {
    const requiredValue = REQUIRED_SECURITY_FLAGS.get(name);
    const hasValue = Object.hasOwn(values, name);
    const value = hasValue ? values[name] : null;
    const status = !hasValue ? 'unknown' : typeof value === 'boolean' ? 'known' : 'invalid';
    const securityStatus = requiredValue === undefined
      ? 'observed'
      : status === 'known' && value === requiredValue ? 'compatible' : 'block';
    capabilities.push({
      name,
      status,
      value,
      required_value: requiredValue ?? null,
      required_for_promotion: requiredValue !== undefined,
      security_status: securityStatus,
      source: 'superset FEATURE_FLAGS runtime config',
    });
  }
  return capabilities;
}

function pathCount(openapi) {
  return Object.keys(openapi.paths ?? {}).length;
}

export function buildSupersetFingerprint(evidence, options = {}) {
  const runtime = validateRuntimeEvidence(evidence);
  const target = sanitizeSupersetBaseUrl(options.targetUrl ?? runtime.target?.baseUrl ?? runtime.target?.base_url);
  if (!sameHostOrFixture(runtime.product.source, target) || !sameHostOrFixture(runtime.openapi.source, target) || !sameHostOrFixture(runtime.featureFlags.source, target)) {
    fail('SUPERSET_FINGERPRINT_TARGET_MISMATCH');
  }
  const openapi = typeof runtime.openapi.document === 'string'
    ? parseOpenApiDocument(runtime.openapi.document, runtime.openapi.contentType, runtime.openapi.source?.path)
    : { value: validateOpenApiDocument(runtime.openapi.document), parser: 'json-object/v1' };
  const openapiCanonical = canonicalJson(openapi.value);
  const capabilities = featureCapabilities(runtime.featureFlags.values);
  const flagBlocks = capabilities.filter((entry) => entry.required_for_promotion && entry.security_status !== 'compatible');
  const versionCompatibility = compatibilityForVersion(runtime.product.version);
  const reasons = [
    ...(versionCompatibility.status === 'compatible' ? [] : [versionCompatibility.code]),
    ...flagBlocks.map((entry) => `SUPERSET_FEATURE_FLAG_${entry.name}_BLOCK`),
  ];
  const observedAt = nowIso(options.observedAt ?? runtime.observedAt);
  const staleAfter = new Date(new Date(observedAt).getTime() + (options.freshnessSeconds ?? DEFAULT_FRESHNESS_SECONDS) * 1000).toISOString();
  const fingerprint = {
    contract_version: SUPERSET_FINGERPRINT_CONTRACT,
    target,
    observed_at: observedAt,
    superset: {
      product: runtime.product.name ?? 'Apache Superset',
      version: runtime.product.version,
      version_source: runtime.product.source ?? { kind: 'superset-runtime' },
      compatibility: versionCompatibility,
    },
    openapi: {
      source: runtime.openapi.source ?? { kind: 'superset-openapi' },
      canonicalization: {
        algorithm: 'canonical-json/v1',
        parser: openapi.parser,
        byte_length: Buffer.byteLength(openapiCanonical),
        sha256: sha256(openapiCanonical),
        path_count: pathCount(openapi.value),
      },
      sha256: sha256(openapiCanonical),
      representation: openapi.value,
    },
    feature_flags: {
      source: runtime.featureFlags.source ?? { kind: 'superset-runtime-config', name: 'FEATURE_FLAGS' },
      capabilities,
    },
    evidence: {
      collector: 'chimpmaera-bi-control/superset-fingerprint',
      runtime_evidence_sha256: sha256(canonicalJson(runtime)),
      provenance: runtime.provenance ?? [],
    },
    freshness: {
      max_age_seconds: options.freshnessSeconds ?? DEFAULT_FRESHNESS_SECONDS,
      stale_after: staleAfter,
      status: 'fresh',
    },
    compatibility_verdict: {
      status: reasons.length === 0 ? 'compatible' : 'block',
      reasons,
    },
    limitations: [
      'Apache Superset runtime evidence is primary; Preset-hosted compatibility is secondary and must be re-fingerprinted per target.',
      'Feature flags are limited to capabilities exposed by the target runtime/config source.',
      'No production, customer, source-database, dataset, chart, dashboard, import, export, or write-path evidence is claimed by this fingerprint.',
    ],
    nonclaims: [
      'No Superset mutation was performed while collecting this fingerprint.',
      'No source database credentials, auth headers, cookies, tokens, or DB connection strings are captured.',
      'No dynamic dashboard promotion or ZIP import/export is authorized by this slice.',
    ],
  };
  const fingerprintShell = { ...fingerprint, openapi: { ...fingerprint.openapi } };
  delete fingerprintShell.openapi.representation;
  assertNoSecretLike(fingerprintShell);
  assertNoSecretLike(fingerprint.openapi.representation, '$.fingerprint.openapi.representation', { allowSecretKeys: true });
  return fingerprint;
}

async function fetchBoundedJson(url, { token, timeoutMs = 10000, maxBytes = DEFAULT_MAX_OPENAPI_BYTES } = {}) {
  const response = await fetch(url, {
    method: 'GET',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((error) => {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') fail('SUPERSET_FINGERPRINT_TIMEOUT');
    fail('SUPERSET_FINGERPRINT_ENDPOINT_UNAVAILABLE');
  });
  if (!response.ok) fail('SUPERSET_FINGERPRINT_ENDPOINT_UNAVAILABLE');
  const contentType = response.headers.get('content-type') ?? '';
  if (!/application\/json/i.test(contentType)) fail('SUPERSET_FINGERPRINT_CONTENT_TYPE_DENIED');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) fail('SUPERSET_OPENAPI_OVERSIZED');
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('SUPERSET_RUNTIME_EVIDENCE_JSON_INVALID'); }
}

export async function collectSupersetFingerprint({ mode = 'runtime', targetUrl, internalUrl, token, fixturePath, receiptDir, now = new Date(), timeoutMs } = {}) {
  let evidence;
  if (mode === 'fixture') {
    evidence = JSON.parse(await readFile(fixturePath, 'utf8'));
  } else if (mode === 'runtime') {
    evidence = await fetchBoundedJson(internalUrl, { token, timeoutMs });
  } else fail('SUPERSET_FINGERPRINT_MODE_DENIED');
  const fingerprint = buildSupersetFingerprint(evidence, { targetUrl, observedAt: nowIso(now) });
  if (receiptDir) {
    await writeFile(path.join(receiptDir, 'latest-superset-fingerprint.json'), `${canonicalJson(fingerprint)}\n`, { mode: 0o600 });
  }
  return fingerprint;
}

export function evaluateSupersetPlanningGate({ fingerprint, request = {}, now = new Date() } = {}) {
  const reasons = [];
  if (!request || typeof request !== 'object' || Array.isArray(request)) fail('SUPERSET_PLANNING_REQUEST_INVALID');
  const action = String(request.action ?? '');
  const writeLike = /(?:write|import|export|promot|publish|materialize|dataset|chart|dashboard|zip)/i.test(action);
  if (!fingerprint) reasons.push('SUPERSET_FINGERPRINT_MISSING');
  if (fingerprint) {
    if (fingerprint.contract_version !== SUPERSET_FINGERPRINT_CONTRACT) reasons.push('SUPERSET_FINGERPRINT_CONTRACT_DENIED');
    if (fingerprint.compatibility_verdict?.status !== 'compatible') reasons.push('SUPERSET_FINGERPRINT_INCOMPATIBLE');
    const observed = new Date(fingerprint.observed_at);
    const maxAge = Number(fingerprint.freshness?.max_age_seconds ?? DEFAULT_FRESHNESS_SECONDS);
    if (Number.isNaN(observed.getTime()) || new Date(now).getTime() - observed.getTime() > maxAge * 1000) reasons.push('SUPERSET_FINGERPRINT_STALE');
    if (!fingerprint.openapi?.sha256 || fingerprint.openapi.sha256 !== fingerprint.openapi.canonicalization?.sha256) reasons.push('SUPERSET_OPENAPI_HASH_MISMATCH');
    if (request.expected_openapi_sha256 && request.expected_openapi_sha256 !== fingerprint.openapi?.sha256) reasons.push('SUPERSET_OPENAPI_DRIFT');
    if (request.target_base_url) {
      const target = sanitizeSupersetBaseUrl(request.target_base_url);
      if (target.base_url !== fingerprint.target?.base_url) reasons.push('SUPERSET_TARGET_MISMATCH');
    }
    const capabilities = new Map((fingerprint.feature_flags?.capabilities ?? []).map((entry) => [entry.name, entry]));
    for (const [name, expected] of Object.entries(request.required_feature_flags ?? {})) {
      const capability = capabilities.get(name);
      if (!capability || capability.status !== 'known') reasons.push(`SUPERSET_FEATURE_FLAG_${name}_UNKNOWN`);
      else if (capability.value !== expected) reasons.push(`SUPERSET_FEATURE_FLAG_${name}_MISMATCH`);
    }
  }
  const status = reasons.length === 0 && writeLike ? 'READY_FOR_REVIEW' : reasons.length === 0 ? 'ALLOWED_READ_ONLY' : 'BLOCKED';
  return {
    contract_version: SUPERSET_PLANNING_GATE_CONTRACT,
    status,
    mutation_performed: false,
    action,
    reasons,
  };
}
