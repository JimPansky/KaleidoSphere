# Progressive Run Controller v1

Status: accepted implementation decision for issue #36.

## Context

KaleidoSphere already has read-only MSSQL/Oracle query manifests, runtime
preflight, explicit query-level coverage and canonical Evidence hashes. It did
not have one persisted controller that proves structural breadth before depth,
tracks every visible object explicitly, limits probe execution and resumes from
successful receipts without reissuing work.

## Decision

Add one engine-neutral controller that composes, rather than replaces, the
existing analyzer evidence mechanisms.

- State advances only through `PREFLIGHT`, `BREADTH_INVENTORY`,
  `PRIORITIZATION`, `SAFE_AGGREGATES`, `RELATIONSHIP_GRAPH`,
  `HYPOTHESIS_VALIDATION`, and `REPORT`.
- Existing structure rows become privacy-safe object references containing only
  typed identifiers and the existing object digest. Each visible object has
  exactly one `COMPLETE`, `PARTIAL`, `DENIED`, `UNSUPPORTED`, or `UNKNOWN`
  state. Query-level denial remains `absenceClaim=NOT_CLAIMED`.
- Depth requires at least 9500 basis points of classified visible-object
  coverage. Any exception is a persisted hash-bound justification limited to
  exact objects and a maximum probe count.
- The method registry is derived only from validated shipped MSSQL/Oracle
  structure/profiling manifests. Requests cannot carry SQL or undeclared
  arguments.
- Authorization reserves hard run and object budgets. A canonical probe key
  suppresses duplicate or unresolved repeat dispatch. A successful bound
  receipt is reused after JSON persistence/restart.
- State, coverage, overrides, probes, receipts and reports use the existing
  canonical SHA-256 identity functions and bind the existing structure snapshot
  and coverage-ledger hashes.

## Safety boundary

No production/customer database was accessed. The controller has no mutation
authority, accepts no DDL/DML/free SQL, stores no raw values or credentials and
never maps missing privilege to absence. Timeout and cancellation receipts are
terminal for v1 and cannot trigger a blind retry.

## Scope split

This release-sized v1 includes minimal run/object budgets, exact duplicate
suppression and successful receipt resume because they are required for a safe
controller. Issue #37 remains responsible for table/hypothesis budget economics,
typed near-duplicate matching, expected-information-gain rationale, no-gain
stopping, concurrent reservation reconciliation and the full persisted
hypothesis/counterevidence ledger.

## Risks, fallback, and review marker

- Risk: a 95% ratio can coexist with a small explicit unknown set. Depth still
  requires the exact target object to be `COMPLETE`, unless that object is named
  by a persisted bounded override.
- Fallback: keep using the existing standalone analyzer workflows; before merge,
  close the controller PR. After merge, use a protected successor revert without
  rewriting historical evidence.
- Review marker: #37 must not weaken v1 gates or reuse unresolved timeout/cancel
  receipts as successful evidence.

## Non-claims

No advanced information-gain optimizer, semantic near-duplicate model,
automatic business interpretation, relationship truth, new MSSQL/Oracle method
parity, production performance or universal completeness.
