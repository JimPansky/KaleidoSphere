# M4 Guided BI Discovery Evidence

Recorded: 2026-08-13

## Scope

M4 adds a guided BI Discovery dialog over the local M3 technical catalog. It is
a requirements-brief increment, not a materialization increment.

Implemented scope:

- Discovery state schema: `chimpmaera.bi/discovery-state/v1`.
- Response schema: `chimpmaera.bi/discovery-response/v1`.
- Export schema: `chimpmaera.bi/discovery-brief/v1`.
- Local lifecycle: start, resume, status, answer, revise, confirm, export.
- Persistent local state: `discovery_sessions` and `discovery_events` in the
  projection SQLite database.
- Required state fields: audience role, business questions, confirmed KPI
  candidates, dimensions, time candidate/granularity, filters/segments,
  drilldowns, freshness need, access/confidentiality, open assumptions, and
  explicit confirmation status.
- Agent and CLI path: `Discovery ...` chat commands plus
  `./bin/bi discovery ...`.

## Safety Properties

- Discovery suggestions are derived only from local M3 catalog/projection tables.
- Every technical suggestion carries receipt ID, snapshot SHA-256, engine,
  database, query/category, and object/column provenance.
- Unknown or invalid actions, fields, session IDs, scopes, suggestion IDs,
  confirmation attempts, export formats, unsafe text, raw SQL, credentials, and
  prompt injection fail closed.
- Sessions are separated by `sessionId`; start is idempotent.
- A Discovery session is bound to the catalog snapshot active at start. If the
  active catalog changes, answer/confirm/export fail with
  `DISCOVERY_CATALOG_SNAPSHOT_MISMATCH` instead of leaking a newer session's
  evidence into an older brief.
- Export requires explicit confirmation and does not create Superset datasets,
  charts, dashboards, SQL, source queries, source-row samples, or semantic
  models.

## Local Proof

Command:

```bash
node --test tests/discovery.test.mjs
```

Observed result:

- 3/3 Discovery tests passing.
- Lifecycle proof covers start, answer, confirm, export, Markdown/JSON brief,
  M5 non-materialization boundary, and confirmation reset on post-confirm
  revision.
- Session proof covers idempotent start and cross-session state isolation.
- Negative proof includes 23 fail-closed probes:
  missing catalog, invalid session ID, unknown action, extra request key,
  invalid scope shape, cross-scope schema, missing session, unsupported field,
  unsafe SQL text, prompt injection, unknown KPI ID, wrong suggestion prefix,
  empty suggestion list, invalid time shape, invalid granularity, invalid access
  class, unconfirmed export, bad export format, non-explicit confirmation,
  incomplete confirmation, invalid revise body, corrupt persisted state, and
  stale snapshot mismatch.

## Full Evidence To Refresh For Release

Completed local release-candidate gates:

- Full `npm test`: 22/22 tests passing.
- `docker compose --env-file .env.example --file compose.yaml config --quiet`:
  passed.
- Shell syntax: `bash -n bin/bi tests/smoke.sh` passed.
- Secret-pattern scan over tracked source: no token/private-key/API-key matches.
- Runtime files created by Docker proof remained under gitignored `.runtime/` and
  `.secrets/`.

Fresh Docker fixture proof:

```bash
cp .env.example .env
COMPOSE_PROJECT_NAME=chimpmaera-bi-m4-smoke SUPERSET_PORT=18288 AGENT_PORT=18990 ./bin/bi setup
COMPOSE_PROJECT_NAME=chimpmaera-bi-m4-smoke SUPERSET_PORT=18288 AGENT_PORT=18990 ./bin/bi up
COMPOSE_PROJECT_NAME=chimpmaera-bi-m4-smoke SUPERSET_PORT=18288 AGENT_PORT=18990 ./tests/smoke.sh
COMPOSE_PROJECT_NAME=chimpmaera-bi-m4-smoke SUPERSET_PORT=18288 AGENT_PORT=18990 ./bin/bi down
```

Observed result:

- Stack became healthy on Superset `18288` and Agent `18990`.
- Smoke passed: `PASS agent->analyze->publish->Superset-readback twice; safety probes denied.`
- Smoke covered two analyze/publish/readback runs, catalog Q&A, catalog search,
  Discovery start/answer/confirm/export, fixed Superset readback counts, control
  port non-exposure, unsafe prompt denial, and unknown action denial.

Clean-room archive proof from committed candidate `5dfc773`:

```bash
git archive --format=tar --prefix=Superset_BI_Agent-v0.5.0/ HEAD > /tmp/sba-m4-clean-Wl22dh/source.tar
tar -xf /tmp/sba-m4-clean-Wl22dh/source.tar -C /tmp/sba-m4-clean-Wl22dh
cd /tmp/sba-m4-clean-Wl22dh/Superset_BI_Agent-v0.5.0
npm test
docker compose --env-file .env.example --file compose.yaml config --quiet
node scripts/build-release.mjs /tmp/sba-m4-clean-Wl22dh/dist
cp .env.example .env
COMPOSE_PROJECT_NAME=chimpmaera-bi-m4-clean SUPERSET_PORT=18388 AGENT_PORT=19090 ./bin/bi setup
COMPOSE_PROJECT_NAME=chimpmaera-bi-m4-clean SUPERSET_PORT=18388 AGENT_PORT=19090 ./bin/bi up
COMPOSE_PROJECT_NAME=chimpmaera-bi-m4-clean SUPERSET_PORT=18388 AGENT_PORT=19090 ./tests/smoke.sh
COMPOSE_PROJECT_NAME=chimpmaera-bi-m4-clean SUPERSET_PORT=18388 AGENT_PORT=19090 ./bin/bi down
```

Observed result:

- Clean-room `npm test`: 22/22 passing.
- Clean-room Compose config: passed.
- Clean-room archive builder worked from `.git`-free extracted source.
- Clean-room archive SHA-256:
  `23c504a93084330529de96332588bb13dee4cdedde4ca85ab491a216b3450def  Superset_BI_Agent-v0.5.0.tar.gz`
- Clean-room Docker smoke passed on Superset `18388` and Agent `19090`; stack
  was removed afterward.

Remaining release-only gates:

- Public PR/CI/protected merge/release asset and anonymous readback verification.

## Nonclaims

M4 does not infer business semantics from technical names. It offers
catalog-backed candidates and records confirmed interests. Dynamic BI object
generation belongs to M5 and must start from a confirmed M4 brief plus a separate
materialization gate.
