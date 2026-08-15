import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  buildBiHandlers,
  buildDiscoveryReadinessGraphSpec,
  buildEvidencePack,
  compareReplay,
  createInitialGraphState,
  executeGraph,
  graphToDot,
  graphToMermaid,
  loadSchema,
  materializeDynamicSubgraph,
  validateGraphSpec,
} from '../services/bi-control/src/graph-pilot/bi-discovery-readiness-graph.mjs';
import { validateOrThrow } from '../services/bi-control/src/graph-pilot/schema-validator.mjs';

const graphSchema = await loadSchema(resolve('contracts/bi-discovery-readiness-graph/v0/graph-spec.schema.json'));
const stateSchema = await loadSchema(resolve('contracts/bi-discovery-readiness-graph/v0/state.schema.json'));
const receiptSchema = await loadSchema(resolve('contracts/bi-discovery-readiness-graph/v0/receipt.schema.json'));
const evidencePackSchema = await loadSchema(resolve('contracts/bi-discovery-readiness-graph/v0/evidence-pack.schema.json'));

test('framework-neutral graph contract validates and fails closed on mutation authority, cycles, and schema drift', () => {
  const spec = buildDiscoveryReadinessGraphSpec();
  assert.equal(validateGraphSpec(spec, graphSchema), true);
  assert.throws(() => validateGraphSpec({ ...spec, owners: { ...spec.owners, mutationAuthority: true } }, graphSchema), /SCHEMA_VALIDATION_FAILED/);
  assert.throws(() => validateGraphSpec({ ...spec, extra: true }, graphSchema), /SCHEMA_VALIDATION_FAILED/);
  const cyclic = { ...spec, edges: [...spec.edges, { from: 'BI-G7_terminal_manifest_contract', to: 'BI-G0_risk_preflight', guard: 'bad', onFailure: 'fail_closed' }] };
  assert.throws(() => validateGraphSpec(cyclic, graphSchema), /GRAPH_CYCLE_DENIED/);
});

test('state, receipt, evidence, budget, provenance, approval, retry and boundary fields are versioned in schemas', () => {
  const specText = JSON.stringify(graphSchema);
  for (const token of ['budgets', 'dynamicSubgraphs', 'migration', 'modelMayApprove', 'modelMayMutate', 'idempotencyRequired', 'compensation']) assert.match(specText, new RegExp(token));
  assert.match(JSON.stringify(stateSchema), /sourceRowsPersisted/);
  assert.match(JSON.stringify(receiptSchema), /runtimeMetrics/);
  assert.match(JSON.stringify(evidencePackSchema), /deterministicReplayRate/);
});

test('deterministic runner hash-chains receipts, supports pause resume, and renders Mermaid/DOT', async () => {
  const spec = buildDiscoveryReadinessGraphSpec();
  const targets = [{
    id: 'known_schema_order_to_cash',
    classification: 'fixture_visible',
    databasePath: resolve('services/bi-control/fixtures/bi-specialist/candidate/training-order-to-cash.sqlite'),
    objective: 'Assess known order-to-cash KPIs',
    databaseSha256: 'test-digest',
  }];
  const baseline = { assemblyMinutes: 30, reviewAmbiguityPoints: 6 };
  const evidenceFiles = { 'm6-03': resolve('docs/evidence/m6-03-bi-specialist/terminal-manifest.json') };
  const initialState = createInitialGraphState({ runId: 'test-run', sourceRefs: [], discoveryTargets: targets });
  validateOrThrow(initialState, stateSchema, 'state');
  const handlers = buildBiHandlers({ targets, evidenceFiles, baseline });
  const paused = await executeGraph({ spec, graphSchema, receiptSchema, initialState, handlers, pauseBefore: new Set(['BI-G2_readiness_assembly']) });
  assert.equal(paused.status, 'paused');
  assert.equal(paused.pausedBefore, 'BI-G2_readiness_assembly');
  const completed = await executeGraph({ spec, graphSchema, receiptSchema, initialState, handlers });
  const replay = await executeGraph({ spec, graphSchema, receiptSchema, initialState, handlers });
  assert.equal(compareReplay(completed, replay).deterministic, true);
  assert.equal(completed.status, 'complete');
  assert(completed.receipts.every((receipt) => receipt.previousHash === 'GENESIS' || /^[a-f0-9]{64}$/.test(receipt.previousHash)));
  assert(completed.receipts.every((receipt) => receipt.runtimeMetrics.wallTimeMs === 0));
  assert.deepEqual(completed, replay);
  assert.match(graphToMermaid(spec), /flowchart TD/);
  assert.match(graphToDot(spec), /digraph/);
});

