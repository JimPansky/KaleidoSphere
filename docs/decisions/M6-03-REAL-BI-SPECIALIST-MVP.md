# M6-03 Real BI Specialist MVP contract

Status: local evaluation contract, 2026-08-15. This slice starts from exact M6-02 commit
`76f0bd3f1b06aa14960cdee5b304f94a98e20ae7` and remains local-only.

## Product boundary

The specialist is a harness-neutral core with an optional loopback-only OpenAI-compatible
model adapter. The database discovery core is read-only, bounded by tables, queries, rows,
duration, steps, context, response tokens, retries, and explicit task policies. Model output
may summarize already collected evidence or propose typed read-only tool calls; it cannot
authorize or execute persistence. Model, adapter, discovery core, development evaluator, and sealed evaluator
are independently replaceable.

Only structured observable records are durable: `plan_summary`, `decision_record`,
`tool_trace`, `self_check`, `correction_record`, configuration, measurement, receipts,
evidence and public-safe rationale. Raw chain-of-thought, source rows, credentials, tokens,
private data and unrestricted prompts/responses are excluded.

## Required investigation loop

1. objective and risk;
2. scope/capability preflight;
3. structural inventory;
4. entity/process/relationship graph;
5. prioritized bounded profiling;
6. anomaly, quality and cause hypotheses;
7. targeted tests;
8. evidence, confidence and blind spots;
9. semantic/KPI model;
10. visualization proposal;
11. user correction;
12. trusted preview/apply/readback/rollback boundary.

The user supplies an objective and database, not table or column names. The visible corpus is
explicitly development/adversarial regression data and makes no blind claim. Blind credit
requires a candidate-source commitment before any new neutral case identifier, database SQL,
oracle or digest is authored; process-separated candidate execution receives only the database
path and objective envelope. The immutable first result, including failure, cannot be replaced
by a rerun. Candidate, pack and evaluator SHA-256 digests are mandatory.

## Fail-closed rules

- Loopback `127.0.0.1` model endpoints only; no API secret surface.
- Read-only SQL grammar and SQLite read-only handles only; no blind full scans.
- Unknown tools, malformed/unknown arguments, secret-like trace values, budget excess,
  timeouts, cancellation, idempotency conflicts and unbound approvals are denied.
- High-temperature visualization output is preview-only.
- Persistent apply is never model-authorized and requires an exact preview digest binding,
  readback and rollback point.
- A candidate can replace the incumbent only with zero hard failures, green privacy/safety,
  and no discovery, oracle, citation or tool-correctness regression.
- Sealed scoring hard-fails path/oracle/case leakage, raw-row or prompt-injection leakage,
  mutation, budget overrun, missing evidence receipts, raw reasoning, unbounded KPI grain, or
  implied causality.

## Local Qwen reference configuration

Default reference model is Qwen3.6-28B-REAP20-A3B Q6_K through an isolated transient
llama.cpp server. Q5 is comparator/fallback only and is not an automatic downgrade.
DeepSeek Harness, Hermes, OpenClaw product Gateway and personal advisor services are not
runtime dependencies. No dependency download or installation is required for this slice.

The live conformance evidence must bind exact binary/model hashes, endpoint configuration,
normal and JSON response, per-call sampling, tool-call boundary, timeout, streaming/cancel,
bounded retries, restart reconciliation, context/response budgets, safe traces and teardown.
Fixed-seed repeatability is measured as observable stability only; runtime determinism is not
claimed unless bytes are actually identical.

## Rollback and nonclaims

Rollback is the retained incumbent generation, trusted semantic rollback point, removal of
only the uniquely named transient Qwen service/listener, or a local Git revert after commit.
There is no push, PR, tag, release, deployment, production/customer access, external write,
native Superset apply, local-Qwen general support, cross-hardware determinism, or visual UI
acceptance claim in this contract. Repository-local process separation is not claimed as
organizationally independent or third-party validation.
