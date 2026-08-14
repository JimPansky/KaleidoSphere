# ChimpMaera BI — Guided BI Discovery M4

Portable single-host BI stack for one bounded use case: analyze a configured
MSSQL or Oracle database with a read-only account, keep a versioned safe
technical catalog, answer bounded technical database questions with evidence,
guide a BI requirements discovery dialog over that catalog, and idempotently
publish managed fixed overview dashboards into this repository's own Apache
Superset instance.

M4 builds on the M3 local technical catalog. Discovery sessions are local,
versioned, deterministic, auditable, and bound to the active M3 catalog snapshot.
The dialog records audience role, business questions, confirmed KPI candidates,
dimensions, time grain, filters/segments, drilldowns, freshness needs,
access/confidentiality, open assumptions, and explicit confirmation state. The
export is a human- and machine-readable BI Discovery Brief with catalog
provenance and coverage blind spots. M4 does not generate dynamic Superset
datasets, charts, dashboards, SQL, source queries, or source-row access.

The Oracle analyzer collects
read-only dictionary metadata for
schemas, tables, views, materialized views, columns, comments, constraints,
indexes, sequences, synonyms, partitions, LOBs, tablespace distribution,
statistics freshness, labelled size/block metadata, materialized-view refresh,
stored logic metadata, scheduler metadata, and credential-free DB-link metadata
where visible. M3 persists the safe receipt metadata into a local SQLite catalog
and adds deterministic search and technical Q&A. Coverage states are
authoritative: `SUCCEEDED`, `PARTIAL`, `DENIED`, `TIMEOUT`, and `ERROR`/unknown
are preserved per collector. A missing privilege is never reported as object
absence.

## Quickstart

Requirements: Docker Engine with Compose v2, OpenSSL, and ports `18088` and
`18790` free on localhost.

```bash
git clone https://github.com/JimPansky/Superset_BI_Agent.git
cd Superset_BI_Agent
cp .env.example .env
./bin/bi setup
./bin/bi up
```

Open:

- Superset: <http://127.0.0.1:18088>
- BI Agent: <http://127.0.0.1:18790>

The Superset navigation includes a visible **BI Agent** link. Sign in as
`analyst`; its generated local password is stored in
`.runtime/secrets/superset_analyst_password` (mode `0600`). The admin user is
`cm_admin`; its password is stored beside the analyst password. Password values
are never printed by the scripts.

In the Agent UI use: **Analysiere die konfigurierte Datenbank**. The normal path
is `status → analyze → catalog ingest → publish → readback`. A successful
response contains the receipt ID, local catalog provenance, and managed dashboard
URLs. Repeating the same flow updates the same fixed datasets, charts, and
dashboards; it does not create duplicates.

CLI equivalent:

```bash
./bin/bi analyze
./bin/bi ask "Largest tables by size"
./bin/bi search orders
./bin/bi discovery start sales_review
./bin/bi discovery answer sales_review audienceRole "Sales analyst"
./bin/bi discovery answer sales_review businessQuestions '["Which order value should be watched weekly?"]'
./bin/bi discovery status sales_review
./bin/bi down
```

After a successful analysis, the Agent accepts bounded technical questions such
as:

```text
Status
Suche orders
Largest tables by size
Row estimates and stale statistics
Object inventory and compile problems
Dependencies object ORDERS
Stored logic signatures
Scheduler and MV refresh overview
Coverage blind spots
BI relevance candidates
Discovery start sales_review
Discovery answer sales_review audienceRole "Sales analyst"
Discovery confirm sales_review
Discovery export sales_review
```

Answers are deterministic local catalog answers. They include receipt ID,
snapshot SHA-256, object identifiers, and collector coverage caveats. The Q&A
path never sends free SQL to the source database and never queries the source
database after the catalog is built.

Discovery suggestions are also deterministic and catalog-bound. KPI, dimension,
time, and drilldown candidates are derived only from local catalog rows and each
technical reference includes receipt, snapshot, engine, database, query, category
and object/column provenance. If a collector is denied, partial, stale, timed out
or unknown, the exported brief carries that as a blind spot instead of inventing
semantics.

## Select and configure the source engine

Choose exactly one engine. The existing MSSQL path remains available:

```dotenv
BI_ENGINE=mssql
BI_SOURCE_MODE=live
MSSQL_HOST=db.example.internal
MSSQL_PORT=1433
MSSQL_DATABASE=MyDatabase
MSSQL_USER=chimpmaera_bi_reader
MSSQL_SCHEMAS=dbo,sales
MSSQL_ENCRYPT=true
MSSQL_TRUST_SERVER_CERTIFICATE=false
```

Put only the password in `.secrets/mssql_password` and keep the file mode
`0600`. The supplied account must have no INSERT, UPDATE, DELETE, ALTER, or
CONTROL permission in the database. The live preflight checks those permissions,
uses the MSSQL driver's `readOnlyIntent`, binds the exact database/schema scope,
and then executes only the shipped audited SELECT catalog query pack. Any
mismatch or missing credential fails closed. Superset never receives MSSQL
credentials and never connects directly to the source.

Oracle uses `node-oracledb` 7 in Thin mode; no Oracle Client libraries are
installed. `ORACLE_DATABASE` is the expected `DB_UNIQUE_NAME`, while
`ORACLE_SERVICE_NAME` is the exact service/PDB and expected `CON_NAME`:

