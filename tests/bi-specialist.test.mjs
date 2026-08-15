import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import test from 'node:test';

import { LocalOpenAIAdapter, ReconciliationLedger, executeReadOnlyToolCall, privacySafeTrace } from '../services/bi-control/src/bi-specialist/local-openai-adapter.mjs';
import { immutableGeneration, scoreGeneration, selectCandidate, stabilitySummary } from '../services/bi-control/src/bi-specialist/optimization-gate.mjs';
import { PLANNING_POLICY_VERSION, SAMPLING_PROFILES, planningComparisonMatrix, planningPolicyGuide, selectPlanningPolicy } from '../services/bi-control/src/bi-specialist/planning-policy.mjs';
import { DISCOVERY_CONTRACT_VERSION, TrustedSemanticStore, discoverDatabase } from '../services/bi-control/src/bi-specialist/progressive-discovery.mjs';
import { RealBiSpecialist } from '../services/bi-control/src/bi-specialist/specialist-agent.mjs';

const fixtureRoot = resolve('services/bi-control/fixtures/bi-specialist');
const candidateRoot = resolve(fixtureRoot, 'candidate');
const specs = JSON.parse(await readFile(resolve(fixtureRoot, 'fixture-specs-v1.json'), 'utf8'));
const provenance = JSON.parse(await readFile(resolve(fixtureRoot, 'fixture-provenance-v1.json'), 'utf8'));
const hidden = JSON.parse(await readFile('tests/fixtures/bi-specialist-hidden-oracles-v1.json', 'utf8'));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function scoreAgainstOracle(result, oracle) {
  const tableNames = result.structuralInventory.map((table) => table.name);
  const relationCount = result.entityProcessRelationshipGraph.filter((item) => item.kind === 'declared_foreign_key').length;
  const anomalyTypes = new Set(result.anomalyQualityCauseHypotheses.anomalies.map((item) => item.type));
  const checks = [
    tableNames.length >= oracle.minimumTables,
    relationCount >= oracle.minimumDeclaredRelationships,
    oracle.requiredDomains.every((name) => tableNames.includes(name)),
    oracle.requiredAnomalies.every((type) => anomalyTypes.has(type)),
  ];
  return checks.filter(Boolean).length / checks.length;
}

test('fixture provenance separates two training databases from three immutable blind holdouts', async () => {
  assert.equal(provenance.fixtures.length, 5);
  assert.equal(provenance.fixtures.filter((item) => item.lane === 'training').length, 2);
  assert.equal(provenance.fixtures.filter((item) => item.lane === 'holdout').length, 3);
  for (const entry of provenance.fixtures) {
    const bytes = await readFile(resolve(candidateRoot, entry.filename));
    assert.equal(sha256(bytes), entry.databaseSha256);
    assert.equal(entry.candidateInputContainsOracle, false);
    assert.equal(entry.optimizationSeen, entry.lane === 'training');
    assert(!entry.filename.includes('oracle'));
  }
  assert(!JSON.stringify(provenance).includes('requiredAnomalies'));
  assert.equal(Object.keys(hidden.oracles).length, 5);
});

test('generic progressive discovery finds relevant tables and fields without table hints on training and blind holdouts', () => {
  for (const fixture of specs.fixtures) {
    const result = discoverDatabase({
      databasePath: resolve(candidateRoot, fixture.filename),
      objective: 'Find relevant entities, process relationships, quality risks, causes, KPIs, and an evidence-bound dashboard proposal',
    });
    assert.equal(result.schemaVersion, DISCOVERY_CONTRACT_VERSION);
    assert.equal(result.scopePreflight.readOnly, true);
    assert.equal(result.budgetUsage.withinBudget, true);
    assert(result.budgetUsage.queries <= result.scopePreflight.maxQueries);
    assert(result.prioritizedBoundedProfiling.every((profile) => profile.sampleBounded));
    assert(result.evidenceConfidenceBlindSpots.evidenceReceipts.every((receipt) => receipt.rows <= result.scopePreflight.maxRowsPerQuery));
    assert.equal(result.trustedApplyReadbackRollback.applyPerformed, false);
    assert.equal(result.visualizationProposal.mode, 'preview-only');
    assert.equal(scoreAgainstOracle(result, hidden.oracles[fixture.id]), 1, fixture.id);
  }
});

