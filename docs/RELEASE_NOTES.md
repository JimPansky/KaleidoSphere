# Release Notes

## v0.18.8 - Deterministic synthetic tiny-fixture demo

Adds the K4e.5 Portable Companion synthetic demo: a deterministic local-only
composition of the released doctor, capability explorer, placeholder-template
validator and synthetic receipt-envelope verifier. A single closed tiny fixture
uses a fixed time and no runtime transport, network request or external source.
Two independent renders are byte-identical canonical JSON.

The root report and every status, guidance, template and receipt layer carry an
exact machine-readable `synthetic-only` classification and a human-readable
synthetic warning. Status is explicitly `RUNTIME_UNAVAILABLE`, guidance is
advisory, the template is placeholder-only, and the receipt result is
`VERIFIED_INTEGRITY_ONLY` with `synthetic-fixture-only` trust. Negative tests
fail closed for removed or altered synthetic labels, secret-looking values, raw
rows, customer-like identifiers, runtime dispatch, network requests, affirmative
live-evidence/runtime-observation claims and integrity drift.

This release is not live or customer evidence, a benchmark, runtime readback,
BI correctness, signing/evidence authority or a production claim. It adds no
database or provider payload, credential, real endpoint, generated private
data, free SQL, mutation/deploy authority, Superset/UI, Gateway/provider/model
activation, hosted/SaaS, remote-MCP or marketplace behavior.

## v0.18.7 - Signed portable receipt-envelope verifier

Adds the K4e.4 Portable Companion receipt-envelope verifier and explainer. The
offline-only utility accepts a closed, size-bounded synthetic envelope, verifies
an allowlisted Ed25519 detached signature, canonical payload digest, Portable
Companion contract binding, External API v2 capability-manifest binding,
repository source binding and strict freshness window.

Machine and human-readable output keep observed facts, computed facts, inferred
candidates and non-claims in separate arrays. Successful verification is
explicitly `VERIFIED_INTEGRITY_ONLY`: it proves local envelope integrity against
an explicitly supplied synthetic fixture public key, not runtime evidence, BI
truth, live observation or production trust. Negative tests fail closed for
missing or invalid signatures, unsupported algorithms, digest mismatch, stale
and future timestamps, wrong contract/capability/source bindings, oversized
input, malformed encodings and synthetic fixtures claiming live observation.

This release does not add runtime evidence creation, signing authority, remote
verification, network lookup, key retrieval, credentials, raw provider
payloads, arbitrary algorithms, mutable receipts, claim promotion, free SQL,
mutation/deploy/evidence authority, hosted/SaaS, remote-MCP, marketplace,
customer data, Gateway/provider/default-model/runtime activation, production
trust anchors or production-readiness claims.

## v0.18.6 - Secret-free profile-template validator

Adds the K4e.3 Portable Companion profile-template validator. The validator is
offline-only, accepts a closed placeholder template shape, emits deterministic
placeholder-only validation reports, and preserves the exact External API v2
runtime intent vocabulary: `status`, `discovery`, `analyze`, `plan`, `preview`
and `readback`.

Valid templates contain only environment-style placeholders and secret
references, with all dispatch, credential-value, arbitrary-endpoint, free-SQL
and raw-row constraints set to false. Negative tests fail closed for password,
API token, bearer token, DSN and private-key values, raw database endpoints or
arbitrary URLs, unknown profile keys, free SQL fields/text, runtime dispatch
requests and runtime-intent widening.

This release does not add credential storage, OAuth, live connection tests,
endpoint lookup, remote fetch, hosted catalogs, free SQL, raw rows/customer
payloads, provider payloads, runtime dispatch, Gateway/provider/default-model
activation, mutation/deploy authority, hosted/SaaS, remote-MCP, marketplace or
production-readiness claims.

## v0.18.5 - Digest-bound capability explorer

Adds the K4e.2 Portable Companion capability explorer for offline guidance over
the canonical External API v2 capability manifest. Every report binds to the
manifest version, manifest digest and source-map commit, and keeps the closed
runtime intent vocabulary unchanged at exactly `status`, `discovery`, `analyze`,
`plan`, `preview` and `readback`.

