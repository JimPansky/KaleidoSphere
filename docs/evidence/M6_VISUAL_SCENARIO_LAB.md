# M6-01 Visual Scenario Lab evidence

Status: local terminal candidate, seven gates satisfied after final readback.
Base commit: `3a5e6b4063d9831a4039196336275fda95007806`.
Branch: `m6-01-visual-scenario-lab`.

## Acceptance result

- Golden scenarios: 8/8 exact final UI state.
- Oracle assertions: exact, including Q2 revenue EUR 12,480,000, margin
  31.4%, quality spike 8.6%, inventory coverage 2.4 days, downtime 41.5
  hours, MTBF 68 hours, demand +24%, and production +9%.
- Negative probes: ambiguity, unknown filter value, stale state, conflicting
  action, arbitrary SQL/action, and direct DOM/JavaScript all denied.
- Persistent mutations: 0; the save/replace request is preview-only and visibly
  denied pending trusted UI approval.
- Cancel/idempotency/undo: exact; no action after cancellation, duplicate action
  returns `already_applied`, and undo restores prior session content.
- Visual evidence: 16 hashed PNGs, eight scenarios at 1440x900 and 390x844.
- Visual review: 9.2/10, no Severity 1 or Severity 2 defects.
- Browser control checks: keyboard scenario activation, real Undo at both
  viewports, and native tab `aria-pressed` readback pass.
- Final verification: `npm test` passes 95/95 twice consecutively.

The machine evidence and screenshot hashes are in
`docs/evidence/m6-01-visual/manifest.json`. The independently recorded pixel
review is bound to the manifest hash in
`docs/evidence/m6-01-visual/visual-review.json`.

## Scenario matrix

| Scenario | Required state/readback | Result |
| --- | --- | --- |
| Executive sales | last completed Q2, revenue/margin chart, top product/customer comparison | exact |
| Quality investigation | Werk 3, Linie C, 2026-05-12..18, volume comparison, supplier-batch drilldown | exact; association only |
| Inventory risk | Werk 2, Rotor-7, coverage ascending, demand/supply comparison | exact |
| Maintenance | Press, Q2, downtime/MTBF focus, event drilldown | exact |
| Cross-domain | Atlas demand/production/inventory comparison | exact; correlation not causation |
| Voice correction/cancel | Werk 2 corrected to Werk 3, then cancel | exact; no post-cancel action |
| Undo/idempotency | duplicate receipt then undo | exact |
| Persistent request | revision preview and denial | no apply route or mutation |

## Synthetic database

`portable-seed-v1.json` is the single logical data source. Deterministic renderers
produce MSSQL, Oracle, and SQLite SQL with the same 12 semantic metric rows. The
SQLite output is executed in a real isolated in-memory database and read back in
the test suite. MSSQL and Oracle live seed execution remains later adapter
evidence, not a claim of this slice.

The fixture is wholly fictional and contains organization/entity labels only. It
contains no copied customer data, realistic people, credentials, or secrets.

## Visual PDCA

The first actual screenshot run found a skip-link projection over the header in
full-page evidence. Focus readback showed the link remained off-screen in the
real viewport; the full-page renderer projected the classic negative-top
technique. The smallest fix made it hidden until `:focus-visible`, retaining
keyboard access. A second gap—native tab buttons without state readback—was fixed
with `aria-pressed` and live-region feedback. Focused runs and the full 16-capture
suite then passed with zero measured horizontal overflow.

OpenClaw browser doctor/status/tabs succeeded, but loopback navigation was blocked
by Gateway policy. No personal OpenClaw or Gateway setting was modified. Evidence
used the already installed Playwright Core and Chromium binary, with no install or
download.

## Verification

- Baseline: 84/84.
- Focused M6-01: 11/11.
- Full test suite: 95/95, two consecutive clean runs.
- Node syntax checks: scenario engine, seed renderer, server, browser client, and
  evidence runner pass.
- JSON parse: oracle, seed, scenario suite, browser manifest, and visual review pass.
- Source map content hashes and derived-file checks pass.
- `git diff --check`, security, release archive, and secret scans pass.
- Isolated server stopped; no project container or network was created.

## Nonclaims and next adapter gate

The shell is faithful embedded test UI, not live Superset readback. Voice events
are deterministic timing simulation, not speech-provider evidence. The suite does
not establish OpenClaw, Hermes, Claude, or any other real-agent quality.

Next slice: implement one real harness adapter at a time behind the frozen planner
and UI-action boundary. No adapter is supported until it independently passes this
same scenario, negative, undo/cancel, and visual suite against a live Superset test
stack; add MSSQL and Oracle live seed readbacks as adapter evidence.
