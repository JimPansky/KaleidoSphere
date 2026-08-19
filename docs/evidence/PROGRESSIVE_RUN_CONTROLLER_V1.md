# Progressive Run Controller v1 evidence

Issue: #36. Evidence source: local deterministic synthetic fixtures only.

## Proven behavior

- Existing MSSQL and Oracle query manifests are the only method-registry source.
- Existing structure snapshot and coverage-ledger hashes bind controller state.
- Every fixture-visible object has one explicit coverage state and every query
  coverage entry declares `absenceClaim=NOT_CLAIMED`.
- The monotonic seven-phase machine blocks invalid skips and blocks depth below
  95% breadth without an exact persisted bounded override.
- Hard run/object budgets, exact duplicate suppression, successful receipt reuse,
  state/coverage/receipt tamper rejection, timeout/cancel no-blind-retry behavior,
  and deterministic terminal reporting are covered by automated tests.
- Negative dispatch probes reject DDL/DML method IDs, free SQL fragments,
  out-of-scope identifiers, raw values and credentials.

## Deterministic fixture hashes

Two independently constructed runs per engine produced byte-equivalent canonical
terminal evidence hashes:

- MSSQL: `b07ff987efa1a693d37c9e091c7a231710d91bc8dd5c4294ecd8cf7d325f894d`
- Oracle: `7093df29859673daac81ea4b0126bc1bfdc449d1ae2c5b582f2071a38be06c8e`

Reproduce with:

```sh
KS_PRINT_PROGRESSIVE_HASHES=1 node --test tests/progressive-controller.test.mjs
```

## Non-claims

No production/customer source, live MSSQL/Oracle depth query, new Oracle
aggregate method, provider/model call, free SQL, raw-value evidence, deployment,
advanced near-duplicate/EIG planner or full hypothesis ledger is claimed.
