# M6-04 Trusted Specialist-to-Superset Workflow contract

Status: local evaluation contract, 2026-08-15. This slice starts from exact M6-03 commit
`74b80d6850a249afcbd246b9a15342b920ce0aa5` and remains local-only.

## Product boundary

M6-04 connects the M6-03 typed specialist output to the M6-00 approval and execution
contracts and the M6-02 reviewed Apache Superset public REST client. The specialist remains
advisory: it cannot mint approvals, choose an undeclared action surface, authorize persistence,
or dispatch tools. The controller deterministically compiles an advisory recommendation into
a reviewable change plan. The plan contains stable asset identities, an exact before/after
diff, dependency order, target fingerprint and capability bindings, limitations, nonclaims,
and a canonical preview digest.

Only a direct trusted-UI confirmation from an authenticated human actor and bound session can
create the one-shot approval. The approval binds actor, session, target, fingerprint,
capability snapshot, asset snapshot, plan, preview digest, complete action set, expiry, and
idempotency key. Voice-only, model-generated, partial, stale, drifted, mismatched, replayed,
or inferred approval fails closed.

## Reviewed apply boundary

The executor accepts only four typed operations:

1. reviewed dataset metadata update;
2. reviewed chart upsert/update with an allowlisted native visualization type;
3. reviewed dashboard metadata/layout revision with exact chart UUID dependencies;
4. reviewed native-filter configuration update with identifier-only column binding.

The target must be `disposable_local`, use credential-free loopback HTTP, match the frozen
Superset 6.1 fingerprint, and declare every required capability as supported. Arbitrary SQL,
query strings, DOM/JavaScript/selectors, URLs, paths, secrets, tokens, raw responses, source
records, prompts, and chain-of-thought are not action fields. Values, UUIDs, identifiers,
labels, dependencies, action count, duration, idempotency, and pre-apply state are bounded and
validated before dispatch.

Every action receives independent public-REST readback. A completed idempotent execution can
be restored from a safe reconciliation snapshot without a second dispatch. The snapshot
contains only typed plan values, digests, receipts, and rollback points, not API responses or
source records.

## Rollback and recovery

The exact allowlisted pre-state is retained before dispatch. Rollback applies it in reverse
dependency order, reads every asset back, consumes its token once, and denies concurrent drift.
Cancellation or timeout before dispatch performs no write. Cancellation, timeout, or injected
partial failure after a completed action compensates every dispatched action in reverse order;
blind retry is not allowed. Unknown network outcome after transport dispatch is not claimed as
solved by this local slice.

## Local evidence and nonclaims

Live evidence uses only Compose project `sba-m6-04-trusted-20260815`, loopback port 39044,
Apache Superset 6.1.0, and the 12-row Northstar synthetic fixture. The six-action proof covers
one dataset, three charts with three distinct native visualization types, one dashboard, and one
native filter. Apply, independent readback, no-dispatch idempotent replay, exact rollback,
restart reconciliation, unauthorized denial, and real two-action partial-failure compensation
are recorded in `docs/evidence/m6-04-trusted-workflow/live-manifest.json`.

This is not Delivery. There is no production/customer/personal Superset access, third-party or
organizationally independent validation, causal proof, cross-hardware determinism, broad
provider support, deployment, publication, push, PR, tag, or release claim.
