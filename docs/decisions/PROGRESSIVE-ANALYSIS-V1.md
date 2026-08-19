# Progressive Analysis v1

Status: accepted implementation decision for issue #37.

## Context

Progressive Run Controller v1 already enforces the MSSQL/Oracle breadth gate,
manifest-derived method allowlist, typed scope, run/object budgets, exact probe
keys, sealed receipts, and timeout/cancel no-blind-retry behavior. The next P0
slice needs table and hypothesis economics, explicit hypotheses and
counterevidence, typed intent equivalence, expected-gain ordering, and safe
continuity after concurrent reservations or unknown dispatch outcomes.

## Decision

Add one sealed advanced-analysis state that composes an intact v1 controller
run. It does not replace or bypass any v1 authorization.

- A reservation passes the v1 breadth, method, target, argument, run-budget,
  and object-budget checks, then atomically persists the returned v1 probe with
  table and hypothesis debits before dispatch. Debits are never refunded.
- The caller must persist the sealed state with compare-and-swap against
  `expectedStateSha256`. A concurrent stale writer fails closed before another
  reservation. This is a bounded storage contract, not a distributed-lock or
  unrestricted-concurrency claim.
- Hypotheses are closed typed candidates bound to one visible table, initial
  confidence bounds, and source evidence hashes. Supporting evidence,
  counterevidence, contradictions, receipt references, current bounds, status,
  streak counters, and terminal reason are append-only within the sealed state.
- Candidate gain is calculated deterministically as bounded uncertainty ×
  outcome probability × relevance. The exact integer basis-point inputs,
  rationale code, evidence hashes, binding, and result are sealed. Ordering is
  descending expected gain, then canonical candidate hash.
- Typed near-duplicate identity uses scope, immutable hypothesis definition,
  table, typed target, and the closed probe/signal/comparison/grain feature set.
  It never compares SQL or raw values. A distinct typed intent or target remains
  eligible, subject to budgets.
- Two consecutive `NO_GAIN` outcomes by default stop a hypothesis before a new
  reservation. The bound is configurable to a stricter positive integer.
  Repeated counterevidence has a separate positive bound and retained
  contradiction records.
- `UNKNOWN` is an immutable v1 outcome receipt and keeps its reservation debit.
  It suppresses redispatch and stops the branch pending a separate hash-bound
  readback reconciliation. Reconciliation appends evidence; it never edits or
  deletes the unknown receipt.

## Safety boundary

The advanced layer has no SQL executor and no mutation authority. Only existing
v1 allowlisted method references and typed parameters reach authorization.
State and reports reject free SQL, raw values, credentials, cross-scope
candidates, stale state, forged gain, counter rollback, receipt replay, and
tampering. Missing privilege remains evidence and never means an absent object.

## Risks, fallback, and review markers

- Expected gain is a deterministic bounded policy signal, not an optimal
  information-theory or learned semantic-equivalence claim.
- Compare-and-swap must be implemented by the state owner when committing the
  returned snapshot. The fixture proves the contract by rejecting the second
  writer against the first committed state.
- A protected successor revert can remove this wrapper while the v1 controller
  and all historical controller/evidence receipts remain readable.
- Review markers are the sequential, JSON restart, concurrent-reservation, and
  unknown-outcome hashes plus negative tests for all authorization boundaries.

## Non-claims

No free model SQL, raw-row transfer, automatic business truth, production or
customer database access, deployment/runtime activation, inferred-FK truth,
universal completeness, unrestricted concurrency, optimal information theory,
or performance improvement.
