# M5-03 Synthetic Promotion Execution and Readback

M5-03 adds a deliberately narrow execution adapter for disposable, owned,
local-only synthetic Superset metadata. Execution requires the exact human
approval phrase, a fresh M5-02 `PASS_REVIEW_ONLY` bundle, byte-equivalent bundled
fingerprint evidence, and a target contract declaring no source connectivity.

Before mutation the adapter atomically backs up metadata. Assets are applied in
stable dependency order and read back by UUID with bundle/dependency binding.
The same bundle is idempotent. Restore verifies the backup SHA-256 before an
atomic replacement, and tests prove promoted UUIDs disappear while prior state
is exact.

This is not production compatibility evidence, a customer deployment, a
Superset-native ZIP import, source-row access, raw SQL execution, credential
handling, or Oracle/MSSQL connectivity. Release, tags, and assets are unchanged.
