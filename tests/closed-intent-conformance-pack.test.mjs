import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {
  CLOSED_INTENTS,
  CLOSED_INTENT_CONFORMANCE_PACK_VERSION,
  createDeterministicLocalConsumer,
  renderClosedIntentConformanceReport,
  runClosedIntentConformancePack,
  runClosedIntentNegativeMatrix,
} from '../services/bi-agent/src/closed-intent-conformance-pack.mjs';

const fixture = JSON.parse(await readFile('tests/fixtures/closed-intent-conformance-pack-v1.json', 'utf8'));

test('K2 attests, dispatches all six closed intents and maps each response through K1', async () => {
  const report = await runClosedIntentConformancePack({consumer: createDeterministicLocalConsumer(fixture), fixture});
  assert.equal(report.schemaVersion, CLOSED_INTENT_CONFORMANCE_PACK_VERSION);
  assert.equal(report.executedIntents, 6);
  assert.equal(report.acceptedEvidence, 6);
  assert.equal(report.downstreamDispatches, 6);
  assert.equal(report.reportDigest, 'sha256:cb6f260370380f473fc4823012f7b82e4e8e482835065858a67703e097bdbac4');
  assert.deepEqual(report.evidence.map(({action}) => action), CLOSED_INTENTS);
  assert.ok(report.evidence.every((item) => item.status === 'succeeded' && item.evidenceDigest.startsWith('sha256:')));
});

test('K2 local-stub report is byte-identical across independent reruns', async () => {
  const left = await runClosedIntentConformancePack({consumer: createDeterministicLocalConsumer(fixture), fixture});
  const right = await runClosedIntentConformancePack({consumer: createDeterministicLocalConsumer(structuredClone(fixture)), fixture: structuredClone(fixture)});
  assert.equal(renderClosedIntentConformanceReport(left), renderClosedIntentConformanceReport(right));
  assert.equal(left.reportDigest, right.reportDigest);
});

test('K2 negative matrix denies every unsafe or invalid probe before downstream dispatch and evidence acceptance', async () => {
  const report = await runClosedIntentNegativeMatrix({fixture});
  assert.equal(report.probeCount, 11);
  assert.equal(report.setupDispatchesExcluded, 1);
  assert.equal(report.setupAcceptedEvidenceExcluded, 1);
  assert.equal(report.downstreamDispatches, 0);
  assert.equal(report.acceptedEvidence, 0);
  assert.equal(report.reportDigest, 'sha256:4bcdaca5813fd10baf5d914ae639376ff0640b0272220d81addc609af1e8e01c');
  assert.ok(report.results.every((item) => item.denied && item.downstreamDispatches === 0 && item.acceptedEvidence === 0));
  assert.deepEqual(report.results.map(({id}) => id), [
    'extra-tool', 'trusted-apply', 'free-sql', 'arbitrary-url', 'credential', 'raw-row',
    'malformed-response', 'tampered-response', 'replayed-response', 'stale-contract', 'missing-capability',
  ]);
});

test('K2 is optional: absent or incompatible consumers disable only the pack with no dispatch or evidence', async () => {
  const absent = await runClosedIntentConformancePack({consumer: null, fixture});
  const incompatible = await runClosedIntentConformancePack({consumer: {schemaVersion: 'unknown/v1'}, fixture});
  for (const report of [absent, incompatible]) {
    assert.equal(report.mode, 'disabled');
    assert.equal(report.executedIntents, 0);
    assert.equal(report.downstreamDispatches, 0);
    assert.equal(report.acceptedEvidence, 0);
    assert.deepEqual(report.evidence, []);
  }
  assert.equal(absent.reason, 'CONSUMER_ABSENT');
  assert.equal(incompatible.reason, 'CONSUMER_INCOMPATIBLE');
});

test('K2 report exposes no credential, SQL, URL, raw-row or provider payload surface', async () => {
  const report = await runClosedIntentConformancePack({consumer: createDeterministicLocalConsumer(fixture), fixture});
  const output = renderClosedIntentConformanceReport(report);
  assert.doesNotMatch(output, /\.secrets|must-not-cross|bearer\s|SELECT\s|https?:\/\/|catalogSnapshot|technicalOverview/i);
  assert.deepEqual(Object.keys(report.evidence[0]), [
    'action', 'requestId', 'resultIntegrityDigest', 'evidenceDigest', 'eventId', 'receiptId', 'status',
  ]);
  assert.match(output, /LOCAL_STUB_ONLY_NOT_REAL_HARNESS_E2E/);
});

test('K2 rejects consumer objects that widen the closed boundary', async () => {
  let dispatches = 0;
  const widened = {
    schemaVersion: 'kaleidosphere/closed-intent-consumer/v1',
    attest() { throw new Error('must not run'); },
    async dispatch() { dispatches += 1; },
    credentials: {token: 'must-not-cross'},
  };
  const report = await runClosedIntentConformancePack({consumer: widened, fixture});
  assert.equal(report.reason, 'CONSUMER_INCOMPATIBLE');
  assert.equal(dispatches, 0);
});

test('K2 fixture explicitly remains local synthetic evidence, not real-harness E2E evidence', async () => {
  const report = await runClosedIntentConformancePack({consumer: createDeterministicLocalConsumer(fixture), fixture});
  assert.equal(report.mode, 'local-stub-conformance');
  assert.ok(report.nonClaims.includes('LOCAL_STUB_ONLY_NOT_REAL_HARNESS_E2E'));
  assert.ok(report.nonClaims.includes('NO_DEEPSEEK_HARNESS_API_ABI_OR_PLUGIN_COMPATIBILITY'));
  assert.ok(report.nonClaims.includes('NO_PRODUCTION_PROVIDER_DATABASE_OR_SUPERSET_CONNECTION'));
});
