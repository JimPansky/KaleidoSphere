import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { ingestCatalogReceipt } from '../services/bi-control/src/catalog.mjs';
import { canonicalJson } from '../services/bi-control/src/canonical-json.js';
import { handleDiscovery } from '../services/bi-control/src/discovery.mjs';
import { runAnalyzeProfile } from '../services/bi-control/src/db-analyzer/workflow.mjs';
import {
  buildPromotionBundle,
  createDeterministicZip,
  inspectPromotionBundle,
  preflightPromotionBundle,
  PROMOTION_BUNDLE_CONTRACT,
  readPromotionZip,
  ZIP_LIMITS,
} from '../services/bi-control/src/promotion-bundle.mjs';
import { buildSupersetFingerprint } from '../services/bi-control/src/superset-fingerprint.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const jsonBytes = (value) => Buffer.from(`${canonicalJson(value)}\n`);
const fixedNow = new Date('2026-08-14T08:30:00.000Z');

async function confirmedBrief() {
  const analysis = await runAnalyzeProfile('services/bi-control/fixtures/mssql-profile-v1.json', { repositoryRoot: 'services/bi-control' });
  const receipt = {
    schemaVersion: 'chimpmaera.bi/analysis-receipt/v1',
    receiptId: `mssql-${analysis.snapshotSha256.slice(0, 24)}`,
    status: 'ANALYZED_READ_ONLY',
    analyzedAt: '2026-08-13T22:20:00.000Z',
    sourceMode: 'fixture',
    engine: 'mssql',
    scope: analysis.profile.scope,
    safety: { queryPackSelectOnly: true, rowSamples: false },
    analysis,
  };
  const db = new DatabaseSync(':memory:');
  ingestCatalogReceipt(db, receipt);
  const started = handleDiscovery(db, { action: 'start', sessionId: 'promotion_review' });
  const first = (group) => started.state.guidance.suggestions[group][0].id;
  const answer = (field, value) => handleDiscovery(db, { action: 'answer', sessionId: 'promotion_review', field, value });
  answer('audienceRole', 'Sales analyst');
  answer('businessQuestions', ['Which confirmed order value should be reviewed weekly?']);
  answer('confirmedKpiCandidates', [first('kpiCandidates')]);
  answer('dimensions', [first('dimensions')]);
  answer('timeGranularity', { candidateIds: [first('timeCandidates')], granularity: 'snapshot' });
  answer('filtersSegments', ['Active customer segment']);
  answer('drilldowns', [first('drilldownCandidates')]);
  answer('freshnessNeed', 'Refresh before weekly review');
  answer('accessConfidentiality', { classification: 'INTERNAL', constraints: ['No source row values'] });
  answer('openAssumptions', ['Business owner validation remains required']);
  handleDiscovery(db, { action: 'confirm', sessionId: 'promotion_review', confirmed: true });
  const brief = handleDiscovery(db, { action: 'export', sessionId: 'promotion_review' }).export;
  db.close();
  return brief;
}

async function validInput() {
  const discoveryBrief = await confirmedBrief();
  const runtime = JSON.parse(await readFile('services/bi-control/fixtures/superset-fingerprint-runtime-v1.json', 'utf8'));
  const supersetFingerprint = buildSupersetFingerprint(runtime);
  const references = discoveryBrief.provenance.evidenceSources.slice(0, 2);
  return {
    createdAt: '2026-08-14T08:30:00.000Z',
    discoveryBrief,
    catalogEvidence: {
      schemaVersion: 'chimpmaera.bi/catalog-promotion-evidence/v1',
      receiptId: discoveryBrief.catalog.receiptId,
      snapshotSha256: discoveryBrief.catalog.snapshotSha256,
      scope: structuredClone(discoveryBrief.catalog.scope),
      coverage: structuredClone(discoveryBrief.coverageBlindSpots),
      provenance: references,
      mutationPerformed: false,
    },
    supersetFingerprint,
    assets: [
      { kind: 'database', uuid: '11111111-1111-4111-8111-111111111111', title: 'Reviewed target placeholder', dependsOn: [], reviewSpec: { targetBinding: 'SANITIZED_TARGET_ONLY', sourceConnectionIncluded: false } },
      { kind: 'dataset', uuid: '22222222-2222-4222-8222-222222222222', title: 'Reviewed order metric dataset', dependsOn: ['11111111-1111-4111-8111-111111111111'], reviewSpec: { catalogReferences: references, semanticReviewRequired: true } },
      { kind: 'chart', uuid: '33333333-3333-4333-8333-333333333333', title: 'Reviewed weekly order value', dependsOn: ['22222222-2222-4222-8222-222222222222'], reviewSpec: { visualizationType: 'big_number', confirmedInterestIds: discoveryBrief.confirmedInterests.kpiCandidates.map((item) => item.id) } },
      { kind: 'chart', uuid: '55555555-5555-4555-8555-555555555555', title: 'Reviewed order trend', dependsOn: ['22222222-2222-4222-8222-222222222222'], reviewSpec: { visualizationType: 'time_series', confirmedInterestIds: discoveryBrief.confirmedInterests.timeCandidates.map((item) => item.id) } },
      { kind: 'dashboard', uuid: '44444444-4444-4444-8444-444444444444', title: 'Reviewed sales dashboard', dependsOn: ['33333333-3333-4333-8333-333333333333', '55555555-5555-4555-8555-555555555555'], reviewSpec: { reviewLayout: 'two_charts', publicationState: 'NOT_AUTHORIZED' } },
    ],
  };
}

