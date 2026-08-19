# Release Notes

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
