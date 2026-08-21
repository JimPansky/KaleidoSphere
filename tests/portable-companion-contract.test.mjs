import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  EXTERNAL_API_V2_RUNTIME_INTENTS,
  PORTABLE_COMPANION_BOUNDARIES,
  PORTABLE_COMPANION_CONTRACT_VERSION,
  PORTABLE_COMPANION_REQUEST_SCHEMA,
  PORTABLE_COMPANION_UTILITY_ACTIONS,
  explainPortableCompanionFoundation,
  loadPortableCompanionCompatibilityMatrix,
  loadPortableCompanionSchema,
  portableCompanionManifestV1,
  sha256Canonical,
  validateCompatibilityMatrixV1,
  validatePortableCompanionManifestV1,
  validatePortableUtilityRequestV1,
} from '../services/bi-control/src/portable-companion/contract.mjs';
import {
  SBA_EXTERNAL_CAPABILITIES,
  validateExternalIntentV2,
} from '../services/bi-agent/src/external-api-v2.mjs';

const request = (action, input = undefined) => ({
  schemaVersion: PORTABLE_COMPANION_REQUEST_SCHEMA,
  contractVersion: PORTABLE_COMPANION_CONTRACT_VERSION,
  action,
  ...(input === undefined ? {} : { input }),
});

function recomputeManifestIntegrity(value) {
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'integrity'));
  value.integrity = { algorithm: 'sha256-canonical-json', digest: sha256Canonical(body) };
  return value;
}

test('K4e.0 schema is closed, versioned and explicitly separate from External API v2 runtime intents', () => {
  const schema = loadPortableCompanionSchema();
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.schemaVersion.const, 'kaleidosphere.portable-companion/contract/v1');
  assert.equal(schema.properties.contract.properties.version.const, '1.0.0');
  assert.deepEqual(schema.properties.externalApiV2.properties.runtimeIntents.prefixItems.map((item) => item.const), EXTERNAL_API_V2_RUNTIME_INTENTS);
  assert.equal(schema.properties.externalApiV2.properties.runtimeIntents.minItems, 6);
  assert.equal(schema.properties.externalApiV2.properties.runtimeIntents.maxItems, 6);
  assert.equal(schema.$defs.Boundaries.properties.runtimeDispatchAccepted.const, false);
  assert.equal(schema.$defs.Boundaries.properties.credentialsAccepted.const, false);
  assert.equal(schema.$defs.Boundaries.properties.freeSqlAccepted.const, false);
  assert.equal(schema.$defs.Boundaries.properties.rawSourceRowsAccepted.const, false);
  assert.equal(schema.$defs.PortableUtilityRequest.additionalProperties, false);
});

test('K4e.0 compatibility matrix validates closed utility vocabulary and unchanged six runtime intents', () => {
  const matrix = validateCompatibilityMatrixV1();
  assert.deepEqual(matrix.externalApiV2.runtimeIntents, ['status', 'discovery', 'analyze', 'plan', 'preview', 'readback']);
  assert.equal(matrix.externalApiV2.runtimeIntentCount, 6);
  assert.equal(matrix.externalApiV2.wideningAllowed, false);
  assert.deepEqual(matrix.portableUtilityActions.map((item) => item.id), PORTABLE_COMPANION_UTILITY_ACTIONS.map((item) => item.id));
  assert(matrix.portableUtilityActions.every((item) => item.authority === 'offline-utility-only' && item.dispatch === false));
  assert.deepEqual(matrix.boundaries, PORTABLE_COMPANION_BOUNDARIES);
  assert.deepEqual(matrix.portableUtilityActions.filter((item) => item.lifecycle === 'foundation').map((item) => item.ownerIssue), [81, 81, 81, 81]);
  assert.deepEqual(matrix.portableUtilityActions.filter((item) => item.lifecycle === 'reserved').map((item) => item.ownerIssue), [82, 83, 84, 85, 86, 87, 88]);
});

