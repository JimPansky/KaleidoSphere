import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildPromotionBundle, readPromotionZip } from '../services/bi-control/src/promotion-bundle.mjs';
import { executeSyntheticPromotion, HUMAN_APPROVAL, SyntheticSupersetMetadata } from '../services/bi-control/src/promotion-execution.mjs';
import { buildSupersetFingerprint } from '../services/bi-control/src/superset-fingerprint.mjs';
import { DatabaseSync } from 'node:sqlite';
import { ingestCatalogReceipt } from '../services/bi-control/src/catalog.mjs';
import { handleDiscovery } from '../services/bi-control/src/discovery.mjs';
import { runAnalyzeProfile } from '../services/bi-control/src/db-analyzer/workflow.mjs';

const now = new Date('2026-08-14T08:30:00.000Z');
async function fixture() {
  const analysis = await runAnalyzeProfile('services/bi-control/fixtures/mssql-profile-v1.json', { repositoryRoot: 'services/bi-control' });
  const receipt = { schemaVersion:'chimpmaera.bi/analysis-receipt/v1', receiptId:`mssql-${analysis.snapshotSha256.slice(0,24)}`, status:'ANALYZED_READ_ONLY', analyzedAt:now.toISOString(), sourceMode:'fixture', engine:'mssql', scope:analysis.profile.scope, safety:{queryPackSelectOnly:true,rowSamples:false}, analysis };
  const db = new DatabaseSync(':memory:'); ingestCatalogReceipt(db, receipt);
  const started = handleDiscovery(db,{action:'start',sessionId:'promotion_exec'}); const first=(g)=>started.state.guidance.suggestions[g][0].id; const answer=(field,value)=>handleDiscovery(db,{action:'answer',sessionId:'promotion_exec',field,value});
  answer('audienceRole','Synthetic reviewer'); answer('businessQuestions',['Review confirmed synthetic metric']); answer('confirmedKpiCandidates',[first('kpiCandidates')]); answer('dimensions',[first('dimensions')]); answer('timeGranularity',{candidateIds:[first('timeCandidates')],granularity:'snapshot'}); answer('filtersSegments',['Synthetic only']); answer('drilldowns',[first('drilldownCandidates')]); answer('freshnessNeed','Test run'); answer('accessConfidentiality',{classification:'INTERNAL',constraints:['No source rows']}); answer('openAssumptions',['Synthetic owned target only']); handleDiscovery(db,{action:'confirm',sessionId:'promotion_exec',confirmed:true}); const brief=handleDiscovery(db,{action:'export',sessionId:'promotion_exec'}).export; db.close();
  const runtime=JSON.parse(await readFile('services/bi-control/fixtures/superset-fingerprint-runtime-v1.json','utf8')); const fingerprint=buildSupersetFingerprint(runtime); const refs=brief.provenance.evidenceSources.slice(0,1);
  const built=await buildPromotionBundle({createdAt:now.toISOString(),discoveryBrief:brief,catalogEvidence:{schemaVersion:'chimpmaera.bi/catalog-promotion-evidence/v1',receiptId:brief.catalog.receiptId,snapshotSha256:brief.catalog.snapshotSha256,scope:brief.catalog.scope,coverage:brief.coverageBlindSpots,provenance:refs,mutationPerformed:false},supersetFingerprint:fingerprint,assets:[{kind:'database',uuid:'61111111-1111-4111-8111-111111111111',title:'Synthetic owned target',dependsOn:[],reviewSpec:{sourceConnectionIncluded:false}},{kind:'dataset',uuid:'62222222-2222-4222-8222-222222222222',title:'Synthetic dataset',dependsOn:['61111111-1111-4111-8111-111111111111'],reviewSpec:{semanticReviewRequired:true}},{kind:'chart',uuid:'63333333-3333-4333-8333-333333333333',title:'Synthetic chart',dependsOn:['62222222-2222-4222-8222-222222222222'],reviewSpec:{visualizationType:'big_number'}},{kind:'dashboard',uuid:'64444444-4444-4444-8444-444444444444',title:'Synthetic dashboard',dependsOn:['63333333-3333-4333-8333-333333333333'],reviewSpec:{publicationState:'SYNTHETIC_ONLY'}}]}, {now});
  const bundledFingerprint=JSON.parse(readPromotionZip(built.archive).get('evidence/superset-fingerprint.json')); return {built,fingerprint:bundledFingerprint};
}

