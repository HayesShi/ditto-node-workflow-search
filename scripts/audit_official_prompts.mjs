import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createExperimentRuntime} from '../dist/ditto/runtime.js';
import {runOfficialAgent} from '../dist/official-agent/executor.js';
import {searchOfficialWorkflows} from '../dist/official-agent/search.js';
import {OFFICIAL_BASELINE} from '../dist/official-agent/schema.js';
import {OFFICIAL_OPTIMIZER_SYSTEM,OFFICIAL_OPTIMIZER_SYSTEM_SHA256} from '../dist/official-agent/prompts.js';
import {NODE_SYSTEM_PROMPT} from '../dist/graph-agent/system.js';

const requests=[],settings={baseUrl:'https://example.invalid',apiKey:'offline',model:'audit',concurrency:1,timeoutMs:3000};
const changed=structuredClone(OFFICIAL_BASELINE);changed.config.strategy='Return the requested public answer concisely.';
const shared=createExperimentRuntime(settings,{provider:{async invoke(input){requests.push(structuredClone(input));return{message:{role:'assistant',content:input.metadata?.role==='optimizer'?JSON.stringify({rationale:'One public user strategy refinement',definition:changed}):'public answer'},finishReason:'stop',usage:{inputTokens:2,outputTokens:1,totalTokens:3}};}}});
try{
 for(const dataset of ['drop','gsm8k']){
  const task={id:'audit-'+dataset,dataset,prompt:'A public passage and question.',outputInstruction:'',metadata:{}};
  await searchOfficialWorkflows({runtime:shared.runtime,model:{provider:shared.providerName,model:shared.model},dataset,publicTasks:[task],exploration:false,expectedRepeats:1,maxValidEvaluations:2,maxDesignRounds:1,evaluate:async definition=>{
   const run=await runOfficialAgent(definition,task,shared,settings);assert.equal(run.answer,'public answer');
   return{valid:true,score:.5,standardDeviation:0,repeats:1,examples:1,successfulRuns:1,failedRuns:0,wrongRuns:0,timeoutRuns:0,inputTokens:2,outputTokens:1,totalTokens:3,durationMs:0,publicTraces:[run],results:[{caseId:task.id+'#1',valid:true,score:.5,expected:'PRIVATE_SENTINEL',prediction:run.answer,normalizedExpected:'PRIVATE_SENTINEL',normalizedPrediction:run.answer,method:'fixture',latencyMs:0,inputTokens:2,outputTokens:1,totalTokens:3}]};
  }});
 }
}finally{await shared.close();}
const optimizers=requests.filter(r=>r.metadata?.role==='optimizer'),nodes=requests.filter(r=>r.metadata?.role!=='optimizer');
assert.equal(optimizers.length,2);assert.equal(nodes.length,4);
assert(optimizers.every(r=>r.messages[0].content===OFFICIAL_OPTIMIZER_SYSTEM));
assert(nodes.every(r=>r.messages.filter(m=>m.role==='system').map(m=>m.content).join('')===NODE_SYSTEM_PROMPT));
assert(!JSON.stringify(requests).includes('PRIVATE_SENTINEL'));
const report={checks:'passed',protocol:'official-agent-json',providerNetworkCalls:0,mockProviderCalls:requests.length,systemPromptSha256:OFFICIAL_OPTIMIZER_SYSTEM_SHA256,crossDatasetOptimizerSystemFrozen:true,crossDatasetNodeSystemFrozen:true,privateReferenceExcluded:true,requests};
const output=resolve(process.argv[2]??'runs/official-prompt-audit');await mkdir(output,{recursive:true});await writeFile(output+'/audit.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,requests:undefined}));
