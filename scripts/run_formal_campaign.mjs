import {execFileSync} from 'node:child_process';
import {open,readFile,unlink,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadProviderSettings} from '../dist/config.js';
import {automationIdentity} from '../dist/benchmark/automation.js';
import {HUBSPOT_CATALOG_COMPAT} from '../dist/benchmark/automation-compat.js';
import {automationLayeredController,AUTOMATION_LAYERED_CONTROLLER_VERSION} from '../dist/official-agent/layered-controller.js';
import {runUnifiedExperiment,providerEnvironment} from '../dist/official-agent/runner.js';
import {assertOfficialComplete} from '../dist/official-agent/search.js';
import {evaluationRuntimeIdentity,assertEvaluationRuntimeIdentity} from '../dist/run/case-recovery.js';
import {UnifiedRunStore,artifactHash} from '../dist/unified/store.js';
import {UNIFIED_DEFAULTS} from '../dist/unified/policy.js';
import {GENERATION} from '../dist/protocol.js';

export const FORMAL_PROFILE=Object.freeze({maxValidEvaluations:UNIFIED_DEFAULTS.maxValidEvaluations,
 maxDesignRounds:UNIFIED_DEFAULTS.maxDesignRounds,maxProposalAttempts:UNIFIED_DEFAULTS.maxProposalAttempts,
 searchRepeats:UNIFIED_DEFAULTS.validationRepeats,testRepeats:UNIFIED_DEFAULTS.testRepeats,seed:42,concurrency:3,
 searchTasks:200,testTasks:{drop:800,automationbench:600},
 budgets:{drop:{maxCalls:50000,maxTokens:100000000},automationbench:{maxCalls:250000,maxTokens:1000000000}}});

export function formalOptions(dataset,projectRoot,dataDir){
 if(!['drop','automationbench'].includes(dataset))throw Error('Unsupported formal dataset');
 return{command:'search',dataset,projectRoot,dataDir,initialization:'baseline',resume:false,offlineOnly:false,
  maxValidEvaluations:FORMAL_PROFILE.maxValidEvaluations,maxDesignRounds:FORMAL_PROFILE.maxDesignRounds,maxProposalAttempts:FORMAL_PROFILE.maxProposalAttempts,
  seed:FORMAL_PROFILE.seed,concurrency:FORMAL_PROFILE.concurrency,...FORMAL_PROFILE.budgets[dataset],requestMs:600000,workflowMs:null,dockerImage:'python:3.13-slim'};
}

