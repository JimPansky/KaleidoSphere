import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { canonicalJson } from '../canonical-json.js';
import { assertSafeJson, sha256Digest } from '../assistant-foundation/core-contracts.mjs';
import { APPLY_CAPABILITY_ID, CHANGE_PLAN_VERSION } from './trusted-specialist-workflow.mjs';

export const OUTCOME_CONTEXT_VERSION = 'chimpmaera.bi/ambiguous-outcome-context/v1';
export const OUTCOME_JOURNAL_VERSION = 'chimpmaera.bi/ambiguous-outcome-journal/v1';
export const OUTCOME_ENTRY_VERSION = 'chimpmaera.bi/ambiguous-outcome-journal-entry/v1';

export const OUTCOME_STATES = Object.freeze([
  'not_dispatched',
  'known_rejected',
  'outcome_unknown',
  'committed_equivalent',
  'unchanged_safe_to_retry',
  'partial',
  'diverged',
  'manual_review',
]);

const START = '__start__';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const FAIL = (code) => { const error = new Error(code); error.code = code; throw error; };
const clone = (value) => structuredClone(value);
const same = (left, right) => canonicalJson(left) === canonicalJson(right);

const FORBIDDEN_PERSISTED_KEYS = new Set([
  'authorization',
  'cookie',
  'password',
  'prompt',
  'raw',
  'raw_request',
  'raw_response',
  'reasoning',
  'request_body',
  'response',
  'response_body',
  'secret',
  'source_record',
  'source_records',
  'token',
  'transcript',
]);

const TRANSITIONS = Object.freeze({
  [START]: Object.freeze({ initialized: 'not_dispatched' }),
  not_dispatched: Object.freeze({
    dispatch_known_rejected: 'known_rejected',
    dispatch_response_lost: 'outcome_unknown',
    dispatch_committed_acknowledged: 'committed_equivalent',
  }),
  outcome_unknown: Object.freeze({
    reconcile_exact_after: 'committed_equivalent',
    reconcile_exact_before: 'unchanged_safe_to_retry',
    reconcile_owned_partial: 'partial',
    reconcile_diverged: 'diverged',
    reconcile_manual_review: 'manual_review',
  }),
  unchanged_safe_to_retry: Object.freeze({ fresh_retry_authorized: 'not_dispatched' }),
  partial: Object.freeze({ manual_review_opened: 'manual_review' }),
  diverged: Object.freeze({ manual_review_opened: 'manual_review' }),
  known_rejected: Object.freeze({}),
  committed_equivalent: Object.freeze({}),
  manual_review: Object.freeze({}),
});

function exactKeys(value, allowed, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) FAIL(code);
  if (Object.keys(value).some((key) => !allowed.has(key))) FAIL(code);
}

function canonicalClone(value) {
  canonicalJson(value);
  return clone(value);
}

function normalizedKey(key) {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[ .-]+/g, '_').toLowerCase();
}

function assertNoForbiddenPersistenceSurface(value) {
  if (Array.isArray(value)) return value.forEach(assertNoForbiddenPersistenceSurface);
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_PERSISTED_KEYS.has(normalizedKey(key))) FAIL('OUTCOME_JOURNAL_RAW_OR_SECRET_FIELD_DENIED');
    assertNoForbiddenPersistenceSurface(item);
  }
}

function assertSafeTrace(value) {
  assertSafeJson(value);
  assertNoForbiddenPersistenceSurface(value);
}

function assertPlan(plan) {
  if (!plan || plan.schemaVersion !== CHANGE_PLAN_VERSION || !Array.isArray(plan.actions) || !Array.isArray(plan.applyOrder)) FAIL('OUTCOME_PLAN_INVALID');
  const body = Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'previewDigest'));
  if (plan.previewDigest !== sha256Digest(body)) FAIL('OUTCOME_PLAN_DIGEST_MISMATCH');
}

function assertGrantBinding({ plan, authorization, idempotencyKey }) {
  if (!authorization || authorization.authorized !== true || authorization.executionId !== plan.planId || authorization.capabilityId !== APPLY_CAPABILITY_ID) FAIL('OUTCOME_AUTHORIZATION_REQUIRED');
  if (authorization.previewDigest !== plan.previewDigest || authorization.targetBindingDigest !== sha256Digest(plan.targetBinding) || authorization.idempotencyKey !== idempotencyKey) FAIL('OUTCOME_AUTHORIZATION_BINDING_MISMATCH');
}