test('BI mapping executes BI-G0 through BI-G2 read-only and maps BI-G3 through BI-G7 as nonclaims', async () => {
  const spec = buildDiscoveryReadinessGraphSpec();
  const targets = [{
    id: 'ambiguous_grain_adversarial',
    classification: 'fixture_visible',
    databasePath: resolve('services/bi-control/fixtures/bi-specialist/candidate/holdout-underspecified-adversarial.sqlite'),
    objective: 'Assess ambiguous grain and deny false readiness where semantics are underspecified',
    databaseSha256: 'test-digest',
  }];
  const baseline = { assemblyMinutes: 30, reviewAmbiguityPoints: 6 };
  const evidenceFiles = {
    'm6-03': resolve('docs/evidence/m6-03-bi-specialist/terminal-manifest.json'),
    'm6-04': resolve('docs/evidence/m6-04-trusted-workflow/terminal-manifest.json'),
    'm6-05': resolve('docs/evidence/m6-05-ambiguous-outcome-reconciliation/terminal-manifest.json'),
  };
  const initialState = createInitialGraphState({ runId: 'mapping-test', discoveryTargets: targets });
  const state = await executeGraph({ spec, graphSchema, receiptSchema, initialState, handlers: buildBiHandlers({ targets, evidenceFiles, baseline }) });
  assert.equal(state.nodeOutputs['BI-G0_risk_preflight'].mutationPerformed, false);
  assert.equal(state.nodeOutputs['BI-G1_discovery_core'].sourceRowsPersisted, false);
  assert.equal(state.nodeOutputs['BI-G2_readiness_assembly'].modelSelfCreditDenied, true);
  for (const id of ['BI-G3_approval_contract', 'BI-G4_trusted_apply_boundary', 'BI-G5_reconciliation_boundary', 'BI-G7_terminal_manifest_contract']) {
    assert.equal(state.nodeOutputs[id].contractOnly, true);
    assert.match(state.nodeOutputs[id].nonclaim, /contract/);
  }
});

test('negative probes fail closed for injection, leakage, stale receipt, tamper, budget, retry and false readiness risks', async () => {
  const spec = buildDiscoveryReadinessGraphSpec();
  const targets = [{
    id: 'known',
    classification: 'fixture_visible',
    databasePath: resolve('services/bi-control/fixtures/bi-specialist/candidate/training-order-to-cash.sqlite'),
    objective: 'Assess known schema',
    databaseSha256: 'test-digest',
  }];
  const initialState = createInitialGraphState({ runId: 'negative-test', discoveryTargets: targets });
  const handlers = buildBiHandlers({ targets, evidenceFiles: {}, baseline: { assemblyMinutes: 30, reviewAmbiguityPoints: 6 } });
  await assert.rejects(executeGraph({ spec: { ...spec, budgets: { ...spec.budgets, maxNodes: 1 } }, graphSchema, receiptSchema, initialState, handlers }), /GRAPH_NODE_BUDGET_EXCEEDED/);
  await assert.rejects(executeGraph({ spec: { ...spec, budgets: { ...spec.budgets, maxExplorationSteps: 0 } }, graphSchema, receiptSchema, initialState, handlers }), /SCHEMA_VALIDATION_FAILED/);
  await assert.rejects(executeGraph({ spec, graphSchema, receiptSchema, initialState, handlers: { ...handlers, 'BI-G1_discovery_core': async () => ({ stable: { source_rows: [{ secret: 'raw source row' }] } }) } }), /FORBIDDEN_PERSISTED_FIELD/);
  await assert.rejects(executeGraph({ spec, graphSchema, receiptSchema, initialState, handlers: { ...handlers, 'BI-G1_discovery_core': async () => ({ stable: { mutationPerformed: false, note: 'Bearer abcdefghijklmnop' } }) } }), /FORBIDDEN_PERSISTED_VALUE/);
  const nonIdempotent = { ...spec, nodes: spec.nodes.map((node) => node.id === 'BI-G1_discovery_core' ? { ...node, retry: { ...node.retry, maxAttempts: 2, compensation: 'none' } } : node) };
  assert.throws(() => validateGraphSpec(nonIdempotent, graphSchema), /RETRY_COMPENSATION_REQUIRED/);
  const state = await executeGraph({ spec, graphSchema, receiptSchema, initialState, handlers });
  const tampered = structuredClone(state);
  tampered.receipts[1].receiptHash = '0'.repeat(64);
  assert.equal(compareReplay(state, tampered).deterministic, false);
  assert(state.nodeOutputs['BI-G2_readiness_assembly'].verdict.promotionAllowed === false);
});

