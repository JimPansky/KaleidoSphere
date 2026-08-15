import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  ADAPTIVE_REQUIRED_BASE_COMMIT,
  buildAdaptiveEvidencePack,
  buildAdaptiveHandlers,
  buildAdaptiveInvestigationGraphSpec,
  compareAdaptiveReplay,
  createAdaptiveInitialState,
  digest,
  executeAdaptiveGraph,
  graphToDot,
  graphToMermaid,
  loadJson,
  validateAdaptiveGraphSpec,
} from '../services/bi-control/src/graph-pilot/bi-adaptive-investigation-graph.mjs';
import { validateOrThrow } from '../services/bi-control/src/graph-pilot/schema-validator.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const root = resolve(process.cwd());
const evidenceDir = resolve(root, 'docs/evidence/graph-adaptive-v1');
const checkOnly = process.argv.includes('--check');

const paths = {
  graphSchema: resolve(root, 'contracts/bi-adaptive-investigation-graph/v1/graph-spec.schema.json'),
  stateSchema: resolve(root, 'contracts/bi-adaptive-investigation-graph/v1/state.schema.json'),
  receiptSchema: resolve(root, 'contracts/bi-adaptive-investigation-graph/v1/receipt.schema.json'),
  evidencePackSchema: resolve(root, 'contracts/bi-adaptive-investigation-graph/v1/evidence-pack.schema.json'),
  sealedPacks: resolve(root, 'services/bi-control/fixtures/graph-adaptive-v1/sealed-neutral-packs.json'),
};

const [graphSchema, stateSchema, receiptSchema, evidencePackSchema, sealedDoc] = await Promise.all([
  loadJson(paths.graphSchema),
  loadJson(paths.stateSchema),
  loadJson(paths.receiptSchema),
  loadJson(paths.evidencePackSchema),
  loadJson(paths.sealedPacks),
]);

if (sealedDoc.privacy.sourceRowsIncluded !== false || sealedDoc.privacy.sampleValuesIncluded !== false || sealedDoc.privacy.secretsIncluded !== false) {
  throw new Error('SEALED_PACK_PRIVACY_DECLARATION_INVALID');
}

const packs = sealedDoc.packs;
if (packs.length < 3 || new Set(packs.map((pack) => pack.id)).size !== packs.length) throw new Error('SEALED_PACK_SET_INVALID');

const spec = buildAdaptiveInvestigationGraphSpec();
validateAdaptiveGraphSpec(spec, graphSchema);

const candidateFreeze = {
  schemaVersion: 'chimpmaera.bi/adaptive-investigation-candidate-freeze/v1',
  frozenBeforeSealedRun: true,
  baseCommit: ADAPTIVE_REQUIRED_BASE_COMMIT,
  modelRoute: 'offline-deterministic-fixtures',
  liveModelUsed: false,
  implementationDigest: digest({
    graphSpec: spec,
    policy: spec.adaptivePolicy,
    scorer: 'bi-adaptive-investigation-graph.mjs',
    sealedInputDigests: packs.map((pack) => ({ id: pack.id, tier: pack.tier, inputDigest: digest(pack.input) })),
  }),
  nonclaims: ['no live Qwen run', 'no production/customer generalization', 'no raw-row evidence'],
};
candidateFreeze.sha256 = digest(candidateFreeze);

const sourceRefs = [
  { id: 'graph-schema-v1', path: paths.graphSchema, sha256: sha256(await readFile(paths.graphSchema)), classification: 'contract' },
  { id: 'state-schema-v1', path: paths.stateSchema, sha256: sha256(await readFile(paths.stateSchema)), classification: 'contract' },
  { id: 'receipt-schema-v1', path: paths.receiptSchema, sha256: sha256(await readFile(paths.receiptSchema)), classification: 'contract' },
  { id: 'evidence-pack-schema-v1', path: paths.evidencePackSchema, sha256: sha256(await readFile(paths.evidencePackSchema)), classification: 'contract' },
  { id: 'sealed-neutral-packs-v1', path: paths.sealedPacks, sha256: sha256(await readFile(paths.sealedPacks)), classification: 'sealed' },
  { id: 'candidate-freeze-v1', path: 'docs/evidence/graph-adaptive-v1/candidate-freeze.json', sha256: candidateFreeze.sha256, classification: 'candidate_freeze' },
];

const initialState = createAdaptiveInitialState({
  runId: 'graph-adaptive-v1-local',
  sourceRefs,
  sealedInputs: packs.map((pack) => ({ id: pack.id, tier: pack.tier, inputDigest: digest(pack.input) })),
});
validateOrThrow(initialState, stateSchema, 'adaptiveInitialState');

const handlers = buildAdaptiveHandlers({ packs, candidateFreeze });
const paused = await executeAdaptiveGraph({
  spec,
  graphSchema,
  receiptSchema,
  initialState,
  handlers,
  pauseBefore: new Set(['BI-G4_hypothesis_graph']),
});
if (paused.status !== 'paused' || paused.pausedBefore !== 'BI-G4_hypothesis_graph') throw new Error('PAUSE_RESUME_PROBE_FAILED');

const state = await executeAdaptiveGraph({ spec, graphSchema, receiptSchema, initialState, handlers });
const replayState = await executeAdaptiveGraph({ spec, graphSchema, receiptSchema, initialState, handlers });
const replay = compareAdaptiveReplay(state, replayState);

const hashes = {
  graphSpec: digest(spec),
  terminalState: digest(state),
  sealedInputSet: digest(packs.map((pack) => ({ id: pack.id, tier: pack.tier, input: pack.input }))),
  sealedOracleSet: digest(packs.map((pack) => ({ id: pack.id, oracle: pack.hiddenOracle }))),
  candidateFreeze: candidateFreeze.sha256,
};
const pack = buildAdaptiveEvidencePack({ runId: initialState.runId, state, replay, packs, candidateFreeze, hashes });
validateOrThrow(pack, evidencePackSchema, 'adaptiveEvidencePack');

if (!checkOnly) {
  await mkdir(evidenceDir, { recursive: true });
  const artifacts = {
    'adaptive-investigation-v1.mmd': graphToMermaid(spec),
    'adaptive-investigation-v1.dot': graphToDot(spec),
    'candidate-freeze.json': `${JSON.stringify(candidateFreeze, null, 2)}\n`,
    'terminal-state.json': `${JSON.stringify(state, null, 2)}\n`,
    'terminal-manifest.json': `${JSON.stringify(pack, null, 2)}\n`,
  };
  for (const [name, body] of Object.entries(artifacts)) {
    const finalPath = resolve(evidenceDir, name);
    const tempPath = `${finalPath}.${process.pid}.tmp`;
    await writeFile(tempPath, body, { flag: 'wx' });
    await rename(tempPath, finalPath);
  }
}

process.stdout.write(`graph adaptive v1 evidence${checkOnly ? ' check' : ''}: verdict=${pack.verdict} accepted=${pack.acceptance.accepted} replay=${pack.acceptance.deterministicReplayRate} hardGain=${pack.comparison.hardTierGain} ambiguityReduction=${pack.comparison.reviewAmbiguityReduction} probes=${pack.comparison.candidateProbes} base=${ADAPTIVE_REQUIRED_BASE_COMMIT}\n`);
