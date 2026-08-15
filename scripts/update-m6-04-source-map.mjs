import { createHash } from 'node:crypto';
import { access, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(process.cwd());
const sourceMapPath = resolve(root, 'SOURCE-MAP.json');
const authoredFiles = [
  'package.json',
  'SOURCE-MAP.md',
  'docs/decisions/M6-04-TRUSTED-SPECIALIST-SUPERSET-WORKFLOW.md',
  'docs/evidence/M6-04_TRUSTED_SPECIALIST_SUPERSET_WORKFLOW.md',
  'docs/evidence/m6-04-trusted-workflow/live-manifest.json',
  'docs/evidence/m6-04-trusted-workflow/terminal-manifest.json',
  'scripts/finalize-m6-04-evidence.mjs',
  'scripts/run-trusted-superset-workflow-evidence.mjs',
  'scripts/update-m6-04-source-map.mjs',
  'services/bi-control/src/trusted-workflow/reviewed-superset-executor.mjs',
  'services/bi-control/src/trusted-workflow/trusted-specialist-workflow.mjs',
  'tests/trusted-workflow.test.mjs',
];

const sourceMap = JSON.parse(await readFile(sourceMapPath, 'utf8'));
for (const file of authoredFiles) {
  try { await access(resolve(root, file)); } catch { continue; }
  sourceMap.files[file] = createHash('sha256').update(await readFile(resolve(root, file))).digest('hex');
}
sourceMap.files = Object.fromEntries(Object.entries(sourceMap.files).sort(([left], [right]) => left.localeCompare(right)));
const temporary = `${sourceMapPath}.m6-04-${process.pid}.tmp`;
await writeFile(temporary, `${JSON.stringify(sourceMap, null, 2)}\n`, { flag: 'wx' });
await rename(temporary, sourceMapPath);
process.stdout.write(`M6-04 source map updated: ${authoredFiles.filter((file) => Object.hasOwn(sourceMap.files, file)).length} authored files, ${Object.keys(sourceMap.files).length} total entries\n`);