The explorer can list all six capabilities or select one by manifest id/action.
Its guidance is advisory only, marks dispatch as false, and requires separate
verified runtime receipts before any evidence claim. Negative tests fail closed
for unknown capability keys, manifest digest mismatch, stale manifest versions,
runtime-intent invocation from guidance, and live-evidence claims without a
receipt.

This release does not add runtime dispatch, arbitrary endpoint discovery,
remote fetch, hosted catalogs, credentials, free SQL, raw rows/customer payloads,
provider payloads, mutation/deploy authority, hosted/SaaS, remote-MCP,
marketplace or production-readiness claims.

## v0.18.4 - Portable Doctor readiness utility

Adds the K4e.1 Portable Doctor/readiness utility for the Portable Companion v1
contract. The doctor evaluates a small allowlisted local snapshot and reports
stable local-utility and runtime-availability statuses separately:
`READY_LOCAL_UTILITY` can be true while `RUNTIME_AVAILABLE` remains false.

The utility detects missing runtime, missing transport, stale capability
manifest, unsupported host bundle and partial local configuration without
starting services, following redirects, probing networks or collecting
credentials. Fixtures cover runtime-present, runtime-missing and partially
configured states. Negative tests fail closed for URL/redirect/network/
service-start requests, credentials or connection strings, unknown local fields
and false analysis/readback success claims when runtime is absent.

This release does not add runtime dispatch, arbitrary endpoint discovery,
credentials, free SQL, raw rows/provider payloads, mutation/deploy authority,
hosted/SaaS, remote-MCP, marketplace, customer-data or production-readiness
claims.

## v0.18.3 - Portable Companion contract foundation

Adds the K4e.0 Portable Companion v1 contract foundation under
`contracts/portable-companion/v1`. The contract is separately versioned,
offline-only, and keeps the External API v2 runtime intent set unchanged at
exactly `status`, `discovery`, `analyze`, `plan`, `preview` and `readback`.

The foundation defines a closed local utility vocabulary, compatibility matrix,
threat model/source map, claim classes and fail-closed validator. Tests cover
unknown actions and fields, schema/version/size/depth bounds, credential and
secret-looking values, free SQL, endpoint discovery, raw rows/provider payloads,
mutation/deploy/evidence claims, runtime-intent widening, and manifest/digest
drift. Reserved utility actions enable later #82-#88 slices without implementing
doctor, explorer, validator, receipt, demo, evidence inspector or cross-harness
behavior here.

This release does not add runtime dispatch, arbitrary endpoint discovery,
credentials, free SQL, raw rows/provider payloads, mutation/deploy authority,
hosted/SaaS, remote-MCP, marketplace, customer-data or production-readiness
claims.

## v0.18.2 - Single-source AgentSkill distribution

Adds deterministic single-source AgentSkill distribution generation for
ClawHub/OpenClaw/Hermes, Codex and Claude Code. The existing KaleidoSphere
AgentSkill bytes from applied Skill Workshop proposal
`kaleidosphere-20260821-e90f51c924` remain unchanged; host packages are thin
generated views only.

The release archive workflow now emits host-specific archives and SHA256
sidecars for public distribution. New tests cover byte equality, manifest
validity, deterministic rebuilds, archive safety, the closed action contract and
the ClawHub MIT-0 versus repository Apache-2.0 license boundary.

## v0.18.1 - External capability manifest foundation

Adds a deterministic, contract-versioned manifest at
`GET /v2/capability-manifest`. It projects only the existing six external
External API v2 capabilities and binds each action to its incumbent authority,
executable state, side-effect and evidence requirements. Canonical integrity and exact current
runtime-attestation validation reject tampered, stale, missing, duplicated,
unknown and action-drifted capabilities.

This is additive. `GET /v2/capabilities`, `POST /v2/intents`, API v2, all
harness paths and the DSH plugin remain unchanged. It adds no dynamic loading,
endpoint discovery, credentials, arbitrary SQL, raw rows or mutation authority.

## v0.18.0 - Governed multi-harness AgentSkill adapters