```dotenv
BI_ENGINE=oracle
BI_SOURCE_MODE=live
ORACLE_HOST=oracle.example.internal
ORACLE_PORT=2484
ORACLE_DATABASE=MYDB
ORACLE_SERVICE_NAME=ANALYTICSPDB
ORACLE_USER=BI_ANALYZE
ORACLE_SCHEMAS=SALES,FINANCE
ORACLE_PROTOCOL=tcps
ORACLE_TLS_SERVER_DN=CN=oracle.example.internal
ORACLE_CONNECT_TIMEOUT_MS=10000
ORACLE_QUERY_TIMEOUT_MS=10000
```

Put only the password in `.secrets/oracle_password`, mode `0600`. The analyze
principal must have `CREATE SESSION` and only `SELECT`/`READ` object privileges
inside the declared schemas. The preflight verifies database, service/PDB,
schema visibility, enabled system privileges, direct object privileges, and
enabled-role object privileges; a known DML, DDL, administrative, or out-of-scope
capability fails closed. Transport encryption is the Oracle equivalent of the
MSSQL encryption options: `tcps` plus the endpoint certificate policy. Plain
`tcp` is appropriate only for an independently trusted local/test network.

Both live adapters use a bounded pool/connection lifecycle and timeouts. The
runtime executes only shipped, audited catalog `SELECT` statements, with schema
filters compiled as driver binds. There is no raw SQL, prompt-SQL, source-row
sampling, DML, or DDL surface. For Oracle M2/M3, scoped `EXECUTE` grants are
accepted only as stored-logic metadata visibility; the analyzer never invokes
packages, procedures, functions, triggers, scheduler programs, or database
links.

Oracle source safety: PL/SQL, view, trigger, scheduler action, compile-error
text, comments, DB-link username/password, and DB-link raw hosts are not sent to
the agent, Superset, public artifacts, or an LLM. Public/agent-facing metadata
uses hashes, line counts, status, signatures, dependencies, timing/status
fields, and explicit blind-spot labels for wrapped code and dynamic SQL.

The default `BI_SOURCE_MODE=fixture` is a portable deterministic MSSQL analyzer
fixture. It proves the agent/tool/materialization path, but it is explicitly
`SYNTHETIC_UNVALIDATED` and is not live-database evidence.

## Optional OpenAI-compatible provider

The containerized agent works offline with `LLM_MODE=stub` for deterministic
tool-invocation E2E. To use an existing OpenAI-compatible service, set:

```dotenv
LLM_MODE=openai-compatible
LLM_BASE_URL=https://provider.example/v1
LLM_MODEL=provider-model-id
```

Put the key in `.secrets/llm_api_key`. No model weights are bundled. The model
may classify only `ANALYZE`, `STATUS`, or `DENY`; catalog search and technical
Q&A plus BI Discovery use deterministic local routing. The agent itself retains
the closed tool allowlist. Raw SQL, credentials, prompt-injection strings,
writes, raw source requests, Superset mutation requests, and unknown actions are
rejected before any tool call.

## Security boundary

- Both source adapters are read-only; query packs contain bounded
  catalog SELECTs and no source row samples.
- `bi-agent` has network access only to the public UI network and internal
  `bi-control`; it has no source-database route or Superset mutation token API.
- `bi-control` is the only source-network member. Superset mutation crosses a
  token-bound internal endpoint and affects only this stack's metadata/projection
  directories.
- Superset's managed database has `allow_dml=false` and
  `expose_in_sqllab=false`. The analyst role strips SQL Lab/database/dataset
  write surfaces. M3 fixed technical dashboards read only catalog/projection
  tables, not Oracle/MSSQL source connections.
- M4 Discovery persists only local requirements state in the projection
  database. It does not call Superset materialization and does not query the
  source database after catalog ingestion.
- Containers are unprivileged, read-only, capability-dropped, have no Docker
  socket, and expose only the Superset and Agent localhost ports.
- Secrets are Docker file secrets backed by gitignored mode-0600 files.

## Operations and recovery

`./bin/bi setup` is idempotent and preserves existing secrets. `./bin/bi down`
stops only this Compose project and retains metadata/receipts. A destructive
local reset requires the explicit command:

```bash
./bin/bi reset --yes-i-understand
```

It removes only this repository's generated metadata, projections, receipts,
local Discovery sessions, and internal passwords. `.env` and external
source/provider secret files remain.

## Evidence and limits

Run local gates with `npm test`, `docker compose config --quiet`, and
`./tests/smoke.sh` after the stack is up. Clean-room instructions and recorded
evidence are in [docs/CLEAN_ROOM.md](docs/CLEAN_ROOM.md). M3 evidence is recorded
in [docs/evidence/M3_LOCAL_TECHNICAL_CATALOG.md](docs/evidence/M3_LOCAL_TECHNICAL_CATALOG.md);
M4 evidence is recorded in
[docs/evidence/M4_GUIDED_BI_DISCOVERY.md](docs/evidence/M4_GUIDED_BI_DISCOVERY.md).

M4 is a guided BI Discovery and requirements-brief increment over the local
technical catalog, not a semantic modeling or dashboard generation platform.
Dynamic user-confirmed datasets/charts/dashboards, free prompt SQL, arbitrary
SQL Lab, source DB query during Q&A or Discovery, raw business rows, raw
PL/SQL/view source, full dynamic-SQL lineage/parser, count-all, full grant audit,
AWR/ASH/performance analysis, SSO, HA, Kubernetes, generic multi-database
framework, bundled LLM/GPU operation, and production readiness belong outside
M4. The next boundary is M5: reviewed materialization from a confirmed M4 brief.

Release boundary: M4 is released only by protected-main merge plus regular
non-draft/non-prerelease GitHub release. The planned release is `v0.5.0`, with
installable archive and portable SHA-256 checksum assets. Existing tags and
assets are never replaced.
