import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  capabilityAttestationV2,
  executeExternalIntentV2,
  SBA_ATTESTATION_SCHEMA,
  SBA_EXTERNAL_CAPABILITIES,
  SBA_EXTERNAL_CONTRACT_VERSION,
  SBA_INTENT_REQUEST_SCHEMA,
  SBA_INTENT_RESULT_SCHEMA,
  SBA_PRODUCT_VERSION,
  sha256Digest,
  validateExternalIntentV2,
} from '../services/bi-agent/src/external-api-v2.mjs';

const request = (action, input = undefined) => ({
  schemaVersion: SBA_INTENT_REQUEST_SCHEMA,
  requestId: `req-${action}`,
  action,
  ...(input === undefined ? {} : {input}),
});

function handlers(calls = []) {
  return {
    async status() { calls.push('status'); return {status: 'READY', engine: 'mssql', sourceMode: 'fixture', catalogReady: true}; },
    async discovery(input) { calls.push('discovery'); return {schemaVersion: 'chimpmaera.bi/discovery-session/v1', ...input}; },
    async analyze() {
      calls.push('analyze');
      return {
        receiptId: 'mssql-abc', status: 'ANALYZED_READ_ONLY', sourceMode: 'fixture', engine: 'mssql', scope: {database: 'fixture', schemas: ['dbo']},
        safety: {queryPackSelectOnly: true, sourceReadOnly: true, rawRows: [{secret: 'must-not-cross'}]},
        analysis: {runtimeValidation: 'SYNTHETIC_UNVALIDATED', snapshotSha256: 'a'.repeat(64), extracts: [{rows: [{raw: 'must-not-cross'}]}]},
        projection: {sha256: 'b'.repeat(64)},
      };
    },
    async plan(input) { calls.push('plan'); return {schemaVersion: 'superset-bi-agent.external/plan/v2', graph: {acceptedIncumbent: 'adaptive-v1'}, ...input}; },
    async preview(input) { calls.push('preview'); return {schemaVersion: 'superset-bi-agent.external/preview/v2', proposalOnly: true, ...input}; },
    async readback() {
      calls.push('readback');
      return {
        receiptId: 'mssql-abc', summary: {source_engine: 'mssql', source_mode: 'fixture', status: 'ANALYZED_READ_ONLY', snapshot_sha256: 'a'.repeat(64), source_read_only: 1},
        catalogSnapshot: {receipt_id: 'mssql-abc'}, technicalOverview: {coverageRows: 2},
        publication: {status: 'PUBLISHED_IDEMPOTENT', readback: {dashboards: 5}, internalToken: 'must-not-cross'},
      };
    },
  };
}

test('G2 runtime attestation binds actual product, contract, capabilities and accepted graph incumbent', () => {
  const attestation = capabilityAttestationV2();
  assert.equal(attestation.schemaVersion, SBA_ATTESTATION_SCHEMA);
  assert.equal(SBA_PRODUCT_VERSION, 'v0.13.0');
  assert.equal(attestation.product.version, SBA_PRODUCT_VERSION);
  assert.equal(attestation.contract.version, SBA_EXTERNAL_CONTRACT_VERSION);
  assert.equal(attestation.graph.acceptedIncumbent, 'adaptive-v1');
  assert.equal(attestation.graph.candidatePromotion, 'none');
  assert.deepEqual(attestation.capabilities, SBA_EXTERNAL_CAPABILITIES);
  const body = Object.fromEntries(Object.entries(attestation).filter(([key]) => key !== 'attestation'));
  assert.equal(attestation.attestation.digest, sha256Digest(body));
});

test('G2 attestation makes trusted mutation capabilities non-external and authority-bound', () => {
  const trusted = capabilityAttestationV2().capabilities.filter((item) => item.id.startsWith('superset.trusted-'));
  assert.deepEqual(trusted.map((item) => item.id), ['superset.trusted-apply', 'superset.trusted-readback', 'superset.trusted-rollback']);
  assert(trusted.every((item) => item.authority === 'trusted-approval-only' && item.externalIntent === false));
  assert.equal(capabilityAttestationV2().boundaries.directSupersetMutationIntentAccepted, false);
  assert.equal(capabilityAttestationV2().boundaries.modelMutationAuthority, false);
});

