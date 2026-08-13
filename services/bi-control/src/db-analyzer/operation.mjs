import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { identitySha256, normalizeJsonValue } from './core.mjs';

export const OPERATION_INVOCATION_SCHEMA = 'chimpmaera.db/operation-invocation/v1';
export const OPERATION_RUN_RECEIPT_SCHEMA = 'chimpmaera.db/operation-run-receipt/v1';
export const OPERATION_RESUME_CHECKPOINT_SCHEMA = 'chimpmaera.db/operation-resume-checkpoint/v1';
export const OPERATION_HISTORY_SCHEMA = 'chimpmaera.db/operation-history/v1';
export const OPERATION_MIGRATION_PLAN_SCHEMA = 'chimpmaera.db/operation-migration-plan/v1';
export const OPERATION_MIGRATION_RECEIPT_SCHEMA = 'chimpmaera.db/operation-migration-receipt/v1';
export const OPERATION_LIFECYCLE_STORE_SCHEMA = 'chimpmaera.db/operation-lifecycle-store/v1';
export const OPERATION_LIFECYCLE_BACKUP_SCHEMA = 'chimpmaera.db/operation-lifecycle-backup/v1';
export const OPERATION_LIFECYCLE_RECEIPT_SCHEMA = 'chimpmaera.db/operation-lifecycle-receipt/v1';

const WORKFLOW = 'cm db analyze <profile>';
const MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 5000;
const MIN_HISTORY_ENTRIES = 3;
const MAX_HISTORY_ENTRIES = 100;
const SHA256 = /^[a-f0-9]{64}$/;
const TOKEN = /^[a-z0-9][a-z0-9._:-]{2,127}$/;
const REASON = /^[A-Z][A-Z0-9_]{2,127}$/;
const LIFECYCLE_ARTIFACT_KINDS = [
  'CHECKPOINT', 'EVIDENCE', 'HISTORY', 'KNOWLEDGE', 'RESOLUTION', 'SUPERSET',
];
const LIFECYCLE_ACTIONS = ['REMOVE', 'RESET', 'RESTORE', 'ROLLBACK'];

const fail = (code) => {
  const error = new Error(code);
  error.code = code;
  throw error;
};

const exactKeys = (value, keys) => value
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));

const isTimestamp = (value) => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && !Number.isNaN(Date.parse(value));

const invocationSha256 = (invocation) => identitySha256(normalizeJsonValue(invocation));

const operationMarker = (resolution) => normalizeJsonValue({
  registryId: resolution.registry.registryId,
  sourceId: resolution.source.sourceId,
});

const lifecycleMarkerSha256 = (resolution) => identitySha256(operationMarker(resolution));

const containsSecretMaterial = (value) => {
  if (Array.isArray(value)) return value.some(containsSecretMaterial);
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, child]) => (
      /(?:password|secret|token|credentialValue|apiKey|privateKey)$/i.test(key) || containsSecretMaterial(child)
    ));
  }
  return typeof value === 'string'
    && /(?:password|secret|token|credentialValue)\s*[=:]\s*\S+/i.test(value);
};

const lifecycleRecordIdentity = (record) => `${record.markerSha256}:${record.artifactKind}:${record.artifactId}`;

function validateLifecycleRecord(record) {
  if (!exactKeys(record, [
    'markerSha256', 'artifactKind', 'artifactId', 'payload', 'payloadSha256',
  ]) || !SHA256.test(record.markerSha256 ?? '')
    || !LIFECYCLE_ARTIFACT_KINDS.includes(record.artifactKind)
    || !TOKEN.test(record.artifactId ?? '')
    || record.payload === undefined || containsSecretMaterial(record.payload)
    || !SHA256.test(record.payloadSha256 ?? '')
    || identitySha256(normalizeJsonValue(record.payload)) !== record.payloadSha256) {
    fail('DB_OPERATION_LIFECYCLE_RECORD_INVALID');
  }
  return record;
}

function lifecycleStoreBody(records, revision) {
  if (!Number.isInteger(revision) || revision < 0 || !Array.isArray(records)) {
    fail('DB_OPERATION_LIFECYCLE_STORE_INPUT_INVALID');
  }
  const normalizedRecords = records.map((record) => normalizeJsonValue(record))
    .sort((left, right) => lifecycleRecordIdentity(left).localeCompare(lifecycleRecordIdentity(right)));
  normalizedRecords.forEach(validateLifecycleRecord);
  if (new Set(normalizedRecords.map(lifecycleRecordIdentity)).size !== normalizedRecords.length) {
    fail('DB_OPERATION_LIFECYCLE_RECORD_DUPLICATE');
  }
  return normalizeJsonValue({
    schemaVersion: OPERATION_LIFECYCLE_STORE_SCHEMA,
    revision,
    records: normalizedRecords,
  });
}

function validateLifecycleStore(store) {
  if (!exactKeys(store, ['schemaVersion', 'revision', 'records', 'storeSha256'])
    || store.schemaVersion !== OPERATION_LIFECYCLE_STORE_SCHEMA
    || !SHA256.test(store.storeSha256 ?? '')) fail('DB_OPERATION_LIFECYCLE_STORE_INVALID');
  const expectedBody = lifecycleStoreBody(store.records, store.revision);
  if (identitySha256(expectedBody) !== store.storeSha256
    || identitySha256({ ...expectedBody, storeSha256: store.storeSha256 }) !== identitySha256(store)) {
    fail('DB_OPERATION_LIFECYCLE_STORE_TAMPERED');
  }
  return store;
}

const lifecycleStore = (records, revision) => {
  const body = lifecycleStoreBody(records, revision);
  return { ...body, storeSha256: identitySha256(body) };
};

const lifecyclePaths = (rootDir) => {
  if (typeof rootDir !== 'string' || rootDir.length < 1) fail('DB_OPERATION_LIFECYCLE_ROOT_INVALID');
  const root = path.resolve(rootDir);
  return {
    root,
    store: path.join(root, 'operation-lifecycle-store.json'),
    lock: path.join(root, '.operation-lifecycle-owner.json'),
    backups: path.join(root, 'backups'),
  };
};

