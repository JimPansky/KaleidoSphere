import { canonicalJson, identitySha256, validateQueryManifest } from './core.mjs';

export const STRUCTURAL_DRIFT_SCHEMA = 'chimpmaera.db/structural-drift/v1';

const fail = (code) => {
  const error = new Error(code);
  error.code = code;
  throw error;
};

const exactKeys = (value, expected) => value
  && typeof value === 'object'
  && !Array.isArray(value)
  && canonicalJson(Object.keys(value).sort()) === canonicalJson([...expected].sort());

function assertSnapshotIntegrity(snapshot, manifest) {
  if (!exactKeys(snapshot, [
    'schemaVersion', 'packId', 'packVersion', 'engine', 'runtimeValidation', 'identityContract',
    ...(Object.hasOwn(snapshot ?? {}, 'observedAt') ? ['observedAt'] : []),
    ...(Object.hasOwn(snapshot ?? {}, 'profile') ? ['profile'] : []),
    'coverage', 'coverageLedger', 'extracts', 'snapshotSha256',
  ])) fail('DB_DRIFT_SNAPSHOT_FIELDS_INVALID');
  const { snapshotSha256, ...body } = snapshot;
  if (identitySha256(body) !== snapshotSha256) fail('DB_DRIFT_SNAPSHOT_TAMPERED');
  if (snapshot.engine !== manifest.engine || snapshot.packId !== manifest.packId || snapshot.packVersion !== manifest.packVersion) {
    fail('DB_DRIFT_SNAPSHOT_BINDING_INVALID');
  }
  const expectedQueries = manifest.queries.map(({ id }) => id);
  if (canonicalJson(snapshot.extracts.map(({ queryId }) => queryId)) !== canonicalJson(expectedQueries)) {
    fail('DB_DRIFT_QUERY_SET_INVALID');
  }
  for (const extract of snapshot.extracts) {
    if (extract.category !== 'preflight' && extract.state !== 'SUCCEEDED') fail('DB_DRIFT_COVERAGE_INCOMPLETE');
    for (const row of extract.rows) {
      const { objectSha256, ...object } = row;
      if (identitySha256({ queryId: extract.queryId, object }) !== objectSha256) fail('DB_DRIFT_OBJECT_TAMPERED');
    }
  }
}

function structuralObjects(snapshot, manifest) {
  const objects = new Map();
  for (const query of manifest.queries.filter(({ category }) => category !== 'preflight')) {
    const extract = snapshot.extracts.find(({ queryId }) => queryId === query.id);
    for (const row of extract.rows) {
      const key = Object.fromEntries(query.sortKeys.map((field) => [field, row[field]]));
      const objectKeySha256 = identitySha256({ queryId: query.id, key });
      if (objects.has(objectKeySha256)) fail('DB_DRIFT_OBJECT_KEY_COLLISION');
      objects.set(objectKeySha256, {
        queryId: query.id,
        category: query.category,
        key,
        objectKeySha256,
        objectSha256: row.objectSha256,
      });
    }
  }
  return objects;
}

const compareKey = (left, right) => Buffer.compare(
  Buffer.from(`${left.queryId}\0${canonicalJson(left.key)}`, 'utf8'),
  Buffer.from(`${right.queryId}\0${canonicalJson(right.key)}`, 'utf8'),
);

export function compareStructuralEvidence({ manifest, baseline, current }) {
  validateQueryManifest(manifest);
  assertSnapshotIntegrity(baseline, manifest);
  assertSnapshotIntegrity(current, manifest);
  if (baseline.identityContract.schemaVersion !== current.identityContract.schemaVersion
    || baseline.runtimeValidation !== current.runtimeValidation
    || baseline.profile?.scope.database !== current.profile?.scope.database
    || baseline.profile?.scope.container !== current.profile?.scope.container
    || canonicalJson(baseline.profile?.scope.schemas ?? null) !== canonicalJson(current.profile?.scope.schemas ?? null)) {
    fail('DB_DRIFT_COMPARISON_SCOPE_INVALID');
  }

  const before = structuralObjects(baseline, manifest);
  const after = structuralObjects(current, manifest);
  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];

  for (const [objectKeySha256, object] of before) {
    const next = after.get(objectKeySha256);
    if (!next) removed.push(object);
    else if (object.objectSha256 !== next.objectSha256) changed.push({
      queryId: object.queryId,
      category: object.category,
      key: object.key,
      objectKeySha256,
      beforeObjectSha256: object.objectSha256,
      afterObjectSha256: next.objectSha256,
    });
    else unchanged.push(object);
  }
  for (const [objectKeySha256, object] of after) if (!before.has(objectKeySha256)) added.push(object);
  for (const collection of [added, removed, changed, unchanged]) collection.sort(compareKey);

  const accounting = {
    baselineObjects: before.size,
    currentObjects: after.size,
    baselineExplained: removed.length + changed.length + unchanged.length,
    currentExplained: added.length + changed.length + unchanged.length,
  };
  accounting.unexplainedChanges = (accounting.baselineObjects - accounting.baselineExplained)
    + (accounting.currentObjects - accounting.currentExplained);
  accounting.zeroUnexplainedChanges = accounting.unexplainedChanges === 0;
  if (!accounting.zeroUnexplainedChanges) fail('DB_DRIFT_ACCOUNTING_INVALID');

  const body = {
    schemaVersion: STRUCTURAL_DRIFT_SCHEMA,
    engine: manifest.engine,
    packId: manifest.packId,
    packVersion: manifest.packVersion,
    baselineSnapshotSha256: baseline.snapshotSha256,
    currentSnapshotSha256: current.snapshotSha256,
    status: added.length + removed.length + changed.length === 0 ? 'UNCHANGED' : 'DRIFT',
    summary: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      unchanged: unchanged.length,
    },
    accounting,
    added,
    removed,
    changed,
    unchanged,
  };
  return { ...body, driftSha256: identitySha256(body) };
}