async function build(input = null, options = {}) {
  return buildPromotionBundle(input ?? await validInput(), { now: fixedNow, ...options });
}

function code(error) {
  return error?.code ?? error?.message;
}

function clone(value) {
  return structuredClone(value);
}

async function expectBuildCode(change, expected, options = {}) {
  const input = await validInput();
  change(input);
  await assert.rejects(build(input, options), (error) => code(error) === expected, expected);
}

function replaceEvery(buffer, from, to) {
  assert.equal(Buffer.byteLength(from), Buffer.byteLength(to));
  const result = Buffer.from(buffer);
  const source = Buffer.from(from);
  const replacement = Buffer.from(to);
  let offset = 0;
  let replacements = 0;
  while ((offset = result.indexOf(source, offset)) !== -1) {
    replacement.copy(result, offset);
    offset += replacement.length;
    replacements += 1;
  }
  assert(replacements >= 2);
  return result;
}

function repack(archive, mutator, { refresh = true } = {}) {
  const entries = readPromotionZip(archive);
  const manifest = JSON.parse(entries.get('promotion-bundle.yaml'));
  mutator(entries, manifest);
  if (refresh) {
    const existing = new Map(manifest.files.map((item) => [item.path, item]));
    manifest.files = [...entries.entries()]
      .filter(([name]) => name !== 'promotion-bundle.yaml' && existing.has(name))
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([name, bytes]) => ({ path: name, sha256: sha256(bytes), bytes: bytes.length }));
    for (const asset of manifest.assets) {
      if (entries.has(asset.path)) asset.sha256 = sha256(entries.get(asset.path));
    }
    if (entries.has('evidence/discovery-brief.json')) manifest.discovery.sha256 = sha256(entries.get('evidence/discovery-brief.json'));
    if (entries.has('evidence/catalog-evidence.json')) manifest.catalog.sha256 = sha256(entries.get('evidence/catalog-evidence.json'));
    if (entries.has('evidence/superset-fingerprint.json')) manifest.fingerprint.sha256 = sha256(entries.get('evidence/superset-fingerprint.json'));
  }
  delete manifest.bundle_id;
  manifest.bundle_id = sha256(canonicalJson(manifest));
  entries.set('promotion-bundle.yaml', jsonBytes(manifest));
  return createDeterministicZip([...entries].map(([name, data]) => ({ name, data })));
}

test('promotion review bundle is deterministic, inspectable, checksum-bound, and never mutates', async () => {
  const input = await validInput();
  const first = await build(input);
  const second = await build(clone(input));
  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(first.archive, second.archive);
  assert.equal(first.manifest.contract_version, PROMOTION_BUNDLE_CONTRACT);
  assert.equal(first.manifest.artifact_mode, 'REVIEW_ONLY');
  assert.equal(first.manifest.mutation_performed, false);
  assert.equal(first.manifest.assets.length, 5);
  assert.equal(first.inspection.status, 'VALID_REVIEW_ARTIFACT');
  assert.equal(preflightPromotionBundle(first.archive, { now: fixedNow }).status, 'PASS_REVIEW_ONLY');
  assert.doesNotMatch(first.archive.toString('latin1'), /(?:password|Bearer |BEGIN PRIVATE KEY|SELECT\s+.+FROM)/i);
});

