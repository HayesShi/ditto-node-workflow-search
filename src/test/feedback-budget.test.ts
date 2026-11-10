import assert from 'node:assert/strict';
import test from 'node:test';
import type {BenchmarkTask,CaseResult,EvaluationSummary} from '../domain.js';
import {buildUnifiedFeedback,type FeedbackEvaluation,type FeedbackRecord} from '../unified/feedback.js';
import {searchOfficialWorkflows} from '../official-agent/search.js';
import {searchUnifiedWorkflows} from '../unified/search.js';

const tasks:BenchmarkTask[]=Array.from({length:6},(_,i)=>({id:`case:${i}`,dataset:'drop',
  prompt:'Passage: '+('public evidence '.repeat(500))+`\nQuestion: Which public item ${i}?\nAnswer:`,outputInstruction:'Return only the requested answer.',metadata:{}}));
function evaluation(score:number,count=6,repeats=5):FeedbackEvaluation{
  const results:CaseResult[]=tasks.slice(0,count).flatMap(task=>Array.from({length:repeats},(_,i)=>({caseId:task.id+'#'+(i+1),valid:true,score,
    prediction:'public answer',expected:'PRIVATE-GOLD',normalizedExpected:'PRIVATE-GOLD',normalizedPrediction:'public answer',method:'fixture',
    latencyMs:1,inputTokens:1,outputTokens:1,totalTokens:2})));
  return {valid:true,score,standardDeviation:0,examples:count,repeats,results,successfulRuns:results.length,failedRuns:0,timeoutRuns:0,wrongRuns:0,
    inputTokens:results.length,outputTokens:results.length,totalTokens:2*results.length,durationMs:1,
    publicTraces:tasks.slice(0,count).flatMap(task=>Array.from({length:2},()=>({taskId:task.id,
      events:Array.from({length:6},()=>({output:{content:'PUBLIC-TRACE '+('x'.repeat(5000)),expected:'PRIVATE-TRACE-GOLD',authorization:'SECRET-TOKEN'}})),
      nodeInputs:{public:'y'.repeat(5000),privateLabel:'PRIVATE-INPUT'},rawNodeOutputs:{public:'z'.repeat(5000),gold:'PRIVATE-OUTPUT'}})))};
}

test('oversized traces retain both candidate measurements and public cases within the whole packet limit',()=>{
  const result=buildUnifiedFeedback([
    {id:'base',parentId:null,status:'valid',evaluation:evaluation(.8)},
    {id:'pruned',parentId:'base',status:'quality-pruned',evaluation:{...evaluation(.5),qualityPruned:true,stage:6}},
  ],tasks);
  assert.deepEqual(result.feedback.map(row=>row.id),['base','pruned']);
  const base=result.feedback[0] as any,pruned=result.feedback[1] as any;
  assert.equal(base.measurement.fullScore,.8);assert.equal(pruned.measurement.fullScore,null);
  assert(Math.abs(pruned.measurement.stageScore-.5)<1e-12);
  assert(base.cases.length>0);assert(pruned.cases.length>0);assert(pruned.paired.meanScoreDelta<0);
  const text=JSON.stringify(result);assert(text.length<=60000);assert.match(text,/Question:/);
  assert.doesNotMatch(text,/PRIVATE-|SECRET-TOKEN|normalizedExpected/);
});

test('a tight budget preserves scores and the later repair diagnosis instead of dropping every candidate',()=>{
  const records:FeedbackRecord[]=[
    {id:'base',parentId:null,status:'valid',rationale:'r'.repeat(10000),evaluation:evaluation(.8)},
    {id:'pruned',parentId:'base',status:'quality-pruned',evaluation:{...evaluation(.5),qualityPruned:true,stage:6}},
    {id:'repair',parentId:'base',status:'invalid-evaluation',publicErrors:['expected an array'],
      publicIssues:[{code:'OFFICIAL_AGENT_CONTRACT',path:'/graphs/main/nodes/3/input/messages',message:'expected an array',repairHint:'Use a text transform for strings.'}]},
  ];
  const result=buildUnifiedFeedback(records,tasks,{maxCharacters:6000});
  assert.deepEqual(new Set(result.feedback.map(row=>row.id)),new Set(records.map(row=>row.id)));
  const text=JSON.stringify(result);assert(text.length<=6000);assert.match(text,/expected an array/);assert.match(text,/stageScore/);
  assert.doesNotMatch(text,/PRIVATE-|SECRET-TOKEN/);
});

test('omission metadata is itself bounded and records how many IDs could not be listed',()=>{
  const records:FeedbackRecord[]=Array.from({length:800},(_,i)=>({id:`candidate-${i}`,parentId:null,status:'invalid-proposal'}));
  const result=buildUnifiedFeedback(records,tasks,{maxCandidates:1,maxCharacters:6000});
  assert.equal(result.feedback.length,1);assert(JSON.stringify(result).length<=6000);
  const packet=result as any;
  assert.equal(packet.omittedCandidateCount,799);assert.equal(packet.omittedCandidateIdsTruncated,true);
  assert(packet.omittedCandidateIds.length<799);
});

test('both search engines retain a quality-pruned score in the next request brief history',async()=>{
  for(const official of [true,false]){
    let calls=0,evaluations=0;
    const runtime:any={async run(_graph:unknown,input:{request:string}){
      const request=JSON.parse(input.request);
      if(calls===1){
        const pruned=request.history.find((row:any)=>row.status==='quality-pruned');
        assert.equal(pruned.stage,1);assert.equal(pruned.stageScore,.1);
        assert.doesNotMatch(input.request,/PRIVATE-GOLD|normalizedExpected/);
      }
      const definition=structuredClone(request.parent.definition);
      if(official)definition.config.strategy=`public change ${++calls}`;
      else definition.graphs[0].nodes[1].config.instruction=`public change ${++calls}`;
      return{proposal:{status:'success',output:{message:{content:JSON.stringify({rationale:'Test a public change',definition})}}}};
    }};
    const options={runtime,model:{provider:'mock',model:'fixture'},dataset:'drop' as const,publicTasks:tasks.slice(0,2),expectedRepeats:1,
      maxValidEvaluations:2,maxDesignRounds:2,exploration:false as const,evaluate:async():Promise<FeedbackEvaluation>=>{
        evaluations++;return evaluations===2?{...evaluation(.1,1,1),qualityPruned:true,stage:1}:evaluation(evaluations===1?.8:.9,2,1);
      }};
    const result=official?await searchOfficialWorkflows(options):await searchUnifiedWorkflows(options);
    assert.equal(calls,2);assert.equal(result.state.prunedEvaluations,1);
  }
});
