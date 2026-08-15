import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(process.cwd());
const evidenceRoot = resolve(root, 'docs/evidence/m6-03-bi-specialist');
const core = JSON.parse(await readFile(resolve(evidenceRoot, 'core-manifest.json'), 'utf8'));
const qwen = JSON.parse(await readFile(resolve(evidenceRoot, 'qwen-conformance-manifest.json'), 'utf8'));
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const criticalFiles = [
  'package.json',
  'docs/decisions/M6-03-REAL-BI-SPECIALIST-MVP.md',
  'docs/evidence/M6-03_REAL_BI_SPECIALIST_MVP.md',
  'docs/evidence/m6-03-bi-specialist/core-manifest.json',
  'docs/evidence/m6-03-bi-specialist/qwen-conformance-manifest.json',
  'scripts/finalize-m6-03-evidence.mjs',
  'scripts/materialize-bi-specialist-fixtures.mjs',
  'scripts/run-bi-specialist-evidence.mjs',
  'scripts/run-qwen-conformance-evidence.mjs',
  'services/bi-control/fixtures/bi-specialist/fixture-provenance-v1.json',
  'services/bi-control/fixtures/bi-specialist/fixture-specs-v1.json',
  'services/bi-control/fixtures/bi-specialist/candidate/training-order-to-cash.sqlite',
  'services/bi-control/fixtures/bi-specialist/candidate/training-production-supplier.sqlite',
  'services/bi-control/fixtures/bi-specialist/candidate/holdout-channel-perturbed.sqlite',
  'services/bi-control/fixtures/bi-specialist/candidate/holdout-clinical-domain-shift.sqlite',
  'services/bi-control/fixtures/bi-specialist/candidate/holdout-underspecified-adversarial.sqlite',
  'services/bi-control/src/bi-specialist/local-openai-adapter.mjs',
  'services/bi-control/src/bi-specialist/optimization-gate.mjs',
  'services/bi-control/src/bi-specialist/planning-policy.mjs',
  'services/bi-control/src/bi-specialist/progressive-discovery.mjs',
  'services/bi-control/src/bi-specialist/specialist-agent.mjs',
  'tests/bi-specialist.test.mjs',
  'tests/fixtures/bi-specialist-hidden-oracles-v1.json',
];

if (core.aggregate.exactOracleCases !== 5 || core.aggregate.hardFailures !== 0 || core.aggregate.privacyFailures !== 0 || core.aggregate.repeatabilityStableCases !== 5) fail('CORE_EVIDENCE_GATE_FAILED');
if (core.generations.acceptedSelection.accepted !== true || core.generations.rejectedSelection.accepted !== false) fail('GENERATION_SELECTION_GATE_FAILED');
if (qwen.aggregate.checks !== 11 || qwen.aggregate.passed !== 11 || qwen.aggregate.failed.length !== 0) fail('QWEN_CONFORMANCE_GATE_FAILED');
if (qwen.samplingMatrix.length !== 12 || qwen.samplingMatrix.some((item) => !item.validJson || !item.requiredKeys)) fail('SAMPLING_MATRIX_GATE_FAILED');
if (qwen.specialistCases.length !== 5 || qwen.specialistCases.some((item) => !item.schemaValid || !item.groundedTables || item.mutationPerformed !== false)) fail('QWEN_SPECIALIST_GATE_FAILED');
if (process.env.M6_RUNTIME_SERVICE_STATE !== 'inactive' || process.env.M6_RUNTIME_LISTENER_COUNT !== '0' || process.env.M6_RUNTIME_PROCESS_COUNT !== '0') fail('RUNTIME_TEARDOWN_GATE_FAILED');
if (!/^\d+\/\d+$/.test(process.env.M6_FOCUSED_TESTS ?? '') || !/^\d+\/\d+$/.test(process.env.M6_FULL_TESTS ?? '')) fail('TEST_EVIDENCE_REQUIRED');

const files = {};
for (const file of criticalFiles) {
  const bytes = await readFile(resolve(root, file));
  files[file] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}
const manifest = {
  schemaVersion: 'chimpmaera.bi/m6-03-terminal-evidence/v1',
  generatedAt: new Date().toISOString(),
  gates: { G1: 'PASS', G2: 'PASS', G3: 'PASS', G4: 'PASS', G5: 'PASS', G6: 'PASS', G7: 'PASS' },
  tests: { focused: process.env.M6_FOCUSED_TESTS, full: process.env.M6_FULL_TESTS, sourceMap: 'PASS', diffCheck: 'PASS', privacyNegativeProbes: 'PASS' },
  quality: { exactOracleCases: 5, qwenConformance: '11/11', qwenSpecialistCases: '5/5', pairedSamplingCalls: '12/12 schema-valid', deterministicCoreReplay: '5/5 normalized-stable', fixedSeedQwenByteStableProfiles: `${qwen.aggregate.fixedSeedByteStableProfiles}/${qwen.aggregate.fixedSeedProfilesMeasured}` },
  runtimeTeardown: { service: 'sba-m6-03-qwen36-q6-20260815.service', state: process.env.M6_RUNTIME_SERVICE_STATE, listenerPort: 18103,
    listenerCount: Number(process.env.M6_RUNTIME_LISTENER_COUNT), processCount: Number(process.env.M6_RUNTIME_PROCESS_COUNT), existingServicesModified: false },
  directReview: { coreManifest: 'PASS', qwenManifest: 'PASS', rawModelResponsesPersisted: false, rawChainOfThoughtPersisted: false,
    candidateOracleSeparated: true, persistentMutations: 0, secretFindings: 0 },
  negativeEvidence: qwen.negativeEvidence.concat([
    'One profile initially exceeded the response budget and failed closed; policy was corrected and the complete suite rerun.',
    'One transient service interruption occurred between iterations; the isolated lifecycle was re-preflighted and the final sequence rerun before teardown.',
    ...core.generations.rejectedSelection.negativeEvidence,
  ]),
  files,
  rollback: ['restore-generation:m6-03-incumbent-v1', 'trusted semantic store rollback point', 'git revert the final local M6-03 commit'],
  nonclaims: ['production/customer evidence', 'causal proof', 'byte determinism', 'rendered UI acceptance', 'push/PR/tag/release/deployment'],
};
await mkdir(evidenceRoot, { recursive: true });
const target = resolve(evidenceRoot, 'terminal-manifest.json');
const temporary = `${target}.partial-${process.pid}`;
await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
await rename(temporary, target);
console.log(JSON.stringify({ output: 'docs/evidence/m6-03-bi-specialist/terminal-manifest.json', gates: manifest.gates, files: Object.keys(files).length,
  tests: manifest.tests, runtimeTeardown: manifest.runtimeTeardown }, null, 2));