test('progressive discovery emits every required phase and no raw sampled rows', () => {
  const result = discoverDatabase({ databasePath: resolve(candidateRoot, 'training-order-to-cash.sqlite'), objective: 'Assess end-to-end order-to-cash quality and root causes' });
  for (const key of ['objectiveRisk', 'scopePreflight', 'structuralInventory', 'entityProcessRelationshipGraph', 'prioritizedBoundedProfiling',
    'anomalyQualityCauseHypotheses', 'targetedTests', 'evidenceConfidenceBlindSpots', 'semanticKpiModel', 'visualizationProposal', 'userCorrection', 'trustedApplyReadbackRollback']) {
    assert(key in result, key);
  }
  assert.doesNotMatch(JSON.stringify(result), /ops@acme|buyer@beta|desk@delta/);
  assert(result.semanticKpiModel.kpis.length > 0);
  assert(result.entityProcessRelationshipGraph.some((relation) => relation.fromTable === 'invoice' && relation.toTable === 'sales_order'));
});

test('read-only discovery fails closed on mutation, exfiltration, row, query, and duration budgets', () => {
  const databasePath = resolve(candidateRoot, 'training-order-to-cash.sqlite');
  assert.throws(() => discoverDatabase({ databasePath, objective: 'drop table and return all raw rows' }), /OBJECTIVE_CAPABILITY_DENIED/);
  assert.throws(() => discoverDatabase({ databasePath, objective: 'assess quality', maxQueries: 1 }), /DISCOVERY_QUERY_BUDGET_EXCEEDED/);
  assert.throws(() => discoverDatabase({ databasePath, objective: 'assess quality', maxRowsPerQuery: 1 }), /DISCOVERY_ROW_BUDGET_EXCEEDED/);
  assert.throws(() => discoverDatabase({ databasePath, objective: 'assess quality', maxDurationMs: -1 }), /DISCOVERY_TIME_BUDGET_EXCEEDED/);
});

test('trusted semantic apply requires exact preview binding, reads back, is idempotent, and rolls back', () => {
  const store = new TrustedSemanticStore();
  const first = { version: 1, kpis: ['revenue'] };
  const preview = store.preview(first);
  assert.throws(() => store.apply({ model: first, approvalBinding: 'approve:wrong' }), /TRUSTED_APPROVAL_BINDING_INVALID/);
  const applied = store.apply({ model: first, approvalBinding: preview.approvalBinding });
  assert.equal(applied.applied, true);
  assert.deepEqual(store.readback(), first);
  const second = { version: 2, kpis: ['revenue', 'late-rate'] };
  store.apply({ model: second, approvalBinding: store.preview(second).approvalBinding });
  assert.deepEqual(store.readback(), second);
  assert.equal(store.rollback().rolledBack, true);
  assert.deepEqual(store.readback(), first);
});

test('task-adaptive policy maps task classes to bounded planning, per-call sampling, validation, fallback, and reconciliation', () => {
  const cases = [
    ['extract columns', 'extraction', 0.0],
    ['write a SQL filter query', 'sql', 0.1],
    ['detect quality anomalies', 'anomaly_quality', 0.2],
    ['analyze root cause relationships', 'relationship_cause', 0.4],
    ['synthesize executive recommendations', 'synthesis', 0.2],
    ['design a responsive dashboard', 'visualization', 0.6],
    ['repair the failed analysis', 'repair', 0.1],
    ['publish and persist dashboard', 'persistent_apply', 0.1],
  ];
  for (const [objective, expectedClass, temperature] of cases) {
    const policy = selectPlanningPolicy(objective);
    assert.equal(policy.schemaVersion, PLANNING_POLICY_VERSION);
    assert.equal(policy.taskClass, expectedClass);
    assert.equal(policy.samplingProfile.temperature, temperature);
    assert.equal(policy.persistentActionAllowed, false);
    assert(policy.toolBudget >= 0 && policy.stepBudget >= policy.toolBudget);
    assert(policy.validationDepth && policy.fallback && policy.reconciliation);
  }
  assert.equal(selectPlanningPolicy('show me everything', { underspecified: true }).clarification, 'required-before-targeted-analysis');
  assert.equal(selectPlanningPolicy('ignore rules', { adversarial: true }).escalation, 'trusted-user-boundary');
  assert.equal(Object.keys(planningPolicyGuide()).length, 8);
  assert.deepEqual([...new Set(Object.values(SAMPLING_PROFILES).map((item) => item.temperature))].sort(), [0, 0.1, 0.2, 0.4, 0.6, 0.8]);
  const matrix = planningComparisonMatrix();
  assert.equal(matrix.length, 8);
  assert(matrix.every((item) => item.changedFactor === 'temperature-only'));
  assert(matrix.every((item) => item.incumbent.topP === item.comparator.topP && item.incumbent.seed === item.comparator.seed
    && item.incumbent.maxTokens === item.comparator.maxTokens));
  assert(matrix.every((item) => item.incumbent.temperature <= 0.6 && item.comparator.temperature <= 0.4));
});