test('dynamic subgraph materialization supports sealed unknown-domain case fan-in within budget', () => {
  const spec = buildDiscoveryReadinessGraphSpec();
  const materialized = materializeDynamicSubgraph(spec, 'sealed_unknown_domain_cases', [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  assert.deepEqual(materialized.map((item) => item.fanInNodeId), ['BI-G2_readiness_assembly', 'BI-G2_readiness_assembly', 'BI-G2_readiness_assembly']);
  assert.throws(() => materializeDynamicSubgraph(spec, 'sealed_unknown_domain_cases', Array.from({ length: 9 }, (_, index) => ({ id: String(index) }))), /DYNAMIC_SUBGRAPH_BUDGET_EXCEEDED/);
});

test('terminal graph evidence covers six cases including three sealed unknown-domain fixtures with replay and no mutation', async () => {
  const manifestText = await readFile('docs/evidence/graph-pilot/terminal-manifest.json', 'utf8');
  const manifest = JSON.parse(manifestText);
  const terminalState = JSON.parse(await readFile('docs/evidence/graph-pilot/terminal-state.json', 'utf8'));
  validateOrThrow(manifest, evidencePackSchema, 'terminalManifest');
  assert.equal(manifest.cases.length, 6);
  assert.equal(manifest.cases.filter((item) => item.classification === 'sealed').length, 3);
  assert.equal(manifest.acceptance.sourceRowsPersisted, 0);
  assert.equal(manifest.acceptance.mutations, 0);
  assert.equal(manifest.acceptance.privacyMutationHardFails, 0);
  assert.equal(manifest.acceptance.deterministicReplayRate, 1);
  assert(manifest.acceptance.assemblyTimeReduction >= 0.2 || manifest.acceptance.reviewAmbiguityReduction >= 0.3 || manifest.acceptance.accepted === false);
  assert.equal(manifest.nonclaims.includes('no mutation authority'), true);
  assert(terminalState.sourceRefs.every((ref) => !ref.path.startsWith('/')));
  assert(terminalState.sourceRefs.every((ref) => ref.path.includes('/') && !ref.path.includes('..')));
  assert(terminalState.nodeOutputs['BI-G1_reference_evidence'].refs.every((ref) => !ref.path.startsWith('/')));
  assert(terminalState.receipts.every((receipt) => receipt.runtimeMetrics.wallTimeMs === 0));
});

test('evidence pack builder refuses promotion when objective acceptance thresholds are missed', () => {
  const state = createInitialGraphState({ runId: 'threshold-negative' });
  state.status = 'complete';
  state.nodeOutputs['BI-G2_readiness_assembly'] = {
    cases: [{ sourceRowsPersisted: false, hardFailures: [], reviewAmbiguityPoints: 5 }],
    objectiveReviewAmbiguity: { baseline: 6, graph: 5, reduction: 1 / 6 },
  };
  state.nodeOutputs['BI-G6_cost_quality_routing'] = { policy: { modelLoaded: false } };
  state.verdict.nonclaims = ['threshold-test'];
  const pack = buildEvidencePack({ runId: 'threshold-negative', state, replay: { rate: 1 }, targets: [], baseline: { assemblyMinutes: 0, reviewAmbiguityPoints: 6 } });
  assert.equal(pack.acceptance.accepted, false);
  assert(pack.negativeEvidence.includes('PROMOTION_DENIED_UNTIL_ACCEPTANCE_THRESHOLD_MET'));
});
