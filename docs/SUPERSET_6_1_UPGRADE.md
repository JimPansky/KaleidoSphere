# Apache Superset 6.1.0 upgrade

This repository pins the owned Superset image to `apache/superset:6.1.0` and an
immutable digest. Treat the metadata database and generated internal secrets as
one restore unit; restoring only the database with different secrets can make
stored credentials unreadable.

## Backup before upgrade

1. Stop the stack with `./bin/bi down`.
2. Archive `.runtime/metadata`, `.runtime/projection`, `.runtime/receipts`, and
   `.runtime/secrets` to access-controlled storage. Do not commit the archive.
3. Record the archive SHA-256 and retain the previous repository revision and
   its Superset 5.0.0 image digest.
4. Verify the archive can be listed and extracted into an empty directory.

## Upgrade and verify

1. Pull the protected-main revision containing the 6.1.0 pin.
2. Run `docker compose config --quiet`, then `./bin/bi up`. The one-shot init
   service runs `superset db upgrade` before the long-running service starts.
3. Derive published ports with `docker compose ps` or `docker compose port`;
   do not assume example port values.
4. Run `npm test` and `./tests/smoke.sh` twice with the derived `SUPERSET_PORT`
   and `AGENT_PORT` values.
5. Confirm the fingerprint reports `6.1.0`, a canonical OpenAPI SHA-256, and a
   `compatible` verdict; confirm the planning gate is `READY_FOR_REVIEW` and
   `mutation_performed=false`.
6. Confirm the analyst role has no SQL Lab, database, upload, or mutation
   permissions and the managed database remains `allow_dml=false` and
   `expose_in_sqllab=false`.

## Restore rollback

Never run an in-place database downgrade. Stop and remove the 6.1.0 stack,
restore the complete backup into an empty runtime directory, and start the
previous repository revision with its pinned 5.0.0 image under a distinct
Compose project name. Derive its published ports, then run the baseline smoke.
Keep the 6.1.0 runtime and the restored 5.0.0 runtime isolated so rollback does
not mutate the only copy of either state.
