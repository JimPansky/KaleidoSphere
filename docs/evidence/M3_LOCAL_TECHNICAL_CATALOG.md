# M3 Local Technical Knowledge Catalog Evidence

M3 extends the M2 Oracle Technical Inventory into a local, versioned, searchable
technical catalog. The release boundary is technical database Q&A and fixed
technical Superset overviews only.

## Implemented scope

- Local SQLite catalog schema version:
  `chimpmaera.bi/local-technical-catalog/v1`.
- Ingestion source: M2 safe analysis receipts/projections only.
- Persisted metadata: systems/scope/schemas, relations, columns, comments,
  constraints, indexes, partitions, LOBs, tablespaces, statistics/capacity,
  stored objects/arguments/compile issues/dependencies, scheduler/MV/DB-link
  metadata, and per-collector coverage facts.
- Idempotency: same snapshot is `INSERT OR REPLACE` by snapshot/query/object
  identity; repeated ingestion does not duplicate rows.
- Supersession: latest ingested snapshot is marked `active=1`; older snapshots
  retain receipt and snapshot provenance.
- Q&A: deterministic local-only families for largest tables, row estimates and
  stale statistics, object inventory/validity, dependencies, stored logic
  signatures, scheduler/MV refresh, coverage blind spots, and deterministic
  technical BI candidates.
- Search: scoped catalog search with explicit schema scope and result budgets.
- Superset package: four fixed technical overview areas backed by catalog
  projection tables:
  - System & schema overview
  - Tables, estimates, freshness & capacity
  - Code, validity & dependencies
  - Coverage, errors & blind spots

## Safety properties

- No raw business rows are collected or persisted.
- No raw PL/SQL/view/source text, scheduler action text, compile error text,
  DB-link username/password, raw DB-link host, credentials, or secrets are
  exposed to the agent, Superset, public artifacts, or an LLM.
- Catalog Q&A uses only the local projection database after analysis; it does
  not query the source database and does not accept free SQL.
- Optional OpenAI-compatible classification remains limited to
  `ANALYZE`/`STATUS`/`DENY`; catalog routing is deterministic local code.
- Missing, denied, partial, timed-out, errored, stale, or ambiguous evidence is
  reported as caveated evidence, not converted into object absence.

## Local proof

From the committed M3 worktree:

```bash
npm test
docker compose config --quiet
```

Observed local result:

- `npm test`: 18/18 passing.
- M3 tests cover schema creation, idempotent ingestion, active snapshot
  supersession, scoped search, result budgets, evidence bindings, deterministic
  answers, coverage caveats, no source-DB Q&A, and negative probes for free SQL,
  unsafe terms, cross-scope access, nonexistent objects and unsupported
  questions.
- `docker compose config --quiet`: passed.
- Python runtime source compile gate in `tests/security.test.mjs`: passed,
  including the expanded Superset materializer.

## Isolated runtime proof

Fixture runtime proof used an isolated Compose project and non-default ports.
It proves the packaged agent/control/Superset/catalog path, but it is not a
live Oracle-Free source proof:

```bash
COMPOSE_PROJECT_NAME=chimpmaera-bi-m3-smoke SUPERSET_PORT=18188 AGENT_PORT=18890 ./bin/bi setup
COMPOSE_PROJECT_NAME=chimpmaera-bi-m3-smoke SUPERSET_PORT=18188 AGENT_PORT=18890 ./bin/bi up
COMPOSE_PROJECT_NAME=chimpmaera-bi-m3-smoke SUPERSET_PORT=18188 AGENT_PORT=18890 ./tests/smoke.sh
COMPOSE_PROJECT_NAME=chimpmaera-bi-m3-smoke SUPERSET_PORT=18188 AGENT_PORT=18890 ./bin/bi down
```

Observed result:

- Stack built and became healthy on Superset `18188` and Agent `18890`.
- Smoke passed: analyze twice, local catalog ingest, fixed Superset publication
  readback, technical catalog question, catalog search, prompt-injection/free SQL
  denial, unknown-tool denial, and host non-exposure of `bi-control`.
