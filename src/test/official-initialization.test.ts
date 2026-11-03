import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {loadOfficialInitialization} from '../official-agent/initialization.js';
import {OFFICIAL_OPTIMIZER_SYSTEM,OFFICIAL_OPTIMIZER_SYSTEM_SHA256,OFFICIAL_DEFINITION_GUIDE} from '../official-agent/prompts.js';
import {UNIFIED_OPTIMIZER_SYSTEM_SHA256} from '../unified/prompts.js';
import {NODE_SYSTEM_PROMPT} from '../graph-agent/system.js';

test('official initialization keeps the unmodified baseline unless explicitly selected',()=>{
 for(const dataset of ['drop','humaneval','mbpp','automationbench','bfcl','math','gsm8k'] as const){
  const value=loadOfficialInitialization(dataset);
  assert.equal(value.selection,'baseline');assert.equal(value.guidance,null);assert.equal(value.seedStrategy,undefined);
  assert.equal(value.presentation,'no-repeat');assert.deepEqual(value.provenance.assets,[]);
  assert.equal(value.identity,loadOfficialInitialization(dataset,'baseline').identity);
 }
 assert.throws(()=>loadOfficialInitialization('bfcl','pr10-selected'),/No reviewed PR10 strategy/);
 assert.throws(()=>loadOfficialInitialization('gsm8k','pr7-guidance'),/No reviewed PR7 prompt pool/);
});

test('selected PR10 text is an explicit frozen user prior with historical research excluded',()=>{
 const systemBefore=NODE_SYSTEM_PROMPT;
 for(const dataset of ['drop','humaneval','mbpp','automationbench'] as const){
  const source=JSON.parse(readFileSync(new URL(`../../prompts/initialization/pr10/${dataset}.json`,import.meta.url),'utf8'));
  const value=loadOfficialInitialization(dataset,'pr10-selected');
  assert.equal(value.seedStrategy,source.selectedSeed.strategy);assert.equal(value.presentation,source.selectedSeed.presentation);
  assert.equal(value.provenance.sourceDefinitionHash,source.selectedSeed.sourceDefinitionHash);
  assert.equal(value.provenance.sourceCommit,'d9e51796b57407f1c083a44252ee0b44c832f67b');
  assert.equal(value.provenance.assets.length,2);
  const shown=JSON.stringify(value.guidance);
  assert(!shown.includes('researchMetadata'));assert(!shown.includes('knownExplorationTokens'));assert(!shown.includes('mean F1'));
  assert.match(shown,/public task\/answer contract/);
 }
 assert.equal(loadOfficialInitialization('drop','pr10-selected').presentation,'repeat-task-on-first-sample');
 assert.equal(loadOfficialInitialization('mbpp','pr10-selected').presentation,'no-repeat');
 assert.equal(NODE_SYSTEM_PROMPT,systemBefore);
});

test('PR7 public guidance excludes obsolete A registration assumptions and is immutable',()=>{
 const value=loadOfficialInitialization('bfcl','pr7-guidance');
 assert.equal(value.seedStrategy,undefined);assert.equal(value.presentation,'no-repeat');
 assert.match(JSON.stringify(value.guidance),/bfcl_respond/);
 assert(!JSON.stringify(value.guidance).includes('executionReminders'));assert(!JSON.stringify(value.guidance).includes('workerHints'));
 assert(Object.isFrozen(value));assert(Object.isFrozen(value.guidance));assert(Object.isFrozen(value.provenance.assets));
 assert.throws(()=>{(value.guidance as any).scope='Change the system';},TypeError);
 assert.throws(()=>{(value.guidance as any).promptPool[0].text='Changed';},TypeError);
 assert.equal(value.identity,loadOfficialInitialization('bfcl','pr7-guidance').identity);
 assert.notEqual(value.identity,loadOfficialInitialization('drop','pr7-guidance').identity);
});

test('new official optimizer has a distinct frozen protocol and the legacy system remains intact',()=>{
 assert.equal(createHash('sha256').update(OFFICIAL_OPTIMIZER_SYSTEM).digest('hex'),OFFICIAL_OPTIMIZER_SYSTEM_SHA256);
 assert.equal(UNIFIED_OPTIMIZER_SYSTEM_SHA256,'b24585922532b06f09bc927f5f9471bd6e40fe68af123769d2b7dd6364daa00a');
 assert.notEqual(OFFICIAL_OPTIMIZER_SYSTEM_SHA256,UNIFIED_OPTIMIZER_SYSTEM_SHA256);
 assert.match(OFFICIAL_OPTIMIZER_SYSTEM,/official version:1/);assert.match(OFFICIAL_OPTIMIZER_SYSTEM,/role:system/);
 assert.match(OFFICIAL_DEFINITION_GUIDE,/toolArtifacts/);assert.match(OFFICIAL_DEFINITION_GUIDE,/concat joins ARRAYS, not strings/);
 assert.match(OFFICIAL_DEFINITION_GUIDE,/nodes.solve.output.message.content/);
});

test('preserved A0 sources match their original hashes without claiming verified scores or Test',()=>{
 const base=new URL('../../examples/legacy-pr7-a0/',import.meta.url);
 const provenance=JSON.parse(readFileSync(new URL('PROVENANCE.json',base),'utf8'));
 assert.equal(provenance.sourceCommit,'b641010f240ced610a45625653375816829c87e4');
 assert.equal(provenance.historicalScoresIndependentlyVerified,false);assert.equal(provenance.heldOutTestPerformed,false);
 assert.equal(provenance.requiredHistoricalDittoVersion,'0.1.1');assert.equal(provenance.files.length,6);
 for(const file of provenance.files){const bytes=readFileSync(new URL(file.file,base));assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256,file.file);}
 const results=JSON.parse(readFileSync(new URL('results.json',base),'utf8'));
 assert.equal(results.split,'Search');assert.equal(results.repeats,1);
 assert.deepEqual(Object.fromEntries(results.results.map((r:any)=>[r.dataset,r.examples])),{drop:200,humaneval:33,mbpp:86,automationbench:200,bfcl:200});
});