function actionPreconditions(plan) {
  const byId = new Map(plan.actions.map((action) => [action.actionId, action]));
  return plan.applyOrder.map((actionId) => {
    const action = byId.get(actionId);
    if (!action) FAIL('OUTCOME_ACTION_ORDER_INVALID');
    return {
      actionId,
      actionDigest: sha256Digest(action),
      beforeDigest: sha256Digest(action.before),
      afterDigest: sha256Digest(action.after),
      dependencyDigest: sha256Digest([...action.dependsOn].sort()),
    };
  });
}

function assertActionUuidBinding(plan, actionUuids) {
  if (!actionUuids || typeof actionUuids !== 'object' || Array.isArray(actionUuids)) FAIL('OUTCOME_ACTION_UUID_BINDING_INVALID');
  return plan.applyOrder.map((actionId) => {
    const actionUuid = actionUuids[actionId];
    if (!UUID.test(actionUuid ?? '')) FAIL('OUTCOME_ACTION_UUID_BINDING_INVALID');
    return { actionId, actionUuid };
  }).sort((a, b) => a.actionId.localeCompare(b.actionId));
}

export function createOutcomeContext({ actorId, sessionId, target, plan, authorization, idempotencyKey, actionUuids, preconditions = null, createdAt }) {
  if (!ID.test(actorId ?? '') || !ID.test(sessionId ?? '') || !ID.test(idempotencyKey ?? '')) FAIL('OUTCOME_CONTEXT_IDENTITY_INVALID');
  assertPlan(plan);
  assertGrantBinding({ plan, authorization, idempotencyKey });
  if (!target || target.targetId !== plan.targetBinding.targetId || target.environment !== plan.targetBinding.environment) FAIL('OUTCOME_TARGET_BINDING_MISMATCH');
  const targetBindingDigest = sha256Digest(plan.targetBinding);
  if (sha256Digest([...target.assets].sort((a, b) => a.identity.localeCompare(b.identity))) !== plan.targetBinding.assetSnapshotDigest) FAIL('OUTCOME_TARGET_SNAPSHOT_MISMATCH');
  const actionBindings = assertActionUuidBinding(plan, actionUuids);
  const preconditionBindings = preconditions ?? actionPreconditions(plan);
  assertSafeTrace(preconditionBindings);
  const context = {
    schemaVersion: OUTCOME_CONTEXT_VERSION,
    actorId,
    sessionId,
    target: {
      targetId: plan.targetBinding.targetId,
      environment: plan.targetBinding.environment,
      baseUrlOrigin: plan.targetBinding.baseUrlOrigin,
      fingerprintDigest: plan.targetBinding.fingerprintDigest,
      capabilityRevision: plan.targetBinding.capabilityRevision,
      capabilityDigest: plan.targetBinding.capabilityDigest,
      assetSnapshotDigest: plan.targetBinding.assetSnapshotDigest,
    },
    planDigest: sha256Digest(plan),
    previewDigest: plan.previewDigest,
    targetBindingDigest,
    grantDigest: sha256Digest({
      executionId: authorization.executionId,
      capabilityId: authorization.capabilityId,
      previewDigest: authorization.previewDigest,
      targetBindingDigest: authorization.targetBindingDigest,
      idempotencyKey: authorization.idempotencyKey,
    }),
    idempotencyKey,
    actionBindings,
    preconditionDigest: sha256Digest(preconditionBindings),
    createdAt,
    privacy: {
      rawResponsePersisted: false,
      responsePayloadPersisted: false,
      sourceRecordsPersisted: false,
      modelTranscriptPersisted: false,
      cotPersisted: false,
    },
    nonclaims: ['exact-local-only', 'no-global-exactly-once', 'no-arbitrary-network-partition-proof'],
  };
  assertSafeTrace(context);
  return Object.freeze(canonicalClone(context));
}

export function transitionOutcomeState(currentState, eventType) {
  const from = currentState ?? START;
  const to = TRANSITIONS[from]?.[eventType];
  if (!to) FAIL('OUTCOME_ILLEGAL_TRANSITION');
  return to;
}

function genesisHash(contextDigest) {
  return sha256Digest({ contextDigest, genesis: true, schemaVersion: OUTCOME_JOURNAL_VERSION });
}

function entryBody(entry) {
  return Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'entryHash'));
}

