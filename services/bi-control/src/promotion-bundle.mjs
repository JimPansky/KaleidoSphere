import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { canonicalJson } from './canonical-json.js';
import { coded, exactObject } from './policy.mjs';
import { evaluateSupersetPlanningGate, sanitizeSupersetBaseUrl, SUPERSET_FINGERPRINT_CONTRACT } from './superset-fingerprint.mjs';

export const PROMOTION_BUNDLE_CONTRACT = 'chimpmaera.bi/superset-promotion-bundle/v1';
export const REVIEW_ASSET_CONTRACT = 'chimpmaera.bi/superset-review-asset/v1';
export const CATALOG_PROMOTION_EVIDENCE_CONTRACT = 'chimpmaera.bi/catalog-promotion-evidence/v1';
export const PROMOTION_PREFLIGHT_CONTRACT = 'chimpmaera.bi/superset-promotion-preflight/v1';
export const PROMOTION_INSPECTION_CONTRACT = 'chimpmaera.bi/superset-promotion-inspection/v1';

export const ZIP_LIMITS = Object.freeze({
  archiveBytes: 8 * 1024 * 1024,
  entryCount: 64,
  entryBytes: 2 * 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
  compressionRatio: 100,
  pathBytes: 240,
});

const MANIFEST_PATH = 'promotion-bundle.yaml';
const SCHEMA_PATHS = Object.freeze([
  'schemas/promotion-bundle.schema.json',
  'schemas/review-asset.schema.json',
]);
const EVIDENCE_PATHS = Object.freeze([
  'evidence/discovery-brief.json',
  'evidence/catalog-evidence.json',
  'evidence/superset-fingerprint.json',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_PATH = /^(?:promotion-bundle\.yaml|schemas\/(?:promotion-bundle|review-asset)\.schema\.json|evidence\/(?:discovery-brief|catalog-evidence|superset-fingerprint)\.json|assets\/(?:database|dataset|chart|dashboard)\/[0-9a-f-]{36}\.yaml)$/;
const SECRET_KEY = /^(?:authorization|cookie|set-cookie|password|passwd|secret|token|api[_-]?key|credential|credentials|client[_-]?secret|connection_uri|sqlalchemy_uri)$/i;
const SECRET_VALUE = /(?:ghp_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._~+/-]{16,}|Basic\s+[A-Za-z0-9+/=]{16,}|BEGIN (?:RSA |EC )?PRIVATE KEY|(?:jdbc:|oracle:|mssql:|postgres(?:ql)?:\/\/)[^\s]+)/i;
const RAW_SQL = /\b(?:select\s+[\s\S]{0,160}\sfrom|insert\s+into|update\s+[A-Za-z0-9_.]+\s+set|delete\s+from|drop\s+(?:table|view)|alter\s+(?:table|view)|create\s+(?:table|view)|merge\s+into)\b/i;
const SOURCE_ROW_KEYS = /^(?:rows?|records?|sample_data|row_values|result_set|raw_data)$/i;
const RAW_SQL_KEYS = /^(?:sql|raw_sql|query_text|statement|sqla_query)$/i;
const ASSET_KINDS = new Set(['database', 'dataset', 'chart', 'dashboard']);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const jsonBytes = (value) => Buffer.from(`${canonicalJson(value)}\n`, 'utf8');

function fail(code) {
  throw coded(code);
}

function exact(value, allowed, required, code) {
  try { exactObject(value, allowed, required); }
  catch { fail(code); }
}

function iso(value, code) {
  const parsed = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) fail(code);
  return value;
}

function safeText(value, code, max = 1000) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail(code);
  if (SECRET_VALUE.test(value)) fail('PROMOTION_SECRET_VALUE_DENIED');
  if (RAW_SQL.test(value)) fail('PROMOTION_RAW_SQL_DENIED');
  return value;
}

function scanDisclosure(value, location = '$') {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return;
  if (typeof value === 'string') {
    safeText(value, 'PROMOTION_TEXT_DENIED', 100_000);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 500) fail('PROMOTION_ARRAY_OVERSIZED');
    value.forEach((item, index) => scanDisclosure(item, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) fail('PROMOTION_OBJECT_INVALID');
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) fail('PROMOTION_SECRET_KEY_DENIED');
    if (SOURCE_ROW_KEYS.test(key)) fail('PROMOTION_SOURCE_ROWS_DENIED');
    if (RAW_SQL_KEYS.test(key)) fail('PROMOTION_RAW_SQL_KEY_DENIED');
    scanDisclosure(child, `${location}.${key}`);
  }
}

