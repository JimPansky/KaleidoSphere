# PostgreSQL #23 local end-to-end readback

Fixture `ks23-postgres-e2e-v1` ran twice through fresh read-only sessions against the digest-pinned official PostgreSQL 16.10 image. Both canonical artifacts are byte-identical at SHA-256 `694e9d033bcd45861e3a5d97df869b572f31b0929474041a980109139a1fc258`.

Observed scope: 1 schema, 3 relations, 13 columns, 9 constraints and 1 declared foreign key. The NOT VALID check remains unvalidated; the partial unique index is explicitly outside the #22 constraint model.

Policy mutation, raw-row and scope-override probes dispatched zero database calls. Independent database mutation/DDL, timeout and cancellation probes failed closed; ground truth remained unchanged and post-probe health passed. No raw values are reproduced here.
