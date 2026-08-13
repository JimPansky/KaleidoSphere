# Clean-room validation

The standalone claim is checked from a local clone/archive that contains only
this repository. It must not mount or reference the ChimpMaera source worktree.

```bash
git archive --format=tar HEAD > /tmp/chimpmaera-bi-m1.tar
mkdir /tmp/chimpmaera-bi-clean
tar -xf /tmp/chimpmaera-bi-m1.tar -C /tmp/chimpmaera-bi-clean
cd /tmp/chimpmaera-bi-clean
cp .env.example .env
./bin/bi setup
./bin/bi up
./tests/smoke.sh
./bin/bi down
```

The portable smoke uses `BI_SOURCE_MODE=fixture`; its receipt must say
`SYNTHETIC_UNVALIDATED`. Live MSSQL evidence is a separate gate and requires an
available safe source plus a read-only account. The M1 Oracle runtime evidence
uses a disposable Oracle Free container and is recorded separately in
`docs/evidence/M1_ORACLE_RUNTIME.md`; the fixture regression never substitutes
for that live evidence.
