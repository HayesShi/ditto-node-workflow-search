import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {AgentRunResult,BenchmarkTask} from '../domain.js';
import type {LoadedBenchmark} from '../benchmark/types.js';
import {evaluateTasks} from '../benchmark/evaluator.js';
import {searchSubset} from '../benchmark/search-subset.js';
import {UnifiedRunStore} from '../unified/store.js';
import {evaluateUnifiedCandidate} from '../unified/evaluation.js';
import {selectionEvaluation} from '../unified/evidence.js';
import {buildUnifiedFeedback,type FeedbackEvaluation} from '../unified/feedback.js';
import {BASELINE_DEFINITION} from '../graph-agent/schema.js';
import {searchOfficialWorkflows,type OfficialSearchState} from '../official-agent/search.js';

const answer='ok';
const result=(text=answer):AgentRunResult=>({answer:text,executedNodeIds:['late/native-operation'],executedGraphIds:['main'],inputTokens:2,outputTokens:3,totalTokens:5,usageKnown:true});
function benchmark(count=2,expected=answer):LoadedBenchmark{
 const tasks:BenchmarkTask[]=Array.from({length:count},(_,i)=>({id:`fixture:${i}`,dataset:'drop',prompt:'Public question '+i,outputInstruction:'Return the requested text.',metadata:{}}));
 const scorer={expectedLabel:()=> 'PRIVATE-GOLD',async score(_id:string,prediction:string){return{score:prediction===expected?1:0,expected:'PRIVATE-GOLD',prediction,
  normalizedExpected:'private',normalizedPrediction:prediction,method:'fixture',details:{finalWorld:'WORLD'.repeat(1000)}};}};
 return{dataset:'drop',split:'validate',tasks,evaluate:(run,options)=>evaluateTasks(tasks,scorer,run,options),
  evaluateSearchSubset:(ids,run,options)=>evaluateTasks(searchSubset('validate',tasks,ids),scorer,run,options)};
}
async function workspace(run:(store:UnifiedRunStore)=>Promise<void>){
 const directory=await mkdtemp(join(tmpdir(),'evidence-storage-'));
 try{await run(new UnifiedRunStore(directory));}finally{await rm(directory,{recursive:true,force:true});}
}

test('serialization failures stay host checkpoint failures, and a later publication can succeed',async()=>workspace(async store=>{
 const cyclic:any={};cyclic.self=cyclic;
 for(const operation of [()=>store.write('state.json',cyclic),()=>store.append('events.jsonl',cyclic)])
  await assert.rejects(operation,(error:any)=>error.checkpointFailure===true&&error.code==='ARTIFACT_PERSISTENCE_FAILED'&&typeof error.artifactPath==='string');
 await store.write('state.json',{ok:true});assert.deepEqual(await store.read('state.json'),{ok:true});
 assert.deepEqual(await store.lines('absent.jsonl'),[]);
 await writeFile(store.path('broken.jsonl'),'not json\n');
 await assert.rejects(()=>store.lines('broken.jsonl'),(error:any)=>error.checkpointFailure===true);
}));

test('large raw traces remain lossless JSONL while completed checkpoints and selection state stay small',async()=>workspace(async original=>{
 class LimitedStore extends UnifiedRunStore{
  override write(name:string,value:unknown){assert(JSON.stringify(value).length<1000000,'aggregate contains raw trace payload');return super.write(name,value);}
 }
 const store=new LimitedStore(original.directory),loaded=benchmark();let calls=0;
 const big='PUBLIC-TRACE-'+('x'.repeat(600000))+'-FULL-END';
 const summary=await evaluateUnifiedCandidate({benchmark:loaded,definition:BASELINE_DEFINITION,id:'large',store,executionIdentity:'fixture',repeats:5,concurrency:2,
  runTask:async()=>{calls++;return{...result(),trace:[{nodeId:'first',output:big}],nodeInputs:{text:big},
   rawNodeOutputs:{first:big,'late/native-operation':{value:1,expected:'PRIVATE-TRACE-GOLD'}}} as AgentRunResult;}});
 assert.equal(calls,10);assert.equal(summary.score,1);assert.equal(summary.results.length,10);
 assert(JSON.stringify(summary).length<100000);assert.equal(summary.artifacts?.representation,'selection');
 const proof=summary.publicTraces!.find((row:any)=>row.executedNodeIds) as any;
 assert(proof.executedNodeIds.includes('late/native-operation'));
 let rawCount=0;for await(const row of store.scan<any>('evaluations/large/public-traces.jsonl')){rawCount++;assert.equal(row.nodeInputs.text,big);}
 assert.equal(rawCount,10);
 const full=await store.read<FeedbackEvaluation>('evaluations/large/summary.json');assert.equal(full.results[0]!.details?.finalWorld,'WORLD'.repeat(1000));
 const feedback=buildUnifiedFeedback([{id:'large',parentId:null,status:'valid',evaluation:summary}],loaded.tasks);
 assert.doesNotMatch(JSON.stringify(feedback),/PRIVATE-GOLD|PRIVATE-TRACE-GOLD/);
}));

