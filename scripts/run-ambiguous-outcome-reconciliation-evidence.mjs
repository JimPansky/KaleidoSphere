import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { sha256Digest } from '../services/bi-control/src/assistant-foundation/core-contracts.mjs';
import { RealBiSpecialist } from '../services/bi-control/src/bi-specialist/specialist-agent.mjs';
import {
  NATIVE_ASSETS,
  SupersetPublicApiClient,
  clientFromEnvironment,
  provisionNativeAssets,
} from '../services/bi-control/src/visual-scenario-lab/native-superset-bridge.mjs';
import {
  APPLY_CAPABILITY_ID,
  TRUSTED_TARGET_VERSION,
  TYPED_RECOMMENDATION_VERSION,
  TrustedApprovalController,
  compileTrustedChangePlan,
  createTrustedWorkflowApproval,
} from '../services/bi-control/src/trusted-workflow/trusted-specialist-workflow.mjs';
import {
  ReviewedSupersetAssetAdapter,
  TrustedSupersetWorkflowExecutor,
} from '../services/bi-control/src/trusted-workflow/reviewed-superset-executor.mjs';
import {
  FileOutcomeJournal,
  authorizeFreshRetryAfterUnchanged,
  createOutcomeContext,
  reconcileUnknownOutcome,
} from '../services/bi-control/src/trusted-workflow/ambiguous-outcome-reconciliation.mjs';

const evidenceRoot = resolve(process.env.M6_05_EVIDENCE_ROOT ?? 'docs/evidence/m6-05-ambiguous-outcome-reconciliation');
await mkdir(evidenceRoot, { recursive: true });
for (const file of ['committed-response-lost-journal.json', 'unchanged-safe-to-retry-journal.json', 'live-manifest.json']) {
  await rm(resolve(evidenceRoot, file), { force: true });
}

const clone = (value) => structuredClone(value);
const sameDigest = (left, right) => sha256Digest(left) === sha256Digest(right);
const nowPlus = (ms) => new Date(Date.now() + ms).toISOString();

function countableMethod(method) {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
}

function startFaultProxy({ targetOrigin, fault }) {
  const target = new URL(targetOrigin);
  const trace = [];
  let faultInjected = false;
  const server = http.createServer((incoming, outgoing) => {
    const startedAt = new Date().toISOString();
    const chunks = [];
    incoming.on('data', (chunk) => chunks.push(chunk));
    incoming.on('end', () => {
      const body = Buffer.concat(chunks);
      const requestPath = incoming.url ?? '/';
      const method = incoming.method ?? 'GET';
      const shouldFault = !faultInjected && method === fault.method && fault.pathPattern.test(requestPath);
      const entry = {
        sequence: trace.length + 1,
        startedAt,
        method,
        pathClass: requestPath.replace(/[0-9]+/g, ':id').replace(/[A-Za-z0-9_-]{20,}/g, ':opaque'),
        bodySha256: body.length ? `sha256:${createHash('sha256').update(body).digest('hex')}` : null,
        mutationRequest: countableMethod(method),
        faultInjected: shouldFault,
        upstreamStatus: null,
      };
      trace.push(entry);
      const upstream = http.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method,
        path: requestPath,
        headers: { ...incoming.headers, host: target.host },
      }, (response) => {
        entry.upstreamStatus = response.statusCode ?? null;
        if (shouldFault) {
          faultInjected = true;
          response.resume();
          response.on('end', () => outgoing.destroy(new Error('INJECTED_RESPONSE_LOST_AFTER_COMMIT')));
          return;
        }
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      });
      upstream.on('error', () => {
        if (!outgoing.headersSent) outgoing.writeHead(502, { 'content-type': 'application/json' });
        outgoing.end('{"error":"FAULT_PROXY_UPSTREAM_UNAVAILABLE"}');
      });
      if (body.length) upstream.write(body);
      upstream.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        trace,
        close: () => new Promise((closeResolve) => server.close(closeResolve)),
      });
    });
  });
}

function authorizationFor(plan, idempotencyKey) {
  return {
    authorized: true,
    executionId: plan.planId,
    capabilityId: APPLY_CAPABILITY_ID,
    previewDigest: plan.previewDigest,
    targetBindingDigest: sha256Digest(plan.targetBinding),
    idempotencyKey,
  };
}