test('K4e.0 manifest binds schema, compatibility matrix, source map and integrity digests', () => {
  const manifest = portableCompanionManifestV1();
  assert.equal(validatePortableCompanionManifestV1(manifest), manifest);
  assert.match(manifest.compatibility.matrixDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(manifest.compatibility.sourceMapDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(manifest.compatibility.schemaDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(manifest.contract.version, '1.0.0');
  assert.deepEqual(manifest.externalApiV2.runtimeIntents, EXTERNAL_API_V2_RUNTIME_INTENTS);
  assert.equal(manifest.utilityActions.some((item) => item.dispatch !== false), false);
});

test('K4e.0 foundation explains nonclaims without dispatch authority', () => {
  const explanation = explainPortableCompanionFoundation();
  assert.equal(explanation.manifest.boundaries.runtimeDispatchAccepted, false);
  assert(explanation.nonClaims.includes('No runtime dispatch.'));
  assert(JSON.stringify(explanation).includes('remote-MCP'));
});

test('K4e.0 utility request accepts only foundation local metadata actions by default', () => {
  assert.deepEqual(validatePortableUtilityRequestV1(request('contract.describe')).input, {});
  assert.throws(() => validatePortableUtilityRequestV1(request('doctor.readiness.check')), /PORTABLE_COMPANION_RESERVED_ACTION_DENIED/);
  const reserved = validatePortableUtilityRequestV1(request('doctor.readiness.check'), { allowReserved: true });
  assert.equal(reserved.acceptedAction.ownerIssue, 82);
  assert.equal(reserved.acceptedAction.dispatch, false);
});

test('K4e.0 preserves External API v2 byte-visible runtime action vocabulary', async () => {
  const schema = JSON.parse(await readFile('contracts/external-api/v2/external-bi-api.schema.json', 'utf8'));
  const runtimeActions = SBA_EXTERNAL_CAPABILITIES.filter((item) => item.externalIntent !== false).map((item) => item.action);
  assert.deepEqual(runtimeActions, EXTERNAL_API_V2_RUNTIME_INTENTS);
  assert.deepEqual(schema.properties.action.enum, EXTERNAL_API_V2_RUNTIME_INTENTS);
  assert.doesNotThrow(() => validateExternalIntentV2({ schemaVersion: 'superset-bi-agent.external/intent-request/v2', requestId: 'req-status', action: 'status' }));
  assert.throws(() => validateExternalIntentV2({ schemaVersion: 'superset-bi-agent.external/intent-request/v2', requestId: 'req-portable', action: 'contract.describe' }), /EXTERNAL_BI_ACTION_DENIED/);
});

const negativeRequests = [
  ['unknown action', request('endpoint.discover'), /PORTABLE_COMPANION_ACTION_DENIED/],
  ['additional top-level property', { ...request('contract.describe'), target: 'runtime' }, /PORTABLE_COMPANION_REQUEST_SURFACE_DENIED/],
  ['additional input property', request('contract.describe', { mode: 'full' }), /PORTABLE_COMPANION_REQUEST_INPUT_DENIED/],
  ['stale contract version', { ...request('contract.describe'), contractVersion: '0.9.0' }, /PORTABLE_COMPANION_CONTRACT_VERSION_DENIED/],
  ['unknown future contract version', { ...request('contract.describe'), contractVersion: '2.0.0' }, /PORTABLE_COMPANION_CONTRACT_VERSION_DENIED/],
  ['secret field', { ...request('contract.describe'), input: {}, apiKey: 'placeholder' }, /PORTABLE_COMPANION_REQUEST_SURFACE_DENIED/],
  ['credential value', { ...request('contract.describe'), action: 'Bearer abcdefghijkl' }, /PORTABLE_COMPANION_ACTION_DENIED|PORTABLE_COMPANION_UNSAFE_SURFACE_DENIED/],
  ['free SQL', { ...request('contract.describe'), action: 'SELECT * FROM orders' }, /PORTABLE_COMPANION_ACTION_DENIED|PORTABLE_COMPANION_UNSAFE_SURFACE_DENIED/],
  ['endpoint discovery', { ...request('contract.describe'), action: 'https://example.test/api' }, /PORTABLE_COMPANION_ACTION_DENIED|PORTABLE_COMPANION_UNSAFE_SURFACE_DENIED/],
  ['raw rows/provider payload', { ...request('contract.describe'), rawRows: [{ id: 1 }] }, /PORTABLE_COMPANION_REQUEST_SURFACE_DENIED/],
  ['mutation/deploy/evidence claim', { ...request('contract.describe'), claim: 'deploy with live evidence' }, /PORTABLE_COMPANION_REQUEST_SURFACE_DENIED/],
];

for (const [name, value, expected] of negativeRequests) {
  test(`K4e.0 negative request denies ${name}`, () => {
    assert.throws(() => validatePortableUtilityRequestV1(value), expected);
  });
}

test('K4e.0 request bounds fail closed for oversized and overly deep JSON', () => {
  assert.throws(() => validatePortableUtilityRequestV1({ ...request('contract.describe'), action: `contract.describe${'x'.repeat(9000)}` }), /PORTABLE_COMPANION_SIZE_LIMIT_DENIED/);
  const deep = request('contract.describe');
  deep.extra = { a: { b: { c: { d: { e: { f: { g: { h: 'too-deep' } } } } } } } };
  assert.throws(() => validatePortableUtilityRequestV1(deep), /PORTABLE_COMPANION_REQUEST_SURFACE_DENIED/);
});

test('K4e.0 matrix rejects runtime-intent widening and boundary drift', () => {
  const widened = loadPortableCompanionCompatibilityMatrix();
  widened.externalApiV2.runtimeIntents.push('doctor');
  widened.externalApiV2.runtimeIntentCount = 7;
  assert.throws(() => validateCompatibilityMatrixV1(widened), /PORTABLE_COMPANION_RUNTIME_INTENT_WIDENING_DENIED/);

  const boundaryDrift = loadPortableCompanionCompatibilityMatrix();
  boundaryDrift.boundaries.credentialsAccepted = true;
  assert.throws(() => validateCompatibilityMatrixV1(boundaryDrift), /PORTABLE_COMPANION_BOUNDARY_DRIFT_DENIED/);
});

test('K4e.0 manifest rejects stale product, unknown actions, matrix/source/schema digest drift and integrity drift', () => {
  const stale = structuredClone(portableCompanionManifestV1());
  stale.product.version = 'v0.18.2';
  recomputeManifestIntegrity(stale);
  assert.throws(() => validatePortableCompanionManifestV1(stale), /PORTABLE_COMPANION_MANIFEST_STALE_DENIED/);

  const unknown = structuredClone(portableCompanionManifestV1());
  unknown.utilityActions[0].id = 'future.unknown';
  recomputeManifestIntegrity(unknown);
  assert.throws(() => validatePortableCompanionManifestV1(unknown), /PORTABLE_COMPANION_ACTION_DRIFT_DENIED/);

  const matrixDrift = structuredClone(portableCompanionManifestV1());
  matrixDrift.compatibility.matrixDigest = `sha256:${'0'.repeat(64)}`;
  recomputeManifestIntegrity(matrixDrift);
  assert.throws(() => validatePortableCompanionManifestV1(matrixDrift), /PORTABLE_COMPANION_MATRIX_DIGEST_DRIFT_DENIED/);

  const sourceMapDrift = structuredClone(portableCompanionManifestV1());
  sourceMapDrift.compatibility.sourceMapDigest = `sha256:${'1'.repeat(64)}`;
  recomputeManifestIntegrity(sourceMapDrift);
  assert.throws(() => validatePortableCompanionManifestV1(sourceMapDrift), /PORTABLE_COMPANION_SOURCE_MAP_DIGEST_DRIFT_DENIED/);

  const schemaDrift = structuredClone(portableCompanionManifestV1());
  schemaDrift.compatibility.schemaDigest = `sha256:${'2'.repeat(64)}`;
  recomputeManifestIntegrity(schemaDrift);
  assert.throws(() => validatePortableCompanionManifestV1(schemaDrift), /PORTABLE_COMPANION_SCHEMA_DIGEST_DRIFT_DENIED/);

  const integrityDrift = structuredClone(portableCompanionManifestV1());
  integrityDrift.boundaries.freeSqlAccepted = true;
  assert.throws(() => validatePortableCompanionManifestV1(integrityDrift), /PORTABLE_COMPANION_BOUNDARY_DRIFT_DENIED|PORTABLE_COMPANION_MANIFEST_INTEGRITY_DENIED/);
});