function assertJournalEntry(entry, expected) {
  exactKeys(entry, new Set(['schemaVersion', 'seq', 'occurredAt', 'contextDigest', 'previousHash', 'fromState', 'toState', 'eventType', 'evidence', 'decision', 'entryHash']), 'OUTCOME_JOURNAL_ENTRY_INVALID');
  if (entry.schemaVersion !== OUTCOME_ENTRY_VERSION || entry.seq !== expected.seq || entry.contextDigest !== expected.contextDigest || entry.previousHash !== expected.previousHash) FAIL('OUTCOME_JOURNAL_ENTRY_INVALID');
  if ((entry.fromState ?? START) !== (expected.fromState ?? START)) FAIL('OUTCOME_JOURNAL_STATE_CHAIN_INVALID');
  if (entry.toState !== transitionOutcomeState(entry.fromState, entry.eventType)) FAIL('OUTCOME_JOURNAL_TRANSITION_MISMATCH');
  assertSafeTrace(entry.evidence);
  assertSafeTrace(entry.decision);
  if (entry.entryHash !== sha256Digest(entryBody(entry))) FAIL('OUTCOME_JOURNAL_HASH_MISMATCH');
}

export class OutcomeJournal {
  #context;
  #contextDigest;
  #entries;
  #state;
  #clock;

  constructor({ context, entries = [], clock = () => new Date().toISOString() }) {
    if (!context || context.schemaVersion !== OUTCOME_CONTEXT_VERSION) FAIL('OUTCOME_CONTEXT_INVALID');
    this.#context = canonicalClone(context);
    this.#contextDigest = sha256Digest(context);
    this.#entries = [];
    this.#state = null;
    this.#clock = clock;
    for (const entry of entries) this.#acceptExisting(entry);
  }

