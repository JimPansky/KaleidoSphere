import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { canonicalJson } from '../canonical-json.js';
import { discoverDatabase } from '../bi-specialist/progressive-discovery.mjs';
import { assertNoForbiddenPersistence, validateOrThrow } from './schema-validator.mjs';

export const GRAPH_SCHEMA_VERSION = 'chimpmaera.bi/discovery-readiness-graph/v0';
export const STATE_SCHEMA_VERSION = 'chimpmaera.bi/discovery-readiness-state/v0';
export const RECEIPT_SCHEMA_VERSION = 'chimpmaera.bi/discovery-readiness-receipt/v0';
export const EVIDENCE_PACK_SCHEMA_VERSION = 'chimpmaera.bi/discovery-readiness-evidence-pack/v0';
export const REQUIRED_BASE_COMMIT = 'e6991f4e2ce29cf798efc95edb409faeb1af4e39';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const digest = (value) => sha256(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalJson(value));
const fail = (code, details) => {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  throw error;
};

const modelBoundary = (modelMayPropose = false) => ({
  modelMayPropose,
  modelMayApprove: false,
  modelMayMutate: false,
  selfCreditDenied: true,
});

export function buildDiscoveryReadinessGraphSpec() {
  const common = {
    deterministicCredit: true,
    evidence: { required: ['receipt_hash', 'output_digest'], forbidden: ['source_rows', 'secrets', 'raw_prompts', 'chain_of_thought'] },
    retry: { maxAttempts: 1, idempotencyRequired: true, compensation: 'none' },
    onFailure: 'fail_closed',
    sideEffects: 'none',
  };
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    graphId: 'superset-bi.discovery-readiness.v0',
    graphVersion: '0.1.0',
    owners: { domain: 'superset-bi-agent', writer: 'main-cron-session', mutationAuthority: false },
    privacy: {
      dataClasses: ['metadata_only', 'no_source_rows', 'local_fixture_paths', 'hashes_and_summaries'],
      forbiddenPersistedFields: ['source_rows', 'secrets', 'raw_prompts', 'chain_of_thought', 'personal_data'],
      sourceRowsPersisted: false,
    },
    budgets: { maxWallMs: 120000, maxNodes: 32, maxRetries: 0, maxExplorationSteps: 16, maxModelTokens: 0, maxToolCalls: 0, maxPersistedBytes: 250000 },
    nodes: [
      { ...common, id: 'BI-G0_risk_preflight', gate: 'BI-G0', kind: 'deterministic', modelBoundary: modelBoundary(false),
        preconditions: ['fixture_path_local', 'read_only_required'], postconditions: ['mutation_performed_false', 'source_rows_persisted_false'], parallelSafe: false },
      { ...common, id: 'BI-G1_discovery_core', gate: 'BI-G1', kind: 'deterministic', modelBoundary: modelBoundary(false),
        preconditions: ['BI-G0_risk_preflight.complete'], postconditions: ['bounded_metadata_profiled', 'source_rows_persisted_false'], parallelSafe: true },
      { ...common, id: 'BI-G1_reference_evidence', gate: 'BI-G1', kind: 'deterministic', modelBoundary: modelBoundary(false),
        preconditions: ['BI-G0_risk_preflight.complete'], postconditions: ['m6_reference_hashes_bound'], parallelSafe: true },
      { ...common, id: 'BI-G2_readiness_assembly', gate: 'BI-G2', kind: 'model_owned_candidate', modelBoundary: modelBoundary(true),
        preconditions: ['BI-G1_discovery_core.complete', 'BI-G1_reference_evidence.complete'], postconditions: ['deterministic_readiness_verdict', 'model_self_credit_denied'], parallelSafe: false },
      { ...common, id: 'BI-G3_approval_contract', gate: 'BI-G3', kind: 'contract_only', modelBoundary: modelBoundary(false),
        preconditions: ['BI-G2_readiness_assembly.complete'], postconditions: ['approval_required_nonclaim'], parallelSafe: false },
      { ...common, id: 'BI-G4_trusted_apply_boundary', gate: 'BI-G4', kind: 'contract_only', modelBoundary: modelBoundary(false),
        preconditions: ['BI-G3_approval_contract.complete'], postconditions: ['m6_04_reference_only', 'mutation_authority_false'], parallelSafe: false },
      { ...common, id: 'BI-G5_reconciliation_boundary', gate: 'BI-G5', kind: 'contract_only', modelBoundary: modelBoundary(false),
        preconditions: ['BI-G4_trusted_apply_boundary.complete'], postconditions: ['m6_05_reference_only', 'unsafe_retry_denied'], parallelSafe: false },
      { ...common, id: 'BI-G6_cost_quality_routing', gate: 'BI-G6', kind: 'deterministic', modelBoundary: modelBoundary(false),
        preconditions: ['BI-G2_readiness_assembly.complete'], postconditions: ['routing_policy_stubbed_no_model_loaded'], parallelSafe: true },
      { ...common, id: 'BI-G7_terminal_manifest_contract', gate: 'BI-G7', kind: 'contract_only', modelBoundary: modelBoundary(false),
        preconditions: ['BI-G5_reconciliation_boundary.complete', 'BI-G6_cost_quality_routing.complete'], postconditions: ['terminal_evidence_required'], parallelSafe: false },
    ],
    edges: [
      ['BI-G0_risk_preflight', 'BI-G1_discovery_core'],
      ['BI-G0_risk_preflight', 'BI-G1_reference_evidence'],
      ['BI-G1_discovery_core', 'BI-G2_readiness_assembly'],
      ['BI-G1_reference_evidence', 'BI-G2_readiness_assembly'],
      ['BI-G2_readiness_assembly', 'BI-G3_approval_contract'],
      ['BI-G3_approval_contract', 'BI-G4_trusted_apply_boundary'],
      ['BI-G4_trusted_apply_boundary', 'BI-G5_reconciliation_boundary'],
      ['BI-G2_readiness_assembly', 'BI-G6_cost_quality_routing'],
      ['BI-G5_reconciliation_boundary', 'BI-G7_terminal_manifest_contract'],
      ['BI-G6_cost_quality_routing', 'BI-G7_terminal_manifest_contract'],
    ].map(([from, to]) => ({ from, to, guard: `${from}.complete`, onFailure: 'fail_closed' })),
    dynamicSubgraphs: [{ id: 'sealed_unknown_domain_cases', templateNodeId: 'BI-G1_discovery_core', itemSource: 'initialState.discoveryTargets', maxItems: 8, fanInNodeId: 'BI-G2_readiness_assembly', budgetGuard: 'maxExplorationSteps' }],
    migration: { fromVersions: [], strategy: 'none', failClosedOnUnknown: true },
  };
}