function validateDiscovery(brief) {
  exact(brief, ['schemaVersion', 'status', 'sessionId', 'revision', 'catalog', 'audienceRole', 'businessQuestions', 'confirmedInterests', 'freshnessNeed', 'filtersSegments', 'accessConfidentiality', 'openAssumptions', 'coverageBlindSpots', 'provenance', 'm5Boundary', 'markdown'], ['schemaVersion', 'status', 'sessionId', 'revision', 'catalog', 'audienceRole', 'businessQuestions', 'confirmedInterests', 'freshnessNeed', 'filtersSegments', 'accessConfidentiality', 'openAssumptions', 'coverageBlindSpots', 'provenance', 'm5Boundary'], 'PROMOTION_DISCOVERY_SCHEMA_INVALID');
  if (brief.schemaVersion !== 'chimpmaera.bi/discovery-brief/v1' || brief.status !== 'EXPORTED_CONFIRMED_DISCOVERY_BRIEF') fail('PROMOTION_DISCOVERY_UNCONFIRMED');
  if (!Number.isInteger(brief.revision) || brief.revision < 1 || !/^[a-z0-9][a-z0-9_-]{2,63}$/.test(brief.sessionId)) fail('PROMOTION_DISCOVERY_IDENTITY_INVALID');
  if (!brief.catalog || typeof brief.catalog !== 'object' || !SHA256.test(brief.catalog.snapshotSha256 ?? '') || typeof brief.catalog.receiptId !== 'string') fail('PROMOTION_DISCOVERY_CATALOG_INVALID');
  if (!brief.catalog.scope || !Array.isArray(brief.catalog.scope.schemas) || brief.catalog.scope.schemas.length < 1) fail('PROMOTION_DISCOVERY_SCOPE_INVALID');
  if (!brief.provenance || brief.provenance.receiptId !== brief.catalog.receiptId || brief.provenance.snapshotSha256 !== brief.catalog.snapshotSha256 || !Array.isArray(brief.provenance.evidenceSources) || brief.provenance.evidenceSources.length < 1) fail('PROMOTION_DISCOVERY_PROVENANCE_INVALID');
  if (!Array.isArray(brief.coverageBlindSpots) || brief.coverageBlindSpots.length < 1) fail('PROMOTION_DISCOVERY_COVERAGE_MISSING');
  if (!brief.accessConfidentiality || !['INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'].includes(brief.accessConfidentiality.classification)) fail('PROMOTION_DISCLOSURE_CLASSIFICATION_DENIED');
  scanDisclosure(brief);
  return brief;
}

function validateCatalog(evidence, brief) {
  exact(evidence, ['schemaVersion', 'receiptId', 'snapshotSha256', 'scope', 'coverage', 'provenance', 'mutationPerformed'], ['schemaVersion', 'receiptId', 'snapshotSha256', 'scope', 'coverage', 'provenance', 'mutationPerformed'], 'PROMOTION_CATALOG_SCHEMA_INVALID');
  if (evidence.schemaVersion !== CATALOG_PROMOTION_EVIDENCE_CONTRACT || evidence.mutationPerformed !== false) fail('PROMOTION_CATALOG_CONTRACT_DENIED');
  if (evidence.receiptId !== brief.catalog.receiptId || evidence.snapshotSha256 !== brief.catalog.snapshotSha256) fail('PROMOTION_CATALOG_BINDING_MISMATCH');
  if (!SHA256.test(evidence.snapshotSha256) || canonicalJson(evidence.scope) !== canonicalJson(brief.catalog.scope)) fail('PROMOTION_CATALOG_SCOPE_MISMATCH');
  if (!Array.isArray(evidence.coverage) || evidence.coverage.length < 1 || canonicalJson(evidence.coverage) !== canonicalJson(brief.coverageBlindSpots)) fail('PROMOTION_CATALOG_COVERAGE_MISMATCH');
  if (!Array.isArray(evidence.provenance) || evidence.provenance.length < 1) fail('PROMOTION_CATALOG_PROVENANCE_MISSING');
  scanDisclosure(evidence);
  return evidence;
}

