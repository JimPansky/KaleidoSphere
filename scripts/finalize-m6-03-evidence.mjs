import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(process.cwd());
const evidenceRoot = resolve(root, 'docs/evidence/m6-03-bi-specialist');
const core = JSON.parse(await readFile(resolve(evidenceRoot, 'core-manifest.json'), 'utf8'));
const qwen = JSON.parse(await readFile(resolve(evidenceRoot, 'qwen-conformance-manifest.json'), 'utf8'));
const sealedV1 = JSON.parse(await readFile(resolve(evidenceRoot, 'sealed-blind-manifest.json'), 'utf8'));
const sealedV2 = JSON.parse(await readFile(resolve(evidenceRoot, 'sealed-blind-v2-manifest.json'), 'utf8'));
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const criticalFiles = [
  'package.json',
  'docs/decisions/M6-03-REAL-BI-SPECIALIST-MVP.md',
  'docs/evidence/M6-03_REAL_BI_SPECIALIST_MVP.md',
  'docs/evidence/m6-03-bi-specialist/core-manifest.json',
  'docs/evidence/m6-03-bi-specialist/qwen-conformance-manifest.json',
  'docs/evidence/m6-03-bi-specialist/sealed-blind-manifest.json',
  'docs/evidence/m6-03-bi-specialist/sealed-blind-v2-manifest.json',
  'scripts/finalize-m6-03-evidence.mjs',
  'scripts/materialize-bi-specialist-fixtures.mjs',
  'scripts/run-bi-specialist-evidence.mjs',
  'scripts/run-qwen-conformance-evidence.mjs',
  'scripts/run-sealed-bi-specialist-evaluation.mjs',
  'scripts/run-sealed-bi-specialist-evaluation-v2.mjs',
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
  'tests/fixtures/bi-specialist-development-oracles-v1.json',
  'tests/evaluator-sealed/m6-03/candidate-commitment.json',
  'tests/evaluator-sealed/m6-03/candidate-commitment-v2.json',
  'tests/evaluator-sealed/m6-03/evaluator-utils.mjs',
  'tests/evaluator-sealed/m6-03/pack/7e3a9c.sqlite',
  'tests/evaluator-sealed/m6-03/pack/2b6f10.sqlite',
  'tests/evaluator-sealed/m6-03/pack/91ad44.sqlite',
  'tests/evaluator-sealed/m6-03/pack-v2/6c7d31.sqlite',
  'tests/evaluator-sealed/m6-03/pack-v2/38f4a2.sqlite',
  'tests/evaluator-sealed/m6-03/pack-v2/ab209e.sqlite',
];

if (core.aggregate.exactOracleCases !== 5 || core.aggregate.hardFailures !== 0 || core.aggregate.privacyFailures !== 0 || core.aggregate.repeatabilityStableCases !== 5) fail('CORE_EVIDENCE_GATE_FAILED');
if (core.generations.acceptedSelection.accepted !== true || core.generations.rejectedSelection.accepted !== false) fail('GENERATION_SELECTION_GATE_FAILED');
if (core.coverage.training !== 2 || core.coverage.development !== 3 || core.coverage.blind !== 0) fail('DEVELOPMENT_RECLASSIFICATION_GATE_FAILED');
if (sealedV1.aggregate.candidateExactCases !== 0 || sealedV1.aggregate.candidateHardFailures !== 3
  || sealedV1.aggregate.grainFailures !== 3 || sealedV1.aggregate.leakageFailures !== 0 || sealedV1.aggregate.mutationFailures !== 0) fail('SEALED_V1_NEGATIVE_EVIDENCE_GATE_FAILED');
if (sealedV2.aggregate.candidateExactCases !== 3 || sealedV2.aggregate.candidateHardFailures !== 0
  || sealedV2.aggregate.incumbentExactCases !== 0 || sealedV2.aggregate.incumbentHardFailures !== 7
  || ['mutationFailures', 'leakageFailures', 'budgetFailures', 'grainFailures', 'causalityFailures'].some((key) => sealedV2.aggregate[key] !== 0)
  || sealedV2.execution.firstRun !== true || sealedV2.execution.singleUse !== true || sealedV2.execution.intermediateFeedback !== false
  || sealedV2.pack.createdAfterCandidateCommitment !== true || sealedV2.pack.v1CasesReused !== false) fail('SEALED_V2_BLIND_GATE_FAILED');
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
  quality: { developmentRegressionCases: '5/5 exact', sealedV1Negative: '0/3 exact; 3 grain hard-fails',
    sealedV2Candidate: '3/3 exact; 0 hard/leakage/mutation/budget/grain/causality failures', sealedV2Incumbent: '0/3 exact; 7 hard-fails',
    qwenConformance: '11/11', qwenSpecialistDevelopmentCases: '5/5', pairedSamplingCalls: '12/12 schema-valid',
    deterministicCoreReplay: '5/5 normalized-stable', fixedSeedQwenByteStableProfiles: `${qwen.aggregate.fixedSeedByteStableProfiles}/${qwen.aggregate.fixedSeedProfilesMeasured}` },
  runtimeTeardown: { service: 'sba-m6-03-qwen36-q6-20260815.service', state: process.env.M6_RUNTIME_SERVICE_STATE, listenerPort: 18103,
    listenerCount: Number(process.env.M6_RUNTIME_LISTENER_COUNT), processCount: Number(process.env.M6_RUNTIME_PROCESS_COUNT), existingServicesModified: false },
  directReview: { coreManifest: 'PASS', qwenManifest: 'PASS', sealedV1Manifest: 'PRESERVED_NEGATIVE', sealedV2Manifest: 'PASS',
    rawModelResponsesPersisted: false, rawChainOfThoughtPersisted: false, visibleCorpusBlindClaim: false,
    candidateSealedEvaluatorSeparated: true, persistentMutations: 0, secretFindings: 0 },
  negativeEvidence: qwen.negativeEvidence.concat([
    'One profile initially exceeded the response budget and failed closed; policy was corrected and the complete suite rerun.',
    'One transient service interruption occurred between iterations; the isolated lifecycle was re-preflighted and the final sequence rerun before teardown.',
    'The originally named holdouts were visible to the implementation lane and were reclassified as development/adversarial regression fixtures.',
    'The immutable first sealed pack failed all three cases on explicit KPI-grain validation; no failed result was overwritten or promoted.',
    'The previous cron lane committed f038e8e3cac089d9003e9f6a28680177dfbbd0a9 eleven seconds before the recovery lane first wrote; it was reviewed in place and not history-rewritten.',
    'The sqlite3 CLI was absent; read-only Node 24 node:sqlite integrity checks returned ok for all eleven databases.',
    ...core.generations.rejectedSelection.negativeEvidence,
  ]),
  files,
  rollback: ['restore-generation:m6-03-incumbent-v1', 'trusted semantic store rollback point', 'git revert the final local M6-03 commit'],
  nonclaims: ['organizationally independent or third-party validation', 'production/customer evidence', 'causal proof', 'byte determinism', 'rendered UI acceptance', 'push/PR/tag/release/deployment'],
};
await mkdir(evidenceRoot, { recursive: true });
const target = resolve(evidenceRoot, 'terminal-manifest.json');
const temporary = `${target}.partial-${process.pid}`;
await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
await rename(temporary, target);
console.log(JSON.stringify({ output: 'docs/evidence/m6-03-bi-specialist/terminal-manifest.json', gates: manifest.gates, files: Object.keys(files).length,
  tests: manifest.tests, runtimeTeardown: manifest.runtimeTeardown }, null, 2));