export async function loadSchema(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export function createInitialGraphState({ graphId = 'superset-bi.discovery-readiness.v0', runId = 'graph-pilot-local', sourceRefs = [], discoveryTargets = [] } = {}) {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    graphId,
    runId,
    status: 'created',
    sourceRefs,
    discoveryTargets,
    nodeOutputs: {},
    receipts: [],
    budgetUsage: { nodes: 0, explorationSteps: 0, modelTokens: 0, toolCalls: 0, persistedBytes: 0, mutations: 0 },
    privacy: { sourceRowsPersisted: false, secretsPersisted: false, rawPromptsPersisted: false, chainOfThoughtPersisted: false },
    verdict: { readiness: 'unknown', nonclaims: [], promotionAllowed: false },
  };
}

function dependencyMap(spec) {
  const deps = new Map(spec.nodes.map((node) => [node.id, []]));
  for (const edge of spec.edges) {
    if (!deps.has(edge.from) || !deps.has(edge.to)) fail('GRAPH_EDGE_NODE_MISSING', edge);
    deps.get(edge.to).push(edge.from);
  }
  return deps;
}

function assertAcyclic(spec) {
  const deps = dependencyMap(spec);
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) fail('GRAPH_CYCLE_DENIED', { id });
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of deps.get(id) ?? []) visit(dep);
    visiting.delete(id);
    visited.add(id);
  }
  for (const node of spec.nodes) visit(node.id);
}