Packages the exact Skill Workshop-generated KaleidoSphere reference skill as
one shared AgentSkills core for OpenClaw, Hermes, Claude Code and Codex. The
only capability surface is the existing External API v2 action set: `status`,
`discovery`, `analyze`, `plan`, `preview` and `readback`. Host records contain
installation/discovery metadata only; they do not copy business logic.

The deterministic validator accepts all six safe action shapes and denies an
eleven-case widening matrix before dispatch. It rejects extra tools, trusted
apply, free SQL, arbitrary URLs, credentials, raw rows, malformed requests,
non-empty read-only inputs, stale contracts, unknown discovery commands and
invalid request IDs. Visual taste guidance is advisory only: it is rejected as
PanSphaira HMI implementation authority, adapted for internal visual review,
and adapted for presentation clarity without becoming a BI truth or evidence
judge.

OpenClaw is runtime-discovered locally. The current AgentSkills installer was
round-tripped for Codex and Claude Code in a disposable project with an empty
post-removal skill lock. Hermes is structurally validated against its current
`~/.hermes/skills/<name>` contract because no Hermes binary is installed. No
marketplace listing, configured transport, provider, endpoint, credential,
mutation authority, deployment, production readiness or customer-data fitness
is claimed.

## v0.17.0 - Proposal-only roles, clusters and extended evidence diff v2

Adds a deterministic terminal projection over the existing progressive
controller, hypothesis ledger and MSSQL/Oracle safe-method evidence. Four closed
technical role kinds and structural connected-component clusters retain exact
support, counterevidence, receipts and stable hashes. Counterevidence-only
relationships cannot create link roles or merge clusters.

The hash-chained extended diff covers coverage, profiles, relationships,
hypotheses, roles and clusters. A structural item is `REMOVED` only after a
successful current query with complete visibility. Denied, unsupported and
unknown visibility remain explicit and never become deletion claims.

This local candidate does not persist source rows or credentials, activate
foreign keys, infer authoritative organizational/domain roles or causal
clusters, access production/customer systems, deploy or publish a release.

## v0.16.0 - Harness-neutral closed-intent conformance pack v1

Adds a deterministic, optional K2 pack that exercises all six External API v2
closed intents through a local stub and maps each verified result through the K1
Evidence Bridge. Independent runs are byte-identical; absent or incompatible
consumers disable only the pack.

Eleven negative probes reject extra tools, trusted apply, free SQL, arbitrary
URLs, credentials/raw rows, malformed/tampered/replayed responses, stale
contracts and missing capabilities with zero probe dispatches and zero accepted
evidence. The pack adds no runtime route, network client, plugin loader,
provider/database/Superset connection, credentials or mutation authority. This
is synthetic local-stub conformance, not DeepSeek Harness API/ABI compatibility,
real-harness E2E, production/customer readiness or deployment evidence.

## v0.15.0 - Harness-neutral closed-intent Evidence Bridge v1

Adds an inactive local adapter that verifies External API v2 runtime
attestations, request/result correlation and canonical integrity before mapping
the six closed external intents into existing M6-00 execution-receipt events.
Only safe IDs, authority classes and digests cross into adapter evidence; the
external result body does not.

The adapter adds no runtime route, foreign harness dependency, plugin loader,
credentials, arbitrary endpoint, free SQL or apply authority. Unknown versions,
capability/authority drift, tampering, replay, unsafe fields and correlation
mismatch fail closed. Evidence is synthetic and does not claim real-harness E2E,
production/customer readiness, semantic truth or deployment.

## v0.14.0 - MSSQL/Oracle safe-analysis method parity

Adds controller-bound MSSQL and Oracle parity for four safe semantic methods:
bounded column summaries, temporal coverage, quality indicators and relationship
overlap. Versioned content-addressed query packs use typed identifiers, a typed
source-row cap, short timeouts, one aggregate output row and read-only sessions.
Every dispatch retains the #36 breadth/coverage/allowlist/object budget gates;
relationship pairs debit both visible objects, and #37 advanced dispatch also
requires the table/hypothesis reservation before runtime execution.

Equivalent synthetic engine fixtures normalize to the same semantic evidence
hash while retaining documented dialect differences outside that hash. Observed
counts, computed quality/key/overlap metrics, proposal-only inference and
counterevidence remain distinct. Missing privileges and capabilities produce
explicit `DENIED`, `UNSUPPORTED`, `PARTIAL` or `UNKNOWN` evidence and never an
absence claim. Oracle native SQL Boolean columns are explicitly unsupported
instead of being inferred from numeric conventions.

