# Configuration

KaleidoSphere is configured with `.env` plus gitignored file secrets. Start
from the portable fixture mode, then switch to exactly one live engine when a
read-only source account is ready.

## Fixture mode

`.env.example` defaults to:

```dotenv
BI_ENGINE=mssql
BI_SOURCE_MODE=fixture
LLM_MODE=stub
```

Fixture mode uses committed synthetic MSSQL metadata. It validates the local
agent, analyzer, catalog, Discovery, proposal, readback, and
fingerprint paths without an external database or API key. Fixture evidence is
reported as `SYNTHETIC_UNVALIDATED` and must not be treated as live database
evidence.

## Runtime files

Run:

```bash
cp .env.example .env
./bin/bi setup
```

`./bin/bi setup` creates:

- `.runtime/secrets/superset_secret_key`
- `.runtime/secrets/superset_admin_password`
- `.runtime/secrets/superset_analyst_password`
- `.runtime/secrets/control_token`
- `.secrets/mssql_password`
- `.secrets/oracle_password`
- `.secrets/llm_api_key`

All secret files must stay mode `0600`. Do not put credentials in `.env`, logs,
command arguments, screenshots, issue bodies, or commits.

## Local ports

Default localhost ports:

```dotenv
SUPERSET_PORT=18088
AGENT_PORT=18790
```

Change them in `.env` if the ports are already in use. The stack binds public
ports to `127.0.0.1` only.

## External API v2

Clients configure only the SBA agent URL, for example
`http://127.0.0.1:18790`. They first read `GET /v2/capabilities`, verify product
`v0.14.0`, contract `2.0.0`, the required capability set and the canonical
attestation digest, then send closed requests to `POST /v2/intents`.

Do not configure a source database URL, Superset URL, DB credential or Superset
credential in PANSPHAIRA. Those remain KaleidoSphere-owned runtime configuration and file
secrets. Missing or incompatible SBA makes BI unavailable; it does not widen a
fallback path.

## Microsoft SQL Server

Set:

```dotenv
BI_ENGINE=mssql
BI_SOURCE_MODE=live
MSSQL_HOST=db.example.internal
MSSQL_PORT=1433
MSSQL_DATABASE=Analytics
MSSQL_USER=bi_readonly
MSSQL_SCHEMAS=dbo,sales
MSSQL_ENCRYPT=true
MSSQL_TRUST_SERVER_CERTIFICATE=false
MSSQL_QUERY_TIMEOUT_MS=10000
```

Put the password only in `.secrets/mssql_password`.

Least-privilege expectations:

- The principal can connect only to the selected database.
- The principal has read visibility for the declared schemas.
- The principal has no `INSERT`, `UPDATE`, `DELETE`, `ALTER`, `CONTROL`, owner,
  administrative, or out-of-scope capability.
- The adapter uses the MSSQL driver's `readOnlyIntent`.
- Schema filters are compiled as driver binds.

Use `MSSQL_ENCRYPT=true` and `MSSQL_TRUST_SERVER_CERTIFICATE=false` for normal
TLS validation. Trusting a server certificate is appropriate only for a
controlled local/test network.

## Oracle

Oracle uses `node-oracledb` Thin mode. No Oracle Client libraries are installed.

Set:

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

Put the password only in `.secrets/oracle_password`.

`ORACLE_DATABASE` is the expected database name. `ORACLE_SERVICE_NAME` is the
exact service/PDB and expected container name. Use `tcps` and
`ORACLE_TLS_SERVER_DN` when endpoint certificate policy requires DN matching.
Plain `tcp` is appropriate only for an independently trusted local/test network.

Least-privilege expectations:

- The principal has `CREATE SESSION`.
- The principal has only `SELECT` or `READ` object privileges inside declared
  schemas.
- Known DML, DDL, administrative, or out-of-scope capabilities fail closed.
- Scoped `EXECUTE` grants are accepted only for stored-logic metadata
  visibility; packages, procedures, functions, triggers, scheduler programs,
  and database links are never invoked.