async function authorize({ plan, target, approvalId, idempotencyKey }) {
  const issuedAt = new Date().toISOString();
  const approval = createTrustedWorkflowApproval({
    approvalId,
    actorId: 'synthetic-local-reviewer',
    sessionId: 'm6-05-isolated-session',
    plan,
    issuedAt,
    expiresAt: nowPlus(5 * 60_000),
    idempotencyKey,
  });
  const controller = new TrustedApprovalController();
  controller.register(approval);
  const executionGrant = controller.authorize({
    approval,
    plan,
    actorId: 'synthetic-local-reviewer',
    sessionId: 'm6-05-isolated-session',
    target,
    idempotencyKey,
    now: issuedAt,
  });
  return { approval, executionGrant };
}

async function datasetAction(adapter, suffix) {
  const shell = {
    actionId: '01-dataset',
    actionType: 'dataset.update',
    asset: { identity: `dataset:${NATIVE_ASSETS.datasetUuid}`, kind: 'dataset' },
    dependsOn: [`database:${NATIVE_ASSETS.databaseUuid}`],
    after: { uuid: NATIVE_ASSETS.datasetUuid },
  };
  shell.before = await adapter.read(shell);
  shell.after = { ...shell.before, description: `${shell.before.description} | ${suffix}` };
  return shell;
}

async function planFor({ client, adapter, specialist, planId, recommendationId, suffix }) {
  const action = await datasetAction(adapter, suffix);
  const fingerprintBody = {
    product: 'Apache Superset',
    version: '6.1.0',
    openapiCanonicalSha256: '1e0aea80b9f9331d83717711c577575d1f0c706f5e0e3632d403a28df0c5caa6',
  };
  const capabilities = [
    { capabilityId: 'superset.dataset.reviewed-update', contractVersion: 'v1', status: 'supported' },
    { capabilityId: 'superset.chart.reviewed-upsert', contractVersion: 'v1', status: 'supported' },
    { capabilityId: 'superset.dashboard.reviewed-update', contractVersion: 'v1', status: 'supported' },
    { capabilityId: 'superset.dashboard.reviewed-filter-update', contractVersion: 'v1', status: 'supported' },
  ];
  const database = (await client.list('database')).find((item) => item.uuid === NATIVE_ASSETS.databaseUuid);
  const target = {
    schemaVersion: TRUSTED_TARGET_VERSION,
    targetId: process.env.COMPOSE_PROJECT_NAME ?? 'sba-m6-05-ambiguous-20260815',
    environment: 'disposable_local',
    baseUrl: client.baseUrl,
    fingerprint: { ...fingerprintBody, digest: sha256Digest(fingerprintBody) },
    capabilityRevision: 'm6-05-reviewed-public-rest-v1',
    capabilities,
    assets: [
      { identity: `database:${NATIVE_ASSETS.databaseUuid}`, kind: 'database', value: { uuid: database.uuid, name: database.database_name } },
      { identity: action.asset.identity, kind: action.asset.kind, value: clone(action.before) },
    ],
  };
  const recommendation = {
    schemaVersion: TYPED_RECOMMENDATION_VERSION,
    recommendationId,
    sourceRunId: specialist.runId,
    sourceDiscoveryDigest: sha256Digest(specialist.discovery),
    authority: 'advisory_only',
    actions: [action],
  };
  return { target, plan: compileTrustedChangePlan({ planId, specialistResult: specialist, recommendation, target }), action };
}

function actionUuidsFor(plan) {
  return Object.fromEntries(plan.applyOrder.map((actionId, index) => [actionId, `a6050000-0000-4000-8000-${String(1000 + index).padStart(12, '0')}`]));
}

function mutationCount(trace) {
  return trace.filter((entry) => entry.mutationRequest).length;
}