test('approved synthetic execution reads back by UUID, is idempotent, and restores exact backup', async()=>{
  const {built,fingerprint}=await fixture(); const dir=await mkdtemp(path.join(tmpdir(),'sba-m5-03-')); const metadata=new SyntheticSupersetMetadata(path.join(dir,'metadata.json')); const seed={uuid:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',kind:'dashboard',title:'prior',depends_on:[],review_spec:{},owned:true,synthetic:true,bundle_id:'prior',digest:'prior'}; await metadata.initialize([seed]);
  const target={mode:'SYNTHETIC_OWNED_LOCAL',owned:true,sourceConnectivity:'NONE',baseUrl:fingerprint.target.base_url};
  const first=await executeSyntheticPromotion({bundle:built.archive,approval:HUMAN_APPROVAL,fingerprint,target,metadata,backupPath:path.join(dir,'backup.json'),now}); assert.equal(first.status,'APPLIED_AND_READ_BACK'); assert.equal(first.readback.length,4); assert.deepEqual(first.dependency_order.slice(0,2),['61111111-1111-4111-8111-111111111111','62222222-2222-4222-8222-222222222222']);
  const second=await executeSyntheticPromotion({bundle:built.archive,approval:HUMAN_APPROVAL,fingerprint,target,metadata,backupPath:path.join(dir,'backup2.json'),now}); assert.equal(second.status,'ALREADY_APPLIED'); assert.equal(second.mutation_performed,false);
  await assert.rejects(metadata.readback('69999999-9999-4999-8999-999999999999'),/PROMOTION_READBACK_UUID_NOT_FOUND/);
  const restored=await metadata.restore(first.backup); assert.equal(restored.restoredSha256,first.before_sha256); await assert.rejects(metadata.readback('64444444-4444-4444-8444-444444444444'),/PROMOTION_READBACK_UUID_NOT_FOUND/); assert.equal((await metadata.readback(seed.uuid)).title,'prior');
});

test('execution denial probes fail before mutation', async()=>{
  const {built,fingerprint}=await fixture(); const dir=await mkdtemp(path.join(tmpdir(),'sba-m5-03-deny-')); const metadata=new SyntheticSupersetMetadata(path.join(dir,'metadata.json')); await metadata.initialize(); const original=await metadata.digest(); const target={mode:'SYNTHETIC_OWNED_LOCAL',owned:true,sourceConnectivity:'NONE',baseUrl:fingerprint.target.base_url};
  const run=(change)=>executeSyntheticPromotion({bundle:built.archive,approval:HUMAN_APPROVAL,fingerprint,target,metadata,backupPath:path.join(dir,`${Math.random()}.bak`),now,...change});
  await assert.rejects(run({approval:'no'}),/PROMOTION_HUMAN_APPROVAL_REQUIRED/); await assert.rejects(run({fingerprint:{...fingerprint,observed_at:'2026-01-01T00:00:00.000Z'}}),/PROMOTION_FRESH_FINGERPRINT_MISMATCH/); await assert.rejects(run({target:{...target,baseUrl:'https:\/\/production.example.com'}}),/PROMOTION_PRODUCTION_LIKE_TARGET_DENIED/); await assert.rejects(run({target:{...target,sourceConnectivity:'MSSQL'}}),/PROMOTION_TARGET_NOT_SYNTHETIC_OWNED/); assert.equal(await metadata.digest(),original);
});
