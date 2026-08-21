# Security

KaleidoSphere is designed for governed first-pass database understanding,
not broad database automation. The trust boundary is narrow by default: collect
safe metadata, store local evidence, answer from the catalog, and keep source
data and credentials out of models and Superset source connections.

## Threat boundary

The stack assumes a local operator controls the checkout, Docker daemon, `.env`,
and gitignored secret files. It does not claim multi-tenant isolation, hostile
host containment, production HA, SSO, or managed service operation.

Primary risks addressed by the current design:

- accidental source-row exposure
- prompt-SQL or raw SQL execution
- source credential leakage to Superset, LLM providers, logs, or public files
- overclaiming missing privilege as object absence
- unreviewed dynamic Superset mutation
- stale or incompatible Superset runtime assumptions before future promotion
  planning

## Source database restrictions

Live adapters execute only shipped audited metadata or aggregate-count SELECT
templates. They use declared database/schema/column scope, driver binds where
values exist, strictly validated/quoted allowlisted identifiers, bounded
timeouts, and read-only principals.

The analyzer rejects or fails closed on unsafe configuration, scope mismatch,
known DML/DDL/admin capability, malformed schema scope, unsupported engine, or
missing credentials. Missing, denied, partial, timed-out, errored, stale, or
unknown collectors are preserved as coverage evidence instead of being converted
into object absence.

## Source-data exclusion

The current stack does not persist source business rows. The opt-in PostgreSQL
Wave 2 module performs count-all/null/distinct and bounded equality-overlap scans
only for explicitly allowlisted columns; source values are evaluated inside
PostgreSQL but only aggregate integer counts cross the database boundary. It
does not persist minima, maxima, distributions, labels, examples, or row
material. The stack does not expose raw PL/SQL, view text, trigger body, scheduler action text,
compile error text, DB-link username/password, raw DB-link host, source
credentials, or provider keys to the agent, Superset, public artifacts, or an
LLM. Public and agent-facing metadata uses identifiers, hashes, line counts,
status, signatures, dependencies, timing/status fields, and explicit blind-spot
labels where necessary.

## LLM restrictions

`LLM_MODE=stub` is the default and works offline. If
`LLM_MODE=openai-compatible` is configured, the provider may classify only
`ANALYZE`, `STATUS`, or `DENY`. Unknown actions, writes, raw SQL, source-row
requests, credentials, prompt-injection text, and Superset mutation requests are
rejected before tool calls.

Catalog search, technical Q&A, BI Discovery suggestions, brief export,
proposal/readback, Superset fingerprint logic, and promotion-bundle
build/inspect/preflight are deterministic local code paths.

PostgreSQL Wave 2 also defines a closed error-reaction proposal contract for a
later optional agent. It accepts only registered method references, known
Evidence Store hashes, enumerated reason/action pairs, and bounded retry counts.
Validation grants no query, execution, mutation, DDL, or provider-call authority.

## Superset boundary

Superset reads only the local projection database. It does not receive Oracle or
MSSQL credentials and does not connect directly to source databases.

Persistent Superset work is managed only through the exact trusted
preview/direct-UI-approval/apply/readback/rollback workflow. Public analyze and
the external v2 client do not call the materializer. The promotion-bundle CLI
produces an offline, review-only ZIP and cannot grant authority. Dynamic assets,
imports and exports retain synthetic/local nonclaims.

The v2 attestation is runtime-generated, canonical-digest-bound and exact about
product/contract versions and capabilities. Every intent response repeats that
identity and has its own digest. Wrong versions, missing capabilities, malformed
or tampered responses, unsafe fields and direct mutation intents fail closed.

The additive external capability manifest is deterministic and contains only
the six already-allowed actions. Consumers must bind it to the exact current v2
attestation; an internally consistent manifest for an older product/contract or
attestation is stale and denied. Unknown, missing, duplicated, action-drifted or
byte-tampered capabilities are denied before tool registration or dispatch.

The Superset runtime fingerprint is read-only. It records sanitized target
identity, runtime version, OpenAPI canonical hash, feature-flag capability
status, provenance, freshness, compatibility verdict, limitations, and
nonclaims. Fingerprint collection does not call the materializer or write
Superset metadata.

Promotion ZIP inspection rejects traversal, absolute/backslash paths, duplicate
paths, symlinks, multidisk/trailing archives, unsupported encodings, overlapping
entries, invalid local/central headers, CRC mismatch, excess archive/entry/count/
ratio limits, unlisted files, missing required files, noncanonical JSON/YAML,
hash drift, UUID/reference drift, stale/incompatible fingerprints, raw SQL,
source rows, credentials, connection URIs, and secret-like values. Mandatory
SHA-256 checksums establish integrity, not signer authenticity; v1 is explicitly
unsigned. Every inspection and preflight result reports
`mutation_performed=false`.

## Network and container controls

- Public ports bind to `127.0.0.1`.
- `bi-agent` can reach only the frontend and internal control networks.
- `bi-control` is the only service with source-egress network access.
- The control network is internal.
- Containers run unprivileged, capability-dropped, with no Docker socket.
- Runtime state and secrets are stored under gitignored local directories.

## Secrets

Secrets are file-based Docker secrets:

- `.secrets/mssql_password`
- `.secrets/oracle_password`
- `.secrets/llm_api_key`
- `.runtime/secrets/*`

Keep them mode `0600`. Do not copy secret values into `.env`, README examples,
issue comments, logs, release artifacts, screenshots, source-map files, or test
fixtures.

## Reset and destructive actions

`./bin/bi down` stops only this Compose project and keeps local state.

The destructive command is intentionally explicit:

```bash
./bin/bi reset --yes-i-understand
```

It removes generated metadata, projections, receipts, and internal passwords for
this repository. It does not delete `.env` or external source/API secret files.

## Operational note

Before using live database mode, verify least-privilege grants independently and
treat the first run as evidence collection. The fixture quickstart is useful for
local validation but remains `SYNTHETIC_UNVALIDATED`.

## Assistant contract security boundary

The inactive M6-00 foundation uses fail-closed versioned envelopes, payload
digests, sensitivity/redaction facts, static built-in plugin digests, exact
capability dependencies, monotone mandatory guards, and one-shot approvals
bound to arguments, resources, policy, capability, execution, trusted UI, and
expiry. A denial cannot be overridden by a later allow. An uncertain side-effect
outcome is `outcome_unknown` and cannot be blindly retried.

Runtime plugin installation, URLs/packages/filesystem paths, dynamic imports,
HMR/watchers, arbitrary MCP servers, direct DOM/JavaScript agent control, raw
secrets, source rows, unredacted PII, and chain-of-thought storage are denied by
the contract/tests. Persistent Superset changes cannot be voice-approved or
applied by the in-memory stub. No live credentials or external provider are
needed for the M6-00 evidence.