- Publication readback proved 6 managed datasets, 13 charts, 5 dashboards,
  3 detail rows, and the four fixed technical overview dashboard URLs.
- Post-run teardown check found no `chimpmaera-bi-m3-smoke` containers or
  networks. Generated runtime state was removed before packaging.

The default fixture is `SYNTHETIC_UNVALIDATED`; it proves the packaged
agent/control/Superset/catalog runtime path, not live customer/source evidence.

## Corrective release recovery

Public `v0.4.0` is functional and its archive digest matches the public GitHub
asset, but its checksum asset recorded an absolute local build path. It is
therefore superseded for anonymous installation by `v0.4.1`, which must use a
portable checksum line containing only the archive basename.

M3 is not called complete from fixture/M2 reuse alone. The terminal M3 state is
complete only after the `v0.4.1` release has a portable checksum asset and a
fresh isolated Oracle-Free M3 E2E proof exercises live Oracle metadata through
analyze, catalog ingest, fixed Superset publish/readback, all supported catalog
question families, search, fail-closed probes, idempotent re-ingest, and
teardown.

## Fresh Oracle-Free M3 proof for v0.4.1

Recovery proof used only disposable `sba-m3-v041-*` resources:

- Oracle image: `gvenzl/oracle-free:23.26.2-slim-faststart`.
- Oracle container/network: `sba-m3-v041-oracle-free`,
  `sba-m3-v041-oracle-net`; initially published only on
  `127.0.0.1:11523`, then connected to the isolated app `source_egress` network
  for container-name access.
- App Compose project/image tag: `sba-m3-v041-app`,
  `m3-v041-recovery`.
- Superset/Agent ports: `19088` / `19091`.
- Source scope: Oracle `FREE` / `FREEPDB1`, schema `BI_DEMO`, principal
  `BI_ANALYZE`.

Observed live result:

- Two full agent runs completed `status -> analyze -> catalog ingest -> publish
  -> readback -> catalog question` against live Oracle metadata.
- Receipt: `oracle-ff846836f1fe32bd633b2e0c`.
- Snapshot SHA-256:
  `5d4fbd23ad6501ea7b3d201817adefd30970cb91cc263be8cf42afc3290a783b`.
- Runtime validation/source mode: `RUNTIME_VALIDATED` / `live`.
- Re-ingest idempotency: repeated analyze produced the same receipt ID and
  snapshot SHA-256.
- Collector coverage: 24/24 succeeded, 24/24 `VISIBLE_COMPLETE`,
  `allComplete=true`, 24 extracts.
- Superset readback: 6 datasets, 13 charts, 5 dashboards, 17 detail rows,
  1 system/schema row, 5 table/capacity rows, 4 code/dependency rows,
  24 coverage rows, and 5 BI-candidate rows.
- After the second analyze/publish/readback, the Oracle container was stopped.
  With the source database unavailable, all eight supported catalog question
  families and catalog search still answered from the local catalog:
  largest tables (5 rows), row estimates/freshness (5), object inventory/validity
  (1), dependencies (1), stored logic signatures (1), scheduler/MV refresh (2),
  coverage blind spots (20), BI relevance candidates (5), and search (20).
- Fail-closed probes: raw SQL/prompt-injection, unknown tool, credential request,
  and SQL Lab/source-query prompt were denied with
  `AGENT_UNSAFE_INPUT_DENIED` or `AGENT_UNKNOWN_ACTION_DENIED`.
- Evidence leakage scan found only the denial-probe text and the documented
  fallback statement that secrets/job action text are not emitted; no secret
  values, raw business rows, raw PL/SQL/source text, scheduler action text, or
  credentials were recorded in public-facing evidence.

## Nonclaims

M3 does not implement guided stakeholder/KPI interviews, semantic-model
confirmation, dynamic user-confirmed Superset dataset/chart/dashboard
generation, free prompt SQL, arbitrary SQL Lab, source database query during
Q&A, raw business row sampling, raw PL/SQL/view source disclosure, full
dynamic-SQL lineage/parsing, count-all, full grant audit, AWR/ASH, SSO, HA,
Kubernetes, generic multi-database expansion, bundled LLM/GPU runtime, or
production readiness.
