import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {loadBenchmark} from '../dist/benchmark/index.js';
import {automationIdentity} from '../dist/benchmark/automation.js';
import {loadProviderSettings} from '../dist/config.js';
import {createExperimentRuntime} from '../dist/ditto/runtime.js';
import {officialBaseline} from '../dist/official-agent/baselines.js';
import {automationProgressController,AUTOMATION_PROGRESS_CONTROLLER_VERSION} from '../dist/official-agent/progress-controller.js';
import {TOOL_PROGRESS_VERSION} from '../dist/official-agent/progress.js';
import {runOfficialAgent} from '../dist/official-agent/executor.js';
import {officialArtifactHash} from '../dist/official-agent/schema.js';
import {providerEnvironment} from '../dist/official-agent/runner.js';
import {evaluationRuntimeIdentity} from '../dist/run/case-recovery.js';
import {evaluateUnifiedCandidate} from '../dist/unified/evaluation.js';
import {UnifiedRunStore,artifactHash} from '../dist/unified/store.js';
import {createProviderBudget} from '../dist/unified/provider-budget.js';
import {NODE_SYSTEM_PROMPT_SHA256} from '../dist/graph-agent/system.js';
import {OFFICIAL_OPTIMIZER_SYSTEM,OFFICIAL_OPTIMIZER_SYSTEM_SHA256} from '../dist/official-agent/prompts.js';
import {GENERATION} from '../dist/protocol.js';

const store=new UnifiedRunStore(resolve(process.argv[2]??'runs/automation-framework-20261109/progress-v2'));
const settings={...loadProviderSettings(),concurrency:3};
const policy={failureThreshold:2,maxAudits:3,verifyCompletion:true,compactRepeatedFailures:true};
const standard=officialBaseline('automationbench'),definition=structuredClone(automationProgressController(policy));
assert.deepEqual(definition.config,standard.config);
assert.deepEqual(definition.graphs.main,standard.graphs.main);
// Match the previous diagnostic's one execution per task.
definition.config={...definition.config,firstTaskRepeat:false};
const environment=providerEnvironment(process.cwd());
const executionIdentity=await evaluationRuntimeIdentity(process.cwd(),environment);
const officialEnvironment=await automationIdentity();
const timeBudget={requestMs:180000,workflowMs:null,reason:'Single-pass framework diagnostic with standard prompts'};
const loaded=await loadBenchmark('automationbench',{dataDir:resolve(process.env.DITTO_AUTOMATION_DATA??'data/automationbench'),split:'validate',dataMode:'formal',limit:0,artifactDir:store.path('private')});
const diagnosticFirst=['email_sf_contact_mobile_update','email_sf_contact_account_update','email_sf_contact_assistant_update','hs_create_deal_with_contact','sheets_log_sales_call','zendesk_resolve_email','demo_request_zoom_email'].map(id=>'automationbench:simple.'+id);
assert.equal(loaded.tasks.length,200);
for(const id of diagnosticFirst)assert(loaded.tasks.some(t=>t.id===id),id);
const benchmark={...loaded,tasks:[...diagnosticFirst.map(id=>loaded.tasks.find(t=>t.id===id)),...loaded.tasks.filter(t=>!diagnosticFirst.includes(t.id))]};
const identity={protocol:'automation-framework-single-pass-diagnostic-v1',commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),executionIdentity,officialEnvironment,data:loaded.identity,taskIds:benchmark.tasks.map(t=>t.id),artifactHash:officialArtifactHash(definition),nodeSystemHash:NODE_SYSTEM_PROMPT_SHA256,optimizerSystemHash:OFFICIAL_OPTIMIZER_SYSTEM_SHA256,model:settings.model,endpoint:settings.baseUrl,generation:GENERATION,repeats:1,retryAttempts:1,concurrency:3,timeBudget,maxCalls:2400,maxTokens:7000000,controller:AUTOMATION_PROGRESS_CONTROLLER_VERSION,progress:TOOL_PROGRESS_VERSION,policy};
const previous=await store.optional('manifest.json');
if(previous&&artifactHash(previous.identity)!==artifactHash(identity))throw Error('Diagnostic identity changed; use a new output directory');
const manifest={identity,createdAt:previous?.createdAt??new Date().toISOString(),status:'running',note:'Same Search200 set as standard baseline; previous failures ordered first. Each task once. Framework mechanism prototype, not an optimizer-selected workflow or held-out Test.'};
await store.write('manifest.json',manifest);
if(!previous)await store.snapshot(process.cwd());
await store.write('prompts/standard-optimizer.json',{text:OFFICIAL_OPTIMIZER_SYSTEM,sha256:OFFICIAL_OPTIMIZER_SYSTEM_SHA256,invoked:false});
await store.write('tasks-public.json',benchmark.tasks.map(t=>({id:t.id,prompt:t.prompt,metadata:t.metadata})));
const budget=createProviderBudget({maxCalls:identity.maxCalls,maxTokens:identity.maxTokens,restored:await store.optional('provider-budget.json'),onEvent:async e=>store.write('provider-budget.json',e.usage)});
const runtime=createExperimentRuntime(settings,{timeBudget,connectTimeoutMs:10000,beforeProviderCall:async input=>{await budget.beforeProviderCall(input);await store.append('provider-requests.jsonl',{at:new Date().toISOString(),input});},afterProviderCall:async event=>{await budget.afterProviderCall(event);await store.append('provider-responses.jsonl',{at:new Date().toISOString(),metadata:event.input.metadata,output:event.output,error:event.error?.message,diagnostics:event.diagnostics});}});
try{
 const summary=await evaluateUnifiedCandidate({benchmark,definition,id:'progress-controller',store,executionIdentity:identity,repeats:1,concurrency:3,retryAttempts:1,timeBudget,prune:false,resume:!!previous,runTask:(spec,task)=>runOfficialAgent(spec,task,runtime,settings),onEvent:async event=>{
  await store.append('events.jsonl',{at:new Date().toISOString(),...event});
  console.log(JSON.stringify({...event,...(event.type==='case-completed'?{usage:budget.snapshot()}:{})}));
  if(event.type==='case-completed'&&(event.valid!==true||event.score<1)){
   const task=benchmark.tasks.find(t=>t.id===event.caseId.replace(/#[1-9]\d*$/,''));
   const failure={caseId:event.caseId,valid:event.valid,score:event.score,question:task?.prompt};
   await store.append('failures-public.jsonl',failure);console.log('FAILED_TASK '+JSON.stringify(failure));
  }
 }});
 await store.write('summary.json',summary);manifest.status='completed';manifest.score=summary.score;manifest.totalTokens=summary.totalTokens;
 console.log('FINAL '+JSON.stringify({status:manifest.status,score:summary.score,cases:summary.results.length,usage:budget.snapshot(),directory:store.directory}));
}catch(error){manifest.status='interrupted';manifest.error={message:error.message,code:error.code};console.error('INTERRUPTED '+JSON.stringify(manifest.error));process.exitCode=1;}
finally{await runtime.close();manifest.usage=budget.snapshot();await store.write('manifest.json',manifest);await store.flush();}
