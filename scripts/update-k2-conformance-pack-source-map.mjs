import {createHash} from 'node:crypto';
import {readFile, rename, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const root = resolve(process.cwd());
const sourceMapPath = resolve(root, 'SOURCE-MAP.json');
const authoredFiles = [
  'SOURCE-MAP.md',
  'docs/ARCHITECTURE.md',
  'docs/evidence/CLOSED_INTENT_CONFORMANCE_PACK_V1.md',
  'docs/RELEASE_NOTES.md',
  'package.json',
  'scripts/update-k2-conformance-pack-source-map.mjs',
  'services/bi-agent/src/closed-intent-conformance-pack.mjs',
  'tests/closed-intent-conformance-pack.test.mjs',
  'tests/fixtures/closed-intent-conformance-pack-v1.json',
];

const sourceMap = JSON.parse(await readFile(sourceMapPath, 'utf8'));
for (const file of authoredFiles) {
  sourceMap.files[file] = createHash('sha256').update(await readFile(resolve(root, file))).digest('hex');
}
sourceMap.files = Object.fromEntries(Object.entries(sourceMap.files).sort(([left], [right]) => left.localeCompare(right)));
const temporary = `${sourceMapPath}.k2-conformance-pack-${process.pid}.tmp`;
await writeFile(temporary, `${JSON.stringify(sourceMap, null, 2)}\n`, {flag: 'wx'});
await rename(temporary, sourceMapPath);
process.stdout.write(`K2 conformance pack source map updated: ${authoredFiles.length} authored files, ${Object.keys(sourceMap.files).length} total entries\n`);
