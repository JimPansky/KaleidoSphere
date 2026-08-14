# M6-00 clean-room contract and security foundation

Status: accepted owner direction, implemented as a local contract slice on
2026-08-14. This decision does not activate a runtime feature.

## Decision

Keep Apache Superset as the visualization UI. A future thin assistant shell may
exchange text/voice stream events and typed reversible UI actions through
versioned contracts. The foundation is harness-neutral: Claude Code, Hermes,
OpenClaw, and other adapters may later implement the same seam. DeepSeek Harness
(DSH) is not integrated; it could only be evaluated later as an optional adapter
after a separate maturity and security review.

M6-00 adds four repository-owned boundaries:

1. A typed event envelope with durable/live channels, monotonic per-channel
   sequence, correlation/causation, producer identity, payload digest,
   sensitivity/redaction, and explicit ignorable semantics.
2. A static built-in capability registry with pinned artifact digests, exact v1
   contract compatibility, a resolved DAG dump/hash, and complete enforcement
   facts. It has no loader or installer.
3. A monotone execution-control contract: mandatory guards, one-shot
   argument/resource/policy-bound approval, execution, observation/receipt, and
   fail-closed uncertain-outcome handling. Retry is bounded, code-selective,
   and idempotency-aware.
4. A deterministic in-memory dashboard state adapter for allowlisted reversible
   session actions. Persistent asset work remains a non-applying proposal that
   requires preview/diff, trusted UI approval, BI-Control apply, readback, and
   rollback in a future slice.

Unknown required events, plugins, digests, dependencies, contract versions, and
unsafe actions fail closed. Direct DOM/JavaScript agent control, runtime plugin
installation, dynamic imports, HMR/watchers, arbitrary MCP servers, persistent
Superset mutation, and voice-only persistent approval are outside the boundary.

## Conceptual provenance, no copied code

The following read-only documents were inspected at the pinned public
`deepseek-ai/deepseek-harness` commit
`47f943859bef60e4160492346772ded9b24f765a`:

- `.agents/notes/implemented/architecture/2026-06-11-event-sourced-sessions.md`
- `.agents/notes/implemented/architecture/2026-06-11-microkernel-event-taxonomy.md`
- `.agents/notes/implemented/architecture/2026-06-13-capability-seams.md`
- `.agents/notes/implemented/architecture/2026-06-21-bounded-llm-request-recovery.md`
- `.agents/notes/implemented/architecture/2026-07-19-cooperative-tool-cancellation.md`
- `.agents/notes/implemented/architecture/2026-07-23-client-plugin-loading-model.md`

They were used only to compare architectural concepts: typed event history,
capability seams, explicit execution phases, bounded recovery, cancellation
facts, and plugin identity. M6-00 is a clean-room implementation written for
this repository from the owner requirements. No DSH/Cordis runtime, package,
schema, source file, generated artifact, or code fragment was copied or added.
DSH's dynamic/HMR plugin model was consciously rejected for this foundation in
favor of a closed built-in registry.

## Autonomous decision ledger

| Decision / assumption | Risk | Fallback and review / rollback marker |
| --- | --- | --- |
| JSON Schema draft 2020-12 files plus dependency-free Node validators are the v1 source contracts. | Runtime and schema validators could drift. | Compatibility tests pin both; a later slice may add existing AJV wiring without changing v1 wire data. Revert the local M6-00 commit to roll back. |
| Contract compatibility is exact by major contract label (`v1`), not a permissive range. | A compatible future minor extension may be rejected. | Add a reviewed v2 compatibility policy; never silently widen v1. |
| Event sequence is monotonic independently for each stream and durable/live channel. | Cross-channel total order is not implied. | Correlation/causation preserves relationships; add an explicit merge-order contract if a consumer needs total order. |
| Raw secrets and source rows are always denied; PII classification is permitted only with `redacted` status and safe payload fields. | Conservative field-name checks can reject harmless names. | Rename to a safe projection or add an audited structured-redaction token in v2; do not weaken v1 ad hoc. |
| Only manifests included in the compiled roster and exact expected-digest map resolve. | Artifact rebuilds require an intentional digest update. | Update manifest, fixture, expected digest, and evidence together after review. There is no runtime override. |
| Optimistic dashboard state version plus dashboard-id precondition is the initial concurrency contract. | A future Superset connector may need richer chart/layout preconditions. | Extend with optional typed preconditions in v2; stale v1 work stays denied. |
| The stub applies only ten reversible session actions and keeps undo state in memory. | Undo is not durable across process restart. | This slice claims contract determinism, not runtime durability; a future evidence store can persist receipts/tokens after threat review. |
| Persistent revision proposals never apply; trusted UI is the only acceptable approval channel. | Voice users need a second interaction step. | Voice can propose, then a trusted visual UI shows preview/diff and collects approval. No voice bypass exists. |
| Retry is capped at three attempts and only for enumerated pre-dispatch/transient codes with idempotency. | Some transient failures may remain terminal. | Operator re-evaluation or a reviewed policy revision; `outcome_unknown` always stops blind retry. |
| No API route, Compose setting, browser adapter, provider, or Superset connector is wired in M6-00. | The contracts are not yet an end-user assistant. | Implement a separately reviewed adapter slice; rollback is the single local commit and requires no runtime teardown. |

## Consequences and nonclaims

The repository now has deterministic fixtures and fail-closed executable
contracts, but it does not have a live assistant overlay, speech recognition,
LLM/provider integration, browser automation, arbitrary harness integration,
Superset asset mutation, persistent approval UI, production deployment, or
customer evidence. No chain-of-thought field exists in the event vocabulary;
assistant text deltas/finals and action receipts are the observable stream.
