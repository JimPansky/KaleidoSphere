# Clean-room validation

The standalone claim is checked from a local clone/archive that contains only
this repository. It must not mount or reference the ChimpMaera source worktree.

```bash
git archive --format=tar HEAD > /tmp/chimpmaera-bi-m4.tar
mkdir /tmp/chimpmaera-bi-clean
tar -xf /tmp/chimpmaera-bi-m4.tar -C /tmp/chimpmaera-bi-clean
cd /tmp/chimpmaera-bi-clean
cp .env.example .env
./bin/bi setup
./bin/bi up
./tests/smoke.sh
./bin/bi discovery start clean_room
./bin/bi discovery status clean_room
./bin/bi down
```

The portable smoke uses `BI_SOURCE_MODE=fixture`; its receipt must say
`SYNTHETIC_UNVALIDATED`. Live MSSQL evidence is a separate gate and requires an
available safe source plus a read-only account. The M2 Oracle technical
inventory evidence uses a disposable Oracle Free container and is recorded
separately in `docs/evidence/M2_ORACLE_TECHNICAL_INVENTORY.md`; the fixture
regression never substitutes for live Oracle evidence.

M4 Discovery clean-room proof must also confirm and export a brief from the local
catalog while the source database is not queried after catalog ingestion. It must
not create dynamic Superset datasets, charts, dashboards, or SQL.

M5-02 clean-room proof additionally runs:

```bash
node --test tests/promotion-bundle.test.mjs
node scripts/build-release.mjs /tmp/sba-release
cd /tmp/sba-release
sha256sum -c Superset_BI_Agent-v0.7.0.tar.gz.sha256
```

Build the release archive twice from the same clean tree and compare bytes and
SHA-256. Extract the archive into a second verifier directory, confirm it has no
`.git`, `.env`, generated `.runtime`, `.secrets`, `node_modules`, or generated
review ZIP, then rerun `npm test`, Compose config, and the promotion malicious-
bundle probes. This proves only portable offline/fixture behavior, not customer
or production promotion compatibility.