export function validateGraphSpec(spec, graphSchema) {
  validateOrThrow(spec, graphSchema, 'graphSpec');
  assertAcyclic(spec);
  for (const node of spec.nodes) {
    if (node.kind !== 'contract_only' && node.modelBoundary.modelMayApprove) fail('MODEL_APPROVAL_DENIED', { nodeId: node.id });
    if (node.retry.maxAttempts > 1 && node.retry.compensation === 'none') fail('RETRY_COMPENSATION_REQUIRED', { nodeId: node.id });
  }
  return true;
}

function stableReceiptFields({ runId, nodeId, status, attempt, inputDigest, outputDigest, previousHash, evidenceRefs, budgetAfter }) {
  return { schemaVersion: RECEIPT_SCHEMA_VERSION, runId, nodeId, status, attempt, inputDigest, outputDigest, previousHash, evidenceRefs, budgetAfter };
}

function makeReceipt({ state, node, output, previousHash, started, finished }) {
  const evidenceRefs = output.evidenceRefs ?? [];
  const inputDigest = digest({ nodeId: node.id, priorOutputs: Object.keys(state.nodeOutputs).sort(), budgetBefore: state.budgetUsage });
  const outputDigest = digest(output.stable ?? output);
  const budgetAfter = structuredClone(state.budgetUsage);
  const stable = stableReceiptFields({ runId: state.runId, nodeId: node.id, status: 'complete', attempt: 1, inputDigest, outputDigest, previousHash, evidenceRefs, budgetAfter });
  const receiptHash = digest(stable);
  return {
    ...stable,
    receiptHash,
    runtimeMetrics: {
      wallTimeMs: Math.max(0, finished - started),
      tokens: output.tokens ?? 0,
      costUsd: output.costUsd ?? 0,
      cacheClass: output.cacheClass ?? 'cold-local',
      retryClass: output.retryClass ?? 'no-retry',
      escalationClass: output.escalationClass ?? 'deterministic',
      criticalPath: !node.parallelSafe,
      parallelSafe: node.parallelSafe,
    },
    stable,
  };
}

function completed(state, nodeId) {
  return Boolean(state.nodeOutputs[nodeId]);
}

function readyNodes(spec, state, deps) {
  return spec.nodes.filter((node) => !completed(state, node.id) && deps.get(node.id).every((dep) => completed(state, dep)));
}

function enforceBudgets(spec, state) {
  if (state.budgetUsage.nodes > spec.budgets.maxNodes) fail('GRAPH_NODE_BUDGET_EXCEEDED', state.budgetUsage);
  if (state.budgetUsage.explorationSteps > spec.budgets.maxExplorationSteps) fail('GRAPH_EXPLORATION_BUDGET_EXCEEDED', state.budgetUsage);
  if (state.budgetUsage.modelTokens > spec.budgets.maxModelTokens) fail('GRAPH_MODEL_TOKEN_BUDGET_EXCEEDED', state.budgetUsage);
  if (state.budgetUsage.toolCalls > spec.budgets.maxToolCalls) fail('GRAPH_TOOL_CALL_BUDGET_EXCEEDED', state.budgetUsage);
  if (state.budgetUsage.persistedBytes > spec.budgets.maxPersistedBytes) fail('GRAPH_PERSISTED_BYTE_BUDGET_EXCEEDED', state.budgetUsage);
  if (state.budgetUsage.mutations !== 0) fail('GRAPH_MUTATION_DENIED', state.budgetUsage);
}

