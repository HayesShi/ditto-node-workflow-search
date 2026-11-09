import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {loadBenchmark} from '../dist/benchmark/index.js';
import {automationIdentity} from '../dist/benchmark/automation.js';
import {HUBSPOT_CATALOG_COMPAT} from '../dist/benchmark/automation-compat.js';
import {loadProviderSettings} from '../dist/config.js';
import {createExperimentRuntime} from '../dist/ditto/runtime.js';
import {officialBaseline} from '../dist/official-agent/baselines.js';
import {automationLayeredController,AUTOMATION_LAYERED_CONTROLLER_VERSION} from '../dist/official-agent/layered-controller.js';
import {DECISION_PROTOCOL_VERSION} from '../dist/official-agent/decision-protocol.js';
import {runOfficialAgent} from '../dist/official-agent/executor.js';
import {providerEnvironment} from '../dist/official-agent/runner.js';
import {evaluationRuntimeIdentity} from '../dist/run/case-recovery.js';
import {evaluateUnifiedCandidate} from '../dist/unified/evaluation.js';
import {UnifiedRunStore,artifactHash} from '../dist/unified/store.js';
import {createProviderBudget} from '../dist/unified/provider-budget.js';
import {NODE_SYSTEM_PROMPT_SHA256} from '../dist/graph-agent/system.js';
import {OFFICIAL_OPTIMIZER_SYSTEM,OFFICIAL_OPTIMIZER_SYSTEM_SHA256} from '../dist/official-agent/prompts.js';
import {GENERATION} from '../dist/protocol.js';

