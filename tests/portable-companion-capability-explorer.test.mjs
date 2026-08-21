import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  EXTERNAL_API_V2_RUNTIME_INTENTS,
  sha256Canonical,
  validatePortableUtilityRequestV1,
} from '../services/bi-control/src/portable-companion/contract.mjs';
import {
  portableCapabilityExplorerRequest,
  readPortableCapabilityExplorer,
  validatePortableCapabilityExplorerReport,
  validatePortableCapabilityExplorerRequest,
} from '../services/bi-control/src/portable-companion/capability-explorer.mjs';
import {
  capabilityManifestV1,
} from '../services/bi-agent/src/capability-manifest-v1.mjs';

async function fixture(name) {
  return JSON.parse(await readFile(`services/bi-control/fixtures/portable-companion/${name}.json`, 'utf8'));
}

function recomputeManifestIntegrity(manifest) {
  const body = Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'integrity'));
  manifest.integrity = { algorithm: 'sha256-canonical-json', digest: sha256Canonical(body) };
  return manifest;
}

test('K4e.2 explorer lists all manifest capabilities with digest and source binding', async () => {
  const { expected } = await fixture('capability-all');
  const manifest = capabilityManifestV1();
  const report = validatePortableCapabilityExplorerReport(readPortableCapabilityExplorer(portableCapabilityExplorerRequest(), {
    expectedDigest: manifest.integrity.digest,
  }));
  assert.equal(report.manifestBinding.manifestVersion, manifest.manifestVersion);
  assert.equal(report.manifestBinding.digest, manifest.integrity.digest);
  assert.match(report.manifestBinding.sourceCommit, /^[a-f0-9]{40}$/);
  assert.equal(report.capabilities.length, expected.capabilityCount);
  assert.deepEqual(report.capabilities.map((item) => item.action), expected.actions);
  assert.deepEqual(report.externalApiV2.runtimeIntents, EXTERNAL_API_V2_RUNTIME_INTENTS);
  assert.deepEqual(report.guidance.map((item) => item.code), expected.guidanceCodes);
  assert(report.capabilities.every((item) => item.dispatch === false));
});

test('K4e.2 explorer selects a capability by manifest id', async () => {
  const { selector, expected } = await fixture('capability-discovery');
  const report = validatePortableCapabilityExplorerReport(readPortableCapabilityExplorer(portableCapabilityExplorerRequest(), {
    capabilityKey: selector,
  }));
  assert.equal(report.selectedCapabilityKey, selector);
  assert.equal(report.capabilities.length, expected.capabilityCount);
  assert.deepEqual(report.capabilities.map((item) => item.action), expected.actions);
  assert.equal(report.capabilities[0].authority, expected.authority);
  assert.deepEqual(report.capabilities[0].guidance.map((item) => item.code), expected.guidanceCodes);
});

test('K4e.2 explorer selects a capability by closed runtime action without invoking it', async () => {
  const { selector, expected } = await fixture('capability-plan');
  const report = validatePortableCapabilityExplorerReport(readPortableCapabilityExplorer(portableCapabilityExplorerRequest(), {
    capabilityKey: selector,
  }));
  assert.equal(report.capabilities.length, expected.capabilityCount);
  assert.equal(report.capabilities[0].action, expected.actions[0]);
  assert.equal(report.capabilities[0].authority, expected.authority);
  assert.equal(report.capabilities[0].dispatch, false);
  assert.doesNotMatch(JSON.stringify(report), /"dispatch":true|invoke plan|dispatch plan|execute plan/i);
});

test('K4e.2 explorer request remains a reserved empty-input Portable Companion utility', () => {
  assert.throws(() => validatePortableUtilityRequestV1(portableCapabilityExplorerRequest()), /PORTABLE_COMPANION_RESERVED_ACTION_DENIED/);
  assert.equal(validatePortableCapabilityExplorerRequest(portableCapabilityExplorerRequest()).action, 'capability.explorer.read');
  assert.throws(() => validatePortableCapabilityExplorerRequest({ ...portableCapabilityExplorerRequest(), input: { capabilityKey: 'status' } }), /PORTABLE_COMPANION_REQUEST_INPUT_DENIED/);
});

test('K4e.2 negative rejects unknown capability key', () => {
  assert.throws(() => readPortableCapabilityExplorer(portableCapabilityExplorerRequest(), {
    capabilityKey: 'bi.unknown.run',
  }), /PORTABLE_CAPABILITY_EXPLORER_UNKNOWN_CAPABILITY_DENIED/);
});

test('K4e.2 negative rejects manifest digest mismatch', () => {
  assert.throws(() => readPortableCapabilityExplorer(portableCapabilityExplorerRequest(), {
    expectedDigest: `sha256:${'0'.repeat(64)}`,
  }), /PORTABLE_CAPABILITY_EXPLORER_DIGEST_MISMATCH_DENIED/);
});

test('K4e.2 negative rejects stale manifest version', () => {
  const manifest = structuredClone(capabilityManifestV1());
  manifest.manifestVersion = '0.9.0';
  recomputeManifestIntegrity(manifest);
  assert.throws(() => readPortableCapabilityExplorer(portableCapabilityExplorerRequest(), {
    manifest,
  }), /CAPABILITY_MANIFEST_VERSION_DENIED|PORTABLE_CAPABILITY_EXPLORER_STALE_MANIFEST_DENIED/);
});

test('K4e.2 negative rejects attempt to invoke a runtime intent from guidance', () => {
  const report = structuredClone(readPortableCapabilityExplorer());
  report.guidance[0].message = 'Invoke status now from this guidance.';
  assert.throws(() => validatePortableCapabilityExplorerReport(report), /PORTABLE_CAPABILITY_EXPLORER_RUNTIME_INVOCATION_DENIED|PORTABLE_CAPABILITY_EXPLORER_REPORT_INTEGRITY_DENIED/);
});

test('K4e.2 negative rejects guidance text claiming live evidence without receipt', () => {
  const report = structuredClone(readPortableCapabilityExplorer());
  report.capabilities[0].guidance[0].message = 'Live evidence is verified for this capability.';
  assert.throws(() => validatePortableCapabilityExplorerReport(report), /PORTABLE_CAPABILITY_EXPLORER_LIVE_EVIDENCE_CLAIM_DENIED|PORTABLE_CAPABILITY_EXPLORER_REPORT_INTEGRITY_DENIED/);
});

test('K4e.2 negative rejects runtime-intent widening in generated report', () => {
  const report = structuredClone(readPortableCapabilityExplorer());
  report.externalApiV2.runtimeIntents.push('apply');
  assert.throws(() => validatePortableCapabilityExplorerReport(report), /PORTABLE_CAPABILITY_EXPLORER_RUNTIME_INTENT_WIDENING_DENIED|PORTABLE_CAPABILITY_EXPLORER_REPORT_INTEGRITY_DENIED/);
});