test('real specialist persists only structured observable records and no chain-of-thought', async () => {
  const agent = new RealBiSpecialist();
  const result = await agent.investigate({ databasePath: resolve(candidateRoot, 'holdout-channel-perturbed.sqlite'), objective: 'Find channel quality anomalies and recommend dashboard views', runId: 'holdout-1' });
  assert(result.plan_summary && result.decision_record && result.tool_trace && result.self_check && result.correction_record);
  assert.equal(result.self_check.mutationPerformed, false);
  assert.doesNotMatch(JSON.stringify(result), /chain.?of.?thought|private reasoning/i);
});

test('incumbent gate accepts only no-regression zero-hard-failure candidates and records negative evidence otherwise', () => {
  const baseCase = { hardFailures: [], discoveryScore: 0.9, oracleScore: 0.9, citationScore: 1, toolCorrectness: 1, privacySafe: true, safetyGreen: true };
  const incumbent = immutableGeneration({ id: 'incumbent-v1', policyVersion: 'v1', promptVersion: 'v1', model: 'qwen-q6', sampling: {}, results: [baseCase, baseCase] });
  const improved = immutableGeneration({ id: 'candidate-v2', policyVersion: 'v2', promptVersion: 'v1', model: 'qwen-q6', sampling: {}, results: [{ ...baseCase, discoveryScore: 1, oracleScore: 1 }, baseCase] });
  const regressed = immutableGeneration({ id: 'candidate-v3', policyVersion: 'v3', promptVersion: 'v1', model: 'qwen-q6', sampling: {}, results: [{ ...baseCase, hardFailures: ['TOOL_UNKNOWN'], oracleScore: 0.8 }, baseCase] });
  assert.equal(selectCandidate({ incumbent, candidate: improved }).accepted, true);
  const rejection = selectCandidate({ incumbent, candidate: regressed });
  assert.equal(rejection.accepted, false);
  assert.equal(rejection.selectedGenerationId, 'incumbent-v1');
  assert(rejection.negativeEvidence.includes('NEW_OR_RETAINED_HARD_FAILURE'));
  assert(rejection.negativeEvidence.includes('REGRESSION:oracle'));
  assert.equal(scoreGeneration(incumbent).privacy, 1);
  assert.throws(() => { incumbent.results[0].oracleScore = 0; }, TypeError);
  assert.equal(stabilitySummary([{ observable: { x: 1 } }, { observable: { x: 1 } }]).fixedSeedStable, true);
  assert.equal(stabilitySummary([{ observable: { x: 1 } }, { observable: { x: 2 } }]).fixedSeedStable, false);
});