function fingerprintSummary(fingerprint) {
  if (!fingerprint || fingerprint.contract_version !== SUPERSET_FINGERPRINT_CONTRACT) fail('PROMOTION_FINGERPRINT_CONTRACT_DENIED');
  const target = sanitizeSupersetBaseUrl(fingerprint.target?.base_url);
  if (target.identity_sha256 !== fingerprint.target?.identity_sha256) fail('PROMOTION_FINGERPRINT_TARGET_IDENTITY_MISMATCH');
  if (!SHA256.test(fingerprint.openapi?.sha256 ?? '') || fingerprint.openapi.sha256 !== fingerprint.openapi.canonicalization?.sha256) fail('PROMOTION_FINGERPRINT_OPENAPI_HASH_MISMATCH');
  const summary = {
    contract_version: fingerprint.contract_version,
    source_fingerprint_sha256: sha256(canonicalJson(fingerprint)),
    target: fingerprint.target,
    observed_at: fingerprint.observed_at,
    superset: fingerprint.superset,
    openapi: {
      source: fingerprint.openapi.source,
      canonicalization: fingerprint.openapi.canonicalization,
      sha256: fingerprint.openapi.sha256,
    },
    feature_flags: fingerprint.feature_flags,
    evidence: fingerprint.evidence,
    freshness: fingerprint.freshness,
    compatibility_verdict: fingerprint.compatibility_verdict,
    limitations: fingerprint.limitations,
    nonclaims: fingerprint.nonclaims,
  };
  scanDisclosure(summary);
  return summary;
}

function validateAsset(asset) {
  exact(asset, ['kind', 'uuid', 'title', 'dependsOn', 'reviewSpec'], ['kind', 'uuid', 'title', 'dependsOn', 'reviewSpec'], 'PROMOTION_ASSET_SCHEMA_INVALID');
  if (!ASSET_KINDS.has(asset.kind) || !UUID.test(asset.uuid)) fail('PROMOTION_ASSET_IDENTITY_INVALID');
  safeText(asset.title, 'PROMOTION_ASSET_TITLE_INVALID', 160);
  if (!Array.isArray(asset.dependsOn) || new Set(asset.dependsOn).size !== asset.dependsOn.length || asset.dependsOn.some((uuid) => !UUID.test(uuid))) fail('PROMOTION_ASSET_DEPENDENCIES_INVALID');
  if (!asset.reviewSpec || typeof asset.reviewSpec !== 'object' || Array.isArray(asset.reviewSpec)) fail('PROMOTION_ASSET_REVIEW_SPEC_INVALID');
  scanDisclosure(asset.reviewSpec);
  return {
    schema_version: REVIEW_ASSET_CONTRACT,
    kind: asset.kind,
    uuid: asset.uuid.toLowerCase(),
    title: asset.title,
    depends_on: asset.dependsOn.map((uuid) => uuid.toLowerCase()).sort(),
    review_spec: asset.reviewSpec,
    mutation_performed: false,
  };
}

function ensureAssetGraph(assets) {
  const identities = new Map();
  for (const asset of assets) {
    if (identities.has(asset.uuid)) fail('PROMOTION_ASSET_UUID_DUPLICATE');
    identities.set(asset.uuid, asset);
  }
  for (const asset of assets) {
    for (const dependency of asset.depends_on) {
      if (dependency === asset.uuid) fail('PROMOTION_ASSET_SELF_REFERENCE');
      if (!identities.has(dependency)) fail('PROMOTION_ASSET_REFERENCE_DANGLING');
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const walk = (uuid) => {
    if (visiting.has(uuid)) fail('PROMOTION_ASSET_GRAPH_CYCLE');
    if (visited.has(uuid)) return;
    visiting.add(uuid);
    for (const dependency of identities.get(uuid).depends_on) walk(dependency);
    visiting.delete(uuid);
    visited.add(uuid);
  };
  for (const uuid of identities.keys()) walk(uuid);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function assertSafePath(name) {
  if (typeof name !== 'string' || Buffer.byteLength(name) > ZIP_LIMITS.pathBytes || name.includes('\\') || name.includes('\0') || name.startsWith('/') || name.split('/').some((part) => part === '' || part === '.' || part === '..') || !SAFE_PATH.test(name)) fail('PROMOTION_ZIP_PATH_DENIED');
}

export function createDeterministicZip(entries) {
  const sorted = [...entries].map((entry) => ({ name: entry.name, data: Buffer.from(entry.data) })).sort((left, right) => left.name.localeCompare(right.name, 'en'));
  const names = new Set();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of sorted) {
    assertSafePath(entry.name);
    if (names.has(entry.name)) fail('PROMOTION_ZIP_DUPLICATE_PATH');
    names.add(entry.name);
    const name = Buffer.from(entry.name, 'utf8');
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, entry.data);
    centrals.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }
  const centralOffset = offset;
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(sorted.length, 8);
  eocd.writeUInt16LE(sorted.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...locals, centralBytes, eocd]);
}