test('promotion CLI builds, inspects, and preflights with machine and human output', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sba-promotion-cli-'));
  const inputPath = path.join(directory, 'input.json');
  const bundlePath = path.join(directory, 'review.zip');
  await writeFile(inputPath, JSON.stringify(await validInput()));
  const buildResult = spawnSync('./bin/bi', ['promotion-bundle', 'build', '--input', inputPath, '--output', bundlePath, '--now', fixedNow.toISOString()], { encoding: 'utf8' });
  assert.equal(buildResult.status, 0, buildResult.stderr);
  assert.equal(JSON.parse(buildResult.stdout).status, 'VALID_REVIEW_ARTIFACT');
  const inspectResult = spawnSync('./bin/bi', ['promotion-bundle', 'inspect', '--bundle', bundlePath, '--now', fixedNow.toISOString()], { encoding: 'utf8' });
  assert.equal(inspectResult.status, 0, inspectResult.stderr);
  assert.equal(JSON.parse(inspectResult.stdout).mutation_performed, false);
  const preflightResult = spawnSync('./bin/bi', ['promotion-bundle', 'preflight', '--bundle', bundlePath, '--now', fixedNow.toISOString(), '--human', 'true'], { encoding: 'utf8' });
  assert.equal(preflightResult.status, 0, preflightResult.stderr);
  assert.match(preflightResult.stdout, /Status: PASS_REVIEW_ONLY/);
  assert.match(await readFile(`${bundlePath}.sha256`, 'utf8'), /^[a-f0-9]{64}  review\.zip\n$/);
});

