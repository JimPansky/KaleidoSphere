# ChimpMaera BI — standalone Docker M0

Portable single-host BI stack for one bounded use case: analyze a configured
MSSQL database with a read-only account, keep a versioned analysis receipt, and
idempotently publish a managed dataset, KPI overview, and drill view into this
repository's own Apache Superset instance.

## Quickstart

Requirements: Docker Engine with Compose v2, OpenSSL, and ports `18088` and
`18790` free on localhost.

```bash
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

In the Agent UI use: **Analysiere die konfigurierte Datenbank**. The agent calls
only `status → analyze → publish → readback`. A successful response contains the
receipt ID and the managed dashboard URL. Repeating the same flow updates the
same two datasets, five charts, and one dashboard; it does not create duplicates.

CLI equivalent:

```bash
./bin/bi analyze
./bin/bi down
```

## Configure a live MSSQL source

M0 supports MSSQL only. Edit `.env`:

```dotenv
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
may classify only `ANALYZE`, `STATUS`, or `DENY`; the agent itself retains the
closed tool allowlist. Raw SQL, credentials, prompt-injection strings, writes,
and unknown actions are rejected before any tool call.

## Security boundary

- The source adapter is MSSQL-only and read-only; query packs contain bounded
  catalog SELECTs and no source row samples.
- `bi-agent` has network access only to the public UI network and internal
  `bi-control`; it has no source-database route or Superset mutation token API.
- `bi-control` is the only source-network member. Superset mutation crosses a
  token-bound internal endpoint and affects only this stack's metadata/projection
  directories.
- Superset's managed database has `allow_dml=false` and
  `expose_in_sqllab=false`. The analyst role strips SQL Lab/database/dataset
  write surfaces.
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
and internal passwords. `.env` and external source/provider secret files remain.

## Evidence and limits

Run local gates with `npm test`, `docker compose config --quiet`, and
`./tests/smoke.sh` after the stack is up. Clean-room instructions and recorded
evidence are in [docs/CLEAN_ROOM.md](docs/CLEAN_ROOM.md).

This is a packaging M0, not a generic multi-database or production platform:
no Oracle adapter, SSO, HA, Kubernetes, alerting, bundled LLM, GPU requirement,
or production-readiness claim.