This release does not accept free SQL, persist source rows/examples/labels or
credentials, perform writes or automatic foreign-key creation, access a
production/customer source, claim full-scan completeness, composite/universal
keys, semantic relationship truth, universal temporal semantics, performance
SLAs, deployment or production certification.

## v0.13.0 - Progressive analysis budgets and hypothesis ledger

Adds a sealed advanced-analysis layer on top of Progressive Run Controller v1.
Every dispatch now reserves the existing run/object budget plus table and
hypothesis debits in a compare-and-swap state before execution. Hypotheses retain
supporting evidence, counterevidence, contradictions, receipt references,
confidence bounds and explicit terminal reasons without promoting inference to
business fact.

Typed canonical intent features suppress near duplicates without inspecting SQL
or values. Expected information gain is a persisted deterministic basis-point
calculation and ordering signal, not an optimality claim. Consecutive no-gain or
counterevidence bounds stop a branch. Unknown outcomes remain debited and cannot
be blindly retried; a separate append-only readback receipt may reconcile them.

The existing breadth gate, manifest allowlist, typed parameters, scope checks,
timeouts, credential/raw-value rejection, and missing-privilege semantics remain
unchanged. Evidence is local and synthetic; this does not activate a runtime or
access production/customer databases.

## v0.12.0 - Progressive Run Controller v1

Adds a persisted, deterministic MSSQL/Oracle progressive-analysis controller
over the existing read-only query manifests, structure coverage ledgers,
Evidence Store schema and canonical SHA-256 identity mechanism. The closed phase
machine enforces Preflight, Breadth Inventory, Prioritization, Safe Aggregates,
Relationship Graph, Hypothesis Validation and Report in order. Every visible
object has an explicit COMPLETE/PARTIAL/DENIED/UNSUPPORTED/UNKNOWN state, and
depth is blocked below 95% classified structural coverage unless a narrow,
hash-bound persisted override authorizes exact objects and a bounded probe count.

The v1 safety kernel also enforces hard run/object probe budgets, exact duplicate
suppression and successful receipt replay on restart. It accepts only existing
allowlisted MSSQL/Oracle method references and typed scoped identifiers; free
SQL, raw values and credentials do not cross the controller boundary. Advanced
near-duplicate matching, information-gain planning, no-gain stopping and the
full hypothesis/counterevidence ledger remain explicitly in follow-up issue #37.

## v0.11.1 - KaleidoSphere brand and browser icons

Ships the approved KaleidoSphere mark in the public README and BI-agent web UI,
plus exact safe routes for SVG/PNG logo assets, 16/32 pixel favicons, a 180
pixel Apple touch icon, 192/512 pixel app icons and a web app manifest. The
container now packages the same governed assets under its non-root runtime.

All raster variants are deterministic downscales of the canonical 1254 pixel
RGBA logo; the canonical PNG and SVG remain byte-identical to the approved
source. Asset hashes, MIME types, dimensions, HTML references and route safety
are covered by automated tests and the content-addressed Source Map.

This increment does not redesign the mark, claim trademark/legal clearance,
deploy or activate a runtime, add a service worker/offline support, claim PWA
installability, ship a native application bundle or establish broad visual or
cross-browser regression coverage.

## v0.11.0 - PostgreSQL profiling and relationship evidence

Adds explicit, privacy-preserving PostgreSQL `rowCount`/`nullCount`/
`distinctCount` profiling and bounded single-column relationship-candidate
evaluation. Versioned hash-bound templates execute only against allowlisted
targets in read-only sessions. Accepted artifacts contain aggregate counts,
identifiers and content hashes, not source-row material, labels, distributions,
examples, credentials or connection strings.

Wave 2 separates observed overlap facts, deterministic computed scores, and
inferred review proposals. A content-addressed Evidence Store, authority-free
rule plan, machine/human reports, and a closed future-agent problem-reaction
proposal contract retain evidence, confidence, limitations, coverage and
nonclaims without making a semantic FK assertion or calling a model/provider.

