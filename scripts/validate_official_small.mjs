import {execFileSync} from 'node:child_process';
import {mkdir,writeFile,appendFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {loadBenchmark,DockerPythonJudge} from '../dist/benchmark/index.js';
import {loadProviderSettings} from '../dist/config.js';
import {createExperimentRuntime} from '../dist/ditto/runtime.js';
import {officialBaseline} from '../dist/official-agent/baselines.js';
import {loadOfficialInitialization} from '../dist/official-agent/initialization.js';
import {runOfficialAgent} from '../dist/official-agent/executor.js';
import {officialArtifactHash,validateOfficialDefinition} from '../dist/official-agent/schema.js';
import {GENERATION} from '../dist/protocol.js';
import {createProviderBudget} from '../dist/unified/provider-budget.js';
import {withWorkflowTimeBudget} from '../dist/execution/time-budget.js';
const flags=new Map();for(let i=2;i<process.argv.length;i+=2)flags.set(process.argv[i].replace(/^--/,''),process.argv[i+1]);
const root=resolve(flags.get('output')??'runs/official-small'),datasets=(flags.get('datasets')??'drop,humaneval,mbpp,automationbench,bfcl').split(',');
const sourceIdentity={commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),trackedDiffSha256:createHash('sha256').update(execFileSync('git',['diff','HEAD'],{windowsHide:true})).digest('hex')};
await mkdir(root,{recursive:true});const report={protocol:'official-json-search-subset-engineering-v1',status:'running',seed:42,repeats:1,formalTest:false,optimizerCalls:0,sourceIdentity,generation:GENERATION,datasets:[]};
const save=()=>writeFile(join(root,'summary.json'),JSON.stringify(report,null,2)+'\n');await save();
for(const dataset of datasets){
 const row={dataset,status:'preparing',variants:[]};report.datasets.push(row);await save();const folder=join(root,dataset);await mkdir(folder,{recursive:true});
 const budget=createProviderBudget({maxCalls:Number(flags.get('max-calls')??(dataset==='bfcl'||dataset==='automationbench'?80:40)),maxTokens:Number(flags.get('max-tokens')??(dataset==='bfcl'||dataset==='automationbench'?250000:100000))});let shared;
 try{
  const settings={...loadProviderSettings(),concurrency:1};
  if(['mbpp','humaneval'].includes(dataset)){execFileSync('docker',['info','--format','{{.ServerVersion}}'],{stdio:'pipe',timeout:15000,windowsHide:true});execFileSync('docker',['image','inspect','python:3.13-slim'],{stdio:'pipe',timeout:15000,windowsHide:true});}
  const benchmark=await loadBenchmark(dataset,{dataDir:resolve(flags.get(dataset+'-data')??flags.get('data-dir')??'../data/datasets'),split:'validate',dataMode:'formal',limit:0,artifactDir:join(folder,'private'),...(['mbpp','humaneval'].includes(dataset)?{codeJudge:new DockerPythonJudge({image:'python:3.13-slim'})}:{})});
  const count=Number(flags.get('count')??(dataset==='bfcl'||dataset==='automationbench'?4:8));
  const selected=benchmark.tasks.slice().sort((a,b)=>createHash('sha256').update('42:'+a.id).digest('hex').localeCompare(createHash('sha256').update('42:'+b.id).digest('hex'))).slice(0,count);
  row.selection=selected.map(t=>({id:t.id,metadata:t.metadata}));row.dataIdentity=benchmark.identity;row.model=settings.model;await save();
  shared=createExperimentRuntime(settings,{beforeProviderCall:input=>budget.beforeProviderCall(input),afterProviderCall:async event=>{await budget.afterProviderCall(event);await appendFile(join(folder,'provider.jsonl'),JSON.stringify({metadata:event.input.metadata,output:event.output,error:event.error?.message,diagnostics:event.diagnostics})+'\n');}});
  for(const variant of ['baseline',...(['drop','mbpp','humaneval'].includes(dataset)?['pr10-selected']:[])]){
   const definition=structuredClone(officialBaseline(dataset)),init=loadOfficialInitialization(dataset,variant==='baseline'?'baseline':'pr10-selected');
   if(definition.loop&&flags.has('max-iterations'))definition.loop.maxIterations=Number(flags.get('max-iterations'));
   definition.config={...definition.config,...(init.seedStrategy?{strategy:init.seedStrategy}:{}),firstTaskRepeat:init.presentation==='repeat-task-on-first-sample'};validateOfficialDefinition(definition);
   await writeFile(join(folder,variant+'.agent.json'),JSON.stringify(definition,null,2));
   const record={variant,artifactHash:officialArtifactHash(definition),status:'running'};row.variants.push(record);await save();
   const summary=await benchmark.evaluateSearchSubset(selected.map(t=>t.id),async task=>withWorkflowTimeBudget({requestMs:180000,workflowMs:600000},async()=>{
    try{const run=await runOfficialAgent(definition,task,shared,settings);await appendFile(join(folder,variant+'.executions.jsonl'),JSON.stringify({taskId:task.id,question:task.prompt,...run})+'\n');return run;}
    catch(error){await appendFile(join(folder,variant+'.errors.jsonl'),JSON.stringify({taskId:task.id,error:error.message,code:error.code,partialRun:error.partialRun})+'\n');throw error;}
   }),{repeats:1,concurrency:1,retryAttempts:1,onCase:async progress=>{await appendFile(join(folder,variant+'.cases.jsonl'),JSON.stringify(progress.result)+'\n');console.log(JSON.stringify({dataset,variant,caseId:progress.result.caseId,valid:progress.result.valid,score:progress.result.score,error:progress.result.error}));}});
   await writeFile(join(folder,variant+'.summary.json'),JSON.stringify(summary,null,2));Object.assign(record,{status:summary.valid?'completed':'invalid-evaluation',score:summary.valid?summary.score:null,valid:summary.valid,validRuns:summary.results.filter(r=>r.valid===true).length,failedRuns:summary.failedRuns,totalTokens:summary.totalTokens});await save();
  }
  row.status=row.variants.every(v=>v.valid===true)?'completed':'invalid-evaluation';
 }catch(error){row.status='blocked';row.error=error.message;console.log(JSON.stringify({dataset,status:row.status,error:row.error}));}
 finally{await shared?.close();row.usage=budget.snapshot();await save();}
}
report.status='completed-with-blockers';if(report.datasets.every(r=>r.status==='completed'))report.status='completed';await save();console.log(JSON.stringify({status:report.status,output:root}));
