# M6-00 Contract/Security Foundation evidence

Evidence date: 2026-08-14. Scope: local public clone and local branch only.

## Gate ledger

| Gate | Evidence |
| --- | --- |
| G1 Preflight/provenance | Fresh `origin/main` clone at `95e6390a18d863a801d9f84552ab09bdc8ae7faa`; remote readback matched; worktree clean; baseline `npm test` passed 37/37. Apache-2.0 and Source-Map v2 conventions confirmed. The clean-room ADR pins DSH commit and exact conceptual documents and states no copied code. |
| G2 Core contracts | `event-envelope.schema.json` and `core-contracts.mjs` cover VersionIdentity, durable/live channels, per-channel monotonic sequence, correlation/causation, producer artifact identity, data class/redaction, canonical payload SHA-256, and ignorable unknown events. Unknown required events fail closed. |
| G3 Static plugins/capabilities | PluginManifest and CapabilityDescriptor schemas plus `capability-registry.mjs` require built-in manifests, pinned artifact digests, exact contract versions, full enforcement facts, and an acyclic provides/requires graph. Resolution emits canonical config and SHA-256. Dynamic/install/HMR fields and unknown identities fail closed. |
| G4 Policy/execution | ApprovalGrant is one-shot and bound to execution, capability, argument, resource, policy, trusted UI, and expiry. Mandatory denies are monotone. ToolExecutionReceipt records outcome and observation; `outcome_unknown` forbids blind retry. Retry policy is bounded, code-selective, and idempotency-aware. |
| G5 UI/voice/stub | `ui-action/v1`, dashboard capability and voice-stream contracts cover ten allowlisted reversible session actions, state version/dashboard precondition, idempotency, receipts and undo. Saved-view requests and persistent revision proposals are separate. Persistent apply is absent; voice-only approval fails. The adapter is in-memory only. |
| G6 Evidence/tests/docs | Four golden fixtures, four JSON Schemas, schema/runtime compatibility tests, 43 distinct fail-closed negative probes, architecture/security/configuration/roadmap/release notes, clean-room ADR, evidence record, and content-addressed Source-Map entries. Full test/diff/syntax checks are recorded below. |
| G7 PDCA/local handoff | Final branch/commit, exact test results, changed files, risks, nonclaims, and rollback are completed after the final verification and local commit; no external write or runtime activation is performed. |

## Negative evidence coverage

The focused suite contains 43 distinct probes covering unknown required events;
digest, sequence, causation and correlation failures; producer identity; secret,
source-row and PII/redaction violations; unknown/non-built-in plugins; artifact
drift; install sources; missing/cyclic/incompatible dependencies; incomplete
enforcement facts; mandatory deny; approval replay/scope/argument/resource/
expiry/trust failures; retry-always, excess budget, unsafe codes and missing
idempotency; uncertain-outcome blind retry; unsafe/stale/preconditioned UI work;
idempotency mismatch; persistent capability exposure; voice-only persistent
approval; chain-of-thought payloads; invalid voice confidence; and PII-shaped UI
arguments.

## Verification record

- Baseline: `npm test` — 37 tests passed before edits.
- Focused: `node --test tests/assistant-foundation.test.mjs` — 47 tests passed,
  including the 43 negative probes.
- Final full suite: `npm test` — 84/84 passed, including existing analyzer,
  catalog, Discovery, Oracle, promotion, release, security, source-map, and
  Superset fingerprint coverage.
- Explicit checks passed: `git diff --check`; JSON parse of all new schemas and
  fixtures; `node --check` for all four new modules and the new test; Source-Map
  hash verification. No container was started.
- Clean status and local commit identity are recorded in the restart checkpoint
  and final local handoff after commit.

## Nonclaims and rollback

No DSH/Cordis dependency, real harness adapter, real model, speech provider,
browser/DOM control, Superset connector mutation, asset apply, live credential,
runtime plugin loader, arbitrary MCP server, deployment, production/customer
evidence, or external publication was added. Before commit, remove only the
listed M6-00 patch; after commit, use a local `git revert` of that commit. No
container teardown is necessary because no container was started.

## Binding next-slice contract: M6-01 Visual Scenario Lab

M6-01 is a separate, subsequently reviewed slice. It must not be folded into
M6-00, and M6-00 does not start frontend, database, browser, visual, container,
or real-harness work. M6-01 is accepted only when all of the following are
demonstrated:

1. Actual visual browser acceptance is performed; DOM assertions and unit
   tests alone are insufficient.
2. A deterministic synthetic pattern database provides known truths across
   multiple business scenarios.
3. Agent/UI actions correctly set and verify filters, time ranges, tabs,
   series, drilldowns, focus, and comparisons for every applicable scenario.
4. Every scenario produces a correlated screenshot, captured UI state, and
   Superset readback.
5. Failures are corrected iteratively until predeclared fixed quality gates
   pass; the gates may not be weakened after observing a failure.
6. Stub/contract E2E evidence is reported separately from later real-harness
   E2E evidence. Stub success must never be presented as real-harness success.
7. Voice is never accepted as approval for a persistent mutation.

This contract reserves no claim that M6-01 has started or that any visual,
database, container, or harness evidence exists.
