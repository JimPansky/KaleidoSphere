import {createHash} from 'node:crypto';
import {readFile, rename, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const root = resolve(process.cwd());
const sourceMapPath = resolve(root, 'SOURCE-MAP.json');
const authoredFiles = [
  'README.md',
  'SOURCE-MAP.md',
  'docs/ARCHITECTURE.md',
  'docs/CONFIGURATION.md',
  'docs/RELEASE_NOTES.md',
  'docs/ROADMAP.md',
  'docs/decisions/SAFE-ANALYSIS-METHOD-PARITY.md',
  'docs/evidence/SAFE_ANALYSIS_METHOD_PARITY.md',
  'package.json',
  'scripts/update-safe-analysis-parity-source-map.mjs',
  'scripts/run-external-api-v2-clean-room.mjs',
  'services/bi-agent/package.json',
  'services/bi-control/query-packs/db-analyzer/v1/mssql/safe-analysis-manifest.json',
  'services/bi-control/query-packs/db-analyzer/v1/mssql/safe-column-summary.sql',
  'services/bi-control/query-packs/db-analyzer/v1/mssql/safe-quality-indicators.sql',
  'services/bi-control/query-packs/db-analyzer/v1/mssql/safe-relationship-overlap.sql',
  'services/bi-control/query-packs/db-analyzer/v1/mssql/safe-temporal-coverage.sql',
  'services/bi-control/query-packs/db-analyzer/v1/oracle/safe-analysis-manifest.json',
  'services/bi-control/query-packs/db-analyzer/v1/oracle/safe-column-summary.sql',
  'services/bi-control/query-packs/db-analyzer/v1/oracle/safe-quality-indicators.sql',
  'services/bi-control/query-packs/db-analyzer/v1/oracle/safe-relationship-overlap.sql',
  'services/bi-control/query-packs/db-analyzer/v1/oracle/safe-temporal-coverage.sql',
  'services/bi-control/src/db-analyzer/progressive-analysis-v1.mjs',
  'services/bi-control/src/db-analyzer/progressive-controller.mjs',
  'services/bi-control/src/db-analyzer/safe-analysis-methods.mjs',
  'tests/safe-analysis-method-parity.test.mjs',
  'tests/external-api-v2.test.mjs',
  'tests/release.test.mjs',
];

const sourceMap = JSON.parse(await readFile(sourceMapPath, 'utf8'));
for (const file of authoredFiles) {
  sourceMap.files[file] = createHash('sha256').update(await readFile(resolve(root, file))).digest('hex');
}
sourceMap.files = Object.fromEntries(Object.entries(sourceMap.files).sort(([left], [right]) => left.localeCompare(right)));
const temporary = `${sourceMapPath}.safe-analysis-parity-${process.pid}.tmp`;
await writeFile(temporary, `${JSON.stringify(sourceMap, null, 2)}\n`, {flag: 'wx'});
await rename(temporary, sourceMapPath);
process.stdout.write(`Safe-analysis parity source map updated: ${authoredFiles.length} authored files, ${Object.keys(sourceMap.files).length} total entries\n`);
