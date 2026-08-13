# Third-party notices

ChimpMaera project-authored work is licensed under Apache License 2.0. The
pinned JavaScript development/runtime dependency set in `package-lock.json`
includes these direct dependencies and selected transitive components:

| Package | Version | License |
| --- | ---: | --- |
| `ajv` | 8.20.0 | MIT |
| `ajv-formats` | 3.0.1 | MIT |
| `mssql` | 12.7.0 | MIT |
| `node-sql-parser` (optional) | 5.4.0 | Apache-2.0 |
| `@types/pegjs` (via optional `node-sql-parser`) | 0.10.6 | MIT |
| `big-integer` (via optional `node-sql-parser`) | 1.6.52 | Unlicense |
| `tedious` (via `mssql`) | 20.0.0 | MIT |
| `fast-deep-equal` | 3.1.3 | MIT |
| `fast-uri` | 3.1.4 | BSD-3-Clause |
| `json-schema-traverse` | 1.0.0 | MIT |
| `require-from-string` | 2.0.2 | MIT |
| `@types/node` | 24.10.1 | MIT |
| `typescript` | 5.9.3 | Apache-2.0 |
| `undici-types` | 7.16.0 | MIT |

The playable demo references pinned container images for Node.js, MariaDB,
EspoCRM and Dolibarr. The optional video reference image installs Debian
Bookworm packages including Python, PyYAML, FFmpeg and CA certificates.
Those components remain under their respective upstream licenses. Building or
redistributing a container image may require retaining additional notices
from the resulting image.

The Issue #192 runtime verification uses Microsoft SQL Server Developer and
Wide World Importers only as external, locally operated test infrastructure.
Neither the proprietary SQL Server runtime nor the sample database is bundled
or redistributed with ChimpMaera; its separate provenance and non-distribution
boundary are recorded under `verification/db-analyzer/`.

The optional voice sample and logo in
`tools/video-production-reference/assets/reference/` are preserved under the
conservative boundary in `MEDIA-LICENSE.md`. Apache-2.0 grants no trademark,
word-mark, logo or endorsement rights. See the tool's `ASSET-USAGE.md` for the
asset boundary.
