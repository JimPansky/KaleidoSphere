import {createHash} from 'node:crypto';
import {readFile, rename, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const root = resolve(process.cwd());
const sourceMapPath = resolve(root, 'SOURCE-MAP.json');
const authoredFiles = [
  'README.md',
  'docs/ARCHITECTURE.md',
  'docs/CONFIGURATION.md',
  'docs/decisions/HARNESS-NEUTRAL-EVIDENCE-BRIDGE-V1.md',
  'docs/evidence/HARNESS_NEUTRAL_EVIDENCE_BRIDGE_V1.md',
  'docs/RELEASE_NOTES.md',
  'package.json',
  'scripts/run-external-api-v2-clean-room.mjs',
  'scripts/update-k1-evidence-bridge-source-map.mjs',
  'services/bi-agent/package.json',
  'services/bi-agent/src/external-intent-evidence-bridge.mjs',
  'tests/external-intent-evidence-bridge.test.mjs',
  'tests/external-api-v2.test.mjs',
  'tests/fixtures/external-intent-evidence-bridge-v1.json',
  'tests/release.test.mjs',
];

const sourceMap = JSON.parse(await readFile(sourceMapPath, 'utf8'));
for (const file of authoredFiles) {
  sourceMap.files[file] = createHash('sha256').update(await readFile(resolve(root, file))).digest('hex');
}
sourceMap.files = Object.fromEntries(Object.entries(sourceMap.files).sort(([left], [right]) => left.localeCompare(right)));
const temporary = `${sourceMapPath}.k1-evidence-bridge-${process.pid}.tmp`;
await writeFile(temporary, `${JSON.stringify(sourceMap, null, 2)}\n`, {flag: 'wx'});
await rename(temporary, sourceMapPath);
process.stdout.write(`K1 evidence bridge source map updated: ${authoredFiles.length} authored files, ${Object.keys(sourceMap.files).length} total entries\n`);