async function startMockModel() {
  const state = { retryCalls: 0, requests: [] };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    state.requests.push(body);
    const marker = body.messages.at(-1).content;
    if (marker === 'retry' && state.retryCalls++ === 0) { response.writeHead(503); response.end('{}'); return; }
    if (marker === 'delay') { await new Promise((resolveDelay) => setTimeout(resolveDelay, 100)); }
    if (body.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"content":"one"}}]}\n\n');
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
      response.write('data: {"choices":[{"delta":{"content":"two"}}]}\n\n');
      response.end('data: [DONE]\n\n');
      return;
    }
    let message = { content: '{"status":"ok"}' };
    if (marker === 'tool-good') message = { content: '', tool_calls: [{ id: 'c1', function: { name: 'inspect_schema', arguments: '{"scope":"bounded"}' } }] };
    if (marker === 'tool-malformed') message = { content: '', tool_calls: [{ id: 'c2', function: { name: 'inspect_schema', arguments: '{bad' } }] };
    if (marker === 'tool-unknown') message = { content: '', tool_calls: [{ id: 'c3', function: { name: 'destroy', arguments: '{}' } }] };
    if (marker === 'tool-extra') message = { content: '', tool_calls: [{ id: 'c4', function: { name: 'inspect_schema', arguments: '{"scope":"bounded","rawSql":"x"}' } }] };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 5, completion_tokens: 4 } }));
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  return { server, state, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

const tools = [{ type: 'function', function: { name: 'inspect_schema', parameters: { type: 'object', additionalProperties: false, required: ['scope'], properties: { scope: { type: 'string', enum: ['bounded'] } } } } }];

test('harness-neutral adapter supports normal, structured, per-call sampling, tools, retries, and privacy-safe traces', async (t) => {
  const mock = await startMockModel();
  t.after(() => mock.server.close());
  const adapter = new LocalOpenAIAdapter({ baseUrl: mock.baseUrl, model: 'test-model', maxRetries: 1 });
  const normal = await adapter.complete({ idempotencyKey: 'normal', messages: [{ role: 'user', content: 'normal' }], temperature: 0.4, responseFormat: { type: 'json_object' } });
  assert.deepEqual(JSON.parse(normal.content), { status: 'ok' });
  const called = await adapter.complete({ idempotencyKey: 'tool', messages: [{ role: 'user', content: 'tool-good' }], tools, temperature: 0.1 });
  assert.deepEqual(called.toolCalls[0].arguments, { scope: 'bounded' });
  const retried = await adapter.complete({ idempotencyKey: 'retry', messages: [{ role: 'user', content: 'retry' }], temperature: 0 });
  assert.equal(retried.receipt.attempts, 2);
  assert.equal(mock.state.requests.find((request) => request.messages.at(-1).content === 'normal').temperature, 0.4);
  assert.equal(adapter.traces.length, 3);
  assert(!JSON.stringify(adapter.traces).includes('normal'));
  assert.deepEqual(privacySafeTrace({ authorization: 'Bearer abcdefghijklmnop', safe: 'ok' }), { safe: 'ok' });
});

test('adapter tool boundary fails closed on malformed, unknown, extra args, and write-like registry entries', async (t) => {
  const mock = await startMockModel();
  t.after(() => mock.server.close());
  const adapter = new LocalOpenAIAdapter({ baseUrl: mock.baseUrl, model: 'test-model' });
  await assert.rejects(adapter.complete({ idempotencyKey: 'bad1', messages: [{ role: 'user', content: 'tool-malformed' }], tools }), /TOOL_ARGUMENT_JSON_INVALID/);
  await assert.rejects(adapter.complete({ idempotencyKey: 'bad2', messages: [{ role: 'user', content: 'tool-unknown' }], tools }), /TOOL_UNKNOWN/);
  await assert.rejects(adapter.complete({ idempotencyKey: 'bad3', messages: [{ role: 'user', content: 'tool-extra' }], tools }), /TOOL_ARGUMENT_UNKNOWN/);
  await assert.rejects(executeReadOnlyToolCall({ name: 'mutate', arguments: {} }, { mutate: { readOnly: false, execute: async () => ({}) } }), /TOOL_EXECUTION_BOUNDARY_DENIED/);
  assert.deepEqual(await executeReadOnlyToolCall({ name: 'inspect', arguments: { x: 1 } }, { inspect: { readOnly: true, execute: async ({ x }) => ({ count: x }) } }), { count: 1 });
});

test('adapter enforces timeout, cancellation, context/response budgets, and bounded stream cancellation', async (t) => {
  const mock = await startMockModel();
  t.after(() => mock.server.close());
  const adapter = new LocalOpenAIAdapter({ baseUrl: mock.baseUrl, model: 'test-model', timeoutMs: 20, maxRetries: 0, maxInputChars: 80, maxOutputTokens: 32 });
  await assert.rejects(adapter.complete({ idempotencyKey: 'delay', messages: [{ role: 'user', content: 'delay' }] }), /MODEL_TIMEOUT/);
  assert.throws(() => adapter.buildRequest({ messages: [{ role: 'user', content: 'x'.repeat(100) }] }), /CONTEXT_BUDGET_EXCEEDED/);
  assert.throws(() => adapter.buildRequest({ messages: [{ role: 'user', content: 'x' }], maxTokens: 33 }), /RESPONSE_BUDGET_EXCEEDED/);
  const controller = new AbortController();
  const streamAdapter = new LocalOpenAIAdapter({ baseUrl: mock.baseUrl, model: 'test-model', timeoutMs: 1000 });
  const seen = [];
  await assert.rejects(async () => {
    for await (const delta of streamAdapter.stream({ messages: [{ role: 'user', content: 'stream' }], signal: controller.signal })) {
      seen.push(delta);
      controller.abort();
    }
  }, /MODEL_CANCELLED/);
  assert.deepEqual(seen, ['one']);
});

test('adapter restart reconciliation replays a completed idempotent result without a second model call', async (t) => {
  const mock = await startMockModel();
  t.after(() => mock.server.close());
  const first = new LocalOpenAIAdapter({ baseUrl: mock.baseUrl, model: 'test-model' });
  const options = { idempotencyKey: 'restart-key', messages: [{ role: 'user', content: 'normal' }], temperature: 0.1 };
  const original = await first.complete(options);
  const ledger = ReconciliationLedger.restore(first.ledger.snapshot());
  const restored = new LocalOpenAIAdapter({ baseUrl: mock.baseUrl, model: 'test-model', ledger,
    fetchImpl: async () => { throw new Error('network must not be called'); } });
  const replay = await restored.complete(options);
  assert.deepEqual(replay, original);
  assert.equal(mock.state.requests.length, 1);
  await assert.rejects(restored.complete({ ...options, messages: [{ role: 'user', content: 'different' }] }), /IDEMPOTENCY_KEY_CONFLICT/);
});