test('G2 external request JSON Schema is closed and lists only high-level non-mutating intents', async () => {
  const schema = JSON.parse(await readFile('contracts/external-api/v2/external-bi-api.schema.json', 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.action.enum, ['status', 'discovery', 'analyze', 'plan', 'preview', 'readback']);
  assert(!schema.properties.action.enum.some((item) => /apply|publish|sql|credential|mutation/i.test(item)));
});

test('G3 every allowed intent dispatches exactly one typed owner handler and returns a digest-bound envelope', async () => {
  const cases = [
    request('status'),
    request('discovery', {command: 'start', sessionId: 'demo-1'}),
    request('analyze'),
    request('plan', {objective: 'Review weekly order value'}),
    request('preview', {objective: 'Preview weekly order value', receiptId: 'mssql-abc'}),
    request('readback'),
  ];
  for (const item of cases) {
    const calls = [];
    const result = await executeExternalIntentV2(item, handlers(calls));
    assert.deepEqual(calls, [item.action]);
    assert.equal(result.schemaVersion, SBA_INTENT_RESULT_SCHEMA);
    assert.equal(result.runtime.product.version, SBA_PRODUCT_VERSION);
    assert.equal(result.runtime.contract.version, SBA_EXTERNAL_CONTRACT_VERSION);
    assert.equal(result.capabilityAttestationDigest, capabilityAttestationV2().attestation.digest);
    const body = Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'integrity'));
    assert.equal(result.integrity.digest, sha256Digest(body));
  }
});

test('G3 analyze and readback cross no credentials, raw rows, free SQL or internal tokens', async () => {
  for (const action of ['analyze', 'readback']) {
    const result = await executeExternalIntentV2(request(action), handlers());
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /must-not-cross|internalToken|extracts|rawRows/);
    assert.equal(result.result.disclosure?.rawSourceRowsReturned ?? result.result.safety.rawSourceRowsReturned, false);
    assert.equal(result.result.disclosure?.credentialsReturned ?? result.result.safety.credentialsReturned, false);
  }
});

test('G3 guided discovery answer stays typed and bounded', () => {
  assert.deepEqual(validateExternalIntentV2(request('discovery', {command: 'answer', sessionId: 'demo-1', field: 'audienceRole', value: 'Sales analyst'})).input,
    {command: 'answer', sessionId: 'demo-1', field: 'audienceRole', value: 'Sales analyst'});
});

const negative = [
  ['wrong schema', {...request('status'), schemaVersion: 'superset-bi-agent.external/intent-request/v1'}, /EXTERNAL_BI_REQUEST_IDENTITY_DENIED/],
  ['unknown action', request('publish'), /EXTERNAL_BI_ACTION_DENIED/],
  ['trusted apply action', request('trusted-apply'), /EXTERNAL_BI_ACTION_DENIED/],
  ['free SQL objective', request('plan', {objective: 'SELECT all orders'}), /EXTERNAL_BI_OBJECTIVE_DENIED/],
  ['credential objective', request('preview', {objective: 'Use password abc'}), /EXTERNAL_BI_OBJECTIVE_DENIED/],
  ['arbitrary URL field', request('plan', {objective: 'Review orders', url: 'http://evil.test'}), /EXTERNAL_BI_REQUEST_SURFACE_DENIED/],
  ['raw rows field', request('discovery', {command: 'start', sessionId: 'demo-1', rawRows: []}), /EXTERNAL_BI_REQUEST_SURFACE_DENIED/],
  ['invalid session', request('discovery', {command: 'start', sessionId: '../escape'}), /EXTERNAL_BI_DISCOVERY_INPUT_DENIED/],
  ['answer missing value', request('discovery', {command: 'answer', sessionId: 'demo-1', field: 'audienceRole'}), /EXTERNAL_BI_DISCOVERY_INPUT_DENIED/],
  ['unexpected status input', request('status', {target: 'other'}), /EXTERNAL_BI_REQUEST_SURFACE_DENIED/],
  ['request extra field', {...request('status'), authorization: 'ambient'}, /EXTERNAL_BI_REQUEST_SURFACE_DENIED/],
  ['secret discovery value', request('discovery', {command: 'answer', sessionId: 'demo-1', field: 'audienceRole', value: 'Bearer abcdef'}), /EXTERNAL_BI_UNSAFE_INPUT_DENIED/],
];

for (const [name, value, expected] of negative) {
  test(`G3 negative probe denies ${name} before handler dispatch`, async () => {
    const calls = [];
    await assert.rejects(executeExternalIntentV2(value, handlers(calls)), expected);
    assert.deepEqual(calls, []);
  });
}

test('G3 tampering any result byte invalidates the canonical response digest', async () => {
  const result = await executeExternalIntentV2(request('status'), handlers());
  const tampered = structuredClone(result);
  tampered.result.catalogReady = false;
  const body = Object.fromEntries(Object.entries(tampered).filter(([key]) => key !== 'integrity'));
  assert.notEqual(tampered.integrity.digest, sha256Digest(body));
});
