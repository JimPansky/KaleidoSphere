import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson } from './canonical-json.js';
import { inspectPromotionBundle, preflightPromotionBundle, readPromotionZip } from './promotion-bundle.mjs';

export const SYNTHETIC_PROMOTION_CONTRACT = 'chimpmaera.bi/synthetic-superset-promotion/v1';
const APPROVAL = 'APPROVE_SYNTHETIC_PROMOTION';
const TARGET = 'chimpmaera-owned-disposable-superset';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fail = (code) => { const error = new Error(code); error.code = code; throw error; };
const json = (value) => Buffer.from(`${canonicalJson(value)}\n`);

async function atomicWrite(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
}
async function loadState(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') fail('SYNTHETIC_METADATA_INVALID');
    return { contract_version: SYNTHETIC_PROMOTION_CONTRACT, target: TARGET, assets: {} };
  }
}

function assertTarget(target) {
  if (!target || target.identity !== TARGET || target.local_only !== true || target.synthetic_owned !== true || target.production !== false || target.customer !== false || target.source_connectivity !== 'NONE') fail('PROMOTION_TARGET_NOT_SYNTHETIC');
}

export async function executeSyntheticPromotion({ bundle, metadataPath, backupPath, approval, target, expectedBundleSha256, expectedFingerprintSha256, now = new Date() }) {
  if (approval !== APPROVAL) fail('PROMOTION_HUMAN_APPROVAL_REQUIRED');
  assertTarget(target);
  const archive = Buffer.from(bundle);
  if (sha256(archive) !== expectedBundleSha256) fail('PROMOTION_BUNDLE_DIGEST_MISMATCH');
  const preflight = preflightPromotionBundle(archive, { now });
  if (preflight.status !== 'PASS_REVIEW_ONLY') fail(preflight.reasons[0] ?? 'PROMOTION_PREFLIGHT_BLOCKED');
  const inspection = inspectPromotionBundle(archive, { now });
  if (inspection.target.identity_sha256 !== expectedFingerprintSha256) fail('PROMOTION_FINGERPRINT_EXPECTATION_MISMATCH');

  const before = await loadState(metadataPath);
  assertTarget({ identity: before.target, local_only: true, synthetic_owned: true, production: false, customer: false, source_connectivity: 'NONE' });
  const beforeBytes = json(before);
  await atomicWrite(backupPath, beforeBytes);
  const entries = readPromotionZip(archive);
  const manifest = JSON.parse(entries.get('promotion-bundle.yaml'));
  const next = structuredClone(before);
  for (const item of manifest.assets) {
    const asset = JSON.parse(entries.get(item.path));
    next.assets[item.uuid] = { kind: item.kind, uuid: item.uuid, title: item.title, depends_on: [...item.depends_on], review_spec: asset.review_spec, bundle_id: manifest.bundle_id };
  }
  await atomicWrite(metadataPath, json(next));
  const readback = await loadState(metadataPath);
  for (const item of manifest.assets) {
    const actual = readback.assets[item.uuid];
    if (!actual || canonicalJson(actual.depends_on) !== canonicalJson(item.depends_on) || actual.bundle_id !== manifest.bundle_id) fail('PROMOTION_READBACK_MISMATCH');
  }
  return { contract_version: SYNTHETIC_PROMOTION_CONTRACT, status: canonicalJson(before) === canonicalJson(next) ? 'IDEMPOTENT_NO_CHANGE' : 'IMPORTED', bundle_id: manifest.bundle_id, bundle_sha256: expectedBundleSha256, backup_sha256: sha256(beforeBytes), asset_uuids: manifest.assets.map((item) => item.uuid), dependency_graph_sha256: sha256(canonicalJson(manifest.assets.map(({ uuid, depends_on }) => ({ uuid, depends_on })))), source_connectivity: 'NONE', mutation_scope: 'ISOLATED_SYNTHETIC_METADATA_ONLY' };
}

export async function readbackSyntheticPromotion({ metadataPath, uuid, target }) {
  assertTarget(target);
  const state = await loadState(metadataPath);
  if (!state.assets[uuid]) fail('PROMOTION_UUID_NOT_FOUND');
  return structuredClone(state.assets[uuid]);
}

export async function restoreSyntheticPromotion({ metadataPath, backupPath, target, expectedBackupSha256 }) {
  assertTarget(target);
  await stat(backupPath);
  const backup = await readFile(backupPath);
  if (sha256(backup) !== expectedBackupSha256) fail('PROMOTION_BACKUP_DIGEST_MISMATCH');
  JSON.parse(backup);
  const restoreCopy = `${metadataPath}.restore-${process.pid}`;
  await copyFile(backupPath, restoreCopy);
  await rename(restoreCopy, metadataPath);
  const restored = await readFile(metadataPath);
  if (sha256(restored) !== expectedBackupSha256) fail('PROMOTION_RESTORE_READBACK_MISMATCH');
  return { contract_version: SYNTHETIC_PROMOTION_CONTRACT, status: 'RESTORED_EXACT', restored_sha256: sha256(restored), source_connectivity: 'NONE' };
}
