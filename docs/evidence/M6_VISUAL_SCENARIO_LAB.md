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

## M6-02 Native Superset Bridge addendum

Status: local terminal candidate, pending final repository cleanup at commit time.
Base commit: `1c056f5200eb0f6fef8e0c840271be8018da6391`.
Branch: `m6-02-native-superset-bridge`.

M6-02 replaces the M6-01 shell-only readback claim with a real isolated Apache
Superset 6.1.0 loopback stack at `127.0.0.1:28088`. The stack uses only the
synthetic 12-row Northstar Components projection and deterministic managed
assets: one database, one dataset, 21 charts, and eight dashboards with stable
UUIDs.

The native bridge uses the public Superset REST API. Supported session effects
are `set_filter`, `clear_filter`, `set_time_range`, and `explain_current_view`
through dashboard permalink data-mask state with independent readback. Unsupported
or unproven capabilities fail closed, including focus, drilldown, segment
comparison, tab selection, table sorting, and series toggling. There is no free
DOM/JavaScript action path, no raw SQL, no source credential in Superset, no
dynamic plugin path, no voice-only persistent approval, and no fake native success.

Fresh evidence run `e78-20260814T2137` completed two consecutive green native
runs, each covering all eight Golden Scenarios with native readback, oracle
values, action traces, denial counts, mutation counts, and persistent mutation
count zero. The diversity gate passed with five domain layout families, eight
meaningful chart types, rationale coverage 100%, maximum domain signature reuse
one, and zero misleading chart types.

The browser evidence contains 16 hashed Superset screenshots: each scenario at
1440x900 desktop and 390x844 narrow. Direct pixel review passed at 8.7/10 with
zero Severity 1/2 defects and zero measured horizontal overflow. Narrow evidence
uses full-width native dashboard rows instead of a scale-only shrink.

Machine evidence:

- `docs/evidence/m6-02-native/live-manifest.json`
- `docs/evidence/m6-02-native-visual/manifest.json`
- `docs/evidence/m6-02-native-visual/direct-pixel-review.json`
- `docs/evidence/m6-02-native-visual/screenshots/*.png`

Binding M6-03 handoff: keep the harness and model as separate components and use
Qwen3.6 through an OpenAI-compatible llama.cpp endpoint as the reference-model
path. Prefer the already available Qwen3.6-28B-REAP20-A3B-Q6_K as the
quality/stability default; Q5_K_M remains only a measured fallback/comparator.
Because the Claude Agent SDK does not support Qwen, the first real harness must
be local-model-capable. The M6-03 preflight must choose between Hermes ACP as the
technically leanest initial candidate and an isolated OpenClaw product gateway by
minimal conformance evidence. It must not modify or depend on the personal
OpenClaw instance or existing local AI infrastructure.

M6-02 remains model-free and makes no Qwen3.6, harness, or provider-quality
claim. M6-03 must practically prove tool calling, structured output,
streaming/cancel, context handling, malformed arguments, timeout,
restart/reconciliation, and the Golden/Diversity suite with Qwen3.6 before any
real-harness support claim.

M6-03 must optimize a generic local-Qwen BI consultant through
incumbent-versus-candidate replay and blind holdout databases, not overfit this
known fixture. Its required discovery loop is: objective/risk; scope/capability
preflight; structural inventory; entity/process/relationship graph; prioritized
bounded profiling; anomaly/quality/cause hypotheses; targeted tests;
evidence/confidence/blind spots; semantic/KPI model; visualization proposal; user
correction; trusted apply/readback/rollback. Users need not know table locations.
Holdouts must include schema/name perturbations, domain shifts, hidden oracle
truths, and underspecified/adversarial requests. Persist auditable evidence and
decisions, never raw chain-of-thought, and allow no production self-modification.
These are terminal M6-03 requirements only; they do not expand or delay M6-02.