The release evidence runs the flow twice against the digest-pinned synthetic
PostgreSQL 16.10 fixture. Results are byte-identical at SHA-256
`e907b98ee1049fae4456cb74195727e1cde63adae304e1817a5820b419906d70`;
ground truth remains unchanged, privacy counters are zero, and owned runtime
resources are removed while the preexisting Docker inventory and OpenClaw
Gateway remain unchanged.

This increment does not activate product/agent behavior, create database
constraints, accept free SQL, persist source rows, access production/customer
databases, call a provider, deploy anything, or claim HA, performance, TLS,
extension, composite-key, semantic-truth or PostgreSQL-version breadth. The
external API contract remains `2.0.0`.

## v0.10.0 - PostgreSQL end-to-end pilot

Adds a bounded PostgreSQL read-only metadata-analysis pilot: credential-free
profiles, enforced read-only sessions and timeouts, a frozen six-query catalog
pack for schemas, relations, columns, constraints and declared dependencies,
and deterministic coverage/blind-spot evidence.

The release includes reproducible synthetic E2E/readback evidence from two
fresh sessions against the exact pinned PostgreSQL 16.10 linux/amd64 image.
Credential rotation preserves byte-identical canonical evidence; timeout,
cancellation, mutation, scope and raw-row probes fail closed; owned container,
network, volume and secret resources are removed without changing preexisting
Docker inventory.

This release does not claim production/customer database validation, row
sampling, free SQL, HA, performance, extension or multi-version breadth,
production TLS, egress isolation, deployment or runtime activation. The
external API contract remains `2.0.0`.

## v0.9.0 - KaleidoSphere product identity

Renames the public product to **KaleidoSphere — Multi-perspective Business &
Decision Intelligence** and positions it as the PANSPHAIRA ecosystem system for
Business Intelligence, analytics, and Decision Intelligence. Public UI, docs,
repository metadata, container titles, and newly built release assets use the
KaleidoSphere identity.

Functionality, architecture, behavior, routes, data formats, environment
variables, Compose service names, and the stable `superset-bi-agent` external
contract identifiers remain unchanged. Existing tags, releases, assets, and
historical evidence retain their original names.

## v0.8.0 - Attested external ownership contract v2

Adds `superset-bi-agent.external` contract `2.0.0`. The running `bi-agent`
attests product `v0.8.0`, the exact contract, accepted Adaptive Graph v1
incumbent, capability set and authority boundaries with canonical SHA-256 at
`GET /v2/capabilities`. `POST /v2/intents` accepts only typed status,
discovery, source-read-only analyze, plan, preview and readback actions and
digest-binds every response.

The v2 boundary rejects free SQL, credentials, raw source rows, arbitrary URLs,
unknown capabilities and direct persistent mutation. Analysis no longer
implicitly publishes through the public agent path. Persistent Superset work is
owned by SBA's trusted preview/direct-UI-approval/apply/readback/rollback
workflow; model output and external clients have no mutation authority.

This release proves local fixture/clean-room interoperability. It does not claim
arbitrary database, production/customer, SSO, HA or multi-tenant readiness.

## Unreleased - M6-00 local contract/security foundation

Adds harness-neutral v1 contracts for typed durable/live events, static built-in
capabilities, one-shot bound approvals, execution receipts, bounded retries,
dashboard capabilities, voice/text streaming, and ten reversible session UI
actions. A deterministic in-memory state adapter supplies local evidence only.

This is not a runtime assistant release. It does not integrate DeepSeek Harness
or Cordis, install plugins, connect a model/speech provider, control a browser,
mutate Superset, apply persistent revisions, activate production behavior, or
publish an external artifact.

## v0.7.1 - Deterministic graph evidence fix

This patch refreshes the graph pilot and adaptive investigation terminal
manifests/state artifacts and aligns their runners, graph-pilot services,
focused tests, and source-map coverage with deterministic artifact generation.

This release does not deploy or activate a runtime, connect Superset, access
customer data, or claim staging, production, customer, or live runtime evidence.

## v0.7.0 - Promotion review bundle contract