export async function executeGraph({ spec, graphSchema, receiptSchema, initialState, handlers, pauseBefore = new Set() }) {
  validateGraphSpec(spec, graphSchema);
  const deps = dependencyMap(spec);
  const state = structuredClone(initialState);
  state.status = 'running';
  let previousHash = state.receipts.at(-1)?.receiptHash ?? 'GENESIS';
  while (state.budgetUsage.nodes < spec.nodes.length) {
    const ready = readyNodes(spec, state, deps);
    if (!ready.length) fail('GRAPH_NO_READY_NODE', { completed: Object.keys(state.nodeOutputs) });
    const safeFanout = ready.filter((node) => node.parallelSafe);
    const selected = safeFanout.length > 1 ? safeFanout.sort((a, b) => a.id.localeCompare(b.id)) : [ready.sort((a, b) => a.id.localeCompare(b.id))[0]];
    for (const node of selected) {
      if (pauseBefore.has(node.id)) {
        state.status = 'paused';
        state.pausedBefore = node.id;
        return state;
      }
      const handler = handlers[node.id] ?? contractOnlyHandler(node);
      const started = performance.now();
      const output = await handler({ state: structuredClone(state), node, spec });
      const finished = performance.now();
      assertNoForbiddenPersistence(output, spec.privacy.forbiddenPersistedFields);
      state.nodeOutputs[node.id] = output.stable ?? output;
      state.budgetUsage.nodes += 1;
      state.budgetUsage.explorationSteps += output.explorationSteps ?? 0;
      state.budgetUsage.modelTokens += output.tokens ?? 0;
      state.budgetUsage.toolCalls += output.toolCalls ?? 0;
      state.budgetUsage.persistedBytes = Buffer.byteLength(canonicalJson({ nodeOutputs: state.nodeOutputs, receipts: state.receipts.map((receipt) => receipt.stable) }));
      state.budgetUsage.mutations += output.mutations ?? 0;
      enforceBudgets(spec, state);
      const receipt = makeReceipt({ state, node, output, previousHash, started, finished });
      validateOrThrow(receipt, receiptSchema, `receipt:${node.id}`);
      state.receipts.push(receipt);
      previousHash = receipt.receiptHash;
      if (node.id === 'BI-G2_readiness_assembly') state.verdict = output.stable.verdict;
    }
  }
  state.status = 'complete';
  return state;
}

export function contractOnlyHandler(node) {
  return async () => ({
    stable: {
      nodeId: node.id,
      gate: node.gate,
      contractOnly: true,
      mutationPerformed: false,
      sourceRowsPersisted: false,
      nonclaim: `${node.gate} is mapped as contract/reference only in this local read-only pilot`,
    },
    evidenceRefs: [],
    escalationClass: 'contract-only-no-runtime',
  });
}

export function graphToMermaid(spec) {
  const lines = ['flowchart TD'];
  for (const node of spec.nodes) lines.push(`  ${node.id}[${node.gate} ${node.id.replace(/^BI-G[0-7]_/, '')}]`);
  for (const edge of spec.edges) lines.push(`  ${edge.from} -->|${edge.guard}| ${edge.to}`);
  return `${lines.join('\n')}\n`;
}

