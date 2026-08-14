import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson } from './canonical-json.js';
import { preflightPromotionBundle, readPromotionZip } from './promotion-bundle.mjs';

export const PROMOTION_EXECUTION_CONTRACT = 'chimpmaera.bi/synthetic-superset-promotion-execution/v1';
export const HUMAN_APPROVAL = 'APPROVE_SYNTHETIC_OWNED_PROMOTION';
const LOCAL_TARGETS = new Set(['superset', 'localhost', '127.0.0.1', '::1']);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fail = (code) => { const error = new Error(code); error.code = code; throw error; };

function parse(bytes, code) {
  try { return JSON.parse(bytes.toString('utf8')); } catch { fail(code); }
}

function assertSyntheticTarget(target, manifest) {
  if (!target || target.mode !== 'SYNTHETIC_OWNED_LOCAL' || target.owned !== true || target.sourceConnectivity !== 'NONE') fail('PROMOTION_TARGET_NOT_SYNTHETIC_OWNED');
  let url;
  try { url = new URL(target.baseUrl); } catch { fail('PROMOTION_TARGET_URL_DENIED'); }
  if (url.protocol !== 'http:' || !LOCAL_TARGETS.has(url.hostname) || url.username || url.password || url.search || url.hash) fail('PROMOTION_PRODUCTION_LIKE_TARGET_DENIED');
  if (target.baseUrl !== manifest.target.base_url) fail('PROMOTION_EXECUTION_TARGET_MISMATCH');
}

function graphOrder(assets) {
  const byId = new Map(assets.map((asset) => [asset.uuid, asset]));
  const ordered = [];
  const visited = new Set();
  const visit = (asset) => {
    if (visited.has(asset.uuid)) return;
    for (const uuid of asset.depends_on) {
      const dependency = byId.get(uuid);
      if (!dependency) fail('PROMOTION_ASSET_REFERENCE_DANGLING');
      visit(dependency);
    }
    visited.add(asset.uuid);
    ordered.push(asset);
  };
  assets.forEach(visit);
  return ordered;
}

export class SyntheticSupersetMetadata {
  constructor(file) { this.file = file; }
  async initialize(seed = []) {
    await mkdir(path.dirname(this.file), { recursive: true });
    try { await readFile(this.file); } catch { await this.#write({ contract: 'synthetic-superset-metadata/v1', assets: Object.fromEntries(seed.map((item) => [item.uuid, item])) }); }
  }
  async #read() { return parse(await readFile(this.file), 'PROMOTION_METADATA_INVALID'); }
  async #write(value) {
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${canonicalJson(value)}\n`, { mode: 0o600 });
    await rename(temporary, this.file);
  }
  async backup(destination) {
    const bytes = await readFile(this.file);
    await writeFile(destination, bytes, { mode: 0o600, flag: 'wx' });
    return { path: destination, sha256: sha256(bytes), bytes: bytes.length };
  }
  async restore(backup) {
    const bytes = await readFile(backup.path);
    if (sha256(bytes) !== backup.sha256) fail('PROMOTION_BACKUP_DIGEST_MISMATCH');
    const temporary = `${this.file}.${process.pid}.restore`;
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, this.file);
    return { restoredSha256: sha256(await readFile(this.file)) };
  }
  async upsert(asset, bundleId) {
    const state = await this.#read();
    const record = { kind: asset.kind, uuid: asset.uuid, title: asset.title, depends_on: asset.depends_on, review_spec: asset.review_spec, owned: true, synthetic: true, bundle_id: bundleId };
    const digest = sha256(canonicalJson(record));
    const previous = state.assets[asset.uuid];
    if (previous?.digest === digest) return 'UNCHANGED';
    state.assets[asset.uuid] = { ...record, digest };
    await this.#write(state);
    return previous ? 'UPDATED' : 'CREATED';
  }
  async readback(uuid) {
    const record = (await this.#read()).assets[uuid];
    if (!record) fail('PROMOTION_READBACK_UUID_NOT_FOUND');
    return record;
  }
  async digest() { return sha256(await readFile(this.file)); }
}

export async function executeSyntheticPromotion({ bundle, approval, fingerprint, target, metadata, backupPath, now = new Date() }) {
  if (approval !== HUMAN_APPROVAL) fail('PROMOTION_HUMAN_APPROVAL_REQUIRED');
  const preflight = preflightPromotionBundle(bundle, { now });
  if (preflight.status !== 'PASS_REVIEW_ONLY') fail(preflight.reasons[0] ?? 'PROMOTION_BUNDLE_PREFLIGHT_DENIED');
  const entries = readPromotionZip(bundle);
  const manifest = parse(entries.get('promotion-bundle.yaml'), 'PROMOTION_MANIFEST_INVALID');
  const bundledFingerprint = parse(entries.get('evidence/superset-fingerprint.json'), 'PROMOTION_FINGERPRINT_ARTIFACT_INVALID');
  if (!fingerprint || canonicalJson(fingerprint) !== canonicalJson(bundledFingerprint)) fail('PROMOTION_FRESH_FINGERPRINT_MISMATCH');
  assertSyntheticTarget(target, manifest);
  const assets = manifest.assets.map((item) => parse(entries.get(item.path), 'PROMOTION_ASSET_ARTIFACT_INVALID'));
  const ordered = graphOrder(assets);
  const backup = await metadata.backup(backupPath);
  const beforeSha256 = await metadata.digest();
  const outcomes = [];
  try {
    for (const asset of ordered) outcomes.push({ uuid: asset.uuid, outcome: await metadata.upsert(asset, manifest.bundle_id) });
    const readback = [];
    for (const asset of ordered) {
      const record = await metadata.readback(asset.uuid);
      if (record.bundle_id !== manifest.bundle_id || canonicalJson(record.depends_on) !== canonicalJson(asset.depends_on)) fail('PROMOTION_READBACK_BINDING_MISMATCH');
      readback.push({ uuid: record.uuid, kind: record.kind, digest: record.digest });
    }
    return { contract_version: PROMOTION_EXECUTION_CONTRACT, status: outcomes.every((x) => x.outcome === 'UNCHANGED') ? 'ALREADY_APPLIED' : 'APPLIED_AND_READ_BACK', mutation_performed: outcomes.some((x) => x.outcome !== 'UNCHANGED'), bundle_id: manifest.bundle_id, backup, before_sha256: beforeSha256, after_sha256: await metadata.digest(), dependency_order: ordered.map((x) => x.uuid), outcomes, readback, nonclaims: ['Synthetic owned local metadata only', 'No production/customer/source database or source-row access', 'No raw SQL or credentials'] };
  } catch (error) {
    await metadata.restore(backup);
    throw error;
  }
}