## Bounded PostgreSQL Wave 2 profile

PostgreSQL remains an explicitly bounded programmatic/E2E analysis path rather
than a `BI_ENGINE` product activation. A runtime analyze profile may opt in with
`policy.postgresqlAnalysis`. The policy must enumerate every
`schemaName`/`relationName`/`columnName` target, a disjoint sensitive-target
denylist, small profile/candidate/query/timeout budgets, exact-column-name
relationship matching, and disclosure flags that are all `false` for row
values, examples, and distributions.

The adapter password is named only through `adapter.passwordEnv`; the secret
value remains process-local. Identifiers are accepted only after they match the
declared profile scope and canonical structure Evidence. Omit the entire policy
to disable Wave 2. There is no CLI/free-SQL field, automatic FK creation,
provider call, Superset publication, or production activation in this release.

## Optional OpenAI-compatible provider

The deterministic default is:

```dotenv
LLM_MODE=stub
```

To use an existing OpenAI-compatible endpoint:

```dotenv
LLM_MODE=openai-compatible
LLM_BASE_URL=https://provider.example/v1
LLM_MODEL=provider-model-id
```

Put the API key only in `.secrets/llm_api_key`. Optional model use is limited to
classifying requests as `ANALYZE`, `STATUS`, or `DENY`. Catalog search,
technical Q&A, Discovery suggestions, Superset proposals, and fingerprint
logic remain deterministic local code.

## Superset fingerprint

Collect the runtime fingerprint while the stack is up:

```bash
./bin/bi superset-fingerprint collect
./bin/bi superset-fingerprint planning-gate "promotion zip import planning"
```

For deterministic offline fixture collection:

```bash
./bin/bi superset-fingerprint collect --fixture
```

The runtime path stores `.runtime/receipts/latest-superset-fingerprint.json`.
That file is local evidence and must not be edited by hand.

## Review-only promotion bundle

Prepare a JSON input containing the exact fields `discoveryBrief`,
`catalogEvidence`, `supersetFingerprint`, `assets`, and `createdAt`. The
Discovery brief must be an exported, confirmed
`chimpmaera.bi/discovery-brief/v1`; the fingerprint must be fresh and compatible.
Then run the offline control CLI:

```bash
./bin/bi promotion-bundle build --input review-input.json --output review.zip
./bin/bi promotion-bundle inspect --bundle review.zip
./bin/bi promotion-bundle preflight --bundle review.zip --human true
sha256sum -c review.zip.sha256
```

Build refuses to overwrite either output file. Keep generated review bundles
outside Git unless a deliberate disclosure review approves them. The commands
need Node 24 but do not require the Compose stack, source credentials, or a
Superset connection. `--now ISO-8601` exists only for deterministic fixture and
clean-room validation; normal use should rely on the current clock.

Asset specifications accept only `database`, `dataset`, `chart`, and
`dashboard` review identities with stable UUIDs, dependencies, and a bounded
`reviewSpec`. They are not Superset import YAML. Raw SQL, source rows,
credentials, connection URIs, secret-like values, dangling references, and
stale/drifted fingerprints fail closed.

## Reset

`./bin/bi down` stops the stack and keeps local state. A destructive local reset
requires:

```bash
./bin/bi reset --yes-i-understand
```

Reset removes this repository's generated metadata, projections, receipts, and
generated internal passwords. It does not remove `.env` or external source/API
secret files.

## M6-00 contract fixtures

The M6-00 assistant foundation has no environment variables, credentials,
network listeners, Compose service, feature flag, runtime plugin directory, or
activation command. Its static manifests and deterministic fixtures live under
`services/bi-control/fixtures/assistant-foundation/`; test them with:

```bash
node --test tests/assistant-foundation.test.mjs
```

Changing a built-in plugin artifact requires an intentional manifest and
expected-digest update plus a fresh resolved-config hash. There is no runtime
digest override or install source.
