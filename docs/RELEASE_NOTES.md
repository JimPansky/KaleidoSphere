# Release Notes

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