  get state() { return this.#state; }
  get contextDigest() { return this.#contextDigest; }
  context() { return clone(this.#context); }

  entries() { return this.#entries.map(clone); }

  snapshot() {
    const value = {
      schemaVersion: OUTCOME_JOURNAL_VERSION,
      contextDigest: this.#contextDigest,
      state: this.#state,
      entries: this.entries(),
      lastHash: this.#entries.at(-1)?.entryHash ?? genesisHash(this.#contextDigest),
    };
    assertSafeTrace(value);
    return value;
  }

  append({ eventType, evidence = {}, decision = {}, occurredAt = this.#clock() }) {
    const nextState = transitionOutcomeState(this.#state, eventType);
    const body = {
      schemaVersion: OUTCOME_ENTRY_VERSION,
      seq: this.#entries.length + 1,
      occurredAt,
      contextDigest: this.#contextDigest,
      previousHash: this.#entries.at(-1)?.entryHash ?? genesisHash(this.#contextDigest),
      fromState: this.#state,
      toState: nextState,
      eventType,
      evidence: canonicalClone(evidence),
      decision: canonicalClone(decision),
    };
    assertSafeTrace(body);
    const entry = Object.freeze({ ...body, entryHash: sha256Digest(body) });
    this.#entries.push(entry);
    this.#state = nextState;
    return clone(entry);
  }

  #acceptExisting(entry) {
    const expected = {
      seq: this.#entries.length + 1,
      contextDigest: this.#contextDigest,
      previousHash: this.#entries.at(-1)?.entryHash ?? genesisHash(this.#contextDigest),
      fromState: this.#state,
    };
    assertJournalEntry(entry, expected);
    this.#entries.push(Object.freeze(canonicalClone(entry)));
    this.#state = entry.toState;
  }
}

export class FileOutcomeJournal extends OutcomeJournal {
  #filePath;

  constructor({ filePath, context, entries = [], clock }) {
    super({ context, entries, clock });
    this.#filePath = filePath;
  }

  static async open({ filePath, context, clock }) {
    let entries = [];
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      exactKeys(parsed, new Set(['schemaVersion', 'contextDigest', 'state', 'entries', 'lastHash']), 'OUTCOME_JOURNAL_FILE_INVALID');
      if (parsed.schemaVersion !== OUTCOME_JOURNAL_VERSION || parsed.contextDigest !== sha256Digest(context) || !Array.isArray(parsed.entries)) FAIL('OUTCOME_JOURNAL_FILE_INVALID');
      entries = parsed.entries;
      const verified = new OutcomeJournal({ context, entries });
      const verifiedSnapshot = verified.snapshot();
      if (parsed.state !== verifiedSnapshot.state || parsed.lastHash !== verifiedSnapshot.lastHash) FAIL('OUTCOME_JOURNAL_FILE_TRUNCATED_OR_FORGED');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const journal = new FileOutcomeJournal({ filePath, context, entries, clock });
    if (entries.length === 0) await journal.flush();
    return journal;
  }

  async appendAndFlush(event) {
    const entry = this.append(event);
    await this.flush();
    return entry;
  }

  async flush() {
    const payload = `${JSON.stringify(this.snapshot(), null, 2)}\n`;
    const tempPath = `${this.#filePath}.tmp-${process.pid}-${Date.now()}`;
    await mkdir(dirname(this.#filePath), { recursive: true });
    await writeFile(tempPath, payload, { mode: 0o600 });
    await rename(tempPath, this.#filePath);
  }
}

export async function withOutcomeRecoveryLease({ leasePath, ownerId, operation, occurredAt = new Date().toISOString() }) {
  if (!ID.test(ownerId ?? '') || typeof operation !== 'function') FAIL('OUTCOME_RECOVERY_LEASE_INVALID');
  await mkdir(dirname(leasePath), { recursive: true });
  let handle;
  try {
    handle = await open(leasePath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') FAIL('OUTCOME_RECOVERY_LEASE_HELD');
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify({ ownerId, occurredAt })}\n`);
    await handle.sync();
    return await operation();
  } finally {
    await handle.close();
    await unlink(leasePath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function recoverUnknownOutcomeFromFile({ filePath, leasePath = `${filePath}.recovery.lock`, ownerId, context, plan, adapter, target, ownership = {}, occurredAt }) {
  return withOutcomeRecoveryLease({ leasePath, ownerId, occurredAt, operation: async () => {
    const journal = await FileOutcomeJournal.open({ filePath, context });
    if (journal.state !== 'outcome_unknown') {
      return { state: journal.state, recovered: false, duplicateSuppressed: true, mutationRequestsIssued: 0, journal };
    }
    const result = await reconcileUnknownOutcome({ journal, plan, adapter, target, ownership, occurredAt });
    await journal.flush();
    return { ...result, recovered: true, duplicateSuppressed: false, mutationRequestsIssued: 0, journal };
  }});
}

function relationForObserved({ observed, action, missingCode }) {
  if (missingCode && action.before === null) return 'before';
  if (missingCode && action.after === null) return 'after';
  if (missingCode) return 'missing';
  if (same(observed, action.after)) return 'after';
  if (same(observed, action.before)) return 'before';
  return 'diverged';
}

export async function reconcileUnknownOutcome({ journal, plan, adapter, target, ownership = {}, occurredAt }) {
  if (!(journal instanceof OutcomeJournal)) FAIL('OUTCOME_JOURNAL_REQUIRED');
  if (journal.state !== 'outcome_unknown') FAIL('OUTCOME_RECONCILE_STATE_INVALID');
  assertPlan(plan);
  const boundContext = journal.context();
  if (boundContext.planDigest !== sha256Digest(plan)) FAIL('OUTCOME_PLAN_SUBSTITUTION');
  if (!target || target.targetId !== boundContext.target.targetId || target.environment !== boundContext.target.environment || target.fingerprint.digest !== boundContext.target.fingerprintDigest || target.capabilityRevision !== boundContext.target.capabilityRevision || sha256Digest([...target.capabilities].sort((a, b) => a.capabilityId.localeCompare(b.capabilityId))) !== boundContext.target.capabilityDigest) {
    const entry = journal.append({
      eventType: 'reconcile_manual_review', occurredAt,
      evidence: { reason: 'target_or_capability_drift', targetBindingDigest: boundContext.targetBindingDigest },
      decision: { retryAllowed: false, compensationAllowed: false, manualReviewRequired: true },
    });
    return { state: entry.toState, classification: 'manual_review', entry };
  }
  if (target && sha256Digest([...target.assets].sort((a, b) => a.identity.localeCompare(b.identity))) !== plan.targetBinding.assetSnapshotDigest) {
    const entry = journal.append({
      eventType: 'reconcile_manual_review',
      occurredAt,
      evidence: { reason: 'target_snapshot_drift', targetBindingDigest: sha256Digest(plan.targetBinding) },
      decision: { retryAllowed: false, compensationAllowed: false, manualReviewRequired: true },
    });
    return { state: entry.toState, classification: 'manual_review', entry };
  }
  const byId = new Map(plan.actions.map((action) => [action.actionId, action]));
  const readback = [];
  for (const actionId of plan.applyOrder) {
    const action = byId.get(actionId);
    let observed;
    let missingCode = null;
    try {
      observed = await adapter.read(action);
    } catch (error) {
      missingCode = error.code ?? 'READBACK_FAILED';
    }
    const relation = relationForObserved({ observed, action, missingCode });
    readback.push({
      actionId,
      relation,
      observedDigest: missingCode ? null : sha256Digest(observed),
      readErrorCode: missingCode,
      owner: ownership[actionId] ?? 'owned',
    });
  }
  const relations = new Set(readback.map((item) => item.relation));
  const afterCount = readback.filter((item) => item.relation === 'after').length;
  const beforeCount = readback.filter((item) => item.relation === 'before').length;
  const foreignCommitted = readback.some((item) => item.relation === 'after' && item.owner !== 'owned');
  let eventType;
  let classification;
  let retryAllowed = false;
  let compensationAllowed = false;
  if (foreignCommitted) {
    eventType = 'reconcile_manual_review';
    classification = 'manual_review';
  } else if (afterCount === readback.length) {
    eventType = 'reconcile_exact_after';
    classification = 'committed_equivalent';
  } else if (beforeCount === readback.length) {
    eventType = 'reconcile_exact_before';
    classification = 'unchanged_safe_to_retry';
    retryAllowed = true;
  } else if ([...relations].every((relation) => relation === 'before' || relation === 'after')) {
    eventType = 'reconcile_owned_partial';
    classification = 'partial';
    compensationAllowed = true;
  } else {
    eventType = 'reconcile_diverged';
    classification = 'diverged';
  }
  const entry = journal.append({
    eventType,
    occurredAt,
    evidence: { readback, planDigest: sha256Digest(plan), mutationRequestsIssuedByReconciler: 0 },
    decision: {
      classification,
      retryAllowed,
      retryRequiresFreshGrant: retryAllowed,
      compensationAllowed,
      manualReviewRequired: ['manual_review', 'diverged'].includes(classification),
    },
  });
  return { state: entry.toState, classification, readback, entry };
}

export function authorizeFreshRetryAfterUnchanged({ journal, context, plan, authorization, idempotencyKey, occurredAt }) {
  if (!(journal instanceof OutcomeJournal)) FAIL('OUTCOME_JOURNAL_REQUIRED');
  if (journal.state !== 'unchanged_safe_to_retry') FAIL('OUTCOME_FRESH_RETRY_STATE_INVALID');
  if (!context || context.schemaVersion !== OUTCOME_CONTEXT_VERSION) FAIL('OUTCOME_CONTEXT_INVALID');
  if (idempotencyKey === context.idempotencyKey) FAIL('OUTCOME_FRESH_RETRY_REQUIRES_NEW_IDEMPOTENCY');
  assertPlan(plan);
  assertGrantBinding({ plan, authorization, idempotencyKey });
  return journal.append({
    eventType: 'fresh_retry_authorized',
    occurredAt,
    evidence: {
      originalContextDigest: sha256Digest(context),
      planDigest: sha256Digest(plan),
      freshGrantDigest: sha256Digest({
        executionId: authorization.executionId,
        capabilityId: authorization.capabilityId,
        previewDigest: authorization.previewDigest,
        targetBindingDigest: authorization.targetBindingDigest,
        idempotencyKey: authorization.idempotencyKey,
      }),
    },
    decision: { retryAllowed: true, blindRedispatch: false, freshIdempotencyKeyDigest: sha256Digest(idempotencyKey) },
  });
}

export async function compensateOwnedPartialOutcome({ journal, plan, adapter, ownership = {}, occurredAt }) {
  if (!(journal instanceof OutcomeJournal) || journal.state !== 'partial') FAIL('OUTCOME_COMPENSATION_STATE_INVALID');
  assertPlan(plan);
  const byId = new Map(plan.actions.map((action) => [action.actionId, action]));
  const restored = [];
  for (const actionId of [...plan.applyOrder].reverse()) {
    const action = byId.get(actionId);
    if ((ownership[actionId] ?? 'owned') !== 'owned') FAIL('OUTCOME_COMPENSATION_FOREIGN_OWNERSHIP');
    const observed = await adapter.read(action);
    if (same(observed, action.before)) continue;
    if (!same(observed, action.after)) FAIL('OUTCOME_COMPENSATION_DRIFT');
    const readback = await adapter.applyValue(action, action.before);
    if (!same(readback, action.before)) FAIL('OUTCOME_COMPENSATION_READBACK_MISMATCH');
    restored.push({ actionId, restoredDigest: sha256Digest(readback) });
  }
  const entry = journal.append({
    eventType: 'manual_review_opened',
    occurredAt,
    evidence: { restored, planDigest: sha256Digest(plan), unrelatedAssetsMutated: 0 },
    decision: { compensationCompleted: true, retryAllowed: false, manualReviewRequired: false },
  });
  return { state: entry.toState, restored, entry };
}