async function atomicWriteJson(file, value) {
  const temporary = `${file}.pending`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  try {
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function readLifecycleStoreFile(paths) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(paths.store, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') fail('DB_OPERATION_LIFECYCLE_STORE_MISSING');
    if (error instanceof SyntaxError) fail('DB_OPERATION_LIFECYCLE_STORE_MALFORMED');
    throw error;
  }
  return validateLifecycleStore(parsed);
}

async function withLifecycleOwnership({ paths, markerSha256, ownerId, acquiredAt }, action) {
  if (!SHA256.test(markerSha256 ?? '') || !TOKEN.test(ownerId ?? '') || !isTimestamp(acquiredAt)) {
    fail('DB_OPERATION_LIFECYCLE_OWNER_INVALID');
  }
  await mkdir(paths.root, { recursive: true });
  let handle;
  try {
    handle = await open(paths.lock, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') fail('DB_OPERATION_LIFECYCLE_CONCURRENCY_DENIED');
    throw error;
  }
  const ownership = normalizeJsonValue({ markerSha256, ownerId, acquiredAt });
  try {
    await handle.writeFile(`${JSON.stringify(ownership)}\n`, 'utf8');
    await handle.close();
    handle = null;
    const persisted = JSON.parse(await readFile(paths.lock, 'utf8'));
    if (identitySha256(persisted) !== identitySha256(ownership)) {
      fail('DB_OPERATION_LIFECYCLE_OWNERSHIP_INVALID');
    }
    return await action(ownership);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(paths.lock).catch(() => {});
  }
}

function validateLifecycleResolutionRecord(store, resolution) {
  validateResolution(resolution);
  const markerSha256 = lifecycleMarkerSha256(resolution);
  const matching = store.records.filter((record) => record.markerSha256 === markerSha256
    && record.artifactKind === 'RESOLUTION');
  if (matching.length !== 1
    || matching[0].artifactId !== resolution.resolutionSha256
    || matching[0].payloadSha256 !== identitySha256(normalizeJsonValue(resolution))) {
    fail('DB_OPERATION_LIFECYCLE_RESOLUTION_UNBOUND');
  }
  return markerSha256;
}

function validateLifecycleBackup({ backup, resolution }) {
  validateResolution(resolution);
  if (!exactKeys(backup, [
    'schemaVersion', 'createdAt', 'source', 'storeRevision', 'records', 'recordsSha256',
    'evidenceBoundary', 'backupSha256',
  ]) || backup.schemaVersion !== OPERATION_LIFECYCLE_BACKUP_SCHEMA
    || !isTimestamp(backup.createdAt) || !Number.isInteger(backup.storeRevision) || backup.storeRevision < 0
    || !Array.isArray(backup.records) || backup.records.length < 1
    || !SHA256.test(backup.recordsSha256 ?? '') || !SHA256.test(backup.backupSha256 ?? '')) {
    fail('DB_OPERATION_LIFECYCLE_BACKUP_INVALID');
  }
  const { backupSha256, ...body } = backup;
  if (identitySha256(body) !== backupSha256) fail('DB_OPERATION_LIFECYCLE_BACKUP_TAMPERED');
  const markerSha256 = lifecycleMarkerSha256(resolution);
  backup.records.forEach(validateLifecycleRecord);
  if (backup.records.some((record) => record.markerSha256 !== markerSha256)
    || identitySha256(backup.records) !== backup.recordsSha256
    || !exactKeys(backup.source, [
      'registryId', 'sourceId', 'engine', 'resolutionSha256', 'markerSha256',
    ]) || backup.source.registryId !== resolution.registry.registryId
    || backup.source.sourceId !== resolution.source.sourceId
    || backup.source.engine !== resolution.source.engine
    || backup.source.resolutionSha256 !== resolution.resolutionSha256
    || backup.source.markerSha256 !== markerSha256
    || !exactKeys(backup.evidenceBoundary, [
      'credentialsIncluded', 'sourceDatabaseIncluded', 'unrelatedRecordsIncluded',
    ]) || backup.evidenceBoundary.credentialsIncluded !== false
    || backup.evidenceBoundary.sourceDatabaseIncluded !== false
    || backup.evidenceBoundary.unrelatedRecordsIncluded !== false) {
    fail('DB_OPERATION_LIFECYCLE_BACKUP_BINDING_INVALID');
  }
  const resolutionRecords = backup.records.filter((record) => record.artifactKind === 'RESOLUTION');
  if (resolutionRecords.length !== 1
    || resolutionRecords[0].artifactId !== resolution.resolutionSha256
    || resolutionRecords[0].payloadSha256 !== identitySha256(normalizeJsonValue(resolution))) {
    fail('DB_OPERATION_LIFECYCLE_BACKUP_RESOLUTION_UNBOUND');
  }
  return backup;
}

export function validateOperationLifecycleReceipt({ receipt, resolution, backup }) {
  validateLifecycleBackup({ backup, resolution });
  if (!exactKeys(receipt, [
    'schemaVersion', 'action', 'performedAt', 'source', 'ownership', 'backupSha256',
    'transition', 'outcome', 'evidenceBoundary', 'receiptSha256',
  ]) || receipt.schemaVersion !== OPERATION_LIFECYCLE_RECEIPT_SCHEMA
    || !LIFECYCLE_ACTIONS.includes(receipt.action) || !isTimestamp(receipt.performedAt)
    || Date.parse(receipt.performedAt) < Date.parse(backup.createdAt)
    || receipt.backupSha256 !== backup.backupSha256
    || identitySha256(receipt.source) !== identitySha256(backup.source)
    || !SHA256.test(receipt.receiptSha256 ?? '')) fail('DB_OPERATION_LIFECYCLE_RECEIPT_INVALID');
  const { receiptSha256, ...body } = receipt;
  if (identitySha256(body) !== receiptSha256) fail('DB_OPERATION_LIFECYCLE_RECEIPT_TAMPERED');
  const markerSha256 = lifecycleMarkerSha256(resolution);
  if (!exactKeys(receipt.ownership, [
    'markerSha256', 'ownerId', 'acquisitionState', 'releaseState',
  ]) || receipt.ownership.markerSha256 !== markerSha256
    || !TOKEN.test(receipt.ownership.ownerId ?? '')
    || receipt.ownership.acquisitionState !== 'ACQUIRED'
    || receipt.ownership.releaseState !== 'RELEASED') {
    fail('DB_OPERATION_LIFECYCLE_RECEIPT_OWNERSHIP_INVALID');
  }
  if (!exactKeys(receipt.transition, [
    'beforeStoreSha256', 'afterStoreSha256', 'revisionBefore', 'revisionAfter',
    'targetRecordsBefore', 'targetRecordsAfter', 'affectedArtifactKinds',
  ]) || !SHA256.test(receipt.transition.beforeStoreSha256 ?? '')
    || !SHA256.test(receipt.transition.afterStoreSha256 ?? '')
    || !Number.isInteger(receipt.transition.revisionBefore) || receipt.transition.revisionBefore < 0
    || !Number.isInteger(receipt.transition.revisionAfter)
    || !Number.isInteger(receipt.transition.targetRecordsBefore)
    || receipt.transition.targetRecordsBefore < 0
    || !Number.isInteger(receipt.transition.targetRecordsAfter)
    || receipt.transition.targetRecordsAfter < 0
    || !Array.isArray(receipt.transition.affectedArtifactKinds)
    || receipt.transition.affectedArtifactKinds.some((kind) => !LIFECYCLE_ARTIFACT_KINDS.includes(kind))
    || identitySha256(receipt.transition.affectedArtifactKinds)
      !== identitySha256([...new Set(receipt.transition.affectedArtifactKinds)].sort())) {
    fail('DB_OPERATION_LIFECYCLE_RECEIPT_TRANSITION_INVALID');
  }
  if (!exactKeys(receipt.outcome, ['state', 'recoverableFromBackup'])
    || !['ALREADY_SATISFIED', 'APPLIED'].includes(receipt.outcome.state)
    || receipt.outcome.recoverableFromBackup !== true
    || (receipt.outcome.state === 'APPLIED'
      && receipt.transition.revisionAfter !== receipt.transition.revisionBefore + 1)
    || (receipt.outcome.state === 'ALREADY_SATISFIED'
      && (receipt.transition.revisionAfter !== receipt.transition.revisionBefore
        || receipt.transition.afterStoreSha256 !== receipt.transition.beforeStoreSha256))
    || !exactKeys(receipt.evidenceBoundary, [
      'persistenceValidation', 'sourceDatabaseWritten', 'credentialsResolved', 'unrelatedRecordsChanged',
    ]) || receipt.evidenceBoundary.persistenceValidation !== 'LOCAL_FILESYSTEM_SYNTHETIC'
    || receipt.evidenceBoundary.sourceDatabaseWritten !== false
    || receipt.evidenceBoundary.credentialsResolved !== false
    || receipt.evidenceBoundary.unrelatedRecordsChanged !== false) {
    fail('DB_OPERATION_LIFECYCLE_RECEIPT_CLAIM_INVALID');
  }
  return receipt;
}

export function createOperationLifecycleRecord({ resolution, artifactKind, artifactId, payload }) {
  validateResolution(resolution);
  const record = normalizeJsonValue({
    markerSha256: lifecycleMarkerSha256(resolution),
    artifactKind,
    artifactId,
    payload: normalizeJsonValue(payload),
    payloadSha256: identitySha256(normalizeJsonValue(payload)),
  });
  return validateLifecycleRecord(record);
}

export async function initializeOperationLifecycleStore({ rootDir, records }) {
  const paths = lifecyclePaths(rootDir);
  await mkdir(paths.root, { recursive: true });
  const expected = lifecycleStore(records, 0);
  try {
    await writeFile(paths.store, `${JSON.stringify(expected, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = await readLifecycleStoreFile(paths);
    if (existing.storeSha256 !== expected.storeSha256) fail('DB_OPERATION_LIFECYCLE_INIT_DRIFT');
    return existing;
  }
  return expected;
}

export async function readOperationLifecycleStore({ rootDir }) {
  return readLifecycleStoreFile(lifecyclePaths(rootDir));
}

export function validateOperationLifecycleStore(store) {
  return validateLifecycleStore(store);
}

export async function recoverStaleOperationLifecycleOwnership({
  rootDir, resolution, expectedOwnerId, observedAt, staleAfterMs,
}) {
  validateResolution(resolution);
  if (!TOKEN.test(expectedOwnerId ?? '') || !isTimestamp(observedAt)
    || !Number.isInteger(staleAfterMs) || staleAfterMs < 1000 || staleAfterMs > 86_400_000) {
    fail('DB_OPERATION_LIFECYCLE_RECOVERY_INPUT_INVALID');
  }
  const paths = lifecyclePaths(rootDir);
  let ownership;
  try {
    ownership = JSON.parse(await readFile(paths.lock, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') fail('DB_OPERATION_LIFECYCLE_RECOVERY_MARKER_MISSING');
    if (error instanceof SyntaxError) fail('DB_OPERATION_LIFECYCLE_RECOVERY_MARKER_INVALID');
    throw error;
  }
  const markerSha256 = lifecycleMarkerSha256(resolution);
  if (!exactKeys(ownership, ['markerSha256', 'ownerId', 'acquiredAt'])
    || !SHA256.test(ownership.markerSha256 ?? '') || !TOKEN.test(ownership.ownerId ?? '')
    || !isTimestamp(ownership.acquiredAt)) fail('DB_OPERATION_LIFECYCLE_RECOVERY_MARKER_INVALID');
  if (ownership.markerSha256 !== markerSha256 || ownership.ownerId !== expectedOwnerId) {
    fail('DB_OPERATION_LIFECYCLE_RECOVERY_FOREIGN_MARKER');
  }
  const ageMs = Date.parse(observedAt) - Date.parse(ownership.acquiredAt);
  if (ageMs < staleAfterMs) fail('DB_OPERATION_LIFECYCLE_RECOVERY_MARKER_NOT_STALE');
  const ownershipSha256 = identitySha256(ownership);
  const quarantine = `${paths.lock}.recover-${ownershipSha256}`;
  try {
    await rename(paths.lock, quarantine);
  } catch (error) {
    if (error?.code === 'ENOENT') fail('DB_OPERATION_LIFECYCLE_RECOVERY_MARKER_CHANGED');
    throw error;
  }
  try {
    const quarantined = JSON.parse(await readFile(quarantine, 'utf8'));
    if (identitySha256(quarantined) !== ownershipSha256) {
      await rename(quarantine, paths.lock).catch(() => {});
      fail('DB_OPERATION_LIFECYCLE_RECOVERY_MARKER_CHANGED');
    }
    await unlink(quarantine);
  } catch (error) {
    await rename(quarantine, paths.lock).catch(() => {});
    throw error;
  }
  const body = normalizeJsonValue({
    schemaVersion: 'chimpmaera.db/operation-lifecycle-recovery-receipt/v1',
    observedAt,
    source: {
      registryId: resolution.registry.registryId,
      sourceId: resolution.source.sourceId,
      engine: resolution.source.engine,
      markerSha256,
      resolutionSha256: resolution.resolutionSha256,
    },
    recoveredOwnership: { ownerId: expectedOwnerId, acquiredAt: ownership.acquiredAt, ownershipSha256 },
    policy: { staleAfterMs },
    outcome: { state: 'STALE_MARKER_REMOVED', retryRequired: true },
    evidenceBoundary: {
      sourceDatabaseWritten: false,
      credentialsResolved: false,
      unrelatedMarkersRemoved: false,
    },
  });
  return { ...body, receiptSha256: identitySha256(body) };
}

export async function createOperationLifecycleBackup({
  rootDir, resolution, ownerId, createdAt,
}) {
  validateResolution(resolution);
  if (!isTimestamp(createdAt)) fail('DB_OPERATION_LIFECYCLE_BACKUP_INPUT_INVALID');
  const paths = lifecyclePaths(rootDir);
  const markerSha256 = lifecycleMarkerSha256(resolution);
  return withLifecycleOwnership({ paths, markerSha256, ownerId, acquiredAt: createdAt }, async () => {
    const store = await readLifecycleStoreFile(paths);
    validateLifecycleResolutionRecord(store, resolution);
    const records = store.records.filter((record) => record.markerSha256 === markerSha256);
    const body = normalizeJsonValue({
      schemaVersion: OPERATION_LIFECYCLE_BACKUP_SCHEMA,
      createdAt,
      source: {
        registryId: resolution.registry.registryId,
        sourceId: resolution.source.sourceId,
        engine: resolution.source.engine,
        resolutionSha256: resolution.resolutionSha256,
        markerSha256,
      },
      storeRevision: store.revision,
      records,
      recordsSha256: identitySha256(records),
      evidenceBoundary: {
        credentialsIncluded: false,
        sourceDatabaseIncluded: false,
        unrelatedRecordsIncluded: false,
      },
    });
    const backup = { ...body, backupSha256: identitySha256(body) };
    validateLifecycleBackup({ backup, resolution });
    await mkdir(paths.backups, { recursive: true });
    const backupFile = path.join(paths.backups, `${backup.backupSha256}.json`);
    try {
      await atomicWriteJson(backupFile, backup);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = JSON.parse(await readFile(backupFile, 'utf8'));
      validateLifecycleBackup({ backup: existing, resolution });
      if (existing.backupSha256 !== backup.backupSha256) fail('DB_OPERATION_LIFECYCLE_BACKUP_COLLISION');
    }
    return backup;
  });
}

export async function applyOperationLifecycleAction({
  rootDir, resolution, ownerId, action, backup, performedAt,
}) {
  validateResolution(resolution);
  validateLifecycleBackup({ backup, resolution });
  if (!LIFECYCLE_ACTIONS.includes(action) || !isTimestamp(performedAt)
    || Date.parse(performedAt) < Date.parse(backup.createdAt)) {
    fail('DB_OPERATION_LIFECYCLE_ACTION_INVALID');
  }
  const paths = lifecyclePaths(rootDir);
  const markerSha256 = lifecycleMarkerSha256(resolution);
  return withLifecycleOwnership({ paths, markerSha256, ownerId, acquiredAt: performedAt }, async (ownership) => {
    const before = await readLifecycleStoreFile(paths);
    const targetBefore = before.records.filter((record) => record.markerSha256 === markerSha256);
    const unrelatedBefore = before.records.filter((record) => record.markerSha256 !== markerSha256);
    let targetAfter;
    if (action === 'RESET') {
      targetAfter = backup.records.filter((record) => !['CHECKPOINT', 'HISTORY'].includes(record.artifactKind));
    } else if (action === 'REMOVE') {
      targetAfter = [];
    } else {
      targetAfter = backup.records;
    }
    const beforeTargetSha256 = identitySha256(targetBefore);
    const desiredTargetSha256 = identitySha256(targetAfter);
    if (['RESET', 'REMOVE'].includes(action)
      && beforeTargetSha256 !== backup.recordsSha256
      && beforeTargetSha256 !== desiredTargetSha256) fail('DB_OPERATION_LIFECYCLE_BACKUP_STALE');
    const alreadySatisfied = beforeTargetSha256 === desiredTargetSha256;
    let after = before;
    if (!alreadySatisfied) {
      const afterCandidate = lifecycleStore([...unrelatedBefore, ...targetAfter], before.revision + 1);
      await atomicWriteJson(paths.store, afterCandidate);
      after = await readLifecycleStoreFile(paths);
    }
    const unrelatedAfter = after.records.filter((record) => record.markerSha256 !== markerSha256);
    if (identitySha256(unrelatedAfter) !== identitySha256(unrelatedBefore)) {
      fail('DB_OPERATION_LIFECYCLE_UNRELATED_STATE_CHANGED');
    }
    const affectedArtifactKinds = [...new Set([
      ...targetBefore.map((record) => record.artifactKind),
      ...targetAfter.map((record) => record.artifactKind),
    ])].sort();
    const body = normalizeJsonValue({
      schemaVersion: OPERATION_LIFECYCLE_RECEIPT_SCHEMA,
      action,
      performedAt,
      source: backup.source,
      ownership: {
        markerSha256: ownership.markerSha256,
        ownerId: ownership.ownerId,
        acquisitionState: 'ACQUIRED',
        releaseState: 'RELEASED',
      },
      backupSha256: backup.backupSha256,
      transition: {
        beforeStoreSha256: before.storeSha256,
        afterStoreSha256: after.storeSha256,
        revisionBefore: before.revision,
        revisionAfter: after.revision,
        targetRecordsBefore: targetBefore.length,
        targetRecordsAfter: targetAfter.length,
        affectedArtifactKinds,
      },
      outcome: {
        state: alreadySatisfied ? 'ALREADY_SATISFIED' : 'APPLIED',
        recoverableFromBackup: true,
      },
      evidenceBoundary: {
        persistenceValidation: 'LOCAL_FILESYSTEM_SYNTHETIC',
        sourceDatabaseWritten: false,
        credentialsResolved: false,
        unrelatedRecordsChanged: false,
      },
    });
    const receipt = { ...body, receiptSha256: identitySha256(body) };
    return {
      store: after,
      receipt: validateOperationLifecycleReceipt({ receipt, resolution, backup }),
    };
  });
}

function validateResolution(resolution) {
  if (!exactKeys(resolution, [
    'schemaVersion', 'profileId', 'registry', 'source', 'capabilityPack', 'runtimeValidation', 'claims', 'resolutionSha256',
  ]) || resolution.schemaVersion !== 'chimpmaera.db/operation-resolution/v1'
    || !TOKEN.test(resolution.profileId ?? '')
    || !exactKeys(resolution.registry, ['registryId', 'registryVersion'])
    || !TOKEN.test(resolution.registry.registryId ?? '')
    || !exactKeys(resolution.source, ['sourceId', 'engine', 'scope', 'policy', 'adapter', 'credentialProvider'])
    || !TOKEN.test(resolution.source.sourceId ?? '')
    || !['mssql', 'oracle'].includes(resolution.source.engine)
    || resolution.source.policy?.access !== 'READ_ONLY'
    || resolution.source.policy?.allowRowSamples !== false
    || !Number.isInteger(resolution.source.policy?.maxQueryTimeoutMs)
    || resolution.source.policy.maxQueryTimeoutMs < 1
    || !exactKeys(resolution.source.credentialProvider, ['kind', 'reference'])
    || resolution.source.credentialProvider.kind !== 'ENV'
    || typeof resolution.source.credentialProvider.reference !== 'string'
    || !/^[A-Z][A-Z0-9_]{2,127}$/.test(resolution.source.credentialProvider.reference)
    || resolution.runtimeValidation !== 'NOT_EXECUTED'
    || !SHA256.test(resolution.resolutionSha256 ?? '')) fail('DB_OPERATION_RESOLUTION_INVALID');
  const { resolutionSha256, ...body } = resolution;
  if (identitySha256(body) !== resolutionSha256) fail('DB_OPERATION_RESOLUTION_TAMPERED');
  return resolution;
}

function validateInvocation(invocation, resolution) {
  if (!exactKeys(invocation, [
    'schemaVersion', 'invocationId', 'requestedAt', 'trigger', 'expectedResolutionSha256', 'controls',
  ]) || invocation.schemaVersion !== OPERATION_INVOCATION_SCHEMA
    || !TOKEN.test(invocation.invocationId ?? '')
    || !isTimestamp(invocation.requestedAt)
    || !exactKeys(invocation.trigger, ['kind', 'reference'])
    || !['MANUAL', 'SCHEDULED'].includes(invocation.trigger.kind)
    || !TOKEN.test(invocation.trigger.reference ?? '')
    || invocation.expectedResolutionSha256 !== resolution.resolutionSha256
    || !exactKeys(invocation.controls, ['timeoutMs', 'maxAttempts', 'retryDelayMs', 'retryStates'])
    || !Number.isInteger(invocation.controls.timeoutMs) || invocation.controls.timeoutMs < 1
    || invocation.controls.timeoutMs > resolution.source.policy.maxQueryTimeoutMs
    || !Number.isInteger(invocation.controls.maxAttempts) || invocation.controls.maxAttempts < 1
    || invocation.controls.maxAttempts > MAX_ATTEMPTS
    || !Number.isInteger(invocation.controls.retryDelayMs) || invocation.controls.retryDelayMs < 0
    || invocation.controls.retryDelayMs > MAX_RETRY_DELAY_MS
    || !Array.isArray(invocation.controls.retryStates)
    || invocation.controls.retryStates.some((state) => !['TIMEOUT', 'ERROR'].includes(state))
    || new Set(invocation.controls.retryStates).size !== invocation.controls.retryStates.length) {
    fail('DB_OPERATION_INVOCATION_INVALID');
  }
  return invocation;
}

function validateAttemptResult(result) {
  if (!exactKeys(result, ['state', 'reasonCode', 'resultSha256'])
    || !['SUCCEEDED', 'PARTIAL', 'DENIED', 'UNSUPPORTED', 'ERROR', 'CANCELLED'].includes(result.state)
    || !(result.reasonCode === null || REASON.test(result.reasonCode ?? ''))
    || !(result.resultSha256 === null || SHA256.test(result.resultSha256 ?? ''))
    || (result.state === 'SUCCEEDED' && (result.reasonCode !== null || result.resultSha256 === null))
    || (result.state !== 'SUCCEEDED' && result.reasonCode === null)
    || (!['SUCCEEDED', 'PARTIAL'].includes(result.state) && result.resultSha256 !== null)) {
    fail('DB_OPERATION_RESULT_INVALID');
  }
  return result;
}

function validateRecordedAttempt(attempt) {
  if (!exactKeys(attempt, ['attempt', 'state', 'reasonCode', 'resultSha256'])
    || !Number.isInteger(attempt.attempt) || attempt.attempt < 1
    || !['SUCCEEDED', 'PARTIAL', 'DENIED', 'UNSUPPORTED', 'TIMEOUT', 'ERROR', 'CANCELLED'].includes(attempt.state)
    || !(attempt.reasonCode === null || REASON.test(attempt.reasonCode ?? ''))
    || !(attempt.resultSha256 === null || SHA256.test(attempt.resultSha256 ?? ''))
    || (attempt.state === 'SUCCEEDED' && (attempt.reasonCode !== null || attempt.resultSha256 === null))
    || (attempt.state !== 'SUCCEEDED' && attempt.reasonCode === null)
    || (!['SUCCEEDED', 'PARTIAL'].includes(attempt.state) && attempt.resultSha256 !== null)) {
    fail('DB_OPERATION_CHECKPOINT_ATTEMPT_INVALID');
  }
  return attempt;
}

function checkpointAttempt(attempt) {
  validateRecordedAttempt(attempt);
  return { ...attempt, attemptIdentitySha256: identitySha256(attempt) };
}

function createResumeCheckpoint({ resolution, invocation, markerSha256, attempts, checkpointedAt, validUntil }) {
  if (!isTimestamp(checkpointedAt) || !isTimestamp(validUntil)
    || Date.parse(validUntil) <= Date.parse(checkpointedAt)
    || !Array.isArray(attempts) || attempts.length === 0
    || attempts.length >= invocation.controls.maxAttempts
    || attempts.some((attempt, index) => attempt.attempt !== index + 1)) {
    fail('DB_OPERATION_CHECKPOINT_INPUT_INVALID');
  }
  const last = attempts.at(-1);
  if (!invocation.controls.retryStates.includes(last.state)) fail('DB_OPERATION_CHECKPOINT_NOT_RESUMABLE');
  const body = normalizeJsonValue({
    schemaVersion: OPERATION_RESUME_CHECKPOINT_SCHEMA,
    workflow: WORKFLOW,
    checkpointedAt,
    validUntil,
    binding: {
      resolutionSha256: resolution.resolutionSha256,
      registryId: resolution.registry.registryId,
      sourceId: resolution.source.sourceId,
      engine: resolution.source.engine,
      scopeSha256: identitySha256(resolution.source.scope),
      markerSha256,
      capabilityPackVersion: resolution.capabilityPack.capabilityPackVersion,
      queryPackVersion: resolution.capabilityPack.queryPackVersion,
      normalizerVersion: resolution.capabilityPack.normalizerVersion,
      enabledCapabilities: [...resolution.capabilityPack.enabledCapabilities].sort(),
    },
    invocation: {
      invocationId: invocation.invocationId,
      invocationSha256: invocationSha256(invocation),
    },
    progress: {
      completedAttempts: attempts.map(checkpointAttempt),
      nextAttempt: attempts.length + 1,
    },
    evidenceBoundary: {
      runtimeValidation: 'SYNTHETIC_UNVALIDATED',
      credentialsResolved: false,
      sourceConnected: false,
      schedulerStarted: false,
    },
  });
  return { ...body, checkpointSha256: identitySha256(body) };
}

export function validateOperationResumeCheckpoint({ checkpoint, resolution, invocation, resumedAt }) {
  validateResolution(resolution);
  validateInvocation(invocation, resolution);
  if (!isTimestamp(resumedAt)
    || !exactKeys(checkpoint, [
      'schemaVersion', 'workflow', 'checkpointedAt', 'validUntil', 'binding', 'invocation', 'progress',
      'evidenceBoundary', 'checkpointSha256',
    ])
    || checkpoint.schemaVersion !== OPERATION_RESUME_CHECKPOINT_SCHEMA
    || checkpoint.workflow !== WORKFLOW || !isTimestamp(checkpoint.checkpointedAt)
    || !isTimestamp(checkpoint.validUntil) || !SHA256.test(checkpoint.checkpointSha256 ?? '')) {
    fail('DB_OPERATION_CHECKPOINT_INVALID');
  }
  const { checkpointSha256, ...body } = checkpoint;
  if (identitySha256(body) !== checkpointSha256) fail('DB_OPERATION_CHECKPOINT_TAMPERED');
  if (Date.parse(checkpoint.validUntil) <= Date.parse(checkpoint.checkpointedAt)
    || Date.parse(resumedAt) < Date.parse(checkpoint.checkpointedAt)) {
    fail('DB_OPERATION_CHECKPOINT_TIME_INVALID');
  }
  if (Date.parse(resumedAt) > Date.parse(checkpoint.validUntil)) fail('DB_OPERATION_CHECKPOINT_STALE');
  if (!exactKeys(checkpoint.evidenceBoundary, [
    'runtimeValidation', 'credentialsResolved', 'sourceConnected', 'schedulerStarted',
  ]) || checkpoint.evidenceBoundary.runtimeValidation !== 'SYNTHETIC_UNVALIDATED'
    || checkpoint.evidenceBoundary.credentialsResolved !== false
    || checkpoint.evidenceBoundary.sourceConnected !== false
    || checkpoint.evidenceBoundary.schedulerStarted !== false) {
    fail('DB_OPERATION_CHECKPOINT_CLAIM_INVALID');
  }
  const markerSha256 = identitySha256(operationMarker(resolution));
  if (!exactKeys(checkpoint.binding, [
    'resolutionSha256', 'registryId', 'sourceId', 'engine', 'scopeSha256', 'markerSha256',
    'capabilityPackVersion', 'queryPackVersion', 'normalizerVersion', 'enabledCapabilities',
  ])) fail('DB_OPERATION_CHECKPOINT_BINDING_INVALID');
  const expectedCapabilities = [...resolution.capabilityPack.enabledCapabilities].sort();
  if (!Array.isArray(checkpoint.binding.enabledCapabilities)
    || checkpoint.binding.enabledCapabilities.some((capability) => !expectedCapabilities.includes(capability))) {
    fail('DB_OPERATION_CHECKPOINT_CAPABILITY_WIDENING_DENIED');
  }
  if (identitySha256(checkpoint.binding.enabledCapabilities) !== identitySha256(expectedCapabilities)
    || checkpoint.binding.capabilityPackVersion !== resolution.capabilityPack.capabilityPackVersion
    || checkpoint.binding.queryPackVersion !== resolution.capabilityPack.queryPackVersion
    || checkpoint.binding.normalizerVersion !== resolution.capabilityPack.normalizerVersion) {
    fail('DB_OPERATION_CHECKPOINT_CAPABILITY_DRIFT');
  }
  if (checkpoint.binding.resolutionSha256 !== resolution.resolutionSha256
    || checkpoint.binding.registryId !== resolution.registry.registryId
    || checkpoint.binding.sourceId !== resolution.source.sourceId
    || checkpoint.binding.engine !== resolution.source.engine
    || checkpoint.binding.scopeSha256 !== identitySha256(resolution.source.scope)
    || checkpoint.binding.markerSha256 !== markerSha256) fail('DB_OPERATION_CHECKPOINT_FOREIGN');
  if (!exactKeys(checkpoint.invocation, ['invocationId', 'invocationSha256'])
    || checkpoint.invocation.invocationId !== invocation.invocationId
    || checkpoint.invocation.invocationSha256 !== invocationSha256(invocation)) {
    fail('DB_OPERATION_CHECKPOINT_INVOCATION_DRIFT');
  }
  if (!exactKeys(checkpoint.progress, ['completedAttempts', 'nextAttempt'])
    || !Array.isArray(checkpoint.progress.completedAttempts)
    || checkpoint.progress.completedAttempts.length === 0
    || checkpoint.progress.completedAttempts.length >= invocation.controls.maxAttempts
    || checkpoint.progress.nextAttempt !== checkpoint.progress.completedAttempts.length + 1) {
    fail('DB_OPERATION_CHECKPOINT_PROGRESS_INVALID');
  }
  const attempts = checkpoint.progress.completedAttempts.map((recorded, index) => {
    if (!exactKeys(recorded, ['attempt', 'state', 'reasonCode', 'resultSha256', 'attemptIdentitySha256'])) {
      fail('DB_OPERATION_CHECKPOINT_ATTEMPT_INVALID');
    }
    const { attemptIdentitySha256, ...attempt } = recorded;
    validateRecordedAttempt(attempt);
    if (attempt.attempt !== index + 1 || identitySha256(attempt) !== attemptIdentitySha256) {
      fail('DB_OPERATION_CHECKPOINT_ATTEMPT_TAMPERED');
    }
    return attempt;
  });
  if (!invocation.controls.retryStates.includes(attempts.at(-1).state)) {
    fail('DB_OPERATION_CHECKPOINT_NOT_RESUMABLE');
  }
  return { attempts, markerSha256, checkpointSha256: checkpoint.checkpointSha256, resumedAt };
}

export function validateOperationRunReceipt({ receipt, resolution, resumeCheckpoint = null }) {
  validateResolution(resolution);
  if (!exactKeys(receipt, [
    'schemaVersion', 'workflow', 'invocation', 'ownership', 'binding', 'controls', 'attempts', 'outcome',
    'resume', 'evidenceBoundary', 'receiptSha256',
  ]) || receipt.schemaVersion !== OPERATION_RUN_RECEIPT_SCHEMA || receipt.workflow !== WORKFLOW
    || !SHA256.test(receipt.receiptSha256 ?? '')) fail('DB_OPERATION_RECEIPT_INVALID');
  const { receiptSha256, ...body } = receipt;
  if (identitySha256(body) !== receiptSha256) fail('DB_OPERATION_RECEIPT_TAMPERED');
  if (!exactKeys(receipt.invocation, ['invocationId', 'requestedAt', 'trigger'])
    || !exactKeys(receipt.binding, [
      'resolutionSha256', 'invocationSha256', 'engine', 'scopeSha256', 'capabilityPackVersion',
      'queryPackVersion', 'normalizerVersion',
    ])) fail('DB_OPERATION_RECEIPT_BINDING_INVALID');
  const invocation = {
    schemaVersion: OPERATION_INVOCATION_SCHEMA,
    invocationId: receipt.invocation.invocationId,
    requestedAt: receipt.invocation.requestedAt,
    trigger: receipt.invocation.trigger,
    expectedResolutionSha256: resolution.resolutionSha256,
    controls: receipt.controls,
  };
  validateInvocation(invocation, resolution);
  if (receipt.binding.resolutionSha256 !== resolution.resolutionSha256
    || receipt.binding.invocationSha256 !== invocationSha256(invocation)
    || receipt.binding.engine !== resolution.source.engine
    || receipt.binding.scopeSha256 !== identitySha256(resolution.source.scope)
    || receipt.binding.capabilityPackVersion !== resolution.capabilityPack.capabilityPackVersion
    || receipt.binding.queryPackVersion !== resolution.capabilityPack.queryPackVersion
    || receipt.binding.normalizerVersion !== resolution.capabilityPack.normalizerVersion) {
    fail('DB_OPERATION_RECEIPT_BINDING_DRIFT');
  }
  const marker = operationMarker(resolution);
  const markerSha256 = identitySha256(marker);
  if (!exactKeys(receipt.ownership, [
    'marker', 'markerSha256', 'ownerInvocationId', 'acquisitionState', 'releaseState',
  ]) || identitySha256(receipt.ownership.marker) !== markerSha256
    || receipt.ownership.markerSha256 !== markerSha256
    || receipt.ownership.ownerInvocationId !== invocation.invocationId
    || receipt.ownership.acquisitionState !== 'ACQUIRED' || receipt.ownership.releaseState !== 'RELEASED') {
    fail('DB_OPERATION_RECEIPT_OWNERSHIP_INVALID');
  }
  if (!Array.isArray(receipt.attempts) || receipt.attempts.length < 1
    || receipt.attempts.length > invocation.controls.maxAttempts) fail('DB_OPERATION_RECEIPT_ATTEMPTS_INVALID');
  const attempts = receipt.attempts.map((attempt, index) => {
    validateRecordedAttempt(attempt);
    if (attempt.attempt !== index + 1) fail('DB_OPERATION_RECEIPT_ATTEMPTS_INVALID');
    return attempt;
  });
  const final = attempts.at(-1);
  if (!exactKeys(receipt.outcome, ['state', 'reasonCode', 'resultSha256', 'attemptsUsed'])
    || receipt.outcome.state !== final.state || receipt.outcome.reasonCode !== final.reasonCode
    || receipt.outcome.resultSha256 !== final.resultSha256 || receipt.outcome.attemptsUsed !== attempts.length) {
    fail('DB_OPERATION_RECEIPT_OUTCOME_INVALID');
  }
  if (!exactKeys(receipt.evidenceBoundary, [
    'runtimeValidation', 'credentialsResolved', 'sourceConnected', 'schedulerStarted',
  ]) || receipt.evidenceBoundary.runtimeValidation !== 'SYNTHETIC_UNVALIDATED'
    || receipt.evidenceBoundary.credentialsResolved !== false || receipt.evidenceBoundary.sourceConnected !== false
    || receipt.evidenceBoundary.schedulerStarted !== false) fail('DB_OPERATION_RECEIPT_CLAIM_INVALID');
  if (receipt.resume === null) {
    if (resumeCheckpoint !== null) fail('DB_OPERATION_RECEIPT_CHECKPOINT_UNBOUND');
  } else {
    if (!exactKeys(receipt.resume, ['checkpointSha256', 'resumedAt'])
      || !SHA256.test(receipt.resume.checkpointSha256 ?? '') || !isTimestamp(receipt.resume.resumedAt)
      || resumeCheckpoint === null || receipt.resume.checkpointSha256 !== resumeCheckpoint.checkpointSha256) {
      fail('DB_OPERATION_RECEIPT_CHECKPOINT_INVALID');
    }
    const resumed = validateOperationResumeCheckpoint({
      checkpoint: resumeCheckpoint,
      resolution,
      invocation,
      resumedAt: receipt.resume.resumedAt,
    });
    if (resumed.attempts.length >= attempts.length
      || identitySha256(attempts.slice(0, resumed.attempts.length)) !== identitySha256(resumed.attempts)) {
      fail('DB_OPERATION_RECEIPT_CHECKPOINT_DRIFT');
    }
  }
  return receipt;
}

function operationHistorySource(resolution) {
  return normalizeJsonValue({
    registryId: resolution.registry.registryId,
    registryVersion: resolution.registry.registryVersion,
    sourceId: resolution.source.sourceId,
    engine: resolution.source.engine,
    scopeSha256: identitySha256(resolution.source.scope),
    markerSha256: identitySha256(operationMarker(resolution)),
    resolutionSha256: resolution.resolutionSha256,
    capabilityPackVersion: resolution.capabilityPack.capabilityPackVersion,
    queryPackVersion: resolution.capabilityPack.queryPackVersion,
    normalizerVersion: resolution.capabilityPack.normalizerVersion,
  });
}

function validateHistoryEntry(entry, resolution) {
  if (!exactKeys(entry, [
    'sequence', 'recordedAt', 'previousEntrySha256', 'receipt', 'resumeCheckpoint', 'drift', 'entrySha256',
  ]) || !Number.isInteger(entry.sequence) || entry.sequence < 1 || !isTimestamp(entry.recordedAt)
    || !(entry.previousEntrySha256 === null || SHA256.test(entry.previousEntrySha256 ?? ''))
    || !exactKeys(entry.drift, ['state', 'comparedToEntrySha256', 'previousResultSha256'])
    || !['BASELINE', 'UNCHANGED', 'CHANGED', 'NOT_COMPARABLE'].includes(entry.drift.state)
    || !(entry.drift.comparedToEntrySha256 === null || SHA256.test(entry.drift.comparedToEntrySha256 ?? ''))
    || !(entry.drift.previousResultSha256 === null || SHA256.test(entry.drift.previousResultSha256 ?? ''))
    || !SHA256.test(entry.entrySha256 ?? '')) fail('DB_OPERATION_HISTORY_ENTRY_INVALID');
  const { entrySha256, ...body } = entry;
  if (identitySha256(body) !== entrySha256) fail('DB_OPERATION_HISTORY_ENTRY_TAMPERED');
  validateOperationRunReceipt({ receipt: entry.receipt, resolution, resumeCheckpoint: entry.resumeCheckpoint });
  if (entry.receipt.outcome.state !== 'SUCCEEDED' && entry.drift.state !== 'NOT_COMPARABLE') {
    fail('DB_OPERATION_HISTORY_DRIFT_INVALID');
  }
  if (entry.receipt.outcome.state === 'SUCCEEDED' && entry.drift.state === 'NOT_COMPARABLE') {
    fail('DB_OPERATION_HISTORY_DRIFT_INVALID');
  }
  return entry;
}

export function validateOperationHistory({ history, resolution }) {
  validateResolution(resolution);
  if (!exactKeys(history, [
    'schemaVersion', 'maxEntries', 'totalEntries', 'prunedEntries', 'source', 'entries',
    'lastKnownGoodEntrySha256', 'historySha256',
  ]) || history.schemaVersion !== OPERATION_HISTORY_SCHEMA
    || !Number.isInteger(history.maxEntries) || history.maxEntries < MIN_HISTORY_ENTRIES
    || history.maxEntries > MAX_HISTORY_ENTRIES
    || !Number.isInteger(history.totalEntries) || history.totalEntries < 1
    || !Number.isInteger(history.prunedEntries) || history.prunedEntries < 0
    || !Array.isArray(history.entries) || history.entries.length < 1
    || history.entries.length > history.maxEntries
    || history.prunedEntries !== history.totalEntries - history.entries.length
    || !(history.lastKnownGoodEntrySha256 === null || SHA256.test(history.lastKnownGoodEntrySha256 ?? ''))
    || !SHA256.test(history.historySha256 ?? '')) fail('DB_OPERATION_HISTORY_INVALID');
  const { historySha256, ...body } = history;
  if (identitySha256(body) !== historySha256) fail('DB_OPERATION_HISTORY_TAMPERED');
  if (identitySha256(history.source) !== identitySha256(operationHistorySource(resolution))) {
    fail('DB_OPERATION_HISTORY_FOREIGN');
  }
  const entries = history.entries.map((entry) => validateHistoryEntry(entry, resolution));
  if (entries.some((entry, index) => index > 0 && entry.sequence <= entries[index - 1].sequence)
    || entries.at(-1).sequence !== history.totalEntries
    || new Set(entries.map(({ entrySha256 }) => entrySha256)).size !== entries.length) {
    fail('DB_OPERATION_HISTORY_SEQUENCE_INVALID');
  }
  for (let index = 1; index < entries.length; index += 1) {
    const current = entries[index];
    const previous = entries[index - 1];
    if (current.sequence === previous.sequence + 1 && current.previousEntrySha256 !== previous.entrySha256) {
      fail('DB_OPERATION_HISTORY_CHAIN_INVALID');
    }
  }
  const successful = entries.filter(({ receipt }) => receipt.outcome.state === 'SUCCEEDED');
  const lastKnownGood = successful.at(-1) ?? null;
  if ((lastKnownGood?.entrySha256 ?? null) !== history.lastKnownGoodEntrySha256) {
    fail('DB_OPERATION_HISTORY_LAST_KNOWN_GOOD_INVALID');
  }
  for (const entry of successful) {
    if (entry.drift.state === 'BASELINE') {
      if (entry.drift.comparedToEntrySha256 !== null || entry.drift.previousResultSha256 !== null) {
        fail('DB_OPERATION_HISTORY_DRIFT_INVALID');
      }
      continue;
    }
    const compared = entries.find(({ entrySha256 }) => entrySha256 === entry.drift.comparedToEntrySha256);
    if (compared) {
      if (compared.receipt.outcome.state !== 'SUCCEEDED'
        || entry.drift.previousResultSha256 !== compared.receipt.outcome.resultSha256
        || entry.drift.state !== (entry.receipt.outcome.resultSha256 === compared.receipt.outcome.resultSha256
          ? 'UNCHANGED' : 'CHANGED')) fail('DB_OPERATION_HISTORY_DRIFT_INVALID');
    } else if (!entry.drift.comparedToEntrySha256 || !entry.drift.previousResultSha256) {
      fail('DB_OPERATION_HISTORY_DRIFT_INVALID');
    }
  }
  return history;
}

export function appendOperationHistory({
  history = null, resolution, receipt, resumeCheckpoint = null, recordedAt, maxEntries = 20,
}) {
  validateResolution(resolution);
  validateOperationRunReceipt({ receipt, resolution, resumeCheckpoint });
  if (!isTimestamp(recordedAt) || !Number.isInteger(maxEntries)
    || maxEntries < MIN_HISTORY_ENTRIES || maxEntries > MAX_HISTORY_ENTRIES) {
    fail('DB_OPERATION_HISTORY_INPUT_INVALID');
  }
  const prior = history === null ? null : validateOperationHistory({ history, resolution });
  if (prior && prior.maxEntries !== maxEntries) fail('DB_OPERATION_HISTORY_POLICY_DRIFT');
  const priorEntries = prior?.entries ?? [];
  const priorLastKnownGood = prior?.lastKnownGoodEntrySha256 === null || prior === null
    ? null
    : priorEntries.find(({ entrySha256 }) => entrySha256 === prior.lastKnownGoodEntrySha256);
  if (prior?.lastKnownGoodEntrySha256 && !priorLastKnownGood) fail('DB_OPERATION_HISTORY_LAST_KNOWN_GOOD_INVALID');
  const success = receipt.outcome.state === 'SUCCEEDED';
  const drift = !success
    ? { state: 'NOT_COMPARABLE', comparedToEntrySha256: null, previousResultSha256: null }
    : priorLastKnownGood === null
      ? { state: 'BASELINE', comparedToEntrySha256: null, previousResultSha256: null }
      : {
          state: receipt.outcome.resultSha256 === priorLastKnownGood.receipt.outcome.resultSha256 ? 'UNCHANGED' : 'CHANGED',
          comparedToEntrySha256: priorLastKnownGood.entrySha256,
          previousResultSha256: priorLastKnownGood.receipt.outcome.resultSha256,
        };
  const entryBody = normalizeJsonValue({
    sequence: (prior?.totalEntries ?? 0) + 1,
    recordedAt,
    previousEntrySha256: priorEntries.at(-1)?.entrySha256 ?? null,
    receipt,
    resumeCheckpoint,
    drift,
  });
  const entry = { ...entryBody, entrySha256: identitySha256(entryBody) };
  let entries = [...priorEntries, entry].slice(-maxEntries);
  const lastKnownGood = success ? entry : priorLastKnownGood;
  if (lastKnownGood && !entries.some(({ entrySha256 }) => entrySha256 === lastKnownGood.entrySha256)) {
    entries = [lastKnownGood, ...entries.slice(-(maxEntries - 1))]
      .sort((left, right) => left.sequence - right.sequence);
  }
  const body = normalizeJsonValue({
    schemaVersion: OPERATION_HISTORY_SCHEMA,
    maxEntries,
    totalEntries: entry.sequence,
    prunedEntries: entry.sequence - entries.length,
    source: operationHistorySource(resolution),
    entries,
    lastKnownGoodEntrySha256: lastKnownGood?.entrySha256 ?? null,
  });
  const next = { ...body, historySha256: identitySha256(body) };
  return validateOperationHistory({ history: next, resolution });
}

export function selectLastKnownGoodOperation({ history, resolution }) {
  const verified = validateOperationHistory({ history, resolution });
  const selected = verified.entries.find(({ entrySha256 }) => entrySha256 === verified.lastKnownGoodEntrySha256);
  if (!selected || selected.receipt.outcome.state !== 'SUCCEEDED') fail('DB_OPERATION_HISTORY_NO_LAST_KNOWN_GOOD');
  return selected;
}

const setDifference = (left, right) => [...new Set(left)]
  .filter((value) => !new Set(right).has(value))
  .sort();

function migrationDrift(fromResolution, toResolution) {
  const fromCapabilities = [...fromResolution.capabilityPack.enabledCapabilities].sort();
  const toCapabilities = [...toResolution.capabilityPack.enabledCapabilities].sort();
  const drift = normalizeJsonValue({
    registryVersion: {
      before: fromResolution.registry.registryVersion,
      after: toResolution.registry.registryVersion,
      changed: fromResolution.registry.registryVersion !== toResolution.registry.registryVersion,
    },
    schemaScope: {
      beforeSha256: identitySha256(fromResolution.source.scope),
      afterSha256: identitySha256(toResolution.source.scope),
      addedSchemas: setDifference(toResolution.source.scope.schemas, fromResolution.source.scope.schemas),
      removedSchemas: setDifference(fromResolution.source.scope.schemas, toResolution.source.scope.schemas),
    },
    capabilityPack: {
      versionBefore: fromResolution.capabilityPack.capabilityPackVersion,
      versionAfter: toResolution.capabilityPack.capabilityPackVersion,
      queryPackVersionBefore: fromResolution.capabilityPack.queryPackVersion,
      queryPackVersionAfter: toResolution.capabilityPack.queryPackVersion,
      normalizerVersionBefore: fromResolution.capabilityPack.normalizerVersion,
      normalizerVersionAfter: toResolution.capabilityPack.normalizerVersion,
      addedCapabilities: setDifference(toCapabilities, fromCapabilities),
      removedCapabilities: setDifference(fromCapabilities, toCapabilities),
    },
  });
  return { ...drift, driftSha256: identitySha256(drift) };
}

function migrationReviewReasons(drift) {
  const reasons = [];
  if (drift.registryVersion.changed) reasons.push('REGISTRY_VERSION_CHANGE');
  if (drift.schemaScope.addedSchemas.length > 0 || drift.schemaScope.removedSchemas.length > 0) {
    reasons.push('SCHEMA_SCOPE_CHANGE');
  }
  if (drift.capabilityPack.versionBefore !== drift.capabilityPack.versionAfter) {
    reasons.push('CAPABILITY_PACK_VERSION_CHANGE');
  }
  if (drift.capabilityPack.queryPackVersionBefore !== drift.capabilityPack.queryPackVersionAfter) {
    reasons.push('QUERY_PACK_VERSION_CHANGE');
  }
  if (drift.capabilityPack.normalizerVersionBefore !== drift.capabilityPack.normalizerVersionAfter) {
    reasons.push('NORMALIZER_VERSION_CHANGE');
  }
  if (drift.capabilityPack.addedCapabilities.length > 0 || drift.capabilityPack.removedCapabilities.length > 0) {
    reasons.push('CAPABILITY_ENABLEMENT_CHANGE');
  }
  return reasons.sort();
}

function validateMigrationPair(fromResolution, toResolution) {
  validateResolution(fromResolution);
  validateResolution(toResolution);
  if (fromResolution.profileId !== toResolution.profileId
    || fromResolution.registry.registryId !== toResolution.registry.registryId
    || fromResolution.source.sourceId !== toResolution.source.sourceId
    || fromResolution.source.engine !== toResolution.source.engine) fail('DB_OPERATION_MIGRATION_FOREIGN');
  if (fromResolution.source.scope.database !== toResolution.source.scope.database
    || fromResolution.source.scope.container !== toResolution.source.scope.container
    || identitySha256(fromResolution.source.policy) !== identitySha256(toResolution.source.policy)
    || identitySha256(fromResolution.source.adapter) !== identitySha256(toResolution.source.adapter)
    || identitySha256(fromResolution.source.credentialProvider) !== identitySha256(toResolution.source.credentialProvider)
    || fromResolution.capabilityPack.capabilityPackId !== toResolution.capabilityPack.capabilityPackId) {
    fail('DB_OPERATION_MIGRATION_REPLACEMENT_DENIED');
  }
}

export function createOperationMigrationPlan({ fromResolution, toResolution, requestedAt }) {
  validateMigrationPair(fromResolution, toResolution);
  if (!isTimestamp(requestedAt)) fail('DB_OPERATION_MIGRATION_PLAN_INPUT_INVALID');
  const drift = migrationDrift(fromResolution, toResolution);
  const reasons = migrationReviewReasons(drift);
  if (reasons.length === 0 || fromResolution.resolutionSha256 === toResolution.resolutionSha256) {
    fail('DB_OPERATION_MIGRATION_NO_CHANGE');
  }
  const body = normalizeJsonValue({
    schemaVersion: OPERATION_MIGRATION_PLAN_SCHEMA,
    requestedAt,
    source: {
      registryId: fromResolution.registry.registryId,
      sourceId: fromResolution.source.sourceId,
      engine: fromResolution.source.engine,
    },
    transition: {
      fromResolutionSha256: fromResolution.resolutionSha256,
      toResolutionSha256: toResolution.resolutionSha256,
    },
    drift,
    reviewBoundary: {
      required: true,
      state: 'PENDING',
      reasons,
      automaticApplicationAllowed: false,
    },
    evidenceBoundary: {
      runtimeValidation: 'SYNTHETIC_UNVALIDATED',
      sourceDatabaseWriteAllowed: false,
      credentialsResolved: false,
    },
  });
  return { ...body, planSha256: identitySha256(body) };
}

function validateOperationMigrationPlan({ plan, fromResolution, toResolution }) {
  validateMigrationPair(fromResolution, toResolution);
  if (!exactKeys(plan, [
    'schemaVersion', 'requestedAt', 'source', 'transition', 'drift', 'reviewBoundary',
    'evidenceBoundary', 'planSha256',
  ]) || plan.schemaVersion !== OPERATION_MIGRATION_PLAN_SCHEMA || !isTimestamp(plan.requestedAt)
    || !SHA256.test(plan.planSha256 ?? '')) fail('DB_OPERATION_MIGRATION_PLAN_INVALID');
  const { planSha256, ...body } = plan;
  if (identitySha256(body) !== planSha256) fail('DB_OPERATION_MIGRATION_PLAN_TAMPERED');
  const expected = createOperationMigrationPlan({ fromResolution, toResolution, requestedAt: plan.requestedAt });
  if (identitySha256(plan) !== identitySha256(expected)) fail('DB_OPERATION_MIGRATION_PLAN_DRIFT');
  return plan;
}

export function validateOperationMigrationReceipt({
  receipt, plan, fromResolution, toResolution, history,
}) {
  validateOperationMigrationPlan({ plan, fromResolution, toResolution });
  validateOperationHistory({ history, resolution: fromResolution });
  if (!exactKeys(receipt, [
    'schemaVersion', 'planSha256', 'source', 'transition', 'priorHistory', 'review', 'outcome',
    'rollback', 'evidenceBoundary', 'receiptSha256',
  ]) || receipt.schemaVersion !== OPERATION_MIGRATION_RECEIPT_SCHEMA
    || !SHA256.test(receipt.receiptSha256 ?? '')) fail('DB_OPERATION_MIGRATION_RECEIPT_INVALID');
  const { receiptSha256, ...body } = receipt;
  if (identitySha256(body) !== receiptSha256) fail('DB_OPERATION_MIGRATION_RECEIPT_TAMPERED');
  if (receipt.planSha256 !== plan.planSha256
    || identitySha256(receipt.source) !== identitySha256(plan.source)
    || receipt.transition.fromResolutionSha256 !== fromResolution.resolutionSha256
    || receipt.transition.toResolutionSha256 !== toResolution.resolutionSha256
    || receipt.transition.driftSha256 !== plan.drift.driftSha256
    || receipt.priorHistory.historySha256 !== history.historySha256
    || receipt.priorHistory.lastKnownGoodEntrySha256 !== history.lastKnownGoodEntrySha256) {
    fail('DB_OPERATION_MIGRATION_RECEIPT_BINDING_DRIFT');
  }
  if (!exactKeys(receipt.review, ['decision', 'reviewedAt', 'reviewerReference', 'reasonCode'])
    || receipt.review.decision !== 'APPROVED' || !isTimestamp(receipt.review.reviewedAt)
    || !TOKEN.test(receipt.review.reviewerReference ?? '') || !REASON.test(receipt.review.reasonCode ?? '')
    || Date.parse(receipt.review.reviewedAt) < Date.parse(plan.requestedAt)) {
    fail('DB_OPERATION_MIGRATION_REVIEW_REQUIRED');
  }
  if (!exactKeys(receipt.outcome, ['state', 'appliedAt', 'newHistoryRequired'])
    || receipt.outcome.state !== 'APPLIED_TO_REGISTRY' || !isTimestamp(receipt.outcome.appliedAt)
    || Date.parse(receipt.outcome.appliedAt) < Date.parse(receipt.review.reviewedAt)
    || receipt.outcome.newHistoryRequired !== true
    || !exactKeys(receipt.rollback, ['resolutionSha256', 'lastKnownGoodEntrySha256'])
    || receipt.rollback.resolutionSha256 !== fromResolution.resolutionSha256
    || receipt.rollback.lastKnownGoodEntrySha256 !== history.lastKnownGoodEntrySha256
    || !exactKeys(receipt.evidenceBoundary, [
      'runtimeValidation', 'sourceDatabaseWritten', 'registryPersistenceClaimed', 'priorHistoryRewritten',
    ]) || receipt.evidenceBoundary.runtimeValidation !== 'SYNTHETIC_UNVALIDATED'
    || receipt.evidenceBoundary.sourceDatabaseWritten !== false
    || receipt.evidenceBoundary.registryPersistenceClaimed !== false
    || receipt.evidenceBoundary.priorHistoryRewritten !== false) {
    fail('DB_OPERATION_MIGRATION_RECEIPT_CLAIM_INVALID');
  }
  return receipt;
}

export function applyOperationMigration({
  plan, fromResolution, toResolution, history, review, appliedAt,
}) {
  validateOperationMigrationPlan({ plan, fromResolution, toResolution });
  validateOperationHistory({ history, resolution: fromResolution });
  if (!exactKeys(review, ['decision', 'reviewedAt', 'reviewerReference', 'reasonCode'])
    || review.decision !== 'APPROVED' || !isTimestamp(review.reviewedAt)
    || !TOKEN.test(review.reviewerReference ?? '') || !REASON.test(review.reasonCode ?? '')
    || !isTimestamp(appliedAt) || Date.parse(review.reviewedAt) < Date.parse(plan.requestedAt)
    || Date.parse(appliedAt) < Date.parse(review.reviewedAt)) fail('DB_OPERATION_MIGRATION_REVIEW_REQUIRED');
  const body = normalizeJsonValue({
    schemaVersion: OPERATION_MIGRATION_RECEIPT_SCHEMA,
    planSha256: plan.planSha256,
    source: plan.source,
    transition: {
      fromResolutionSha256: fromResolution.resolutionSha256,
      toResolutionSha256: toResolution.resolutionSha256,
      driftSha256: plan.drift.driftSha256,
    },
    priorHistory: {
      historySha256: history.historySha256,
      lastKnownGoodEntrySha256: history.lastKnownGoodEntrySha256,
    },
    review,
    outcome: { state: 'APPLIED_TO_REGISTRY', appliedAt, newHistoryRequired: true },
    rollback: {
      resolutionSha256: fromResolution.resolutionSha256,
      lastKnownGoodEntrySha256: history.lastKnownGoodEntrySha256,
    },
    evidenceBoundary: {
      runtimeValidation: 'SYNTHETIC_UNVALIDATED',
      sourceDatabaseWritten: false,
      registryPersistenceClaimed: false,
      priorHistoryRewritten: false,
    },
  });
  const receipt = { ...body, receiptSha256: identitySha256(body) };
  return {
    resolution: toResolution,
    receipt: validateOperationMigrationReceipt({ receipt, plan, fromResolution, toResolution, history }),
  };
}

const timeoutAttempt = async ({ executor, context, timeoutMs }) => {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort('DB_OPERATION_ATTEMPT_TIMEOUT');
      resolve({ state: 'TIMEOUT', reasonCode: 'DB_OPERATION_ATTEMPT_TIMEOUT', resultSha256: null });
    }, timeoutMs);
  });
  try {
    const execution = Promise.resolve()
      .then(() => executor({ ...context, signal: controller.signal }))
      .then(validateAttemptResult)
      .catch((error) => controller.signal.aborted
        ? { state: 'TIMEOUT', reasonCode: 'DB_OPERATION_ATTEMPT_TIMEOUT', resultSha256: null }
        : {
            state: 'ERROR',
            reasonCode: REASON.test(error?.code ?? '') ? error.code : 'DB_OPERATION_EXECUTOR_ERROR',
            resultSha256: null,
          });
    return await Promise.race([execution, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

export function createOperationCoordinator() {
  const owners = new Map();
  return {
    acquire(markerSha256, invocationId) {
      if (owners.has(markerSha256)) fail('DB_OPERATION_CONCURRENCY_DENIED');
      owners.set(markerSha256, invocationId);
    },
    release(markerSha256, invocationId) {
      if (owners.get(markerSha256) !== invocationId) fail('DB_OPERATION_MARKER_OWNERSHIP_INVALID');
      owners.delete(markerSha256);
    },
    owner(markerSha256) {
      return owners.get(markerSha256) ?? null;
    },
  };
}

export async function runOperationInvocation({
  resolution, invocation, coordinator, executor, sleep, checkpointing, resume,
}) {
  validateResolution(resolution);
  validateInvocation(invocation, resolution);
  if (!coordinator || typeof coordinator.acquire !== 'function' || typeof coordinator.release !== 'function'
    || typeof executor !== 'function' || (sleep !== undefined && typeof sleep !== 'function')
    || (checkpointing !== undefined && (!exactKeys(checkpointing, ['checkpointedAt', 'validUntil', 'sink'])
      || !isTimestamp(checkpointing.checkpointedAt) || !isTimestamp(checkpointing.validUntil)
      || typeof checkpointing.sink !== 'function'))
    || (resume !== undefined && (!exactKeys(resume, ['checkpoint', 'resumedAt']) || !isTimestamp(resume.resumedAt)))) {
    fail('DB_OPERATION_RUNTIME_INVALID');
  }
  const marker = operationMarker(resolution);
  const markerSha256 = identitySha256(marker);
  const resumed = resume === undefined
    ? { attempts: [], markerSha256, checkpointSha256: null, resumedAt: null }
    : validateOperationResumeCheckpoint({ checkpoint: resume.checkpoint, resolution, invocation, resumedAt: resume.resumedAt });
  coordinator.acquire(markerSha256, invocation.invocationId);
  try {
    const attempts = [...resumed.attempts];
    for (let attempt = attempts.length + 1; attempt <= invocation.controls.maxAttempts; attempt += 1) {
      const result = await timeoutAttempt({
        executor,
        timeoutMs: invocation.controls.timeoutMs,
        context: { attempt, resolution, invocation, markerSha256 },
      });
      attempts.push(normalizeJsonValue({ attempt, ...result }));
      if (result.state === 'SUCCEEDED' || result.state === 'PARTIAL'
        || !invocation.controls.retryStates.includes(result.state)
        || attempt === invocation.controls.maxAttempts) break;
      if (checkpointing) {
        await checkpointing.sink(createResumeCheckpoint({
          resolution,
          invocation,
          markerSha256,
          attempts,
          checkpointedAt: checkpointing.checkpointedAt,
          validUntil: checkpointing.validUntil,
        }));
      }
      if (invocation.controls.retryDelayMs > 0) {
        await (sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))))(invocation.controls.retryDelayMs);
      }
    }
    const final = attempts.at(-1);
    const body = normalizeJsonValue({
      schemaVersion: OPERATION_RUN_RECEIPT_SCHEMA,
      workflow: WORKFLOW,
      invocation: {
        invocationId: invocation.invocationId,
        requestedAt: invocation.requestedAt,
        trigger: invocation.trigger,
      },
      ownership: {
        marker,
        markerSha256,
        ownerInvocationId: invocation.invocationId,
        acquisitionState: 'ACQUIRED',
        releaseState: 'RELEASED',
      },
      binding: {
        resolutionSha256: resolution.resolutionSha256,
        invocationSha256: invocationSha256(invocation),
        engine: resolution.source.engine,
        scopeSha256: identitySha256(resolution.source.scope),
        capabilityPackVersion: resolution.capabilityPack.capabilityPackVersion,
        queryPackVersion: resolution.capabilityPack.queryPackVersion,
        normalizerVersion: resolution.capabilityPack.normalizerVersion,
      },
      controls: invocation.controls,
      attempts,
      outcome: {
        state: final.state,
        reasonCode: final.reasonCode,
        resultSha256: final.resultSha256,
        attemptsUsed: attempts.length,
      },
      resume: resumed.checkpointSha256 === null ? null : {
        checkpointSha256: resumed.checkpointSha256,
        resumedAt: resumed.resumedAt,
      },
      evidenceBoundary: {
        runtimeValidation: 'SYNTHETIC_UNVALIDATED',
        credentialsResolved: false,
        sourceConnected: false,
        schedulerStarted: false,
      },
    });
    return validateOperationRunReceipt({
      receipt: { ...body, receiptSha256: identitySha256(body) },
      resolution,
      resumeCheckpoint: resume?.checkpoint ?? null,
    });
  } finally {
    coordinator.release(markerSha256, invocation.invocationId);
  }
}
