# M1 Oracle Runtime Foundation evidence

Validation date: 2026-08-13. Base implementation merge: public `main`
`77aa962bc9eb386d954c38a085665c50742cfd85` from PR #2.

## Decision

All M1 implementation/runtime gates are closed. M1 is released only by a regular
GitHub release created after the protected-main release-truth correction lands.
The planned tag is `v0.2.0`, chosen conservatively because the pre-correction
package line was `0.2.0-m1` and GitHub API readback showed no existing tags or
releases before publication.

Assumption safety and rollback marker: `v0.2.0` must not replace any existing tag
or asset. If a conflicting tag or release appears before publication, stop the
release step, keep the merged correction, and choose the next non-conflicting
regular semver in a reviewed follow-up.

## Runtime evidence

- Disposable image: `docker.io/gvenzl/oracle-free:23.26.2-slim-faststart`
- Pulled manifest/image digest (amd64):
  `sha256:d8913e4e4769b6e60197949bef30a4391713afe662b4b4e71a2665c881bdac8b`
- Upstream image documentation/license notice:
  <https://github.com/gvenzl/oci-oracle-free>; use is subject to the Oracle Free
  container/image terms documented by that project and Oracle.
- Host gate before pull: 676 GiB disk available, about 72 GiB RAM available.
- Database/service/schema: `FREE` / `FREEPDB1` / `BI_DEMO`.
- Test schema: two tables, one view, primary/foreign/check constraints, one
  explicit index, one sequence, and one synonym. Two source rows per base table
  were present solely to prove that the analyzer returns no row samples.
- Analyze principal: `BI_ANALYZE`; `CREATE SESSION` plus `SELECT` on three
  relations and one sequence. No DML, DDL, administrative, cross-schema, or
  dictionary-wide grant.
- Driver: `oracledb` 7.0.1 Thin mode, bounded pool 0–2, per-connection call
  timeout, queue/connect timeout, deterministic connection/pool cleanup.

Agent → analyze → publish → readback result:

```text
receiptId: oracle-7c099b3114417f3a4af7981f
runtimeValidation: RUNTIME_VALIDATED
snapshotSha256: 8e58cec4da153d421cfcb00cb4ec535e9322df50e545af2e58ce4c1196ab9e34
query coverage: 9/9 SUCCEEDED; 0 ERROR/DENIED/TIMEOUT/PARTIAL
relations / columns / constraints / indexes / sequences / synonyms: 3 / 14 / 11 / 4 / 1 / 1
Superset readback: 2 datasets / 5 charts / 1 dashboard / 14 detail rows
source_read_only: 1
```

The nine runtime-validated queries were identity, rights, schemas, relations,
columns, constraints, indexes, sequences, and synonyms. Schema-bearing queries
were wrapped with `:scopeN` binds. Query-pack audit reports zero mutations and
zero row samples.

## Other gates

- `npm test`: 13/13 tests passed, including 28 numbered Oracle probes.
- `docker compose config --quiet`: passed for Oracle and fixture configurations.
- MSSQL portable fixture analyzer: passed and remained
  `SYNTHETIC_UNVALIDATED`.
- Source provenance: permitted Oracle pack bytes came read-only from public
  ChimpMaera commit `7a483ad9db76f6233b166874447693d28e8ac942`; `SOURCE-MAP.json`
  retains current and original SHA-256 values for derived bytes.
- Secret handling: password only in gitignored mode-0600 file; no password in
  profile/receipt, Compose environment, repository, commands captured as
  evidence, or logs. Leakage scan passed.
- Runtime cleanup: the disposable Oracle container and M1 Compose project were
  removed after evidence capture. Existing `chimpmaera-bi-m0-*` containers were
  not stopped, recreated, or attached to the M1 networks.

## M1 nonclaims and PDCA

Aggregate profiling and Stored Logic runtime are M2. Semantic model, guided
interview, and dynamic dashboards are M3–M5. None is implemented or claimed by
M1. No new UI, SSO, HA, Kubernetes, or generic multi-database framework was
introduced.

Evidence quality is direct live runtime plus deterministic receipt/readback,
not a synthetic substitute. The live run found and corrected two Oracle 23.26
compatibility assumptions (`Oracle AI Database` product naming and
`ALL_TAB_COLS` virtual-column visibility). Plan revision: no; the M1 scope and
M2 boundary remain sound. Next M2 step is bounded aggregate profiling and
Stored Logic discovery with separate budgets, evidence, and non-sampling gates.
