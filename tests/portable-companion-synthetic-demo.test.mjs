import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  PORTABLE_SYNTHETIC_HUMAN_LABEL,
  loadPortableSyntheticDemoFixture,
  renderPortableSyntheticDemo,
  runPortableSyntheticDemo,
  validatePortableSyntheticDemoFixture,
  validatePortableSyntheticDemoReport,
} from '../services/bi-control/src/portable-companion/synthetic-demo.mjs';

const root = path.resolve(import.meta.dirname, '..');
const fixturePath = path.join(root, 'services/bi-control/fixtures/portable-companion/synthetic-demo-v1.json');
const sourcePath = path.join(root, 'services/bi-control/src/portable-companion/synthetic-demo.mjs');
const runtimeIntents = ['status', 'discovery', 'analyze', 'plan', 'preview', 'readback'];

function clone(value) {
  return structuredClone(value);
}

test('synthetic demo renders byte-identically on two independent runs', () => {
  const first = renderPortableSyntheticDemo();
  const second = renderPortableSyntheticDemo();
  assert.equal(first, second);
  assert.equal(Buffer.compare(Buffer.from(first), Buffer.from(second)), 0);
  assert.equal(first.endsWith('\n'), true);
});

test('every machine and human output layer is explicitly synthetic', () => {
  const report = runPortableSyntheticDemo();
  for (const layer of [report, ...Object.values(report.layers)]) {
    assert.equal(layer.classification.machine.synthetic, true);
    assert.equal(layer.classification.machine.fixtureClass, 'synthetic-only');
    assert.equal(layer.classification.machine.liveEvidence, false);
    assert.equal(layer.classification.machine.runtimeObservation, false);
    assert.equal(layer.classification.human, PORTABLE_SYNTHETIC_HUMAN_LABEL);
  }
});

test('demo composes bounded status, guidance, template and receipt utilities without dispatch', () => {
  const report = runPortableSyntheticDemo();
  assert.deepEqual(report.externalApiV2.runtimeIntents, runtimeIntents);
  assert.deepEqual(Object.keys(report.layers).sort(), ['guidance', 'receipt', 'status', 'template']);
  assert.equal(report.layers.status.localUtilityStatus, 'READY_LOCAL_UTILITY');
  assert.equal(report.layers.status.runtimeStatus, 'RUNTIME_UNAVAILABLE');
  assert.equal(report.layers.status.analysisSucceeded, false);
  assert.equal(report.layers.status.readbackSucceeded, false);
  assert.equal(report.layers.guidance.selectedCapabilityId, 'bi.preview.create');
  assert.equal(report.layers.guidance.advisoryOnly, true);
  assert.equal(report.layers.template.validationStatus, 'VALID_PLACEHOLDER_ONLY');
  assert.equal(report.layers.template.placeholderOnly, true);
  assert.equal(report.layers.receipt.verificationStatus, 'VERIFIED_INTEGRITY_ONLY');
  assert.equal(report.layers.receipt.trustClass, 'synthetic-fixture-only');
  assert.equal(report.layers.receipt.liveObservationClaim, false);
  assert(Object.values(report.layers).every((layer) => layer.dispatch === false));
  assert(Object.values(report.boundaries).every((accepted) => accepted === false));
  assert.equal(validatePortableSyntheticDemoReport(report), report);
});

