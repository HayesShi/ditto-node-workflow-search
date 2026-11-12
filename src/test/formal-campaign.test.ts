import assert from 'node:assert/strict';
import test from 'node:test';

test('formal campaign uses main normal-scale budgets and complete fixed splits',async()=>{
 const {FORMAL_PROFILE,formalOptions}=await import(new URL('../../scripts/run_formal_campaign.mjs',import.meta.url).href);
 assert.equal(FORMAL_PROFILE.maxValidEvaluations,20);assert.equal(FORMAL_PROFILE.maxDesignRounds,100);assert.equal(FORMAL_PROFILE.maxProposalAttempts,3);
 assert.equal(FORMAL_PROFILE.searchRepeats,5);assert.equal(FORMAL_PROFILE.testRepeats,3);
 assert.deepEqual(FORMAL_PROFILE.testTasks,{drop:800,automationbench:600});
 for(const dataset of ['drop','automationbench']){
  const options=formalOptions(dataset,'project','public-data');
  assert.equal(options.maxValidEvaluations,20);assert.equal(options.maxDesignRounds,100);assert.equal(options.concurrency,3);
  assert.equal(options.requestMs,600000);assert.equal(options.workflowMs,null);assert.equal(options.initialization,'baseline');
 }
 assert.throws(()=>formalOptions('unknown','project','data'),/Unsupported/);
});
