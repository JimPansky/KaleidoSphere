import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { LocalOpenAIAdapter, ReconciliationLedger, privacySafeTrace } from '../services/bi-control/src/bi-specialist/local-openai-adapter.mjs';
import { SAMPLING_PROFILES } from '../services/bi-control/src/bi-specialist/planning-policy.mjs';
import { RealBiSpecialist } from '../services/bi-control/src/bi-specialist/specialist-agent.mjs';

const baseUrl = process.env.M6_QWEN_BASE_URL ?? 'http://127.0.0.1:18103/v1';
const model = process.env.M6_QWEN_MODEL ?? 'Qwen3.6-28B-REAP20-A3B-Q6_K.gguf';
const evidenceRoot = resolve('docs/evidence/m6-03-bi-specialist');
const sha256 = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const observations = [];
const record = (id, passed, details = {}) => observations.push({ id, passed, ...privacySafeTrace(details) });

async function atomicJson(path, value) {
  const temporary = `${path}.partial-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, path);
}

const modelsResponse = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(5_000) });
const models = await modelsResponse.json();
record('models-endpoint', modelsResponse.ok && Array.isArray(models.data), { count: models.data?.length ?? 0, ids: models.data?.map((item) => item.id).slice(0, 4) });

const adapter = new LocalOpenAIAdapter({ baseUrl, model, timeoutMs: 20_000, maxRetries: 1, maxInputChars: 24_000, maxOutputTokens: 1024 });
const normal = await adapter.complete({ idempotencyKey: 'm6-live-normal', messages: [{ role: 'user', content: 'Reply with exactly the word READY.' }],
  ...SAMPLING_PROFILES.precise_tool_v1, maxTokens: 32 });
record('normal-response', /READY/i.test(normal.content), { contentDigest: sha256(normal.content), outputChars: normal.content.length, receipt: normal.receipt });

const structured = await adapter.complete({ idempotencyKey: 'm6-live-json', messages: [
  { role: 'system', content: 'Return a JSON object only. Do not include reasoning.' },
  { role: 'user', content: 'Return status=ok, confidence=0.8, and blind_spots as an empty array.' },
], ...SAMPLING_PROFILES.deterministic_extract_v1, maxTokens: 128, responseFormat: { type: 'json_object' } });
let structuredParsed = null;
try { structuredParsed = JSON.parse(structured.content); } catch {}
record('structured-output', structuredParsed?.status === 'ok' && Array.isArray(structuredParsed?.blind_spots), { contentDigest: sha256(structured.content), keys: Object.keys(structuredParsed ?? {}).sort() });

const tool = { type: 'function', function: { name: 'inspect_schema', description: 'Read bounded structural metadata.', parameters: { type: 'object', additionalProperties: false,
  required: ['scope'], properties: { scope: { type: 'string', enum: ['bounded'] } } } } };
const toolResult = await adapter.complete({ idempotencyKey: 'm6-live-tool', messages: [{ role: 'user', content: 'Use inspect_schema with scope bounded. Do not answer directly.' }],
  tools: [tool], toolChoice: { type: 'function', function: { name: 'inspect_schema' } }, ...SAMPLING_PROFILES.precise_tool_v1, maxTokens: 128 });
record('tool-call-parsing', toolResult.toolCalls.length === 1 && toolResult.toolCalls[0].name === 'inspect_schema' && toolResult.toolCalls[0].arguments.scope === 'bounded',
  { toolCallCount: toolResult.toolCalls.length, toolNames: toolResult.toolCalls.map((item) => item.name) });

let timeoutCode = null;
try {
  const timeoutAdapter = new LocalOpenAIAdapter({ baseUrl, model, timeoutMs: 1, maxRetries: 0 });
  await timeoutAdapter.complete({ idempotencyKey: 'm6-live-timeout', messages: [{ role: 'user', content: 'Write a 100 word bounded summary.' }], maxTokens: 256 });
} catch (error) { timeoutCode = error.code; }
record('timeout', timeoutCode === 'MODEL_TIMEOUT', { code: timeoutCode });

let cancelCode = null;
let streamDeltas = 0;
const controller = new AbortController();
try {
  for await (const delta of adapter.stream({ messages: [{ role: 'user', content: 'Count from one to twenty slowly, words only.' }], maxTokens: 128, signal: controller.signal })) {
    if (delta) streamDeltas += 1;
    controller.abort();
  }
} catch (error) { cancelCode = error.code; }
record('streaming-cancel', streamDeltas >= 1 && cancelCode === 'MODEL_CANCELLED', { streamDeltas, code: cancelCode });

const reconciliationOptions = { idempotencyKey: 'm6-live-reconcile', messages: [{ role: 'user', content: 'Reply with RECORDED.' }], temperature: 0, maxTokens: 32 };
const firstReconcile = await adapter.complete(reconciliationOptions);
const restored = new LocalOpenAIAdapter({ baseUrl, model, ledger: ReconciliationLedger.restore(adapter.ledger.snapshot()),
  fetchImpl: async () => { throw new Error('RESTART_REPLAY_MUST_NOT_CALL_PROVIDER'); } });
const secondReconcile = await restored.complete(reconciliationOptions);
record('restart-reconciliation-idempotency', JSON.stringify(firstReconcile) === JSON.stringify(secondReconcile), { receipt: secondReconcile.receipt });

let contextCode = null;
let responseCode = null;
try { adapter.buildRequest({ messages: [{ role: 'user', content: 'x'.repeat(24_100) }] }); } catch (error) { contextCode = error.code; }
try { adapter.buildRequest({ messages: [{ role: 'user', content: 'x' }], maxTokens: 1025 }); } catch (error) { responseCode = error.code; }
record('context-response-budgets', contextCode === 'CONTEXT_BUDGET_EXCEEDED' && responseCode === 'RESPONSE_BUDGET_EXCEEDED', { contextCode, responseCode });

const pairedPrompt = [
  { role: 'system', content: 'Return JSON only with keys task, evidence_rule, confidence, blind_spots. No reasoning.' },
  { role: 'user', content: 'Given bounded aggregate evidence that late deliveries increased, propose one non-causal diagnostic next step.' },
];
const profiles = [
  { profileId: 'temperature-ablation-0.0', taskClass: 'deterministic-extraction', temperature: 0.0 },
  { profileId: 'temperature-ablation-0.1', taskClass: 'sql-and-repair', temperature: 0.1 },
  { profileId: 'temperature-ablation-0.2', taskClass: 'anomaly-quality', temperature: 0.2 },
  { profileId: 'temperature-ablation-0.4', taskClass: 'relationship-cause', temperature: 0.4 },
  { profileId: 'temperature-ablation-0.6', taskClass: 'visual-preview', temperature: 0.6 },
  { profileId: 'temperature-ablation-0.8', taskClass: 'visual-preview-high-comparator', temperature: 0.8 },
];
const samplingMatrix = [];
for (const matrixProfile of profiles) {
  for (let repeat = 1; repeat <= 2; repeat += 1) {
    const sampling = { temperature: matrixProfile.temperature, topP: 0.95, seed: 7, maxTokens: 256 };
    const result = await adapter.complete({ idempotencyKey: `m6-matrix-${matrixProfile.profileId}-${repeat}`, messages: pairedPrompt, ...sampling,
      responseFormat: { type: 'json_object' } });
    let parsed = null;
    try { parsed = JSON.parse(result.content); } catch {}
    samplingMatrix.push({ profileId: matrixProfile.profileId, taskClass: matrixProfile.taskClass, repeat, sampling,
      validJson: parsed !== null, requiredKeys: ['task', 'evidence_rule', 'confidence', 'blind_spots'].every((key) => parsed && key in parsed),
      outputDigest: sha256(result.content), outputChars: result.content.length, receipt: result.receipt });
  }
}
record('paired-sampling-matrix', samplingMatrix.length === profiles.length * 2 && samplingMatrix.every((item) => item.validJson && item.requiredKeys),
  { calls: samplingMatrix.length, temperatures: [...new Set(samplingMatrix.map((item) => item.sampling.temperature))] });

const fixtureRoot = resolve('services/bi-control/fixtures/bi-specialist');
const specs = JSON.parse(await readFile(resolve(fixtureRoot, 'fixture-specs-v1.json'), 'utf8'));
const specialist = new RealBiSpecialist({ adapter });
const specialistCases = [];
for (const fixture of specs.fixtures) {
  const objective = fixture.id.includes('production') ? 'Analyze root cause relationships behind production quality and cost anomalies'
    : fixture.id.includes('channel') ? 'Design an evidence-bound channel 360 dashboard preview'
      : fixture.id.includes('clinical') ? 'Detect data quality anomalies and summarize bounded evidence'
        : fixture.id.includes('underspecified') ? 'Help me understand what matters here'
          : 'Assess order-to-cash anomalies and produce an evidence-bound executive synthesis';
  let result = null;
  let errorCode = null;
  try {
    result = await specialist.investigate({ databasePath: resolve(fixtureRoot, 'candidate', fixture.filename), objective,
      underspecified: fixture.id.includes('underspecified'), modelSynthesis: true, runId: `qwen-${fixture.id}` });
  } catch (error) { errorCode = error.code ?? error.message; }
  const observable = result?.synthesis?.observable;
  const knownTables = new Set(result?.discovery?.structuralInventory?.map((table) => table.name) ?? []);
  const groundedTables = Array.isArray(observable?.evidence_tables) && observable.evidence_tables.every((table) => knownTables.has(table));
  const schemaValid = typeof observable?.summary === 'string' && groundedTables
    && typeof observable?.confidence === 'number' && observable.confidence >= 0 && observable.confidence <= 1
    && Array.isArray(observable?.blind_spots) && observable?.persistence_proposed === false;
  specialistCases.push({ id: fixture.id, lane: fixture.lane, taskClass: result?.plan_summary?.taskClass ?? null,
    sampling: result?.decision_record?.samplingProfile ?? null, schemaValid, groundedTables, errorCode,
    outputDigest: observable ? sha256(JSON.stringify(observable)) : null,
    discoveredTables: knownTables.size, evidenceTableCount: observable?.evidence_tables?.length ?? 0,
    mutationPerformed: result?.self_check?.mutationPerformed ?? null });
}
record('qwen-specialist-training-and-blind-holdouts', specialistCases.length === 5
  && specialistCases.every((item) => item.schemaValid && item.groundedTables && item.mutationPerformed === false),
{ cases: specialistCases.length, training: specialistCases.filter((item) => item.lane === 'training').length,
  holdout: specialistCases.filter((item) => item.lane === 'holdout').length,
  failures: specialistCases.filter((item) => !item.schemaValid || !item.groundedTables).map((item) => item.id) });

record('privacy-safe-trace-schema', adapter.traces.every((trace) => !('messages' in trace) && !('content' in trace)), { traceCount: adapter.traces.length, fields: Object.keys(adapter.traces[0] ?? {}).sort() });

const manifest = {
  schemaVersion: 'chimpmaera.bi/m6-03-qwen-conformance/v1',
  generatedAt: new Date().toISOString(),
  provider: { endpoint: baseUrl, loopbackOnly: true, model, quantization: 'Q6_K', reasoningPersisted: false,
    binaryPath: '/mnt/data2/ai/llama.cpp/llama-b8929/llama-server', binarySha256: '96b71dd5794723b8812e559e39657e3cb1acfb699ebe52938717c32143212b04',
    modelPath: '/mnt/data2/ai/gguf-models/qwen3.6-28b-reap20-a3b/Qwen3.6-28B-REAP20-A3B-Q6_K.gguf', modelSha256: '62cecf9785ea5d13c9a59b46c3c5a61eb629c2b6fe40e5a991beb4b0a11fcbe3',
    config: { host: '127.0.0.1', port: 18103, ctxSize: 16384, parallel: 1, jinja: true, reasoning: 'off', reasoningBudget: 0, gpuLayers: 99, threads: 8 },
    service: 'sba-m6-03-qwen36-q6-20260815.service' },
  observations,
  samplingMatrix,
  specialistCases,
  safeTraces: adapter.traces,
  aggregate: { checks: observations.length, passed: observations.filter((item) => item.passed).length, failed: observations.filter((item) => !item.passed).map((item) => item.id),
    fixedSeedByteStableProfiles: profiles.filter(({ profileId }) => new Set(samplingMatrix.filter((item) => item.profileId === profileId).map((item) => item.outputDigest)).size === 1).length,
    fixedSeedProfilesMeasured: profiles.length },
  boundaryEvidence: { malformedUnknownArgsAndBoundedRetries: 'tests/bi-specialist.test.mjs', executionBoundary: 'read-only allowlisted tool registry', noHarnessDependency: true },
  negativeEvidence: ['Fixed-seed Qwen outputs were schema-stable but not byte-identical for every measured profile; do not claim runtime determinism.'],
  nonclaims: ['No full model determinism claim', 'No Q5 default or silent downgrade', 'No production/provider support claim', 'No raw reasoning evidence'],
};
await mkdir(evidenceRoot, { recursive: true });
await atomicJson(resolve(evidenceRoot, 'qwen-conformance-manifest.json'), manifest);
console.log(JSON.stringify({ output: 'docs/evidence/m6-03-bi-specialist/qwen-conformance-manifest.json', aggregate: manifest.aggregate,
  samplingProfiles: samplingMatrix.map((item) => `${item.profileId}:${item.repeat}`) }, null, 2));
if (manifest.aggregate.failed.length) process.exitCode = 2;