function findEocd(buffer) {
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  fail('PROMOTION_ZIP_EOCD_MISSING');
}

export function readPromotionZip(input) {
  const buffer = Buffer.from(input);
  if (buffer.length > ZIP_LIMITS.archiveBytes) fail('PROMOTION_ZIP_ARCHIVE_OVERSIZED');
  if (buffer.length < 22) fail('PROMOTION_ZIP_TRUNCATED');
  const eocdOffset = findEocd(buffer);
  const disk = buffer.readUInt16LE(eocdOffset + 4);
  const centralDisk = buffer.readUInt16LE(eocdOffset + 6);
  const diskEntries = buffer.readUInt16LE(eocdOffset + 8);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  const commentLength = buffer.readUInt16LE(eocdOffset + 20);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount) fail('PROMOTION_ZIP_MULTIDISK_DENIED');
  if (commentLength !== 0 || eocdOffset + 22 !== buffer.length) fail('PROMOTION_ZIP_TRAILING_DATA_DENIED');
  if (entryCount < 1 || entryCount > ZIP_LIMITS.entryCount) fail('PROMOTION_ZIP_ENTRY_COUNT_DENIED');
  if (centralOffset + centralSize !== eocdOffset) fail('PROMOTION_ZIP_CENTRAL_DIRECTORY_INVALID');
  const entries = new Map();
  const ranges = [];
  let cursor = centralOffset;
  let totalBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > eocdOffset || buffer.readUInt32LE(cursor) !== 0x02014b50) fail('PROMOTION_ZIP_CENTRAL_ENTRY_INVALID');
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const checksum = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const entryCommentLength = buffer.readUInt16LE(cursor + 32);
    const diskStart = buffer.readUInt16LE(cursor + 34);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + entryCommentLength;
    if (end > eocdOffset || diskStart !== 0 || extraLength !== 0 || entryCommentLength !== 0) fail('PROMOTION_ZIP_CENTRAL_ENTRY_INVALID');
    if ((flags & ~0x0800) !== 0 || ![0, 8].includes(method)) fail('PROMOTION_ZIP_ENCODING_DENIED');
    if (((externalAttributes >>> 16) & 0o170000) === 0o120000) fail('PROMOTION_ZIP_SYMLINK_DENIED');
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    assertSafePath(name);
    if (entries.has(name)) fail('PROMOTION_ZIP_DUPLICATE_PATH');
    if (uncompressedSize > ZIP_LIMITS.entryBytes) fail('PROMOTION_ZIP_ENTRY_OVERSIZED');
    totalBytes += uncompressedSize;
    if (totalBytes > ZIP_LIMITS.totalBytes) fail('PROMOTION_ZIP_TOTAL_OVERSIZED');
    if (compressedSize === 0 ? uncompressedSize > 0 : uncompressedSize / compressedSize > ZIP_LIMITS.compressionRatio) fail('PROMOTION_ZIP_COMPRESSION_RATIO_DENIED');
    if (localOffset + 30 > centralOffset || buffer.readUInt32LE(localOffset) !== 0x04034b50) fail('PROMOTION_ZIP_LOCAL_ENTRY_INVALID');
    const localFlags = buffer.readUInt16LE(localOffset + 6);
    const localMethod = buffer.readUInt16LE(localOffset + 8);
    const localChecksum = buffer.readUInt32LE(localOffset + 14);
    const localCompressedSize = buffer.readUInt32LE(localOffset + 18);
    const localUncompressedSize = buffer.readUInt32LE(localOffset + 22);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const localName = buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('utf8');
    if (localFlags !== flags || localMethod !== method || localChecksum !== checksum || localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize || localExtraLength !== 0 || localName !== name) fail('PROMOTION_ZIP_LOCAL_CENTRAL_MISMATCH');
    const dataStart = localOffset + 30 + localNameLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > centralOffset) fail('PROMOTION_ZIP_ENTRY_TRUNCATED');
    ranges.push([localOffset, dataEnd]);
    const compressed = buffer.subarray(dataStart, dataEnd);
    let data;
    try { data = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: ZIP_LIMITS.entryBytes }); }
    catch { fail('PROMOTION_ZIP_DECOMPRESSION_DENIED'); }
    if (data.length !== uncompressedSize || crc32(data) !== checksum) fail('PROMOTION_ZIP_CHECKSUM_MISMATCH');
    entries.set(name, data);
    cursor = end;
  }
  if (cursor !== eocdOffset) fail('PROMOTION_ZIP_CENTRAL_DIRECTORY_INVALID');
  ranges.sort((left, right) => left[0] - right[0]);
  for (let index = 1; index < ranges.length; index += 1) if (ranges[index][0] < ranges[index - 1][1]) fail('PROMOTION_ZIP_OVERLAPPING_ENTRIES');
  return entries;
}

