import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  EXTERNAL_API_V2_RUNTIME_INTENTS,
  validatePortableUtilityRequestV1,
} from '../services/bi-control/src/portable-companion/contract.mjs';
import {
  checkPortableDoctorReadiness,
  evaluatePortableDoctorReadiness,
  portableDoctorRequest,
  validatePortableDoctorReadinessReport,
  validatePortableDoctorRequest,
} from '../services/bi-control/src/portable-companion/doctor.mjs';

async function fixture(name) {
  return JSON.parse(await readFile(`services/bi-control/fixtures/portable-companion/${name}.json`, 'utf8'));
}

test('K4e.1 doctor reports runtime-present readiness without widening External API v2', async () => {
  const { snapshot, expected } = await fixture('doctor-runtime-present');
  const report = validatePortableDoctorReadinessReport(checkPortableDoctorReadiness(portableDoctorRequest(), snapshot));
  assert.equal(report.localUtilityStatus, expected.localUtilityStatus);
  assert.equal(report.runtimeStatus, expected.runtimeStatus);
  assert.equal(report.statuses.readyLocalUtility, true);
  assert.equal(report.statuses.runtimeAvailable, true);
  assert.equal(report.statuses.analysisSucceeded, false);
  assert.equal(report.statuses.readbackSucceeded, false);
  assert.deepEqual(report.guidance.map((item) => item.code), expected.guidanceCodes);
  assert.deepEqual(EXTERNAL_API_V2_RUNTIME_INTENTS, ['status', 'discovery', 'analyze', 'plan', 'preview', 'readback']);
});

test('K4e.1 doctor separates READY_LOCAL_UTILITY from missing runtime availability', async () => {
  const { snapshot, expected } = await fixture('doctor-runtime-missing');
  const report = validatePortableDoctorReadinessReport(evaluatePortableDoctorReadiness(snapshot));
  assert.equal(report.localUtilityStatus, expected.localUtilityStatus);
  assert.equal(report.runtimeStatus, expected.runtimeStatus);
  assert.equal(report.statuses.readyLocalUtility, true);
  assert.equal(report.statuses.runtimeAvailable, false);
  assert.equal(report.statuses.analysisSucceeded, false);
  assert.equal(report.statuses.readbackSucceeded, false);
  assert.deepEqual(report.guidance.map((item) => item.code), expected.guidanceCodes);
  assert.doesNotMatch(JSON.stringify(report), /analysis succeeded|readback succeeded|runtime success/i);
});

test('K4e.1 doctor reports partial local configuration and stale manifest with bounded guidance', async () => {
  const { snapshot, expected } = await fixture('doctor-partial-local');
  const report = validatePortableDoctorReadinessReport(evaluatePortableDoctorReadiness(snapshot));
  assert.equal(report.localUtilityStatus, expected.localUtilityStatus);
  assert.equal(report.runtimeStatus, expected.runtimeStatus);
  assert.deepEqual(report.guidance.map((item) => item.code), expected.guidanceCodes);
  assert(report.guidance.every((item) => item.dispatch === false));
  assert(report.checks.some((item) => item.status === 'STALE'));
});

test('K4e.1 doctor request stays empty-input and reserved-action explicit', () => {
  assert.throws(() => validatePortableUtilityRequestV1(portableDoctorRequest()), /PORTABLE_COMPANION_RESERVED_ACTION_DENIED/);
  assert.equal(validatePortableDoctorRequest(portableDoctorRequest()).action, 'doctor.readiness.check');
  assert.throws(() => validatePortableDoctorRequest({ ...portableDoctorRequest(), input: { mode: 'full' } }), /PORTABLE_COMPANION_REQUEST_INPUT_DENIED/);
});

const negativeSnapshots = [
  ['URL request', { runtime: { state: 'present' }, transport: { state: 'configured' }, capabilityManifest: { state: 'current', observedDigest: 'https://example.test/manifest.json' } }, /PORTABLE_DOCTOR_UNSAFE_INSPECTION_DENIED|PORTABLE_DOCTOR_MANIFEST_DIGEST_DENIED/],
  ['redirect request', { redirect: 'follow' }, /PORTABLE_DOCTOR_INSPECTION_SURFACE_DENIED|PORTABLE_DOCTOR_UNSAFE_INSPECTION_DENIED/],
  ['network request', { transport: { state: 'network-probe' } }, /PORTABLE_DOCTOR_TRANSPORT_STATE_DENIED|PORTABLE_DOCTOR_UNSAFE_INSPECTION_DENIED/],
  ['service-start request', { runtime: { state: 'service start' } }, /PORTABLE_DOCTOR_RUNTIME_STATE_DENIED|PORTABLE_DOCTOR_UNSAFE_INSPECTION_DENIED/],
  ['credential field', { configuration: { state: 'complete', missing: [], password: 'redacted' } }, /PORTABLE_DOCTOR_CONFIGURATION_SURFACE_DENIED|PORTABLE_DOCTOR_SECRET_FIELD_DENIED/],
  ['connection string value', { configuration: { state: 'partial', missing: ['runtime.identity'], note: 'postgresql://user:pass@example/db' } }, /PORTABLE_DOCTOR_CONFIGURATION_SURFACE_DENIED|PORTABLE_DOCTOR_UNSAFE_INSPECTION_DENIED/],
  ['unknown local environment field', { runtime: { state: 'missing' }, localEnv: { mode: 'dev' } }, /PORTABLE_DOCTOR_INSPECTION_SURFACE_DENIED/],
];

for (const [name, snapshot, expected] of negativeSnapshots) {
  test(`K4e.1 doctor negative denies ${name}`, () => {
    assert.throws(() => evaluatePortableDoctorReadiness(snapshot), expected);
  });
}

test('K4e.1 doctor validator rejects false runtime-success claims while runtime is absent', async () => {
  const { snapshot } = await fixture('doctor-runtime-missing');
  const report = structuredClone(evaluatePortableDoctorReadiness(snapshot));
  report.statuses.analysisSucceeded = true;
  assert.throws(() => validatePortableDoctorReadinessReport(report), /PORTABLE_DOCTOR_FALSE_RUNTIME_SUCCESS_DENIED|PORTABLE_DOCTOR_REPORT_INTEGRITY_DENIED/);
});
