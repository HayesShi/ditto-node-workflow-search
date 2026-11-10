import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {loadProviderSettings} from '../dist/config.js';
import {loadBenchmark} from '../dist/benchmark/index.js';
import {automationIdentity} from '../dist/benchmark/automation.js';
import {HUBSPOT_CATALOG_COMPAT} from '../dist/benchmark/automation-compat.js';
import {createExperimentRuntime} from '../dist/ditto/runtime.js';
import {automationLayeredController,AUTOMATION_LAYERED_CONTROLLER_VERSION} from '../dist/official-agent/layered-controller.js';
import {runOfficialAgent} from '../dist/official-agent/executor.js';
import {runUnifiedExperiment,providerEnvironment} from '../dist/official-agent/runner.js';
import {assertOfficialComplete} from '../dist/official-agent/search.js';
import {evaluationRuntimeIdentity,assertEvaluationRuntimeIdentity} from '../dist/run/case-recovery.js';
import {evaluateUnifiedCandidate} from '../dist/unified/evaluation.js';
import {UnifiedRunStore,artifactHash} from '../dist/unified/store.js';
import {createProviderBudget} from '../dist/unified/provider-budget.js';
import {GENERATION} from '../dist/protocol.js';

// An explicit campaign: verify the fixed controller, Search both complete splits,
// then Test only their frozen winners. It never resumes the older paused run.
const root=new UnifiedRunStore(resolve(process.argv[2]??'../output/automation-route-campaign-20261110'));
const resume=process.argv[3]==='resume';
if(process.argv[3]&&!resume)throw Error('Usage: run_automation_route_campaign.mjs [output-directory] [resume]');
const previous=await root.optional('campaign.json');
if(!!previous!==resume)throw Error(previous?'Campaign exists; inspect it or use explicit resume':'No campaign exists to resume');
if(execFileSync('git',['status','--porcelain'],{encoding:'utf8',windowsHide:true}).trim())throw Error('Commit reviewed source before freezing a campaign');
process.env.DITTO_AUTOMATION_COMPAT=HUBSPOT_CATALOG_COMPAT;
const settings={...loadProviderSettings(),concurrency:2};
const executionIdentity=await evaluationRuntimeIdentity(process.cwd(),providerEnvironment(process.cwd()));
const officialEnvironment=await automationIdentity();
const seed=structuredClone(automationLayeredController());seed.config={...seed.config,firstTaskRepeat:false};
const data={drop:resolve('../data/datasets'),automationbench:resolve(process.env.DITTO_AUTOMATION_DATA??'../output/five-dataset-small-20261104/data/automationbench')};
const configuration={executionIdentity,officialEnvironment,seedHash:artifactHash(seed),controller:AUTOMATION_LAYERED_CONTROLLER_VERSION,model:settings.model,generation:GENERATION,data,verification:{tasks:200,repeats:1,retryAttempts:5,maxCalls:6000,maxTokens:30000000},search:{maxValidEvaluations:3,maxDesignRounds:2,maxProposalAttempts:3,repeats:5},test:{dropTasks:800,automationTasks:600,repeats:3}};
if(previous&&artifactHash(previous.configuration)!==artifactHash(configuration))throw Error('Frozen campaign runtime/data/model/controller configuration changed');
const campaign={...previous,schemaVersion:1,status:'running',createdAt:previous?.createdAt??new Date().toISOString(),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),configuration,phases:previous?.phases??{},testFeedsOptimizer:false};
delete campaign.error;
await root.write('campaign.json',campaign);
if(!previous)await root.snapshot(process.cwd());
const save=()=>root.write('campaign.json',campaign);
const event=async value=>{await root.append('events.jsonl',{at:new Date().toISOString(),...value});console.log(JSON.stringify(value));};
const assertFrozenRuntime=async()=>assertEvaluationRuntimeIdentity(executionIdentity,await evaluationRuntimeIdentity(process.cwd(),providerEnvironment(process.cwd())));
async function verify(){
 await assertFrozenRuntime();
 const store=new UnifiedRunStore(root.path('verification'));
 const benchmark=await loadBenchmark('automationbench',{dataDir:data.automationbench,split:'validate',dataMode:'formal',limit:0,artifactDir:store.path('private')});
 if(benchmark.tasks.length!==200||!benchmark.identity?.verified)throw Error('Verification requires the full pinned Search200');
 const done=await store.optional('summary.json');
 if(done){assertOfficialComplete(done,benchmark.tasks,1);return done;}
 const budget=createProviderBudget({...configuration.verification,restored:resume?await store.optional('provider-budget.json'):undefined,onEvent:e=>store.write('provider-budget.json',e.usage)});
 const timeBudget={requestMs:600000,workflowMs:null,reason:'Complete route verification; same request deadline as formal Search, no aggregate workflow cutoff'};
 await store.write('identity.json',{...configuration,data:benchmark.identity,taskIds:benchmark.tasks.map(t=>t.id),repeats:1,timeBudget});
 const runtime=createExperimentRuntime(settings,{timeBudget,beforeProviderCall:async input=>{await budget.beforeProviderCall(input);await store.append('provider-requests.jsonl',{metadata:input.metadata,input});},afterProviderCall:async e=>{await budget.afterProviderCall(e);await store.append('provider-responses.jsonl',{metadata:e.input.metadata,output:e.output,error:e.error?.message,diagnostics:e.diagnostics});}});
 try{
  const summary=await evaluateUnifiedCandidate({benchmark,definition:seed,id:'controller-v10',store,executionIdentity:configuration,repeats:1,concurrency:2,retryAttempts:5,timeBudget,prune:false,resume,runTask:(definition,task)=>runOfficialAgent(definition,task,runtime,settings),onEvent:async e=>event({phase:'verification',...e})});
  assertOfficialComplete(summary,benchmark.tasks,1);await assertFrozenRuntime();await store.write('summary.json',summary);return summary;
 }finally{await runtime.close();await store.write('provider-budget.json',budget.snapshot());await store.flush();}
}
async function formal(dataset){
 await assertFrozenRuntime();
 const directory=root.path(dataset+'/search');
 const options={command:'search',dataset,projectRoot:process.cwd(),dataDir:data[dataset],initialization:'baseline',resume:false,offlineOnly:false,maxValidEvaluations:3,maxDesignRounds:2,maxProposalAttempts:3,seed:42,concurrency:2,maxCalls:dataset==='drop'?15000:250000,maxTokens:dataset==='drop'?50000000:1000000000,requestMs:600000,workflowMs:null,dockerImage:'python:3.13-slim'};
 let manifest=await new UnifiedRunStore(directory).optional('manifest.json');
 campaign.phases[dataset]={...campaign.phases[dataset],status:'searching',directory};await save();
 if(manifest?.status!=='search-completed'){
  const invocation={...options,...(manifest?{resume:true,runDir:directory}:{outputDir:directory}),...(dataset==='automationbench'?{initialDefinition:seed}:{})};
  await runUnifiedExperiment(invocation);manifest=await new UnifiedRunStore(directory).read('manifest.json');
 }
 if(manifest.status!=='search-completed')throw Error(dataset+' Search did not finish: '+manifest.status);
 const selection=await new UnifiedRunStore(directory).read('frozen-selection.json');
 if(!selection.selectedBeforeTest||selection.dataset!==dataset)throw Error('Missing matching pre-Test frozen selection');
 campaign.phases[dataset]={status:'testing',directory,frozenId:selection.id,frozenArtifactHash:selection.artifactHash,searchScore:manifest.best?.score};await save();
 const testStore=new UnifiedRunStore(join(directory,'test'));const oldTest=await testStore.optional('manifest.json');
 await assertFrozenRuntime();
 const {initialization:_searchInitialization,...testOptions}=options;
 if(oldTest?.status!=='test-completed')await runUnifiedExperiment({...testOptions,command:'test',runDir:directory,resume:!!oldTest});
 const testManifest=await testStore.read('manifest.json');
 if(testManifest.status!=='test-completed')throw Error(dataset+' Test did not finish: '+testManifest.status);
 const measured=await testStore.read('summary.json');const expected=(dataset==='drop'?800:600)*3;
 if(measured.valid!==true||measured.results.length!==expected||measured.results.some(c=>c.valid!==true||c.error))throw Error('Incomplete frozen Test measurement');
 await assertFrozenRuntime();
 campaign.phases[dataset]={...campaign.phases[dataset],status:'completed',testScore:measured.score,testCases:expected};await save();await event({phase:'dataset-completed',dataset,searchScore:manifest.best?.score,testScore:measured.score});
}
try{
 campaign.phases.verification={status:'running'};await save();
 const checked=await verify();campaign.phases.verification={status:'completed',score:checked.score,cases:checked.results.length};await save();
 const outcomes=await Promise.allSettled(['drop','automationbench'].map(async dataset=>{try{return await formal(dataset);}catch(error){campaign.phases[dataset]={...campaign.phases[dataset],status:'interrupted',error:error.message};await save();throw error;}}));
 campaign.status=outcomes.every(r=>r.status==='fulfilled')?'completed':'interrupted';
 if(campaign.status!=='completed')process.exitCode=1;
}catch(error){campaign.status='interrupted';campaign.error=error.message;if(campaign.phases.verification?.status!=='completed')campaign.phases.verification={status:'interrupted',error:error.message};process.exitCode=1;await event({phase:'campaign-interrupted',error:error.message});}
finally{campaign.updatedAt=new Date().toISOString();await save();await root.flush();console.log(JSON.stringify({phase:'campaign-ended',status:campaign.status,directory:root.directory}));}
