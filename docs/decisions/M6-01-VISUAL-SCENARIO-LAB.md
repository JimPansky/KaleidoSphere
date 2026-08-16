# M6-01 Visual Scenario Lab decisions

Status: local implementation decision record. These decisions are reversible and
remain inside the owner-authorized synthetic test lane.

## Architecture

The repository has no Superset frontend build or existing browser-test framework.
M6-01 therefore uses the allowed faithful embedded shell: static HTML/CSS/JS served
by a loopback-only Node server. Dashboard cards remain separate from the assistant
overlay. Assistant plans cross the server boundary only as frozen
`chimpmaera.bi/ui-action/v1` requests into `InMemoryDashboardStateAdapter`.

- Assumption: a faithful shell is enough for deterministic UI/action acceptance.
- Risk: this does not prove live Superset filter or chart event integration.
- Fallback/review marker: preserve the scenario engine and replace only the shell
  bridge in the next adapter slice; every adapter must pass the same suite.
- Rollback: remove the M6-01-authored visual-lab paths and package scripts, leaving
  the M6-00 contracts unchanged.

## Synthetic data and portability

One engine-neutral JSON seed is the source of truth. Small deterministic renderers
produce MSSQL, Oracle, and SQLite dialects. The SQLite dialect is executed against
an isolated in-memory database during tests; MSSQL and Oracle renderers are checked
for semantic row parity and dialect markers. A second live database seed is future
evidence, not a local acceptance blocker.

- Assumption: generated-dialect equivalence is sufficient for this slice.
- Risk: a live engine may expose collation or numeric/date conversion differences.
- Fallback: keep exact expected values in the oracle, and require a later live seed
  readback before claiming engine deployment support.

## Deterministic planner and voice stream

The planner is a closed scenario stub, not a language-model agent. It emits only
the ten enumerated UI actions, validates fixture values, and records normalized
requests and receipts. Voice correction, interruption, and cancellation are timed
event fixtures; there is no microphone or speech provider.

- Risk: no claim about natural-language generalization or barge-in latency.
- Fallback: each real OpenClaw, Hermes, Claude, speech, or provider adapter must
  independently pass this exact suite before support is claimed.

## Browser evidence fallback

Browser doctor/status/tabs succeeded, but the OpenClaw browser gateway correctly
blocked loopback navigation by policy. No Gateway setting was changed. The test
used the already-installed Playwright Core and already-installed Chromium binary.
No browser, package, plugin, or runtime was downloaded or installed.

- Assumption: local Playwright is equivalent visual evidence for the isolated shell.
- Risk: it does not validate the OpenClaw browser gateway integration.
- Fallback: rerun the same evidence script in an approved browser test environment.

## Safety boundaries

Persistent requests produce only a diff proposal and a visible
`TRUSTED_UI_APPROVAL_REQUIRED` denial. The slice implements no apply route. It also
rejects arbitrary SQL, arbitrary actions, direct DOM/JavaScript control, ambiguous
values, unknown filter values, stale state, and conflicting actions. Native tab
buttons are user controls inside the shell; they are not assistant actions.

No customer data, realistic people, secrets, production systems, personal
OpenClaw instance changes, external messages, GitHub writes, or hidden reasoning
are present.
