import {resolve} from 'node:path';
import {loadBenchmark} from '../dist/benchmark/index.js';
import {automationIdentity} from '../dist/benchmark/automation.js';
import {HUBSPOT_CATALOG_COMPAT} from '../dist/benchmark/automation-compat.js';
import {loadProviderSettings} from '../dist/config.js';
import {createExperimentRuntime} from '../dist/ditto/runtime.js';
import {officialBaseline} from '../dist/official-agent/baselines.js';
import {runOfficialAgent} from '../dist/official-agent/executor.js';
import {providerEnvironment} from '../dist/official-agent/runner.js';
import {evaluationRuntimeIdentity} from '../dist/run/case-recovery.js';
import {evaluateUnifiedCandidate} from '../dist/unified/evaluation.js';
import {UnifiedRunStore,artifactHash} from '../dist/unified/store.js';
import {createProviderBudget} from '../dist/unified/provider-budget.js';
import {NODE_SYSTEM_PROMPT_SHA256} from '../dist/graph-agent/system.js';
import {GENERATION} from '../dist/protocol.js';

process.env.DITTO_AUTOMATION_COMPAT=HUBSPOT_CATALOG_COMPAT;
const store=new UnifiedRunStore(resolve(process.argv[2]??'runs/automation-framework-20261109/hubspot-catalog-fixed'));
const settings={...loadProviderSettings(),concurrency:1};
const definition=officialBaseline('automationbench');definition.config={...definition.config,firstTaskRepeat:false};
const environment=providerEnvironment(process.cwd());
const executionIdentity=await evaluationRuntimeIdentity(process.cwd(),environment),officialEnvironment=await automationIdentity();
const timeBudget={requestMs:180000,workflowMs:null,reason:'Single-case public API contract regression diagnosis'};
const loaded=await loadBenchmark('automationbench',{dataDir:resolve(process.env.DITTO_AUTOMATION_DATA??'data/automationbench'),split:'validate',dataMode:'formal',limit:0,artifactDir:store.path('private')});
const task=loaded.tasks.find(t=>t.id==='automationbench:simple.hs_create_deal_with_contact');if(!task)throw Error('Missing diagnostic task');
const benchmark={...loaded,tasks:[task]};
const identity={protocol:'automation-catalog-repair-single-case-v1',executionIdentity,officialEnvironment,data:loaded.identity,taskIds:[task.id],definitionHash:artifactHash(definition),nodeSystemHash:NODE_SYSTEM_PROMPT_SHA256,model:settings.model,endpoint:settings.baseUrl,generation:GENERATION,repeats:1,retryAttempts:1,timeBudget};
const previous=await store.optional('manifest.json');if(previous&&artifactHash(previous.identity)!==artifactHash(identity))throw Error('Diagnostic identity changed');
const manifest={identity,status:'running',createdAt:previous?.createdAt??new Date().toISOString(),note:'Standard baseline workflow and prompts. Explicit public endpoint catalog repair only. One Search case, not a full benchmark score.'};
await store.write('manifest.json',manifest);if(!previous)await store.snapshot(process.cwd());
await store.write('tasks-public.json',[{id:task.id,prompt:task.prompt}]);
const budget=createProviderBudget({maxCalls:100,maxTokens:500000,restored:await store.optional('provider-budget.json'),onEvent:async e=>store.write('provider-budget.json',e.usage)});
const runtime=createExperimentRuntime(settings,{timeBudget,connectTimeoutMs:10000,beforeProviderCall:async input=>{await budget.beforeProviderCall(input);await store.append('provider-requests.jsonl',{input});},afterProviderCall:async e=>{await budget.afterProviderCall(e);await store.append('provider-responses.jsonl',{metadata:e.input.metadata,output:e.output,error:e.error?.message});}});
try{
 const summary=await evaluateUnifiedCandidate({benchmark,definition,id:'standard-baseline-catalog-fixed',store,executionIdentity:identity,repeats:1,concurrency:1,retryAttempts:1,timeBudget,prune:false,resume:!!previous,runTask:(spec,task)=>runOfficialAgent(spec,task,runtime,settings),onEvent:async e=>{await store.append('events.jsonl',e);console.log(JSON.stringify(e));}});
 await store.write('summary.json',summary);manifest.status='completed';manifest.score=summary.score;
 console.log('FINAL '+JSON.stringify({score:summary.score,cases:summary.results.length,usage:budget.snapshot()}));
}catch(error){manifest.status='interrupted';manifest.error={message:error.message,code:error.code};console.error('INTERRUPTED '+JSON.stringify(manifest.error));process.exitCode=1;}
finally{await runtime.close();manifest.usage=budget.snapshot();await store.write('manifest.json',manifest);await store.flush();}