test('at least 25 semantic build probes fail closed before any review artifact is accepted', async () => {
  const probes = [
    ['unconfirmed discovery', (x) => { x.discoveryBrief.status = 'DRAFT'; }, 'PROMOTION_DISCOVERY_UNCONFIRMED'],
    ['discovery schema drift', (x) => { x.discoveryBrief.schemaVersion = 'chimpmaera.bi/discovery-brief/v2'; }, 'PROMOTION_DISCOVERY_UNCONFIRMED'],
    ['discovery bad session', (x) => { x.discoveryBrief.sessionId = '../bad'; }, 'PROMOTION_DISCOVERY_IDENTITY_INVALID'],
    ['discovery missing coverage', (x) => { x.discoveryBrief.coverageBlindSpots = []; }, 'PROMOTION_DISCOVERY_COVERAGE_MISSING'],
    ['discovery bad classification', (x) => { x.discoveryBrief.accessConfidentiality.classification = 'PUBLIC'; }, 'PROMOTION_DISCLOSURE_CLASSIFICATION_DENIED'],
    ['discovery receipt provenance mismatch', (x) => { x.discoveryBrief.provenance.receiptId = 'other'; }, 'PROMOTION_DISCOVERY_PROVENANCE_INVALID'],
    ['discovery snapshot provenance mismatch', (x) => { x.discoveryBrief.provenance.snapshotSha256 = 'f'.repeat(64); }, 'PROMOTION_DISCOVERY_PROVENANCE_INVALID'],
    ['discovery provenance empty', (x) => { x.discoveryBrief.provenance.evidenceSources = []; }, 'PROMOTION_DISCOVERY_PROVENANCE_INVALID'],
    ['discovery secret key', (x) => { x.discoveryBrief.accessConfidentiality.password = 'masked'; }, 'PROMOTION_SECRET_KEY_DENIED'],
    ['discovery secret value', (x) => { x.discoveryBrief.openAssumptions = [`ghp_${'a'.repeat(30)}`]; }, 'PROMOTION_SECRET_VALUE_DENIED'],
    ['discovery raw SQL', (x) => { x.discoveryBrief.businessQuestions = ['SELECT amount FROM orders']; }, 'PROMOTION_RAW_SQL_DENIED'],
    ['discovery source rows', (x) => { x.discoveryBrief.confirmedInterests.rows = [{ value: 1 }]; }, 'PROMOTION_SOURCE_ROWS_DENIED'],
    ['catalog contract drift', (x) => { x.catalogEvidence.schemaVersion = 'catalog/v2'; }, 'PROMOTION_CATALOG_CONTRACT_DENIED'],
    ['catalog mutation flag', (x) => { x.catalogEvidence.mutationPerformed = true; }, 'PROMOTION_CATALOG_CONTRACT_DENIED'],
    ['catalog receipt mismatch', (x) => { x.catalogEvidence.receiptId = 'other'; }, 'PROMOTION_CATALOG_BINDING_MISMATCH'],
    ['catalog snapshot mismatch', (x) => { x.catalogEvidence.snapshotSha256 = 'f'.repeat(64); }, 'PROMOTION_CATALOG_BINDING_MISMATCH'],
    ['catalog scope mismatch', (x) => { x.catalogEvidence.scope.schemas = ['other']; }, 'PROMOTION_CATALOG_SCOPE_MISMATCH'],
    ['catalog coverage mismatch', (x) => { x.catalogEvidence.coverage[0].state = 'altered'; }, 'PROMOTION_CATALOG_COVERAGE_MISMATCH'],
    ['catalog provenance missing', (x) => { x.catalogEvidence.provenance = []; }, 'PROMOTION_CATALOG_PROVENANCE_MISSING'],
    ['fingerprint contract drift', (x) => { x.supersetFingerprint.contract_version = 'fingerprint/v2'; }, 'PROMOTION_FINGERPRINT_CONTRACT_DENIED'],
    ['fingerprint target identity mismatch', (x) => { x.supersetFingerprint.target.identity_sha256 = 'f'.repeat(64); }, 'PROMOTION_FINGERPRINT_TARGET_IDENTITY_MISMATCH'],
    ['fingerprint OpenAPI hash mismatch', (x) => { x.supersetFingerprint.openapi.sha256 = 'f'.repeat(64); }, 'PROMOTION_FINGERPRINT_OPENAPI_HASH_MISMATCH'],
    ['no assets', (x) => { x.assets = []; }, 'PROMOTION_ASSET_INVENTORY_INVALID'],
    ['asset kind denied', (x) => { x.assets[0].kind = 'query'; }, 'PROMOTION_ASSET_IDENTITY_INVALID'],
    ['asset UUID invalid', (x) => { x.assets[0].uuid = 'not-a-uuid'; }, 'PROMOTION_ASSET_IDENTITY_INVALID'],
    ['asset duplicate UUID', (x) => { x.assets[1].uuid = x.assets[0].uuid; x.assets[1].dependsOn = []; }, 'PROMOTION_ASSET_UUID_DUPLICATE'],
    ['asset dangling reference', (x) => { x.assets[1].dependsOn = ['99999999-9999-4999-8999-999999999999']; }, 'PROMOTION_ASSET_REFERENCE_DANGLING'],
    ['asset self reference', (x) => { x.assets[0].dependsOn = [x.assets[0].uuid]; }, 'PROMOTION_ASSET_SELF_REFERENCE'],
    ['asset graph cycle', (x) => { x.assets[0].dependsOn = [x.assets[1].uuid]; }, 'PROMOTION_ASSET_GRAPH_CYCLE'],
    ['asset raw SQL', (x) => { x.assets[1].reviewSpec.raw_sql = 'SELECT amount FROM orders'; }, 'PROMOTION_RAW_SQL_KEY_DENIED'],
    ['asset source rows', (x) => { x.assets[1].reviewSpec.rows = [{ amount: 1 }]; }, 'PROMOTION_SOURCE_ROWS_DENIED'],
    ['asset credential field', (x) => { x.assets[0].reviewSpec.credentials = 'none'; }, 'PROMOTION_SECRET_KEY_DENIED'],
    ['asset secret value', (x) => { x.assets[0].reviewSpec.note = `Bearer ${'a'.repeat(24)}`; }, 'PROMOTION_SECRET_VALUE_DENIED'],
  ];
  assert(probes.length >= 25);
  for (const [name, change, expected] of probes) await expectBuildCode(change, expected).catch((error) => { error.message = `${name}: ${error.message}`; throw error; });
});

