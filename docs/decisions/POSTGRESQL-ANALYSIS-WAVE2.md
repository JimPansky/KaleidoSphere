# PostgreSQL Analysis Wave 2

## Decision

KaleidoSphere extends the v0.10.0 PostgreSQL read-only structure pilot with an
additive, opt-in analysis vertical. Explicitly allowlisted columns receive
deterministic row/null/distinct counts. Candidate pairs are limited to exact
column-name and native-type matches against declared single-column primary or
unique targets; already declared foreign keys are excluded.

The runtime persists three claim layers separately:

1. `OBSERVED`: structure/profile/overlap aggregate Evidence.
2. `COMPUTED`: deterministic overlap and target-coverage scores.
3. `INFERRED`: review-required relationship proposals with confidence,
   limitations, Evidence references, and no execution/mutation authority.

The result composes a content-addressed `kaleidosphere.analysis/evidence-store/v1`,
an authority-free rule plan, and machine/human reports. A closed reaction
contract permits only enumerated proposal actions against registered methods,
known Evidence hashes, and a retry budget. It performs no provider call.

## Safety contract

- Existing PostgreSQL read-only connection/session proof and bounded timeouts.
- Versioned, hash-bound, single-statement aggregate templates; no caller SQL.
- Runtime identifiers come only from the validated profile scope and canonical
  structure Evidence, then pass strict PostgreSQL identifier validation/quoting.
- No DDL/DML/EXEC/COPY/multiple statements.
- No source-row material, minima/maxima, distributions, labels or examples in
  accepted Evidence/reports.
- Fail closed on target/type/scope/budget/hash/result/timeout errors; no partial
  Evidence is returned as accepted.
- Candidate and reaction outputs remain proposal-only with authority `NONE`.

## Autonomous assumption, risk and fallback

- Assumption: exact column-name/native-type matching plus aggregate distinct
  overlap is the smallest useful relationship-candidate heuristic for this wave.
- Risk: equality overlap can be coincidental and one snapshot can hide temporal
  or semantic differences; aggregate scans may be expensive on large tables.
- Guard: explicit targets, small query/candidate budgets, statement timeout,
  single-column declared unique targets, confidence threshold, limitations and
  mandatory review.
- Fallback/rollback: disable/omit `policy.postgresqlAnalysis`, close the feature
  PR before merge, or reviewably revert the Wave 2 commits. The v0.10.0 structure
  path remains independent and no canonical history rewrite is needed.
- Review marker: validate later against representative non-production data
  before widening types, composite keys, query budgets, runtime activation or
  production claims.

## Evidence

- Focused positive/negative contract tests cover hash/scope/sensitivity/type,
  declared-FK deduplication, low-overlap rejection, Evidence/plan binding, and
  reaction budget/shape denial.
- The existing isolated digest-pinned PostgreSQL E2E harness runs Wave 2 twice
  through fresh credentials/read-only sessions. Canonical results are
  byte-identical at `e907b98ee1049fae4456cb74195727e1cde63adae304e1817a5820b419906d70`.
- The E2E observes 3 profiles, evaluates 1 pair, and retains 4 observed, 1
  computed and 1 inferred fact. The declared orders FK is not duplicated.
- Ground truth is unchanged; privacy counters and owned container/network/volume
  counts are zero; preexisting Docker inventory and Gateway state are unchanged.

## Non-claims

No production/customer database, product activation, automatic FK/DDL, free
SQL, live LLM/provider, HA/performance/TLS/version breadth, composite/expression/
partial-key coverage, semantic relationship truth, deployment, or Superset
mutation is claimed.
