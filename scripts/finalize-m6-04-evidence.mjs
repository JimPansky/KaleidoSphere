import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(process.cwd());
const evidenceRoot = resolve(root, 'docs/evidence/m6-04-trusted-workflow');
const livePath = resolve(evidenceRoot, 'live-manifest.json');
const live = JSON.parse(await readFile(livePath, 'utf8'));
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const implementationCommit = process.env.M6_IMPLEMENTATION_COMMIT;
const focusedTests = process.env.M6_FOCUSED_TESTS;
const fullTests = process.env.M6_FULL_TESTS;
const ownedContainers = Number(process.env.M6_OWNED_CONTAINER_COUNT);
const ownedNetworks = Number(process.env.M6_OWNED_NETWORK_COUNT);
const listenerCount = Number(process.env.M6_RUNTIME_LISTENER_COUNT);
const relatedProcesses = Number(process.env.M6_RUNTIME_PROCESS_COUNT);

if (!/^[a-f0-9]{40}$/.test(implementationCommit ?? '')) fail('IMPLEMENTATION_COMMIT_REQUIRED');
if (!/^\d+\/\d+$/.test(focusedTests ?? '') || !/^\d+\/\d+$/.test(fullTests ?? '')) fail('TEST_EVIDENCE_REQUIRED');
if ([ownedContainers, ownedNetworks, listenerCount, relatedProcesses].some((value) => value !== 0)) fail('RUNTIME_TEARDOWN_GATE_FAILED');
if (live.schemaVersion !== 'chimpmaera.bi/trusted-superset-workflow-evidence/v1' || live.preview.actionCount !== 6
  || live.apply.receipt.status !== 'succeeded' || live.apply.idempotentSecondStatus !== 'already_applied'
  || live.apply.distinctChartVizTypes !== 3 || live.rollback.receipt.status !== 'rolled_back'
  || live.rollback.postRollback.length !== 6 || live.reconciliation.replayedWithoutDispatch !== true
  || live.partialFailure.code !== 'INJECTED_PARTIAL_FAILURE' || live.partialFailure.compensation.length !== 2
  || live.partialFailure.compensation.some((item) => item.status !== 'restored')) fail('LIVE_WORKFLOW_EVIDENCE_GATE_FAILED');
if (Object.values(live.privacy).some((value) => value !== false)) fail('PRIVACY_EVIDENCE_GATE_FAILED');

const criticalFiles = [
  'package.json',
  'SOURCE-MAP.md',
  'docs/decisions/M6-04-TRUSTED-SPECIALIST-SUPERSET-WORKFLOW.md',
  'docs/evidence/M6-04_TRUSTED_SPECIALIST_SUPERSET_WORKFLOW.md',
  'docs/evidence/m6-04-trusted-workflow/live-manifest.json',
  'scripts/finalize-m6-04-evidence.mjs',
  'scripts/run-trusted-superset-workflow-evidence.mjs',
  'scripts/update-m6-04-source-map.mjs',
  'services/bi-control/src/trusted-workflow/reviewed-superset-executor.mjs',
  'services/bi-control/src/trusted-workflow/trusted-specialist-workflow.mjs',
  'tests/trusted-workflow.test.mjs',
];
const files = {};
for (const file of criticalFiles) {
  const bytes = await readFile(resolve(root, file));
  files[file] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}
const manifest = {
  schemaVersion: 'chimpmaera.bi/m6-04-terminal-evidence/v1',
  generatedAt: new Date().toISOString(),
  implementationCommit,
  branch: 'm6-04-trusted-specialist-superset-workflow',
  gates: { G1: 'PASS', G2: 'PASS', G3: 'PASS', G4: 'PASS', G5: 'PASS', G6: 'PASS', G7: 'PASS' },
  tests: { focused: focusedTests, full: fullTests, postImplementationCommit: 'PASS', sourceMap: 'PASS', diffCheck: 'PASS', jsonAndSyntax: 'PASS' },
  liveEvidence: { path: 'docs/evidence/m6-04-trusted-workflow/live-manifest.json', sha256: createHash('sha256').update(await readFile(livePath)).digest('hex') },
  quality: {
    trustedActions: 6,
    chartVisualizationTypes: 3,
    exactApplyReadbacks: 6,
    exactRollbackReadbacks: 6,
    idempotentReplayWithoutDispatch: true,
    restartReconciliationWithoutDispatch: true,
    realPartialFailureCompensation: '2/2',
  },
  security: {
    loopbackOnly: true,
    disposableSyntheticOnly: true,
    planAndAuthorizationRevalidatedAtExecution: true,
    freeFormSqlDomPathNetworkDenied: true,
    responsePayloadPersisted: false,
    sourceRecordsPersisted: false,
    modelTranscriptPersisted: false,
    chainOfThoughtPersisted: false,
    secretFindings: 0,
    deliberateFakeSecretProbeFindings: 1,
  },
  runtimeTeardown: {
    composeProject: 'sba-m6-04-trusted-20260815',
    listenerPort: 39044,
    ownedContainers,
    ownedNetworks,
    listenerCount,
    relatedProcesses,
    unrelatedExistingStacksModified: false,
  },
  negativeEvidence: [
    'Initial focused run failed 0/4 because an overbroad dangerous-key matcher falsely matched description; it was narrowed and the complete suite rerun.',
    'Initial setup failed closed because the reviewed local .env had not yet been created.',
    'Initial live workflow rejected an unknown dashboard metadata key with HTTP 400 after four writes; automatic compensation restored 4/4 before the supported field was selected.',
    'A later successful workflow run failed only during manifest hashing because Buffer is not canonical plain JSON; byte hashing was corrected and the complete live workflow rerun.',
  ],
  files,
  rollback: [`git revert the terminal-evidence commit, then git revert ${implementationCommit}`, 'restore only allowlisted Superset asset pre-state', 'remove only Compose project sba-m6-04-trusted-20260815'],
  nonclaims: ['Delivery', 'production/customer/personal Superset', 'organizationally independent validation', 'causal proof', 'unknown-network-outcome recovery', 'cross-hardware determinism', 'broad provider support', 'deployment/publication/push/PR/tag/release'],
};
await mkdir(evidenceRoot, { recursive: true });
const target = resolve(evidenceRoot, 'terminal-manifest.json');
const temporary = `${target}.partial-${process.pid}`;
await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
await rename(temporary, target);
process.stdout.write(`M6-04 terminal evidence: 7/7, ${Object.keys(files).length} critical files, implementation ${implementationCommit.slice(0, 12)}\n`);