export function graphToDot(spec) {
  const lines = ['digraph superset_bi_discovery_readiness {'];
  for (const node of spec.nodes) lines.push(`  "${node.id}" [label="${node.gate} ${node.kind}"];`);
  for (const edge of spec.edges) lines.push(`  "${edge.from}" -> "${edge.to}" [label="${edge.guard}"];`);
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

export function materializeDynamicSubgraph(spec, subgraphId, items) {
  const subgraph = spec.dynamicSubgraphs.find((item) => item.id === subgraphId);
  if (!subgraph) fail('DYNAMIC_SUBGRAPH_MISSING', { subgraphId });
  if (items.length > subgraph.maxItems) fail('DYNAMIC_SUBGRAPH_BUDGET_EXCEEDED', { subgraphId, count: items.length });
  return items.map((item, index) => ({
    id: `${subgraph.templateNodeId}__${index + 1}`,
    sourceItemId: item.id,
    templateNodeId: subgraph.templateNodeId,
    fanInNodeId: subgraph.fanInNodeId,
  }));
}

export function compareReplay(firstState, replayState) {
  const first = firstState.receipts.map((receipt) => receipt.receiptHash);
  const second = replayState.receipts.map((receipt) => receipt.receiptHash);
  return {
    deterministic: first.length === second.length && first.every((hash, index) => hash === second[index]),
    first,
    second,
    rate: first.length ? first.filter((hash, index) => hash === second[index]).length / first.length : 0,
  };
}

export function buildBiHandlers({ targets, evidenceFiles, baseline }) {
  return {
    'BI-G0_risk_preflight': async () => ({
      stable: {
        mutationPerformed: false,
        sourceRowsPersisted: false,
        readOnly: true,
        targetCount: targets.length,
        deniedCapabilities: ['mutation', 'source-row-persistence', 'live-superset', 'external-model'],
      },
      evidenceRefs: targets.map((target) => target.id),
    }),
    'BI-G1_discovery_core': async () => {
      const cases = targets.map((target) => {
        const result = discoverDatabase({ databasePath: target.databasePath, objective: target.objective, maxRowsPerQuery: 48, maxQueries: 96, maxDurationMs: 5000 });
        return summarizeDiscovery(target, result);
      });
      return {
        stable: { cases, sourceRowsPersisted: false, mutationPerformed: false },
        evidenceRefs: cases.map((item) => item.caseId),
        explorationSteps: cases.length,
        escalationClass: 'deterministic-easy',
      };
    },
    'BI-G1_reference_evidence': async () => {
      const refs = [];
      for (const [id, path] of Object.entries(evidenceFiles)) refs.push({ id, path, sha256: digest(await readFile(path)), classification: 'evidence' });
      return {
        stable: {
          refs,
          boundaries: {
            m603: 'read-only discovery evidence reused without relabeling visible fixtures as blind',
            m604: 'trusted apply/readback/rollback reference only',
            m605: 'ambiguous outcome reconciliation reference only',
          },
        },
        evidenceRefs: refs.map((ref) => ref.id),
        escalationClass: 'deterministic-reference-bind',
      };
    },
    'BI-G2_readiness_assembly': async ({ state }) => {
      const cases = state.nodeOutputs['BI-G1_discovery_core'].cases;
      if (!Array.isArray(cases)) fail('DISCOVERY_CORE_OUTPUT_INVALID', { nodeId: 'BI-G1_discovery_core' });
      const ambiguityPoints = cases.reduce((sum, item) => sum + item.reviewAmbiguityPoints, 0);
      const baselineAmbiguity = baseline.reviewAmbiguityPoints;
      const reviewAmbiguityReduction = baselineAmbiguity ? (baselineAmbiguity - ambiguityPoints) / baselineAmbiguity : 0;
      const verdict = {
        readiness: cases.every((item) => item.hardFailures.length === 0) ? 'ready_for_review' : 'not_ready',
        nonclaims: [
          'read-only local fixture readiness only',
          'no production/customer/staging Superset or database evidence',
          'no mutation authority',
          'no model-loaded savings claim',
        ],
        promotionAllowed: false,
      };
      return {
        stable: {
          verdict,
          cases,
          objectiveReviewAmbiguity: { baseline: baselineAmbiguity, graph: ambiguityPoints, reduction: reviewAmbiguityReduction },
          deterministicCredit: true,
          modelSelfCreditDenied: true,
          sourceRowsPersisted: false,
          mutationPerformed: false,
        },
        evidenceRefs: cases.map((item) => item.caseId),
        escalationClass: cases.some((item) => item.reviewAmbiguityPoints > 0) ? 'strong-model-contract-stub' : 'deterministic-easy',
      };
    },
    'BI-G6_cost_quality_routing': async ({ state }) => ({
      stable: {
        policy: {
          deterministicEasy: ['risk preflight', 'schema inventory', 'bounded profiling', 'evidence hashing', 'readiness scoring'],
          strongModelEscalationStub: ['ambiguous KPI semantics', 'domain naming conflict', 'visual rationale drafting'],
          modelLoaded: false,
          savingsClaimAllowed: false,
        },
        criticalPathNodes: state.receipts.filter((receipt) => receipt.runtimeMetrics.criticalPath).map((receipt) => receipt.nodeId),
        parallelSafeNodes: state.receipts.filter((receipt) => receipt.runtimeMetrics.parallelSafe).map((receipt) => receipt.nodeId),
        cacheRetryEscalationClasses: state.receipts.map((receipt) => ({
          nodeId: receipt.nodeId,
          cacheClass: receipt.runtimeMetrics.cacheClass,
          retryClass: receipt.runtimeMetrics.retryClass,
          escalationClass: receipt.runtimeMetrics.escalationClass,
        })),
        sourceRowsPersisted: false,
        mutationPerformed: false,
      },
      evidenceRefs: ['routing-policy-stub'],
      escalationClass: 'deterministic-routing-contract',
    }),
  };
}

function summarizeDiscovery(target, result) {
  const tableCount = result.structuralInventory.length;
  const relationshipCount = result.entityProcessRelationshipGraph.length;
  const kpiCount = result.semanticKpiModel.kpis.length;
  const hardFailures = [];
  if (!result.scopePreflight.readOnly) hardFailures.push('NOT_READ_ONLY');
  if (result.trustedApplyReadbackRollback.applyPerformed) hardFailures.push('MUTATION_PERFORMED');
  if (!result.evidenceConfidenceBlindSpots.evidenceReceipts.every((receipt) => receipt.rows <= result.scopePreflight.maxRowsPerQuery)) hardFailures.push('ROW_BUDGET_EXCEEDED');
  const ambiguity = (kpiCount ? 0 : 2) + (relationshipCount ? 0 : 1) + (result.evidenceConfidenceBlindSpots.blindSpots.length ? 1 : 0);
  return {
    caseId: target.id,
    classification: target.classification,
    databaseSha256: target.databaseSha256,
    tableCount,
    relationshipCount,
    kpiCount,
    queryCount: result.budgetUsage.queries,
    rowsObservedVolatileOnly: result.budgetUsage.rowsObserved,
    sourceRowsPersisted: false,
    mutationPerformed: false,
    hardFailures,
    blindSpots: result.evidenceConfidenceBlindSpots.blindSpots,
    reviewAmbiguityPoints: ambiguity,
    resultDigest: digest({
      schemaVersion: result.schemaVersion,
      tableNames: result.structuralInventory.map((table) => table.name),
      relationships: result.entityProcessRelationshipGraph.map((item) => [item.kind, item.fromTable, item.toTable]),
      kpiIds: result.semanticKpiModel.kpis.map((item) => item.id),
      blindSpots: result.evidenceConfidenceBlindSpots.blindSpots,
    }),
  };
}

export function buildEvidencePack({ runId, state, replay, targets, baseline }) {
  const assembly = state.nodeOutputs['BI-G2_readiness_assembly'];
  const sourceRowsPersisted = assembly.cases.reduce((sum, item) => sum + (item.sourceRowsPersisted ? 1 : 0), 0);
  const mutations = state.budgetUsage.mutations;
  const privacyMutationHardFails = assembly.cases.reduce((sum, item) => sum + item.hardFailures.filter((failure) => /MUTATION|ROW|SECRET|PRIVACY/.test(failure)).length, 0);
  const assemblyTimeReduction = baseline.assemblyMinutes ? (baseline.assemblyMinutes - measuredAssemblyMinutes(state)) / baseline.assemblyMinutes : 0;
  const reviewAmbiguityReduction = assembly.objectiveReviewAmbiguity.reduction;
  const accepted = sourceRowsPersisted === 0 && mutations === 0 && privacyMutationHardFails === 0 && replay.rate === 1
    && (assemblyTimeReduction >= 0.2 || reviewAmbiguityReduction >= 0.3);
  return {
    schemaVersion: EVIDENCE_PACK_SCHEMA_VERSION,
    runId,
    graphId: state.graphId,
    baseCommit: REQUIRED_BASE_COMMIT,
    acceptance: {
      accepted,
      reason: accepted ? 'local read-only pilot acceptance thresholds met' : 'threshold not met; retain partial/negative evidence without promotion',
      sourceRowsPersisted,
      mutations,
      privacyMutationHardFails,
      deterministicReplayRate: replay.rate,
      assemblyTimeReduction,
      reviewAmbiguityReduction,
    },
    cases: targets.map((target) => ({ id: target.id, classification: target.classification, sha256: target.databaseSha256 })),
    replay,
    routing: state.nodeOutputs['BI-G6_cost_quality_routing'],
    privacy: state.privacy,
    negativeEvidence: accepted ? [] : ['PROMOTION_DENIED_UNTIL_ACCEPTANCE_THRESHOLD_MET'],
    nonclaims: state.verdict.nonclaims,
    artifacts: {
      mermaid: 'docs/evidence/graph-pilot/discovery-readiness-v0.mmd',
      dot: 'docs/evidence/graph-pilot/discovery-readiness-v0.dot',
      manifest: 'docs/evidence/graph-pilot/terminal-manifest.json',
    },
  };
}

function measuredAssemblyMinutes(state) {
  return state.receipts.reduce((sum, receipt) => sum + receipt.runtimeMetrics.wallTimeMs, 0) / 60000;
}
