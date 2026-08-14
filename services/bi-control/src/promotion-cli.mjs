#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { buildPromotionBundle, inspectPromotionBundle, preflightPromotionBundle, writePromotionBundle } from './promotion-bundle.mjs';
import { executeSyntheticPromotion, readbackSyntheticPromotion, restoreSyntheticPromotion } from './synthetic-promotion.mjs';

const syntheticTarget = { identity: 'chimpmaera-owned-disposable-superset', local_only: true, synthetic_owned: true, production: false, customer: false, source_connectivity: 'NONE' };

function fail(message) {
  process.stderr.write(`ChimpMaera BI promotion bundle ERROR: ${message}\n`);
  process.exit(2);
}

function args(values) {
  const result = { _: [] };
  for (let index = 0; index < values.length; index += 1) {
    if (!values[index].startsWith('--')) result._.push(values[index]);
    else {
      const key = values[index].slice(2);
      const value = values[index + 1];
      if (!value || value.startsWith('--')) fail(`missing value for --${key}`);
      result[key] = value;
      index += 1;
    }
  }
  return result;
}

function render(report, human) {
  if (!human) return `${JSON.stringify(report, null, 2)}\n`;
  const inspection = report.inspection ?? report;
  return [
    `Status: ${report.status}`,
    `Contract: ${report.contract_version}`,
    `Bundle: ${inspection.bundle_id ?? 'unavailable'}`,
    `Archive SHA-256: ${inspection.archive_sha256 ?? 'unavailable'}`,
    `Assets: ${inspection.asset_count ?? 'unavailable'}`,
    `Mutation performed: ${report.mutation_performed}`,
    ...(report.reasons?.length ? [`Reasons: ${report.reasons.join(', ')}`] : []),
  ].join('\n') + '\n';
}

const parsed = args(process.argv.slice(2));
const command = parsed._[0];
const human = parsed.human === 'true';
const now = parsed.now ? new Date(parsed.now) : new Date();

if (command === 'build') {
  if (!parsed.input || !parsed.output) fail('usage: promotion-bundle build --input INPUT.json --output REVIEW.zip [--now ISO] [--human true]');
  const input = JSON.parse(await readFile(parsed.input, 'utf8'));
  const result = await buildPromotionBundle(input, { contractDir: path.resolve('contracts/superset-promotion-bundle/v1'), now });
  const written = await writePromotionBundle(result, parsed.output);
  process.stdout.write(render({ ...result.inspection, output: written }, human));
} else if (command === 'inspect' || command === 'preflight') {
  if (!parsed.bundle) fail(`usage: promotion-bundle ${command} --bundle REVIEW.zip [--now ISO] [--human true]`);
  const archive = await readFile(parsed.bundle);
  const report = command === 'inspect' ? inspectPromotionBundle(archive, { now }) : preflightPromotionBundle(archive, { now });
  process.stdout.write(render(report, human));
  if (report.status === 'BLOCKED') process.exitCode = 2;
} else if (command === 'execute-synthetic') {
  if (!parsed.bundle || !parsed.metadata || !parsed.backup || !parsed.approval || !parsed['bundle-sha256'] || !parsed['fingerprint-sha256']) fail('usage: promotion-bundle execute-synthetic --bundle REVIEW.zip --metadata STATE.json --backup BACKUP.json --approval APPROVE_SYNTHETIC_PROMOTION --bundle-sha256 SHA256 --fingerprint-sha256 SHA256 [--now ISO]');
  const report = await executeSyntheticPromotion({ bundle: await readFile(parsed.bundle), metadataPath: parsed.metadata, backupPath: parsed.backup, approval: parsed.approval, target: syntheticTarget, expectedBundleSha256: parsed['bundle-sha256'], expectedFingerprintSha256: parsed['fingerprint-sha256'], now });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else if (command === 'readback-synthetic') {
  if (!parsed.metadata || !parsed.uuid) fail('usage: promotion-bundle readback-synthetic --metadata STATE.json --uuid UUID');
  process.stdout.write(`${JSON.stringify(await readbackSyntheticPromotion({ metadataPath: parsed.metadata, uuid: parsed.uuid, target: syntheticTarget }), null, 2)}\n`);
} else if (command === 'restore-synthetic') {
  if (!parsed.metadata || !parsed.backup || !parsed['backup-sha256']) fail('usage: promotion-bundle restore-synthetic --metadata STATE.json --backup BACKUP.json --backup-sha256 SHA256');
  process.stdout.write(`${JSON.stringify(await restoreSyntheticPromotion({ metadataPath: parsed.metadata, backupPath: parsed.backup, target: syntheticTarget, expectedBackupSha256: parsed['backup-sha256'] }), null, 2)}\n`);
} else fail('usage: promotion-bundle {build|inspect|preflight|execute-synthetic|readback-synthetic|restore-synthetic} ...');
