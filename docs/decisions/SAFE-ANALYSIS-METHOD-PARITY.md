# Safe-analysis method parity

Status: accepted for Issue #38.

## Decision

MSSQL and Oracle expose the same four semantic methods under versioned,
content-addressed manifests:

- `COLUMN_SUMMARY` for bounded row/null/distinct counts and a computed
  proposal-only single-column key candidate;
- `TEMPORAL_COVERAGE` for bounded count/range/freshness-maximum aggregates;
- `QUALITY_INDICATORS` for bounded null, distinct and duplicate metrics;
- `RELATIONSHIP_OVERLAP` for bounded pair counts, computed overlap, a
  proposal-only relationship candidate and retained counterevidence.

The pack is executable only after the existing Progressive Run Controller
authorizes the exact method, phase, scope, typed target and arguments. A
relationship target names two typed visible columns and debits both #36 object
budgets. When the #37 advanced layer is used, the exact persisted table and
hypothesis reservation is additionally required before the session executes.
Those debits are never refunded.

Every template is an audited aggregate-only `SELECT` or read-only CTE. A typed
`maxSourceRows` bind bounds each source side before aggregation. Output is one
row, timeout is at most 1.5 seconds, and the session contract must declare
read-only authority. SQL text, source values, examples, samples, labels,
credentials and connection strings are not request fields.

## Evidence semantics

Engine-specific results normalize into an engine-neutral semantic body and an
engine-specific envelope. Equivalent synthetic facts therefore have the same
semantic SHA-256 while dialect notes remain reviewable. Evidence always records
one of `COMPLETE`, `PARTIAL`, `DENIED`, `UNSUPPORTED` or `UNKNOWN`, plus
`absenceClaim: NOT_CLAIMED`.

Observed aggregates, computed metrics, inferred proposals and counterevidence
are separate arrays. An inferred key or relationship is never a catalog fact,
DDL plan or automatic constraint. Uniqueness failures and unmatched values
remove the proposal and remain counterevidence.

## Engine differences

- MSSQL uses `TOP (@maxSourceRows)` and `COUNT_BIG`; Oracle uses a
  `ROWNUM <= :maxSourceRows` bind and `COUNT`. Counts normalize to safe integers.
- MSSQL temporal output uses `datetime2` style 126. Oracle emits six fractional
  digits and leaves timezone meaning explicitly source-type-specific.
- Oracle native SQL Boolean columns are `UNSUPPORTED`; the implementation does
  not guess that `NUMBER(1)` is Boolean.

## Rejected alternatives

- Free SQL or generated SQL: rejected because it bypasses the manifest boundary.
- Unbounded full-table aggregates: rejected because timeout alone is not a row
  bound.
- Direct promotion of key/FK heuristics: rejected because bounded overlap is not
  semantic truth.
- Treating denied/unsupported as empty: rejected because privilege visibility is
  not evidence of absence.

## Rollback and non-claims

Rollback is a protected successor that removes the new manifests, methods and
pair-target support while retaining prior controller receipts. No production or
customer source, automatic FK/DDL, composite/universal key completeness,
semantic relationship truth, causal quality diagnosis, universal temporal
semantics, performance SLA, deployment or production certification is claimed.