test('incomplete evaluation resumes by streaming traces and never pays again for completed cases',async()=>workspace(async original=>{
 class StreamingStore extends UnifiedRunStore{
  override async lines<T>(name:string):Promise<readonly T[]>{assert(!name.endsWith('public-traces.jsonl'),'resume loaded the entire trace file');return super.lines<T>(name);}
 }
 const store=new StreamingStore(original.directory),loaded=benchmark();let calls=0;
 const options={benchmark:loaded,definition:BASELINE_DEFINITION,id:'resume',store,executionIdentity:'fixture',repeats:5,concurrency:1,
  runTask:async()=>{calls++;return result();}};
 await assert.rejects(()=>evaluateUnifiedCandidate({...options,onEvent:event=>{if(event.type==='case-completed')throw Object.assign(Error('operator interruption'),{checkpointFailure:true});}}),/operator interruption/);
 const resumed=await evaluateUnifiedCandidate({...options,resume:true});assert.equal(resumed.score,1);assert.equal(calls,10);
 const completed=await evaluateUnifiedCandidate({...options,resume:true});assert.equal(calls,10);assert.equal(completed.score,1);
}));

test('long answers are graded intact; excerpts and full artifacts remain explicitly distinguishable',async()=>workspace(async store=>{
 const long='begin '+('answer '.repeat(1000))+' FULL-END',loaded=benchmark(1,long);
 const summary=await evaluateUnifiedCandidate({benchmark:loaded,definition:BASELINE_DEFINITION,id:'long',store,executionIdentity:'fixture',repeats:1,concurrency:1,runTask:async()=>result(long)});
 assert.equal(summary.score,1);assert.equal(summary.results[0]!.prediction.length,4000);
 const full=await store.read<FeedbackEvaluation>(summary.artifacts!.fullSummary);assert.equal(full.results[0]!.prediction,long);
 const again=selectionEvaluation(summary,'evaluations/long');
 const feedback=buildUnifiedFeedback([{id:'long',parentId:null,status:'valid',evaluation:again}],loaded.tasks);
 const prediction=feedback.feedback[0]!.cases[0]!.outcomes[0]!.prediction;
 assert.equal(prediction.originalLength,long.length);assert.equal(prediction.truncated,true);
}));

test('a storage failure preserves the pending baseline instead of inventing an invalid candidate',async()=>workspace(async store=>{
 let saved:OfficialSearchState|undefined,optimizerCalls=0;
 const cyclic:any={};cyclic.self=cyclic;
 await assert.rejects(()=>searchOfficialWorkflows({runtime:{async run(){optimizerCalls++;throw Error('unexpected optimizer call');}} as any,
  model:{provider:'fixture',model:'fixture'},dataset:'drop',publicTasks:benchmark(1).tasks,expectedRepeats:1,maxValidEvaluations:1,
  save:state=>{saved=state;},evaluate:async()=>{await store.write('checkpoint.json',cyclic);throw Error('unreachable');}}),
  (error:any)=>error.checkpointFailure===true);
 assert(saved?.pending);assert.equal(saved!.engineeringFailures,0);assert.equal(saved!.history.length,0);assert.equal(optimizerCalls,0);
}));


test('bulky private worlds are journaled intact while checkpoints and graded summaries retain exact answers and scores',async()=>workspace(async original=>{
 class BoundedStore extends UnifiedRunStore{override write(name:string,value:unknown){assert(JSON.stringify(value).length<100000,'large private worlds accumulated in a checkpoint/summary');return super.write(name,value);}}
 const store=new BoundedStore(original.directory),loaded=benchmark(4),world='WORLD-'+ 'x'.repeat(250000),tasks=loaded.tasks;
 const score={expectedLabel:()=> 'private',async score(_id:string,prediction:string){return{score:1,expected:'private',prediction,normalizedExpected:'private',normalizedPrediction:prediction,method:'fixture',details:{finalWorld:world,toolTrace:[world]}};}};
 const bench={...loaded,evaluateSearchSubset:(ids:readonly string[],run:any,options:any)=>evaluateTasks(searchSubset('validate',tasks,ids),score,run,options)};
 const measured=await evaluateUnifiedCandidate({benchmark:bench,definition:BASELINE_DEFINITION,id:'worlds',store,executionIdentity:'fixture',repeats:2,concurrency:2,runTask:async()=>result('exact complete answer')});
 assert.equal(measured.score,1);assert.equal(measured.results.length,8);assert.equal(measured.totalTokens,40);
 const checkpoint=await store.read<any>('evaluations/worlds/checkpoint.json');assert.equal(checkpoint.cases[0].prediction,'exact complete answer');assert.equal(checkpoint.cases[0].details.artifactProjection.version,'external-case-details-v1');
 const full=await store.read<any>('evaluations/worlds/summary.json');assert.equal(full.results[0].prediction,'exact complete answer');
 let n=0;for await(const row of store.scan<any>('evaluations/worlds/case-events.jsonl')){assert.equal(row.details.finalWorld,world);n++;}assert(n>=8);
}));