function parseJsonEntry(entries, entryPath, code) {
  const bytes = entries.get(entryPath);
  if (!bytes) fail(code);
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { fail(code); }
  if (canonicalJson(value) + '\n' !== bytes.toString('utf8')) fail('PROMOTION_CANONICAL_ARTIFACT_REQUIRED');
  return value;
}

function validateManifest(entries, manifest, { now = new Date() } = {}) {
  exact(manifest, ['contract_version', 'bundle_id', 'artifact_mode', 'created_at', 'mutation_performed', 'discovery', 'catalog', 'target', 'superset', 'fingerprint', 'assets', 'files', 'disclosure', 'limitations', 'nonclaims', 'integrity'], ['contract_version', 'bundle_id', 'artifact_mode', 'created_at', 'mutation_performed', 'discovery', 'catalog', 'target', 'superset', 'fingerprint', 'assets', 'files', 'disclosure', 'limitations', 'nonclaims', 'integrity'], 'PROMOTION_MANIFEST_SCHEMA_INVALID');
  if (manifest.contract_version !== PROMOTION_BUNDLE_CONTRACT || manifest.artifact_mode !== 'REVIEW_ONLY' || manifest.mutation_performed !== false) fail('PROMOTION_MANIFEST_CONTRACT_DENIED');
  iso(manifest.created_at, 'PROMOTION_MANIFEST_TIME_INVALID');
  if (!SHA256.test(manifest.bundle_id ?? '')) fail('PROMOTION_BUNDLE_ID_INVALID');
  const payload = { ...manifest };
  delete payload.bundle_id;
  if (sha256(canonicalJson(payload)) !== manifest.bundle_id) fail('PROMOTION_BUNDLE_ID_MISMATCH');
  if (!manifest.integrity || manifest.integrity.algorithm !== 'sha256' || manifest.integrity.signature?.status !== 'UNSIGNED_REVIEW_ARTIFACT' || manifest.integrity.signature?.authenticity_claimed !== false) fail('PROMOTION_INTEGRITY_SEMANTICS_DENIED');
  const listed = new Map();
  if (!Array.isArray(manifest.files)) fail('PROMOTION_FILE_INVENTORY_INVALID');
  for (const file of manifest.files) {
    exact(file, ['path', 'sha256', 'bytes'], ['path', 'sha256', 'bytes'], 'PROMOTION_FILE_INVENTORY_INVALID');
    assertSafePath(file.path);
    if (file.path === MANIFEST_PATH || listed.has(file.path) || !SHA256.test(file.sha256) || !Number.isInteger(file.bytes) || file.bytes < 1) fail('PROMOTION_FILE_INVENTORY_INVALID');
    const bytes = entries.get(file.path);
    if (!bytes || bytes.length !== file.bytes || sha256(bytes) !== file.sha256) fail('PROMOTION_FILE_HASH_MISMATCH');
    listed.set(file.path, file);
  }
  const actual = [...entries.keys()].filter((name) => name !== MANIFEST_PATH).sort();
  if (canonicalJson([...listed.keys()].sort()) !== canonicalJson(actual)) fail('PROMOTION_FILE_INVENTORY_INCOMPLETE');
  for (const required of [...SCHEMA_PATHS, ...EVIDENCE_PATHS]) if (!listed.has(required)) fail('PROMOTION_REQUIRED_FILE_MISSING');

  const discovery = parseJsonEntry(entries, EVIDENCE_PATHS[0], 'PROMOTION_DISCOVERY_ARTIFACT_INVALID');
  const catalog = parseJsonEntry(entries, EVIDENCE_PATHS[1], 'PROMOTION_CATALOG_ARTIFACT_INVALID');
  const fingerprint = parseJsonEntry(entries, EVIDENCE_PATHS[2], 'PROMOTION_FINGERPRINT_ARTIFACT_INVALID');
  validateDiscovery(discovery);
  validateCatalog(catalog, discovery);
  if (manifest.discovery.sha256 !== sha256(entries.get(EVIDENCE_PATHS[0])) || manifest.discovery.session_id !== discovery.sessionId || manifest.discovery.revision !== discovery.revision || manifest.discovery.status !== discovery.status) fail('PROMOTION_DISCOVERY_BINDING_MISMATCH');
  if (manifest.catalog.sha256 !== sha256(entries.get(EVIDENCE_PATHS[1])) || manifest.catalog.receipt_id !== catalog.receiptId || manifest.catalog.snapshot_sha256 !== catalog.snapshotSha256 || canonicalJson(manifest.catalog.scope) !== canonicalJson(catalog.scope) || manifest.catalog.coverage_sha256 !== sha256(canonicalJson(catalog.coverage))) fail('PROMOTION_CATALOG_BINDING_MISMATCH');
  const sanitizedTarget = sanitizeSupersetBaseUrl(fingerprint.target?.base_url);
  if (canonicalJson(manifest.target) !== canonicalJson(fingerprint.target) || sanitizedTarget.identity_sha256 !== manifest.target.identity_sha256) fail('PROMOTION_TARGET_BINDING_MISMATCH');
  if (manifest.superset.version !== fingerprint.superset?.version || manifest.fingerprint.sha256 !== sha256(entries.get(EVIDENCE_PATHS[2])) || manifest.fingerprint.source_fingerprint_sha256 !== fingerprint.source_fingerprint_sha256 || manifest.fingerprint.openapi_sha256 !== fingerprint.openapi?.sha256 || manifest.fingerprint.observed_at !== fingerprint.observed_at || manifest.fingerprint.stale_after !== fingerprint.freshness?.stale_after || canonicalJson(manifest.fingerprint.feature_flags) !== canonicalJson(fingerprint.feature_flags?.capabilities)) fail('PROMOTION_FINGERPRINT_BINDING_MISMATCH');
  const gateFingerprint = {
    contract_version: fingerprint.contract_version,
    target: fingerprint.target,
    observed_at: fingerprint.observed_at,
    superset: fingerprint.superset,
    openapi: fingerprint.openapi,
    feature_flags: fingerprint.feature_flags,
    freshness: fingerprint.freshness,
    compatibility_verdict: fingerprint.compatibility_verdict,
  };
  const requiredFlags = Object.fromEntries((fingerprint.feature_flags?.capabilities ?? []).filter((entry) => entry.required_for_promotion).map((entry) => [entry.name, entry.required_value]));
  const gate = evaluateSupersetPlanningGate({ fingerprint: gateFingerprint, request: { action: 'promotion review bundle preflight', target_base_url: manifest.target.base_url, expected_openapi_sha256: manifest.fingerprint.openapi_sha256, required_feature_flags: requiredFlags }, now });
  if (gate.status === 'BLOCKED') fail(gate.reasons[0] ?? 'PROMOTION_FINGERPRINT_BLOCKED');

  if (!Array.isArray(manifest.assets) || manifest.assets.length < 1) fail('PROMOTION_ASSET_INVENTORY_INVALID');
  const assetObjects = [];
  for (const item of manifest.assets) {
    exact(item, ['kind', 'uuid', 'title', 'path', 'sha256', 'depends_on'], ['kind', 'uuid', 'title', 'path', 'sha256', 'depends_on'], 'PROMOTION_ASSET_INVENTORY_INVALID');
    const expectedPath = `assets/${item.kind}/${item.uuid}.yaml`;
    if (item.path !== expectedPath || !listed.has(item.path) || listed.get(item.path).sha256 !== item.sha256) fail('PROMOTION_ASSET_FILE_BINDING_MISMATCH');
    const asset = parseJsonEntry(entries, item.path, 'PROMOTION_ASSET_ARTIFACT_INVALID');
    if (asset.schema_version !== REVIEW_ASSET_CONTRACT || asset.mutation_performed !== false || asset.kind !== item.kind || asset.uuid !== item.uuid || asset.title !== item.title || canonicalJson(asset.depends_on) !== canonicalJson(item.depends_on)) fail('PROMOTION_ASSET_BINDING_MISMATCH');
    scanDisclosure(asset);
    assetObjects.push(asset);
  }
  ensureAssetGraph(assetObjects);
  if (manifest.disclosure.classification !== discovery.accessConfidentiality.classification || manifest.disclosure.source_rows_included !== false || manifest.disclosure.raw_sql_included !== false || manifest.disclosure.secrets_included !== false) fail('PROMOTION_DISCLOSURE_GUARD_DENIED');
  if (!Array.isArray(manifest.limitations) || manifest.limitations.length < 1 || !Array.isArray(manifest.nonclaims) || manifest.nonclaims.length < 1) fail('PROMOTION_NONCLAIMS_MISSING');
  scanDisclosure(manifest);
  return { discovery, catalog, fingerprint, assets: assetObjects, gate };
}

