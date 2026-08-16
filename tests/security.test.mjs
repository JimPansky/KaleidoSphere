import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { buildSupersetFingerprint, evaluateSupersetPlanningGate } from '../services/bi-control/src/superset-fingerprint.mjs';
import { parseSchemas, validateActionRequest } from '../services/bi-control/src/policy.mjs';

test('control action and schema scopes are exact and closed', () => {
  assert.deepEqual(parseSchemas('sales,dbo,sales'), ['dbo', 'sales']);
  assert.throws(() => parseSchemas('dbo;DROP'), /DB_ANALYZE_SCHEMA_SCOPE_INVALID/);
  assert.deepEqual(validateActionRequest({action:'analyze'}, 'analyze'), {action:'analyze'});
  assert.throws(() => validateActionRequest({action:'analyze', rawSql:'SELECT 1'}, 'analyze'), /CONTROL_REQUEST_SURFACE_DENIED/);
  assert.throws(() => validateActionRequest({action:'delete'}, 'analyze'), /CONTROL_ACTION_DENIED/);
});

test('Compose has bounded ports, no Docker socket, no privilege, and closed control network', async () => {
  const compose = await readFile('compose.yaml', 'utf8');
  assert.doesNotMatch(compose, /docker\.sock|privileged:\s*true/i);
  assert.match(compose, /127\.0\.0\.1:\$\{SUPERSET_PORT:-18088\}:8088/);
  assert.match(compose, /127\.0\.0\.1:\$\{AGENT_PORT:-18790\}:18790/);
  assert.doesNotMatch(compose, /18789/);
  assert.match(compose, /control:\n\s+internal: true/);
  assert.match(compose, /cap_drop: \[ALL\]/);
});

test('shell and Python runtime sources parse', async () => {
  execFileSync('bash', ['-n', 'bin/bi']);
  for (const file of ['bootstrap.py','healthcheck.py','materialize.py','materializer_server.py','superset_config.py']) {
    execFileSync('python3', ['-c', `compile(open('services/superset/runtime/${file}', encoding='utf-8').read(), '${file}', 'exec')`]);
  }
});

test('Superset materializer initializes its application once per process', async () => {
  const source = await readFile('services/superset/runtime/materialize.py', 'utf8');
  assert.match(source, /^APP = create_app\(\)$/m);
  assert.match(source, /with APP\.app_context\(\):/);
  assert.doesNotMatch(source, /def materialize\(request\):[\s\S]*?\n\s+app = create_app\(\)/);
});

test('tracked/config source contains no obvious committed secret assignment', async () => {
  for (const file of ['.env.example','compose.yaml','README.md','services/bi-agent/src/server.mjs','services/bi-agent/src/external-api-v2.mjs','services/bi-control/src/server.mjs','services/bi-control/src/discovery.mjs','services/bi-control/src/superset-fingerprint.mjs','services/bi-control/fixtures/superset-fingerprint-runtime-v1.json']) {
    const value = await readFile(file, 'utf8');
    assert.doesNotMatch(value, /(?:sk-[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|BEGIN (?:RSA |EC )?PRIVATE KEY)/, file);
  }
});

test('Superset planning gate blocks write-like work without a valid fingerprint', async () => {
  const result = evaluateSupersetPlanningGate({ fingerprint: null, request: { action: 'promotion zip import dashboard write' } });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.mutation_performed, false);
  assert(result.reasons.includes('SUPERSET_FINGERPRINT_MISSING'));
});

test('Superset fingerprint contract rejects token-like evidence', async () => {
  const evidence = JSON.parse(await readFile('services/bi-control/fixtures/superset-fingerprint-runtime-v1.json', 'utf8'));
  evidence.openapi.document.paths['/api/v1/_info'].get.token = `Bearer ${'abcdefghijklmnopqrstuvwxyz'}`;
  assert.throws(() => buildSupersetFingerprint(evidence), /SUPERSET_FINGERPRINT_SECRET_VALUE_DENIED/);
});
