# M5-03 Synthetic Promotion Execution and Readback

This slice adds one mutation lane: a human-approved import into an explicitly
owned, disposable, local-only synthetic Superset metadata state. It is not a
production Superset import API and cannot connect to Oracle, MSSQL, customer
systems, or source rows.

Execution requires the literal approval `APPROVE_SYNTHETIC_PROMOTION`, the
archive SHA-256, the fresh compatible M5-02 fingerprint target identity, and a
`PASS_REVIEW_ONLY` bundle. Before mutation it writes a byte-stable metadata
backup. Assets are imported and read back by UUID with their exact dependency
graph and bundle binding. Repeating the import is idempotent. Restore requires
the backup SHA-256 and verifies the restored bytes exactly.

```bash
./bin/bi promotion-bundle execute-synthetic --bundle review.zip \
  --metadata /tmp/owned-synthetic/metadata.json \
  --backup /tmp/owned-synthetic/metadata.backup.json \
  --approval APPROVE_SYNTHETIC_PROMOTION \
  --bundle-sha256 "$BUNDLE_SHA256" --fingerprint-sha256 "$TARGET_IDENTITY_SHA256"
./bin/bi promotion-bundle readback-synthetic \
  --metadata /tmp/owned-synthetic/metadata.json --uuid "$ASSET_UUID"
./bin/bi promotion-bundle restore-synthetic \
  --metadata /tmp/owned-synthetic/metadata.json \
  --backup /tmp/owned-synthetic/metadata.backup.json \
  --backup-sha256 "$BACKUP_SHA256"
```

Nonclaims: no production activation, customer/source database access,
source-row access, raw-SQL execution, credential use, or network connectivity.