test('rendered output is canonical JSON with a valid integrity digest', () => {
  const parsed = JSON.parse(renderPortableSyntheticDemo());
  assert.match(parsed.integrity.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(validatePortableSyntheticDemoReport(parsed), parsed);
});

test('missing or altered synthetic fixture labels fail closed', () => {
  const missing = clone(loadPortableSyntheticDemoFixture());
  delete missing.classification;
  assert.throws(() => validatePortableSyntheticDemoFixture(missing), /PORTABLE_SYNTHETIC_DEMO_LABEL_DENIED/);

  const altered = clone(loadPortableSyntheticDemoFixture());
  altered.classification.human = 'offline example';
  assert.throws(() => validatePortableSyntheticDemoFixture(altered), /PORTABLE_SYNTHETIC_DEMO_LABEL_DENIED/);
});

test('secret-looking fixture values fail closed', () => {
  const fixture = clone(loadPortableSyntheticDemoFixture());
  fixture.note = `sk-${'a'.repeat(24)}`;
  assert.throws(() => validatePortableSyntheticDemoFixture(fixture), /PORTABLE_SYNTHETIC_DEMO_SECRET_VALUE_DENIED/);
});

test('raw rows and customer-like identifiers fail closed', () => {
  const raw = clone(loadPortableSyntheticDemoFixture());
  raw.rawRows = [{ value: 1 }];
  assert.throws(() => validatePortableSyntheticDemoFixture(raw), /PORTABLE_SYNTHETIC_DEMO_RAW_ROW_DENIED/);

  const customer = clone(loadPortableSyntheticDemoFixture());
  customer.customerId = 'customer-12345';
  assert.throws(() => validatePortableSyntheticDemoFixture(customer), /PORTABLE_SYNTHETIC_DEMO_CUSTOMER_IDENTIFIER_DENIED/);
});

test('runtime dispatch or network requests fail closed', () => {
  const dispatch = clone(loadPortableSyntheticDemoFixture());
  dispatch.boundaries.runtimeDispatch = true;
  assert.throws(() => validatePortableSyntheticDemoFixture(dispatch), /PORTABLE_SYNTHETIC_DEMO_RUNTIME_DISPATCH_DENIED/);

  const network = clone(loadPortableSyntheticDemoFixture());
  network.boundaries.network = true;
  assert.throws(() => validatePortableSyntheticDemoFixture(network), /PORTABLE_SYNTHETIC_DEMO_NETWORK_DENIED/);
});

test('output cannot claim observed or live runtime evidence', () => {
  const live = clone(runPortableSyntheticDemo());
  live.layers.receipt.claimsLiveEvidence = true;
  assert.throws(() => validatePortableSyntheticDemoReport(live), /PORTABLE_SYNTHETIC_DEMO_LIVE_EVIDENCE_CLAIM_DENIED/);

  const observed = clone(runPortableSyntheticDemo());
  observed.layers.status.claimsRuntimeObservation = true;
  assert.throws(() => validatePortableSyntheticDemoReport(observed), /PORTABLE_SYNTHETIC_DEMO_LIVE_EVIDENCE_CLAIM_DENIED/);
});

test('output synthetic labels and canonical integrity cannot be altered', () => {
  const label = clone(runPortableSyntheticDemo());
  label.layers.guidance.classification.machine.synthetic = false;
  assert.throws(() => validatePortableSyntheticDemoReport(label), /PORTABLE_SYNTHETIC_DEMO_LABEL_DENIED/);

  const integrity = clone(runPortableSyntheticDemo());
  integrity.nonClaims[0] = 'Changed boundary text.';
  assert.throws(() => validatePortableSyntheticDemoReport(integrity), /PORTABLE_SYNTHETIC_DEMO_REPORT_INTEGRITY_DENIED/);
});

test('fixture contains no obvious secret, raw-row or customer identifier material', async () => {
  const bytes = await readFile(fixturePath, 'utf8');
  assert.doesNotMatch(bytes, /(?:sk-[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9_]{20,}|BEGIN [A-Z ]*PRIVATE KEY|bearer\s+[a-z0-9._:-]{8,})/i);
  assert.doesNotMatch(bytes, /"(?:rawRows?|rows?|records?|customerId|clientId|tenantId|accountId|userId)"\s*:/i);
  assert.doesNotMatch(bytes, /\b(?:https?|wss?):\/\/|\blocalhost\b/i);
});

test('demo implementation has no network or runtime-dispatch primitive', async () => {
  const source = await readFile(sourcePath, 'utf8');
  assert.doesNotMatch(source, /from ['"]node:(?:http|https|net|tls|dns|dgram)['"]/);
  assert.doesNotMatch(source, /\b(?:fetch|WebSocket|EventSource)\s*\(/);
  assert.doesNotMatch(source, /child_process|\bspawn(?:Sync)?\s*\(|\bexec(?:File|Sync)?\s*\(/);
});
