# M6-05 Ambiguous Transport Outcome Reconciliation

Status: local exact-envelope evaluation contract, 2026-08-15. This slice starts from exact
M6-04 commit `e4b20c0794dcb4f08f99893937ec6377617494bf` and remains local-only.

## Boundary

After a mutation request may have reached the disposable loopback Superset 6.1.0 fixture but
its response is lost, the executor records `outcome_unknown` and prohibits blind redispatch.
A hash-chained journal binds the actor, session, target fingerprint, capability and asset
snapshots, plan, preview, grant, idempotency key, per-action UUIDs, and preconditions.

Recovery takes an exclusive local file lease, reopens and verifies the journal, and uses only
public REST readback. Exact after-state becomes `committed_equivalent` without mutation. Exact
before-state permits only a newly bound grant and idempotency key. Partial, diverged,
foreign-owned, substituted, or drifted state cannot retry. Repeated recovery of a terminal
journal is a no-read/no-mutation duplicate suppression result.

Owned partial compensation is allowed only when every touched value is still the exact planned
after-state. It restores exact before-values in reverse dependency order and refuses foreign
ownership or concurrent drift. Unrelated assets are outside the adapter call set.

## Security and privacy

Journal entries are canonical, sequence-checked, hash-chained, atomically replaced, and stored
mode 0600. Forged heads, reordered entries, hash changes, illegal transitions, plan
substitution, target/capability/snapshot drift, raw responses, request bodies, secrets, source
records, prompts, model transcripts, and chain-of-thought-shaped persistence fail closed.
Existing M6-04 validation continues to bound loopback transport, paths, credentials, values,
dependencies, action count, duration, UUIDs, and injection surfaces.

## Claim and rollback

The claim is only exact-local reconciliation for the tested synthetic Superset 6.1.0 image,
public-REST action, and loopback lost-response envelope. It is not global exactly-once,
arbitrary partition tolerance, external durability, production concurrency, deployment, or
Delivery. Rollback is removal of the local M6-05 commits/worktree; no remote state exists.