export async function buildPromotionBundle(input, { contractDir = path.resolve('contracts/superset-promotion-bundle/v1'), now = new Date() } = {}) {
  exact(input, ['discoveryBrief', 'catalogEvidence', 'supersetFingerprint', 'assets', 'createdAt', 'limitations', 'nonclaims'], ['discoveryBrief', 'catalogEvidence', 'supersetFingerprint', 'assets', 'createdAt'], 'PROMOTION_BUILD_INPUT_INVALID');
  const discovery = validateDiscovery(input.discoveryBrief);
  const catalog = validateCatalog(input.catalogEvidence, discovery);
  const fingerprint = fingerprintSummary(input.supersetFingerprint);
  const createdAt = iso(input.createdAt, 'PROMOTION_BUILD_TIME_INVALID');
  if (!Array.isArray(input.assets) || input.assets.length < 1 || input.assets.length > 32) fail('PROMOTION_ASSET_INVENTORY_INVALID');
  const assets = input.assets.map(validateAsset).sort((left, right) => left.uuid.localeCompare(right.uuid, 'en'));
  ensureAssetGraph(assets);
  const entries = new Map();
  entries.set(EVIDENCE_PATHS[0], jsonBytes(discovery));
  entries.set(EVIDENCE_PATHS[1], jsonBytes(catalog));
  entries.set(EVIDENCE_PATHS[2], jsonBytes(fingerprint));
  for (const schemaPath of SCHEMA_PATHS) entries.set(schemaPath, await readFile(path.join(contractDir, path.basename(schemaPath))));
  for (const asset of assets) entries.set(`assets/${asset.kind}/${asset.uuid}.yaml`, jsonBytes(asset));
  const files = [...entries.entries()].sort(([left], [right]) => left.localeCompare(right, 'en')).map(([entryPath, bytes]) => ({ path: entryPath, sha256: sha256(bytes), bytes: bytes.length }));
  const manifestWithoutId = {
    contract_version: PROMOTION_BUNDLE_CONTRACT,
    artifact_mode: 'REVIEW_ONLY',
    created_at: createdAt,
    mutation_performed: false,
    discovery: { schema_version: discovery.schemaVersion, session_id: discovery.sessionId, revision: discovery.revision, status: discovery.status, sha256: sha256(entries.get(EVIDENCE_PATHS[0])) },
    catalog: { schema_version: catalog.schemaVersion, receipt_id: catalog.receiptId, snapshot_sha256: catalog.snapshotSha256, scope: catalog.scope, coverage_sha256: sha256(canonicalJson(catalog.coverage)), sha256: sha256(entries.get(EVIDENCE_PATHS[1])) },
    target: fingerprint.target,
    superset: { product: fingerprint.superset.product, version: fingerprint.superset.version },
    fingerprint: { contract_version: fingerprint.contract_version, source_fingerprint_sha256: fingerprint.source_fingerprint_sha256, sha256: sha256(entries.get(EVIDENCE_PATHS[2])), observed_at: fingerprint.observed_at, stale_after: fingerprint.freshness.stale_after, openapi_sha256: fingerprint.openapi.sha256, feature_flags: fingerprint.feature_flags.capabilities },
    assets: assets.map((asset) => { const assetPath = `assets/${asset.kind}/${asset.uuid}.yaml`; return { kind: asset.kind, uuid: asset.uuid, title: asset.title, path: assetPath, sha256: sha256(entries.get(assetPath)), depends_on: asset.depends_on }; }),
    files,
    disclosure: { classification: discovery.accessConfidentiality.classification, source_rows_included: false, raw_sql_included: false, secrets_included: false, review_required: true },
    limitations: input.limitations ?? ['This deterministic bundle is limited to offline review of evidence-bound asset specifications.'],
    nonclaims: input.nonclaims ?? ['No Superset import, promotion, mutation, source-database connection, source-row access, or SQL generation is performed or authorized.'],
    integrity: { algorithm: 'sha256', file_hashes_required: true, sidecar_checksum_required_for_delivery: true, signature: { status: 'UNSIGNED_REVIEW_ARTIFACT', authenticity_claimed: false } },
  };
  scanDisclosure(manifestWithoutId);
  const manifest = { ...manifestWithoutId, bundle_id: sha256(canonicalJson(manifestWithoutId)) };
  entries.set(MANIFEST_PATH, jsonBytes(manifest));
  const archive = createDeterministicZip([...entries].map(([name, data]) => ({ name, data })));
  const inspection = inspectPromotionBundle(archive, { now });
  return { archive, sha256: sha256(archive), manifest, inspection };
}

