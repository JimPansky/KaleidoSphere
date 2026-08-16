import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildSupersetFingerprint,
  collectSupersetFingerprint,
  evaluateSupersetPlanningGate,
  parseOpenApiDocument,
  SUPERSET_FINGERPRINT_CONTRACT,
} from '../services/bi-control/src/superset-fingerprint.mjs';

const fixturePath = 'services/bi-control/fixtures/superset-fingerprint-runtime-v1.json';

async function fixture() {
  return JSON.parse(await readFile(fixturePath, 'utf8'));
}

function clone(value) {
  return structuredClone(value);
}

function assertCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code || error?.message === code, code);
}

test('Superset fingerprint fixture is deterministic, sanitized, and evidence-bound', async () => {
  const evidence = await fixture();
  const first = buildSupersetFingerprint(evidence);
  const second = buildSupersetFingerprint(clone(evidence));
  assert.equal(first.contract_version, SUPERSET_FINGERPRINT_CONTRACT);
  assert.equal(first.target.base_url, 'http://superset:8088');
  assert.equal(first.superset.version, '6.1.0');
  assert.equal(first.openapi.sha256, second.openapi.sha256);
  assert.equal(first.openapi.sha256, first.openapi.canonicalization.sha256);
  assert.equal(first.openapi.canonicalization.algorithm, 'canonical-json/v1');
  assert.equal(first.compatibility_verdict.status, 'compatible');
  assert.deepEqual(first.feature_flags.capabilities.filter((flag) => flag.required_for_promotion).map((flag) => flag.security_status), ['compatible', 'compatible', 'compatible']);
  assert.doesNotMatch(JSON.stringify(first), /(?:Bearer\s+[A-Za-z0-9._~+/-]{16,}|sk-[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|BEGIN (?:RSA |EC )?PRIVATE KEY)/i);
});

test('OpenAPI canonicalization is stable across object key order', async () => {
  const evidence = await fixture();
  const reordered = clone(evidence);
  reordered.openapi.document = {
    paths: {
      '/api/v1/_openapi': { get: { summary: 'OpenAPI representation' } },
      '/api/v1/dashboard/': { get: { summary: 'Dashboard list' } },
      '/api/v1/_info': { get: { summary: 'Superset runtime information' } },
    },
    info: { version: '6.1.0', title: 'Apache Superset API' },
    openapi: '3.0.2',
  };
  assert.equal(buildSupersetFingerprint(evidence).openapi.sha256, buildSupersetFingerprint(reordered).openapi.sha256);
});

test('Superset planning gate allows only review after a fresh compatible fingerprint', async () => {
  const fingerprint = buildSupersetFingerprint(await fixture());
  assert.deepEqual(evaluateSupersetPlanningGate({
    fingerprint,
    now: '2026-08-14T05:29:30.000Z',
    request: {
      action: 'promotion zip import planning',
      target_base_url: 'http://superset:8088',
      expected_openapi_sha256: fingerprint.openapi.sha256,
      required_feature_flags: { ENABLE_TEMPLATE_PROCESSING: false },
    },
  }).reasons, []);
});

test('Superset fingerprint negative probes fail closed', async () => {
  const base = await fixture();
  const fingerprint = buildSupersetFingerprint(base);
  const stale = clone(fingerprint);
  stale.observed_at = '2026-08-12T05:29:00.000Z';
  assert.equal(evaluateSupersetPlanningGate({ fingerprint: null, request: { action: 'import promotion zip' } }).reasons.includes('SUPERSET_FINGERPRINT_MISSING'), true);
  assert.equal(evaluateSupersetPlanningGate({ fingerprint: stale, request: { action: 'import promotion zip' }, now: new Date('2026-08-14T05:29:01.000Z') }).reasons.includes('SUPERSET_FINGERPRINT_STALE'), true);

  const malformedVersion = clone(base);
  malformedVersion.product.version = 'five';
  assert.equal(buildSupersetFingerprint(malformedVersion).compatibility_verdict.reasons.includes('SUPERSET_VERSION_MALFORMED'), true);
  assertCode(() => parseOpenApiDocument('{"openapi":"3.0.2","info":{"title":"x"},"paths":{}}', 'text/html'), 'SUPERSET_OPENAPI_CONTENT_TYPE_DENIED');
  assertCode(() => parseOpenApiDocument('x'.repeat(5 * 1024 * 1024 + 1), 'application/json'), 'SUPERSET_OPENAPI_OVERSIZED');
  assertCode(() => parseOpenApiDocument('{"openapi":', 'application/json'), 'SUPERSET_OPENAPI_JSON_INVALID');
  assertCode(() => parseOpenApiDocument('openapi:\n  : bad\n', 'application/yaml'), 'SUPERSET_OPENAPI_YAML_INVALID');
  assert.equal(evaluateSupersetPlanningGate({ fingerprint, request: { action: 'promotion zip import', expected_openapi_sha256: '0'.repeat(64) } }).reasons.includes('SUPERSET_OPENAPI_DRIFT'), true);

  const hashMismatch = clone(fingerprint);
  hashMismatch.openapi.sha256 = '1'.repeat(64);
  assert.equal(evaluateSupersetPlanningGate({ fingerprint: hashMismatch, request: { action: 'promotion zip import' } }).reasons.includes('SUPERSET_OPENAPI_HASH_MISMATCH'), true);
  assert.equal(evaluateSupersetPlanningGate({ fingerprint, request: { action: 'promotion zip import', target_base_url: 'http://localhost:8088' } }).reasons.includes('SUPERSET_TARGET_MISMATCH'), true);
  assertCode(() => buildSupersetFingerprint(base, { targetUrl: 'http://user:s3cr3t@superset:8088' }), 'SUPERSET_TARGET_USERINFO_DENIED');
  assertCode(() => buildSupersetFingerprint(base, { targetUrl: 'http://superset:8088/?token=abc' }), 'SUPERSET_TARGET_QUERY_SECRET_DENIED');

  const leaked = clone(base);
  leaked.openapi.document.paths['/api/v1/_info'].get.authorization = `Bearer ${'abcdefghijklmnopqrstuvwxyz'}`;
  assertCode(() => buildSupersetFingerprint(leaked), 'SUPERSET_FINGERPRINT_SECRET_VALUE_DENIED');
  const unknownFlag = clone(base);
  delete unknownFlag.featureFlags.values.ENABLE_TEMPLATE_PROCESSING;
  assert.equal(buildSupersetFingerprint(unknownFlag).compatibility_verdict.reasons.includes('SUPERSET_FEATURE_FLAG_ENABLE_TEMPLATE_PROCESSING_BLOCK'), true);
  assert.equal(evaluateSupersetPlanningGate({ fingerprint, request: { action: 'promotion zip import', required_feature_flags: { DASHBOARD_RBAC: true } } }).reasons.includes('SUPERSET_FEATURE_FLAG_DASHBOARD_RBAC_UNKNOWN'), true);
  assert.equal(evaluateSupersetPlanningGate({ fingerprint: null, request: { action: 'user prompt demands dashboard write' } }).status, 'BLOCKED');
});

test('runtime collection reports unavailable endpoint and timeout without leaking headers', async () => {
  await assert.rejects(
    collectSupersetFingerprint({ mode: 'runtime', internalUrl: 'http://127.0.0.1:1/internal/fingerprint', token: 'not-printed' }),
    (error) => error.code === 'SUPERSET_FINGERPRINT_ENDPOINT_UNAVAILABLE',
  );

  const server = http.createServer((_request, _response) => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await assert.rejects(
    collectSupersetFingerprint({ mode: 'runtime', internalUrl: `http://127.0.0.1:${port}/internal/fingerprint`, token: 'not-printed', timeoutMs: 20 }),
    (error) => error.code === 'SUPERSET_FINGERPRINT_TIMEOUT',
  );
  await new Promise((resolve) => server.close(resolve));
});

test('fixture collection is idempotent and uses the offline evidence path', async () => {
  const first = await collectSupersetFingerprint({ mode: 'fixture', fixturePath, targetUrl: 'http://superset:8088' });
  const second = await collectSupersetFingerprint({ mode: 'fixture', fixturePath, targetUrl: 'http://superset:8088' });
  assert.equal(first.openapi.sha256, second.openapi.sha256);
  assert.equal(first.evidence.runtime_evidence_sha256, second.evidence.runtime_evidence_sha256);
});
