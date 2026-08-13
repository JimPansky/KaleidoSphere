# M2 Oracle Technical Inventory Evidence

Recorded: 2026-08-13

## Scope

M2 extends the Oracle live analyzer from runtime foundation to technical
metadata inventory. It does not sample business rows and does not run `COUNT(*)`
over source tables. Missing privileges are represented in the coverage ledger
instead of being inferred as empty object absence.

## Local isolated Oracle Free proof

- Oracle image: `gvenzl/oracle-free:23.26.2-slim-faststart`
- Container: `sba-m2-oracle-free-20260813`
- Host port: `127.0.0.1:15521`
- Compose proof network alias: `oracle-m2-free`
- Fixture schema: `BI_DEMO`
- Analyzer principal: `BI_ANALYZE`
- Fixture template: `tests/oracle-m2-live-fixture.sql`
- Existing M0 containers were left running on ports `18088/18790`; M2 proof used `18188/18890`.

Fixture object categories exercised:

- tables, view, materialized view, sequence, synonym
- generated identity/default/comment metadata
- PK, FK, unique and check constraints
- index and range partition metadata
- LOB metadata and tablespace distribution
- optimizer statistics and labelled size/block metadata
- package, package body, function, procedure, trigger and type metadata
- scheduler program/schedule/job metadata
- DB-link collector contract with credential-free output

## Analyzer evidence

Direct host analyzer run:

- Snapshot SHA-256: `e8d5092349d20f7f68939448868514d24b08ffac0986753218e795c3ee5c0154`
- Query pack version: `1.1.0`
- Coverage: 24/24 `SUCCEEDED`, 0 `DENIED`, 0 `ERROR`, 0 `TIMEOUT`

Docker agent/control run:

- Receipt ID: `oracle-c68a490343a57b66bfd9579b`
- Snapshot SHA-256: `9cb4aa0fed5833323bf7fe21956db9a73fb367c5a055981d3c45ec50dd98e9f4`
- Runtime validation: `RUNTIME_VALIDATED`
- Coverage: 24/24 `SUCCEEDED`
- Superset publication: `PUBLISHED_IDEMPOTENT`
- Publication counts: 2 datasets, 5 charts, 1 dashboard, 17 detail rows
- Readback: `chimpmaera.bi/readback/v1`, 17 detail rows, source engine `oracle`, source mode `live`

Visible row counts in the Docker receipt:

- identity: 1
- rights: 11
- capability probes: 6
- schemas: 1
- relations: 5
- columns: 17
- comments: 21
- constraints: 18
- indexes: 7
- sequences: 1
- synonyms: 1
- partitions: 3
- LOBs: 1
- tablespace distribution: 1
- table statistics: 6
- index statistics: 0 visible rows
- labelled size metadata: 13
- materialized-view refresh: 1
- stored objects: 4
- stored arguments: 5
- stored errors: 0 visible rows
- stored dependencies: 3
- scheduler metadata: 1
- DB links: 0 visible rows

## Safety probes

- `npm test`: 14/14 passing, including MSSQL fixture regression.
- Oracle M2 query pack audit: 24/24 SELECT-only catalog collectors.
- Scope filters are compiled with driver binds; tests assert the scoped schema is not interpolated into SQL text.
- Mutation probes reject `DELETE` and multi-statement SQL.
- Coverage tests assert `DENIED` means invisible and `ERROR` means unknown; neither is treated as empty success.
- Redaction tests assert no raw source, trigger body, scheduler action, DB-link username/password or raw host output columns.
- Source-map test verifies updated tracked file SHA-256 values.

## M2 nonclaims

M2 does not provide M3 searchable knowledge catalog, guided BI discovery,
dynamic datasets/charts/dashboards, full PL/SQL parser, dynamic-SQL lineage,
count-all, grant audit, AWR/ASH/performance analysis, SSO, HA, Kubernetes,
generic multi-database framework, bundled LLM/GPU operation, or production
readiness.