export function inspectPromotionBundle(input, { now = new Date() } = {}) {
  const archive = Buffer.from(input);
  const entries = readPromotionZip(archive);
  const manifest = parseJsonEntry(entries, MANIFEST_PATH, 'PROMOTION_MANIFEST_INVALID');
  const validated = validateManifest(entries, manifest, { now });
  return {
    contract_version: PROMOTION_INSPECTION_CONTRACT,
    status: 'VALID_REVIEW_ARTIFACT',
    bundle_contract: manifest.contract_version,
    bundle_id: manifest.bundle_id,
    archive_sha256: sha256(archive),
    archive_bytes: archive.length,
    entry_count: entries.size,
    asset_count: validated.assets.length,
    target: manifest.target,
    superset_version: manifest.superset.version,
    openapi_sha256: manifest.fingerprint.openapi_sha256,
    disclosure: manifest.disclosure,
    mutation_performed: false,
    limitations: manifest.limitations,
    nonclaims: manifest.nonclaims,
  };
}

export function preflightPromotionBundle(input, options = {}) {
  try {
    const inspection = inspectPromotionBundle(input, options);
    return { contract_version: PROMOTION_PREFLIGHT_CONTRACT, status: 'PASS_REVIEW_ONLY', reasons: [], inspection, mutation_performed: false };
  } catch (error) {
    return { contract_version: PROMOTION_PREFLIGHT_CONTRACT, status: 'BLOCKED', reasons: [error?.code ?? error?.message ?? 'PROMOTION_PREFLIGHT_FAILED'], mutation_performed: false };
  }
}

export async function writePromotionBundle(result, outputPath) {
  await writeFile(outputPath, result.archive, { mode: 0o600, flag: 'wx' });
  const sidecar = `${result.sha256}  ${path.basename(outputPath)}\n`;
  await writeFile(`${outputPath}.sha256`, sidecar, { mode: 0o600, flag: 'wx' });
  return { bundle: outputPath, checksum: `${outputPath}.sha256`, sha256: result.sha256 };
}
