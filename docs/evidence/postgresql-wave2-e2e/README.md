# PostgreSQL Analysis Wave 2 local readback

The allowlisted Wave 2 flow ran twice through fresh read-only sessions against the digest-pinned PostgreSQL 16.10 fixture. Both canonical results are byte-identical at SHA-256 `e907b98ee1049fae4456cb74195727e1cde63adae304e1817a5820b419906d70`.

Three columns were profiled with count-only evidence. One candidate pair was evaluated and produced the review-required high-confidence proposal `ks23_app.staging_events.account_id` → `ks23_app.accounts.account_id`; the declared orders foreign key was excluded rather than duplicated.

Observed, computed and inferred records are separated and content-addressed. No source-row material, credentials, connection strings, provider calls, free SQL or mutation authority are included.
