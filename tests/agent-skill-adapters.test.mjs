import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

const root = 'agent-skills/kaleidosphere';
const validator = `${root}/scripts/validate-request.mjs`;
const base = {schemaVersion: 'superset-bi-agent.external/intent-request/v2'};

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function validate(request) {
  const input = typeof request === 'string' ? request : JSON.stringify(request);
  const result = spawnSync(process.execPath, [validator], {input, encoding: 'utf8'});
  return {status: result.status, output: JSON.parse(result.stdout)};
}

test('repository package is byte-identical to the applied Skill Workshop artifact', async () => {
  const hosts = JSON.parse(await readFile('agent-skills/host-contracts.json', 'utf8'));
  assert.equal(digest(await readFile(`${root}/SKILL.md`)), hosts.workshop.skillSha256);
  assert.equal(digest(await readFile(`${root}/references/contract.json`)), hosts.workshop.contractSha256);
  assert.equal(digest(await readFile(validator)), hosts.workshop.validatorSha256);
  assert.equal(hosts.workshop.status, 'applied');
});

test('one shared closed core serves four thin host contracts', async () => {
  const contract = JSON.parse(await readFile(`${root}/references/contract.json`, 'utf8'));
  const hosts = JSON.parse(await readFile('agent-skills/host-contracts.json', 'utf8'));
  const portable = JSON.parse(await readFile('contracts/portable-companion/v1/compatibility-matrix.json', 'utf8'));
  const externalSchema = JSON.parse(await readFile('contracts/external-api/v2/external-bi-api.schema.json', 'utf8'));
  assert.equal(hosts.schemaVersion, 'kaleidosphere/agent-skill-host-contracts/v2');
  assert.deepEqual(contract.actions, ['status', 'discovery', 'analyze', 'plan', 'preview', 'readback']);
  assert.deepEqual(hosts.crossHarness.externalApiV2Intents, contract.actions);
  assert.deepEqual(hosts.crossHarness.externalApiV2Intents, externalSchema.properties.action.enum);
  assert.deepEqual(portable.externalApiV2.runtimeIntents, contract.actions);
  assert.deepEqual(hosts.crossHarness.portableUtilityActions, portable.portableUtilityActions.map((item) => item.id));
  assert.equal(hosts.crossHarness.authority, 'offline-utility-only');
  assert.equal(hosts.crossHarness.runtimeDispatch, false);
  assert.deepEqual(hosts.crossHarness.security, {
    skillsOnly: true,
    hooksAllowed: false,
    mcpServersAllowed: false,
    executableModeFilesAllowed: false,
    externalCallsAllowed: false,
    secretsAllowed: false,
    archiveTraversalAllowed: false,
  });
  assert.equal(contract.authority, 'authority-free');
  assert.equal(hosts.sharedBusinessLogicCopies, 1);
  assert.deepEqual(Object.keys(hosts.hosts), ['openclaw', 'hermes', 'claude-code', 'codex']);
  assert.ok(Object.values(hosts.hosts).every((host) => !('actions' in host) && !('logic' in host)));
});

test('all six safe intent shapes validate locally', () => {
  const requests = [
    {...base, requestId: 'h-status', action: 'status', input: {}},
    {...base, requestId: 'h-discovery', action: 'discovery', input: {command: 'start', sessionId: 'demo_1'}},
    {...base, requestId: 'h-analyze', action: 'analyze', input: {}},
    {...base, requestId: 'h-plan', action: 'plan', input: {objective: 'Review bounded BI proposal'}},
    {...base, requestId: 'h-preview', action: 'preview', input: {objective: 'Preview bounded BI proposal', receiptId: 'receipt:1'}},
    {...base, requestId: 'h-readback', action: 'readback', input: {}},
  ];
  for (const request of requests) {
    const result = validate(request);
    assert.equal(result.status, 0, request.action);
    assert.equal(result.output.valid, true, request.action);
  }
});

test('eleven widening and malformed probes fail before dispatch or evidence acceptance', () => {
  const probes = [
    {...base, requestId: 'n-extra', action: 'status', input: {}, tool: 'extra'},
    {...base, requestId: 'n-apply', action: 'apply', input: {}},
    {...base, requestId: 'n-sql', action: 'plan', input: {objective: 'Run SQL', sql: 'select 1'}},
    {...base, requestId: 'n-url', action: 'plan', input: {objective: 'Use endpoint', url: 'https://invalid.example'}},
    {...base, requestId: 'n-secret', action: 'discovery', input: {command: 'start', sessionId: 'demo_1', token: 'x'}},
    {...base, requestId: 'n-row', action: 'discovery', input: {command: 'answer', sessionId: 'demo_1', rawRows: [{x: 1}]}},
    '{',
    {...base, requestId: 'n-empty', action: 'status', input: {unexpected: true}},
    {...base, requestId: 'n-stale', schemaVersion: 'unknown/v1', action: 'status', input: {}},
    {...base, requestId: 'n-command', action: 'discovery', input: {command: 'drop', sessionId: 'demo_1'}},
    {...base, requestId: ' bad', action: 'status', input: {}},
  ];
  for (const probe of probes) {
    const result = validate(probe);
    assert.equal(result.status, 2);
    assert.equal(result.output.valid, false);
  }
});

test('taste disposition never grants product or evidence authority', async () => {
  const contract = JSON.parse(await readFile(`${root}/references/contract.json`, 'utf8'));
  assert.deepEqual(contract.visualReview, {
    hmi: 'advisory-only-not-implementation-authority',
    internalDesignReview: 'adapt-visual-heuristics-never-evidence-override',
    presentations: 'adapt-clarity-never-truth-judge',
  });
  const skill = await readFile(`${root}/SKILL.md`, 'utf8');
  assert.match(skill, /never a BI truth or evidence judge/i);
  assert.match(skill, /do not use taste guidance as implementation authority/i);
});