// The diagnosed API contract repair applies to BOTH arms, so it cannot be
// mistaken for a framework improvement. No source-world or scorer patch.
process.env.DITTO_AUTOMATION_COMPAT=HUBSPOT_CATALOG_COMPAT;
const root=new UnifiedRunStore(resolve(process.argv[2]??'runs/automation-layered-20261109/comparison'));
const mode=process.argv[3]??'paired';
if(!['paired','layered-only'].includes(mode))throw Error('Mode must be paired or layered-only');
const settings={...loadProviderSettings(),concurrency:2}; // two arms, <=4 active provider calls
const executionIdentity=await evaluationRuntimeIdentity(process.cwd(),providerEnvironment(process.cwd()));
const officialEnvironment=await automationIdentity();
const timeBudget={requestMs:180000,workflowMs:null,reason:'Single-pass paired framework diagnostic, standard prompts'};
const policy={failureThreshold:2,maxAudits:4,maxProtocolFailures:2};
const original=officialBaseline('automationbench'),layered=structuredClone(automationLayeredController(policy));
assert.deepEqual(layered.config,original.config);
assert.deepEqual(layered.graphs.main.nodes[0],original.graphs.main.nodes[0]);
for(const definition of [original,layered])definition.config={...definition.config,firstTaskRepeat:false};
const first=['email_sf_contact_mobile_update','email_sf_contact_account_update','email_sf_contact_assistant_update','hs_create_deal_with_contact','sheets_log_sales_call','zendesk_resolve_email','demo_request_zoom_email','asana_dark_mode_from_email','jira_login_bug_from_email','zoom_client_call_from_email','zoom_customer_training','zendesk_wrong_order_ticket','zendesk_urgent_reply','email_zendesk_ack_reply','email_hubspot_deal_slack','new_hire_asana_email','email_airtable_lead','email_airtable_customer_welcome','weekly_digest_sheets_email'].map(id=>'automationbench:simple.'+id);
const progress={};
async function arm(name,definition){
 const store=new UnifiedRunStore(root.path(name));
 const loaded=await loadBenchmark('automationbench',{dataDir:resolve(process.env.DITTO_AUTOMATION_DATA??'data/automationbench'),split:'validate',dataMode:'formal',limit:0,artifactDir:store.path('private')});
 assert.equal(loaded.tasks.length,200);for(const id of first)assert(loaded.tasks.some(t=>t.id===id),id);
 const tasks=[...first.map(id=>loaded.tasks.find(t=>t.id===id)),...loaded.tasks.filter(t=>!first.includes(t.id))];
 const benchmark={...loaded,tasks};
 const identity={protocol:'automation-layered-paired-single-pass-v1',arm:name,executionIdentity,officialEnvironment,data:loaded.identity,taskIds:tasks.map(t=>t.id),artifactHash:artifactHash(definition),model:settings.model,endpoint:settings.baseUrl,generation:GENERATION,repeats:1,retryAttempts:1,concurrency:2,combinedProviderConcurrency:4,timeBudget,maxCalls:1900,maxTokens:6000000,nodeSystemHash:NODE_SYSTEM_PROMPT_SHA256,optimizerSystemHash:OFFICIAL_OPTIMIZER_SYSTEM_SHA256,controller:name==='layered'?AUTOMATION_LAYERED_CONTROLLER_VERSION:'standard-baseline',decisionProtocol:name==='layered'?DECISION_PROTOCOL_VERSION:'strict-json',policy:name==='layered'?policy:null};
 const previous=await store.optional('manifest.json');
 if(previous&&artifactHash(previous.identity)!==artifactHash(identity))throw Error('Frozen comparison identity changed: '+name);
 const manifest={identity,status:'running',createdAt:previous?.createdAt??new Date().toISOString(),note:'Same repaired task-world catalog, model, standard strategy, task set/order and one attempt in both arms. Framework prototype, not automatic search selection or held-out Test.'};
 await store.write('manifest.json',manifest);if(!previous)await store.snapshot(process.cwd());
 await store.write('tasks-public.json',tasks.map(t=>({id:t.id,prompt:t.prompt,metadata:t.metadata})));
 await store.write('prompts/standard-optimizer.json',{text:OFFICIAL_OPTIMIZER_SYSTEM,sha256:OFFICIAL_OPTIMIZER_SYSTEM_SHA256,invoked:false});
 await store.write('prompts/standard-strategy.json',{text:original.config.strategy,sha256:artifactHash(original.config.strategy)});
 const budget=createProviderBudget({maxCalls:identity.maxCalls,maxTokens:identity.maxTokens,restored:await store.optional('provider-budget.json'),onEvent:async e=>store.write('provider-budget.json',e.usage)});
 const runtime=createExperimentRuntime(settings,{timeBudget,connectTimeoutMs:10000,beforeProviderCall:async input=>{await budget.beforeProviderCall(input);await store.append('provider-requests.jsonl',{at:new Date().toISOString(),input});},afterProviderCall:async event=>{await budget.afterProviderCall(event);await store.append('provider-responses.jsonl',{at:new Date().toISOString(),metadata:event.input.metadata,output:event.output,error:event.error?.message,diagnostics:event.diagnostics});}});
 try{
  const summary=await evaluateUnifiedCandidate({benchmark,definition,id:name,store,executionIdentity:identity,repeats:1,concurrency:2,retryAttempts:1,timeBudget,prune:false,resume:!!previous,runTask:(spec,task)=>runOfficialAgent(spec,task,runtime,settings),onEvent:async event=>{
   await store.append('events.jsonl',{at:new Date().toISOString(),...event});
   console.log(JSON.stringify({arm:name,...event,...(event.type==='case-completed'?{usage:budget.snapshot()}:{})}));
   if(event.type==='case-completed'){
    progress[name]={completed:event.completed,total:event.total,usage:budget.snapshot()};
    await root.write('progress.json',progress);
    if(event.valid!==true||event.score<1){const question=tasks.find(t=>t.id===event.caseId.replace(/#[1-9]\d*$/,''))?.prompt;await store.append('failures-public.jsonl',{caseId:event.caseId,valid:event.valid,score:event.score,question});}
   }
  }});
  await store.write('summary.json',summary);manifest.status='completed';manifest.score=summary.score;
  console.log('FINAL '+JSON.stringify({arm:name,score:summary.score,cases:summary.results.length,usage:budget.snapshot()}));
  return{arm:name,status:'completed',score:summary.score,cases:summary.results.length,usage:budget.snapshot()};
 }catch(error){manifest.status='interrupted';manifest.error={message:error.message,code:error.code};console.error('INTERRUPTED '+JSON.stringify({arm:name,...manifest.error}));process.exitCode=1;return{arm:name,status:manifest.status,error:manifest.error,usage:budget.snapshot()};}
 finally{await runtime.close();manifest.usage=budget.snapshot();await store.write('manifest.json',manifest);await store.flush();}
}
const results=await Promise.allSettled([...(mode==='paired'?[arm('baseline-fixed',original)]:[]),arm('layered',layered)]);
await root.write('comparison.json',{createdAt:new Date().toISOString(),results});
await root.flush();
if(results.some(r=>r.status==='rejected')){for(const r of results)if(r.status==='rejected')console.error(r.reason);process.exitCode=1;}