export async function runFormalCampaign(directory,resume=false){
 const root=new UnifiedRunStore(resolve(directory)),previous=await root.optional('campaign.json');
 if(!!previous!==resume)throw Error(previous?'Campaign exists; use explicit resume after inspecting it':'No campaign exists to resume');
 if(execFileSync('git',['status','--porcelain'],{encoding:'utf8',windowsHide:true}).trim())throw Error('Commit source before freezing the formal campaign');
 await mkdir(root.directory,{recursive:true});
 const lockPath=root.path('campaign.lock');
 try{const lock=await open(lockPath,'wx');await lock.writeFile(JSON.stringify({pid:process.pid,at:new Date().toISOString()}));await lock.close();}
 catch(error){
  if(error.code!=='EEXIST'||!resume)throw error;
  const owner=JSON.parse(await readFile(lockPath,'utf8'));let alive=true;
  try{process.kill(owner.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;else throw e;}
  if(alive)throw Error('Formal campaign process is already alive: '+owner.pid);
  await unlink(lockPath);const lock=await open(lockPath,'wx');await lock.writeFile(JSON.stringify({pid:process.pid,at:new Date().toISOString()}));await lock.close();
 }
 let campaign;
 try{
  process.env.DITTO_AUTOMATION_COMPAT=HUBSPOT_CATALOG_COMPAT;
  const projectRoot=process.cwd(),settings={...loadProviderSettings(),concurrency:FORMAL_PROFILE.concurrency};
  const executionIdentity=await evaluationRuntimeIdentity(projectRoot,providerEnvironment(projectRoot));
  const officialEnvironment=await automationIdentity();
  const seed=structuredClone(automationLayeredController());seed.config={...seed.config,firstTaskRepeat:false};
  const data={drop:resolve('../data/datasets'),automationbench:resolve(process.env.DITTO_AUTOMATION_DATA??'../output/five-dataset-small-20261104/data/automationbench')};
  const configuration={profile:FORMAL_PROFILE,executionIdentity,officialEnvironment,seedHash:artifactHash(seed),controller:AUTOMATION_LAYERED_CONTROLLER_VERSION,
   model:settings.model,endpoint:settings.baseUrl,generation:GENERATION,data};
  if(previous&&artifactHash(previous.configuration)!==artifactHash(configuration))throw Error('Formal runtime/data/model/controller/profile changed');
  campaign={...previous,schemaVersion:1,status:'running',createdAt:previous?.createdAt??new Date().toISOString(),
   sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),configuration,phases:previous?.phases??{},testFeedsOptimizer:false};
  delete campaign.error;
  const save=()=>root.write('campaign.json',campaign);
  await save();if(!previous)await root.snapshot(projectRoot);
  const assertFrozen=async()=>assertEvaluationRuntimeIdentity(executionIdentity,await evaluationRuntimeIdentity(projectRoot,providerEnvironment(projectRoot)));
  async function datasetRun(dataset){
   const searchRoot=new UnifiedRunStore(root.path(dataset+'/search')),options=formalOptions(dataset,projectRoot,data[dataset]);
   const update=async fields=>{campaign.phases[dataset]={...fields,directory:searchRoot.directory};await save();};
   try{
    await assertFrozen();await update({status:'searching'});
    let manifest=await searchRoot.optional('manifest.json');
    if(manifest?.status!=='search-completed'){
     await runUnifiedExperiment({...options,...(manifest?{resume:true,runDir:searchRoot.directory}:{outputDir:searchRoot.directory}),
      ...(dataset==='automationbench'?{initialDefinition:seed}:{})});
     manifest=await searchRoot.read('manifest.json');
    }
    if(manifest.status!=='search-completed')throw Error(dataset+' Search did not complete: '+manifest.status);
    const frozen=await searchRoot.read('frozen-selection.json');
    if(!frozen.selectedBeforeTest||frozen.dataset!==dataset)throw Error('Missing matching selection frozen before Test');
    const fields={frozenId:frozen.id,frozenArtifactHash:frozen.artifactHash,searchScore:manifest.best?.score,stoppedBecause:manifest.stoppedBecause};
    const control=await root.optional('operator-control.json');
    if(control?.stopAfterSearch===true){await update({...fields,status:'awaiting-confirmation',testStarted:false});return 'held';}
    await assertFrozen();await update({...fields,status:'testing'});
    const testRoot=new UnifiedRunStore(join(searchRoot.directory,'test')),testManifest=await testRoot.optional('manifest.json');
    const {initialization:_initialization,...testOptions}=options;
    if(testManifest?.status!=='test-completed')await runUnifiedExperiment({...testOptions,command:'test',runDir:searchRoot.directory,resume:!!testManifest});
    const measured=await testRoot.read('summary.json'),finished=await testRoot.read('manifest.json'),selection=await testRoot.read('selection.json');
    if(finished.status!=='test-completed'||selection.taskIds.length!==FORMAL_PROFILE.testTasks[dataset])throw Error('Incomplete Test identity');
    assertOfficialComplete(measured,selection.taskIds.map(id=>({id})),FORMAL_PROFILE.testRepeats);
    await assertFrozen();await update({...fields,status:'completed',testScore:measured.score,testCases:measured.results.length});
    console.log(JSON.stringify({phase:'dataset-completed',dataset,...campaign.phases[dataset]}));return 'completed';
   }catch(error){await update({...campaign.phases[dataset],status:'interrupted',error:error.message});throw error;}
  }
  const outcomes=await Promise.allSettled(['drop','automationbench'].map(datasetRun));
  campaign.status=outcomes.some(outcome=>outcome.status==='rejected')?'interrupted':outcomes.some(outcome=>outcome.value==='held')?'paused':'completed';
  campaign.updatedAt=new Date().toISOString();await save();
  if(campaign.status==='interrupted')process.exitCode=1;
  console.log(JSON.stringify({phase:'formal-campaign-ended',status:campaign.status,directory:root.directory}));
 }catch(error){
  if(campaign){campaign.status='interrupted';campaign.error=error.message;campaign.updatedAt=new Date().toISOString();await root.write('campaign.json',campaign);}
  throw error;
 }finally{await root.flush();const owner=JSON.parse(await readFile(lockPath,'utf8'));if(owner.pid===process.pid)await unlink(lockPath);}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [directory,mode]=process.argv.slice(2);
 if(!directory||(mode&&mode!=='resume'))throw Error('Usage: run_formal_campaign.mjs <new-directory> [resume]');
 runFormalCampaign(directory,mode==='resume').catch(error=>{console.error(error.stack??error.message);process.exitCode=1;});
}