M5-02 adds `chimpmaera.bi/superset-promotion-bundle/v1`: a deterministic,
review-only ZIP/YAML contract with repository-owned manifest and review-asset
schemas. It binds a confirmed Discovery brief, catalog receipt/snapshot/scope/
coverage, sanitized target identity, Superset version, fingerprint/OpenAPI/
feature-flag freshness, stable UUID asset inventory, file hashes, disclosure,
limitations, nonclaims, and `mutation_performed=false`.

`./bin/bi promotion-bundle build|inspect|preflight` provides machine-readable
JSON and optional human output. Mandatory SHA-256 establishes integrity; v1 is
explicitly unsigned and makes no signer-authenticity claim. The bounded ZIP
parser and semantic validator fail closed on traversal, archive bombs, hash and
schema drift, stale/incompatible fingerprint evidence, UUID/reference errors,
secrets, credentials, source rows, and raw SQL.

This capability creates review evidence only. It does not emit a Superset-native
import package, import/export assets, connect Superset to Oracle/MSSQL, access
source rows, generate SQL, call the materializer, or mutate Superset.

## 2026-08-14 - Product README and docs navigation refresh

The README now presents the repository as Superset BI Agent with a compact
product-oriented overview, fixture-first quickstart, visible workflow,
security-by-design summary, and explicit current boundaries. Operational detail
was moved into dedicated Architecture, Configuration, Security, and Roadmap
documents. This is documentation-only maintenance; no runtime behavior,
container configuration, query pack, Superset materializer, release asset, tag,
or version change is included.

## v0.6.1 - Apache Superset 6.1.0 security/runtime upgrade

The owned Superset runtime is pinned to Apache Superset 6.1.0 by immutable image
digest. Fingerprint fixtures, compatibility bounds, OpenAPI expectations, and
runtime smoke assertions now require 6.1.0 or a later 6.x version. The upgrade
procedure includes a metadata backup, forward migration, fresh-install check,
and restore rollback to the original 5.0.0 image without an in-place downgrade.

## v0.6.0 - Superset Fingerprint M5

M5 adds a read-only Superset Version/OpenAPI/Feature-Flag Fingerprint contract:
`chimpmaera.bi/superset-fingerprint/v1`.

The local stack can collect Apache Superset runtime version, Flask-AppBuilder
`/api/v1/_openapi` representation, canonical OpenAPI SHA-256,
security-relevant `FEATURE_FLAGS`, sanitized target identity, provenance,
freshness policy, compatibility verdict, limitations, and nonclaims. The
collector rejects
secret-like evidence, unsafe target URLs, unexpected content types, malformed
OpenAPI payloads, oversized OpenAPI documents, target mismatch, and incompatible
required feature flags.

M5 also adds `chimpmaera.bi/superset-planning-gate/v1` for later
write/import/export/promotion planning. The gate blocks missing, stale,
incomplete, target-mismatched, OpenAPI-drifted, version-incompatible, or
unknown-required-flag fingerprints and returns `mutation_performed=false`.

Apache Superset runtime evidence is primary. Preset-compatible deployments are
secondary and require target-specific fingerprints. This release does not create
dynamic datasets, charts, dashboards, imports, exports, ZIP promotions, SQL,
source queries, source-row samples, or production/customer evidence.

## v0.5.0 - Guided BI Discovery M4

M4 adds a local, deterministic BI Discovery dialog over the M3 technical catalog.
Discovery sessions are versioned and persisted in the local projection database,
with start/resume/status/answer/revise/confirm/export lifecycle operations.

The exported BI Discovery Brief is available as structured JSON plus Markdown
content. It includes audience role, business questions, confirmed KPI candidates,
dimensions, time grain, filters/segments, drilldowns, freshness needs,
access/confidentiality, open assumptions, coverage blind spots, and catalog
provenance.

All technical suggestions are derived only from the M3 catalog/projection rows
and carry receipt/snapshot/query provenance. The deterministic offline agent path
works with `LLM_MODE=stub`; optional OpenAI-compatible provider use remains
bounded and cannot trigger SQL execution or Superset mutation.

M5 is not included. This release does not create dynamic Superset datasets,
charts, dashboards, SQL, source queries, source-row samples, or semantic models
from Discovery results.