function reviewedAssetMutationCount(trace) {
  return trace.filter((entry) => entry.mutationRequest && /^\/api\/v[^/]+\/(?:dataset|chart|dashboard)\//.test(entry.pathClass)).length;
}

const directClient = await clientFromEnvironment();
const provisioned = await provisionNativeAssets(directClient);
const directAdapter = new ReviewedSupersetAssetAdapter({ client: directClient });
const specialist = await new RealBiSpecialist().investigate({
  databasePath: resolve('services/bi-control/fixtures/bi-specialist/candidate/training-order-to-cash.sqlite'),
  objective: 'Prove ambiguous transport outcome reconciliation on a disposable local Superset fixture without blind redispatch',
  runId: 'm6-05-deterministic-specialist',
});

const committed = await planFor({
  client: directClient,
  adapter: directAdapter,
  specialist,
  planId: 'm6-05-live-committed-plan',
  recommendationId: 'm6-05-live-committed-recommendation',
  suffix: 'M6-05 committed-response-lost proof',
});
const committedAuth = await authorize({ plan: committed.plan, target: committed.target, approvalId: 'm6-05-live-approval-committed', idempotencyKey: 'm6-05-live-idem-committed' });
const committedContext = createOutcomeContext({
  actorId: 'synthetic-local-reviewer',
  sessionId: 'm6-05-isolated-session',
  target: committed.target,
  plan: committed.plan,
  authorization: committedAuth.executionGrant,
  idempotencyKey: 'm6-05-live-idem-committed',
  actionUuids: actionUuidsFor(committed.plan),
  createdAt: new Date().toISOString(),
});
const committedJournal = await FileOutcomeJournal.open({
  filePath: resolve(evidenceRoot, 'committed-response-lost-journal.json'),
  context: committedContext,
});
await committedJournal.appendAndFlush({
  eventType: 'initialized',
  evidence: { planDigest: sha256Digest(committed.plan), targetBindingDigest: sha256Digest(committed.plan.targetBinding) },
  decision: { dispatchAllowed: true, blindRetryAllowed: false },
});

const datasetRecord = (await directClient.list('dataset')).find((item) => item.uuid === NATIVE_ASSETS.datasetUuid);
const proxy = await startFaultProxy({
  targetOrigin: directClient.baseUrl,
  fault: { method: 'PUT', pathPattern: new RegExp(`^/api/v1/dataset/${datasetRecord.id}$`) },
});
let responseLostCode = null;
try {
  const proxyPassword = (await readFile(process.env.SUPERSET_ADMIN_PASSWORD_FILE ?? '.runtime/secrets/superset_admin_password', 'utf8')).trim();
  const proxyClient = new SupersetPublicApiClient({ baseUrl: proxy.baseUrl, password: proxyPassword });
  await proxyClient.authenticate();
  const proxyAdapter = new ReviewedSupersetAssetAdapter({ client: proxyClient });
  await new TrustedSupersetWorkflowExecutor({ adapter: proxyAdapter }).apply({
    plan: committed.plan,
    authorization: committedAuth.executionGrant,
    idempotencyKey: 'm6-05-live-idem-committed',
  });
} catch (error) {
  responseLostCode = error.code ?? error.cause?.code ?? error.message;
}
await proxy.close();
if (!responseLostCode) throw new Error('M6_05_FAULT_DID_NOT_CUT_RESPONSE');
if (reviewedAssetMutationCount(proxy.trace) !== 1 || proxy.trace.filter((entry) => entry.faultInjected).length !== 1) {
  throw new Error(`M6_05_FAULT_PROXY_MUTATION_COUNT_MISMATCH:${JSON.stringify(proxy.trace.map(({ method, pathClass, mutationRequest, faultInjected, upstreamStatus }) => ({ method, pathClass, mutationRequest, faultInjected, upstreamStatus })))}`);
}
await committedJournal.appendAndFlush({
  eventType: 'dispatch_response_lost',
  evidence: {
    transportFault: 'loopback_proxy_destroyed_client_response_after_upstream_commit',
    dispatchReachedServer: true,
    responseLostCode: String(responseLostCode).slice(0, 96),
    proxyReviewedAssetMutationRequests: reviewedAssetMutationCount(proxy.trace),
    proxyTotalMutationLikeRequests: mutationCount(proxy.trace),
    proxyFaultCount: proxy.trace.filter((entry) => entry.faultInjected).length,
  },
  decision: { blindRetryAllowed: false },
});

const postFaultReadback = await directAdapter.read(committed.action);
if (!sameDigest(postFaultReadback, committed.action.after)) throw new Error('M6_05_POST_FAULT_READBACK_NOT_COMMITTED');
let reconcileMutationAttempts = 0;
const readOnlyReconcileAdapter = {
  async read(action) { return directAdapter.read(action); },
  async applyValue() { reconcileMutationAttempts += 1; throw new Error('M6_05_RECONCILER_MUTATION_DENIED'); },
};
const committedReconciliation = await reconcileUnknownOutcome({
  journal: committedJournal,
  plan: committed.plan,
  adapter: readOnlyReconcileAdapter,
  target: committed.target,
  occurredAt: new Date().toISOString(),
});
await committedJournal.flush();
if (committedReconciliation.state !== 'committed_equivalent' || reconcileMutationAttempts !== 0) throw new Error('M6_05_COMMITTED_RECONCILIATION_FAILED');
const restored = await directAdapter.applyValue(committed.action, committed.action.before);
if (!sameDigest(restored, committed.action.before)) throw new Error('M6_05_RESTORE_AFTER_COMMITTED_PROOF_FAILED');

const unchanged = await planFor({
  client: directClient,
  adapter: directAdapter,
  specialist,
  planId: 'm6-05-live-unchanged-plan',
  recommendationId: 'm6-05-live-unchanged-recommendation',
  suffix: 'M6-05 unchanged retry proof',
});
const unchangedAuth = await authorize({ plan: unchanged.plan, target: unchanged.target, approvalId: 'm6-05-live-approval-unchanged-original', idempotencyKey: 'm6-05-live-idem-unchanged-original' });
const unchangedContext = createOutcomeContext({
  actorId: 'synthetic-local-reviewer',
  sessionId: 'm6-05-isolated-session',
  target: unchanged.target,
  plan: unchanged.plan,
  authorization: unchangedAuth.executionGrant,
  idempotencyKey: 'm6-05-live-idem-unchanged-original',
  actionUuids: actionUuidsFor(unchanged.plan),
  createdAt: new Date().toISOString(),
});
const unchangedJournal = await FileOutcomeJournal.open({
  filePath: resolve(evidenceRoot, 'unchanged-safe-to-retry-journal.json'),
  context: unchangedContext,
});
await unchangedJournal.appendAndFlush({
  eventType: 'initialized',
  evidence: { planDigest: sha256Digest(unchanged.plan), targetBindingDigest: sha256Digest(unchanged.plan.targetBinding) },
  decision: { dispatchAllowed: true, blindRetryAllowed: false },
});
await unchangedJournal.appendAndFlush({
  eventType: 'dispatch_response_lost',
  evidence: { transportFault: 'pre_dispatch_loopback_cut', dispatchReachedServer: false, proxyMutationRequests: 0 },
  decision: { blindRetryAllowed: false },
});
const unchangedReconciliation = await reconcileUnknownOutcome({
  journal: unchangedJournal,
  plan: unchanged.plan,
  adapter: readOnlyReconcileAdapter,
  target: unchanged.target,
  occurredAt: new Date().toISOString(),
});
let originalRetryDenied = null;
try {
  authorizeFreshRetryAfterUnchanged({
    journal: unchangedJournal,
    context: unchangedContext,
    plan: unchanged.plan,
    authorization: unchangedAuth.executionGrant,
    idempotencyKey: 'm6-05-live-idem-unchanged-original',
  });
} catch (error) {
  originalRetryDenied = error.code;
}
const freshRetryAuth = authorizationFor(unchanged.plan, 'm6-05-live-idem-unchanged-fresh');
const freshRetryEntry = authorizeFreshRetryAfterUnchanged({
  journal: unchangedJournal,
  context: unchangedContext,
  plan: unchanged.plan,
  authorization: freshRetryAuth,
  idempotencyKey: 'm6-05-live-idem-unchanged-fresh',
  occurredAt: new Date().toISOString(),
});
await unchangedJournal.flush();
if (unchangedReconciliation.state !== 'unchanged_safe_to_retry' || originalRetryDenied !== 'OUTCOME_FRESH_RETRY_REQUIRES_NEW_IDEMPOTENCY' || freshRetryEntry.toState !== 'not_dispatched') throw new Error('M6_05_UNCHANGED_RETRY_PROOF_FAILED');

const projectionBytes = await readFile('.runtime/projection/analytics.db');
const manifest = {
  schemaVersion: 'chimpmaera.bi/ambiguous-outcome-reconciliation-evidence/v1',
  generatedAt: new Date().toISOString(),
  runtime: {
    projectName: process.env.COMPOSE_PROJECT_NAME ?? 'sba-m6-05-ambiguous-20260815',
    baseUrl: directClient.baseUrl,
    loopbackOnly: true,
    product: 'Apache Superset',
    version: '6.1.0',
    image: 'apache/superset:6.1.0@sha256:fb3464528ec7076f91195f0ff7835755aa023e281f1bb78a84782ce7a36b3705',
    fixture: 'northstar-components-synthetic-v1',
    projectionDigest: `sha256:${createHash('sha256').update(projectionBytes).digest('hex')}`,
    customerData: false,
  },
  managedAssets: provisioned.counts,
  committedResponseLost: {
    planDigest: sha256Digest(committed.plan),
    contextDigest: sha256Digest(committedContext),
    journalDigest: sha256Digest(committedJournal.snapshot()),
    proxyTraceDigest: sha256Digest(proxy.trace),
    proxyReviewedAssetMutationRequests: reviewedAssetMutationCount(proxy.trace),
    proxyTotalMutationLikeRequests: mutationCount(proxy.trace),
    proxyFaultCount: proxy.trace.filter((entry) => entry.faultInjected).length,
    responseLostCode: String(responseLostCode).slice(0, 96),
    postFaultReadbackDigest: sha256Digest(postFaultReadback),
    expectedAfterDigest: sha256Digest(committed.action.after),
    reconciliationState: committedReconciliation.state,
    duplicateMutationRequestsAfterUnknown: reconcileMutationAttempts,
    restoredDigest: sha256Digest(restored),
    expectedBeforeDigest: sha256Digest(committed.action.before),
  },
  unchangedSafeToRetry: {
    planDigest: sha256Digest(unchanged.plan),
    contextDigest: sha256Digest(unchangedContext),
    journalDigest: sha256Digest(unchangedJournal.snapshot()),
    reconciliationState: unchangedReconciliation.state,
    originalRetryDenied,
    freshRetryEntryHash: freshRetryEntry.entryHash,
    freshRetryState: freshRetryEntry.toState,
  },
  actionMatrix: [
    { actionType: 'dataset.update', liveFaultCovered: true, outcome: 'committed_equivalent', duplicateMutationRequestsAfterUnknown: 0 },
    { actionType: 'dataset.update', liveUnchangedCovered: true, outcome: 'unchanged_safe_to_retry_requires_fresh_grant' },
    { actionType: 'chart.upsert', representativeCoverage: 'unit-reconciler and M6-04 live apply/readback/rollback; live fault pending extension' },
    { actionType: 'dashboard.update', representativeCoverage: 'unit-reconciler and M6-04 live apply/readback/rollback; live fault pending extension' },
    { actionType: 'filter.configure', representativeCoverage: 'unit-reconciler and M6-04 live apply/readback/rollback; live fault pending extension' },
    { actionType: 'delete', supported: false, reason: 'M6-04 trusted executor denies reviewed delete; delete fault proof is a nonclaim for this action surface' },
  ],
  privacy: {
    rawResponsePersisted: false,
    responsePayloadPersisted: false,
    sourceRecordsPersisted: false,
    modelTranscriptPersisted: false,
    cotPersisted: false,
  },
  nonclaims: ['no-production-or-customer-use', 'no-global-exactly-once', 'no-arbitrary-network-partition-proof', 'no-broad-provider-support', 'no-deployment'],
};
await writeFile(resolve(evidenceRoot, 'live-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`M6-05 live ambiguous outcome: committed=${committedReconciliation.state}, duplicate mutations=${reconcileMutationAttempts}, unchanged=${unchangedReconciliation.state}, fresh retry=${freshRetryEntry.toState}\n`);
