# M6-05 Ambiguous Outcome Reconciliation evidence

## Gate result

- G1: exact clean M6-04 base, isolated worktree/branch, sole writer, rollback/nonclaims, atomic checkpoint.
- G2: deterministic state machine and hash-chained restart-safe journal with complete bound context and fail-closed transitions.
- G3: public-REST readback reconciliation; exact-after commits without dispatch, exact-before requires a fresh grant, all ambiguous/drift/foreign cases deny retry.
- G4: real loopback proxy cut the response after Superset returned HTTP 200; direct REST readback matched exact after-state and duplicate reviewed mutation requests were zero.
- G5: journal rehydration after executor handoff, exclusive owner lease, concurrent duplicate suppression, idempotent repeated recovery, and exact owned partial compensation with unrelated mutation count zero.
- G6: forged journal head, entry tampering/reordering, plan substitution, capability/snapshot drift, foreign ownership, unsafe retry, secret/raw/PII/CoT persistence, loopback/path/credential/injection/budget boundaries fail closed.
- G7: focused/full/source-map suites, diff checks, syntax/JSON/privacy/network scans, commit hashes, clean status, and teardown are recorded in the terminal manifest.

## Live and local artifacts

- `docs/evidence/m6-05-ambiguous-outcome-reconciliation/live-manifest.json`
- `docs/evidence/m6-05-ambiguous-outcome-reconciliation/committed-response-lost-journal.json`
- `docs/evidence/m6-05-ambiguous-outcome-reconciliation/unchanged-safe-to-retry-journal.json`
- `docs/evidence/m6-05-ambiguous-outcome-reconciliation/terminal-manifest.json`
- `tests/ambiguous-outcome-reconciliation.test.mjs`

## Negative evidence

All G2-G4 failures listed in the atomic checkpoint remain retained. No failed result was
rewritten as success. G5-G6 focused probes passed on their first committed implementation run.

## Nonclaims

No production/customer data, production RBAC/concurrency, external durability,
organizationally independent validation, arbitrary network partitions, broad provider
support, deployment, push, PR, tag, release, or global exactly-once semantics.