test('malicious ZIP and post-build contract probes fail closed', async () => {
  const valid = await build();
  const semantic = [
    ['truncated archive', valid.archive.subarray(0, valid.archive.length - 5), 'PROMOTION_ZIP_EOCD_MISSING'],
    ['trailing data', Buffer.concat([valid.archive, Buffer.from('x')]), 'PROMOTION_ZIP_TRAILING_DATA_DENIED'],
    ['path traversal', replaceEvery(valid.archive, 'assets/', '../bad/'), 'PROMOTION_ZIP_PATH_DENIED'],
    ['duplicate path', replaceEvery(valid.archive, '55555555-5555-4555-8555-555555555555', '33333333-3333-4333-8333-333333333333'), 'PROMOTION_ZIP_DUPLICATE_PATH'],
    ['oversized archive', Buffer.alloc(ZIP_LIMITS.archiveBytes + 1), 'PROMOTION_ZIP_ARCHIVE_OVERSIZED'],
    ['checksum corruption', (() => { const value = Buffer.from(valid.archive); value[100] ^= 0xff; return value; })(), 'PROMOTION_ZIP_CHECKSUM_MISMATCH'],
    ['noncanonical JSON artifact', repack(valid.archive, (entries) => { const name = 'evidence/catalog-evidence.json'; entries.set(name, Buffer.concat([entries.get(name).subarray(0, -1), Buffer.from(' ')])); }), 'PROMOTION_CANONICAL_ARTIFACT_REQUIRED'],
    ['required schema omitted', repack(valid.archive, (entries, manifest) => { entries.delete('schemas/review-asset.schema.json'); manifest.files = manifest.files.filter((item) => item.path !== 'schemas/review-asset.schema.json'); }), 'PROMOTION_REQUIRED_FILE_MISSING'],
    ['unsigned semantics altered', repack(valid.archive, (_entries, manifest) => { manifest.integrity.signature.status = 'SIGNED_UNVERIFIED'; }), 'PROMOTION_INTEGRITY_SEMANTICS_DENIED'],
    ['mutation flag altered', repack(valid.archive, (_entries, manifest) => { manifest.mutation_performed = true; }), 'PROMOTION_MANIFEST_CONTRACT_DENIED'],
    ['disclosure raw SQL claim altered', repack(valid.archive, (_entries, manifest) => { manifest.disclosure.raw_sql_included = true; }), 'PROMOTION_DISCLOSURE_GUARD_DENIED'],
    ['Superset version binding altered', repack(valid.archive, (_entries, manifest) => { manifest.superset.version = '6.2.0'; }), 'PROMOTION_FINGERPRINT_BINDING_MISMATCH'],
    ['asset inventory UUID altered', repack(valid.archive, (_entries, manifest) => { manifest.assets[0].uuid = '99999999-9999-4999-8999-999999999999'; }), 'PROMOTION_ASSET_FILE_BINDING_MISMATCH'],
  ];
  for (const [name, archive, expected] of semantic) {
    const report = preflightPromotionBundle(archive, { now: fixedNow });
    assert.equal(report.status, 'BLOCKED', name);
    assert.equal(report.reasons[0], expected, name);
    assert.equal(report.mutation_performed, false, name);
  }
  const stale = preflightPromotionBundle(valid.archive, { now: new Date('2026-08-16T08:30:00.000Z') });
  assert.equal(stale.status, 'BLOCKED');
  assert.equal(stale.reasons[0], 'SUPERSET_FINGERPRINT_STALE');
});

test('ZIP parser rejects entry-count and symlink metadata abuse', async () => {
  const valid = await build();
  const entryCount = Buffer.from(valid.archive);
  const eocd = entryCount.length - 22;
  entryCount.writeUInt16LE(ZIP_LIMITS.entryCount + 1, eocd + 8);
  entryCount.writeUInt16LE(ZIP_LIMITS.entryCount + 1, eocd + 10);
  assert.equal(preflightPromotionBundle(entryCount, { now: fixedNow }).reasons[0], 'PROMOTION_ZIP_ENTRY_COUNT_DENIED');

  const symlink = Buffer.from(valid.archive);
  const centralOffset = symlink.readUInt32LE(eocd + 16);
  symlink.writeUInt32LE((0o120777 << 16) >>> 0, centralOffset + 38);
  assert.equal(preflightPromotionBundle(symlink, { now: fixedNow }).reasons[0], 'PROMOTION_ZIP_SYMLINK_DENIED');
});
