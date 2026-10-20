import assert from 'node:assert/strict';
import test from 'node:test';
import type {EvaluationSummary,SearchTreeNode} from '../domain.js';
import {NodeTreeWorkflowSearch,NodeTreeStalledError} from '../search/node-tree-search.js';
import type {SearchResumeState} from '../search/optimizer.js';
import {NodeExpansionProposer,NodeExpansionRejectedError,type ExpansionRequest} from '../search/node-expansion-proposer.js';
import {executionTopologyHash,prepareExpansion,type NodeExpansion,type WorkflowEvaluation} from '../search/node-construction.js';
import {initialOrganization} from '../workflow/organization.js';
import {createExperimentRuntime} from '../ditto/runtime.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RunStore} from '../run/store.js';
import {loadHistoricalResume} from '../run/resume.js';

const summary=(score:number):EvaluationSummary=>({valid:true,score,standardDeviation:0,repeats:1,examples:1,successfulRuns:1,failedRuns:0,timeoutRuns:0,wrongRuns:score?0:1,inputTokens:1,outputTokens:1,totalTokens:2,durationMs:1,results:[]});
function assembled(request:ExpansionRequest,id:string):NodeExpansion {
  const base=request.branches.find(b=>b.nodes.length===2&&b.nodes[1]!.id==='answer')!;
  return {baseBranchId:base.id,anchorNodeId:'context',operation:'add',node:{id,template:'sample',dependencies:['answer']},assembly:{
    graphs:[{id:'solve',nodeIds:['context','answer',id]}],entryGraphId:'solve',transitions:{solve:{kind:'end'}},outputNodeId:id}};
}

test('tree stores all real nodes; optimizer can fork an early prefix and partial edits spend no experiment',async()=>{
  const records:WorkflowEvaluation[]=[];const vertices:SearchTreeNode[]=[];let proposals=0,evaluations=0;let state:SearchResumeState|undefined;
  const result=await new NodeTreeWorkflowSearch({dataset:'math',rounds:1,patience:5,evaluate:async()=>{evaluations++;return summary(0.8);},
    proposer:{async propose(r){proposals++;
      if(proposals===1)return {baseBranchId:r.branches[0]!.id,anchorNodeId:'context',operation:'add',node:{id:'independent',template:'sample',dependencies:['context']}};
      const b=r.branches.find(b=>b.nodes.some(n=>n.id==='independent'))!;
      return {baseBranchId:b.id,anchorNodeId:'independent',operation:'add',node:{id:'check',template:'verify',dependencies:['context','independent'],targetNodeId:'independent'},assembly:{
        graphs:[{id:'solve',nodeIds:['context','independent']},{id:'check',nodeIds:['check']}],entryGraphId:'solve',transitions:{solve:{kind:'next',graphId:'check'},check:{kind:'end'}},outputNodeId:'independent'}};
    }},callbacks:{async node(v){vertices.push(v);},async workflow(r){records.push(r);},async state(s){state=structuredClone(s);}}}).run();
  assert.equal(evaluations,2);assert.equal(proposals,2);assert.equal(result.nodes.length,4);assert.equal(records.length,2);assert.equal(state!.completedRounds,1);
  assert.ok(result.nodes.every(v=>!v.evaluation&&v.organizationBinding));
  const independent=result.nodes.find(v=>v.node.id==='independent')!;
  assert.equal(independent.searchParentId,result.nodes.find(v=>v.node.id==='context')!.id);
  assert.notEqual(independent.searchParentId,result.nodes.find(v=>v.node.id==='answer')!.id);
  assert.equal(state!.nodeConstruction!.branches[2]!.assembly,undefined);
  assert.equal(state!.nodeConstruction!.evaluations.length,2);
});

test('rejected batches do not consume experiment budget or create scored zero workflows',async()=>{
  let calls=0,evals=0;let state:SearchResumeState|undefined;
  const result=await new NodeTreeWorkflowSearch({dataset:'math',rounds:2,patience:20,evaluate:async()=>summary(++evals/10),
    proposer:{async propose(r){if(++calls===1)throw new NodeExpansionRejectedError([{content:'bad',error:'bad binding'}]);const p=assembled(r,`trial-${calls}`); if(calls===3){const b=r.branches.at(-1)!;return {...p,baseBranchId:b.id,node:{id:'third',template:'sample',dependencies:['trial-2']},assembly:{graphs:[{id:'solve',nodeIds:[...b.nodes.map(n=>n.id),'third']}],entryGraphId:'solve',transitions:{solve:{kind:'end'}},outputNodeId:'third'}};}return p;}},
    callbacks:{async state(s){state=structuredClone(s);}}}).run();
  assert.equal(result.experiences.length,3);assert.equal(state!.completedRounds,2);assert.equal(state!.proposalFailures,1);
});

test('service outage preserves the exact pending workflow; resume does not sample another parent or spend budget',async()=>{
  let state:SearchResumeState|undefined,calls=0,evals=0;
  const options={dataset:'math' as const,rounds:1,patience:5,proposer:{async propose(r:ExpansionRequest){calls++;return assembled(r,'second');}},
    async evaluate(){if(++evals===2)throw Error('HTTP 503');return summary(0.7);},callbacks:{async state(s:SearchResumeState){state=structuredClone(s);}}};
  await assert.rejects(new NodeTreeWorkflowSearch(options).run(),/503/);
  assert.equal(state!.completedRounds,0);assert.ok(state!.nodeConstruction!.pending);
  const resumed=await new NodeTreeWorkflowSearch({...options,resume:state!}).run();
  assert.equal(calls,1);assert.equal(evals,3);assert.equal(resumed.experiences.length,2);assert.equal(state!.completedRounds,1);
});

test('three rejected batches stop as stalled, survive resume, and never freeze or consume budget',async()=>{
  let state:SearchResumeState|undefined,calls=0;
  const options={dataset:'math' as const,rounds:20,patience:5,evaluate:async()=>summary(0.9),
    proposer:{async propose(){calls++;throw new NodeExpansionRejectedError([{content:'bad',error:'duplicate'}]);}},callbacks:{async state(s:SearchResumeState){state=structuredClone(s);}}};
  await assert.rejects(new NodeTreeWorkflowSearch(options).run(),NodeTreeStalledError);
  assert.equal(state!.completedRounds,0);assert.equal(state!.evaluationHistory.length,1);assert.equal(calls,3);
  await assert.rejects(new NodeTreeWorkflowSearch({...options,resume:state!}).run(),NodeTreeStalledError);assert.equal(calls,3);
});

test('cosmetic node and graph renames do not manufacture a new experiment',()=>{
  const a=initialOrganization('math');
  const b={...a,nodes:[{id:'task',template:'context',dependencies:[]},{id:'solve-again',template:'sample',dependencies:['task']}],graphs:[{id:'renamed',nodeIds:['task','solve-again']}],entryGraphId:'renamed',transitions:{renamed:{kind:'end' as const}},outputNodeId:'solve-again'};
  assert.equal(executionTopologyHash(a),executionTopologyHash(b));
});

test('AFlow Top-3 convergence uses only completed experiments; flat scores stop after five new experiments',async()=>{
  let evaluations=0,proposals=0;
  const result=await new NodeTreeWorkflowSearch({dataset:'math',rounds:20,patience:5,
    evaluate:async()=>{evaluations++;return summary(0.5);},proposer:{async propose(r){
      const b=r.branches.at(-1)!,id=`extra-${++proposals}`;
      return {baseBranchId:b.id,anchorNodeId:b.nodes.at(-1)!.id,operation:'add',node:{id,template:'sample',dependencies:[b.nodes.at(-1)!.id]},assembly:{
        graphs:[{id:'solve',nodeIds:[...b.nodes.map(n=>n.id),id]}],entryGraphId:'solve',transitions:{solve:{kind:'end'}},outputNodeId:id}};
    }}}).run();
  assert.equal(result.stoppedBecause,'converged');assert.equal(evaluations,6);assert.equal(proposals,5);
  assert.equal(result.bestPlan.leafSearchNodeId,'search-001','ties keep earliest initial workflow');
});

test('replace/rewire creates actual node versions; removal adds no fake vertex and complete assembly is checked',async()=>{
  let n=0;const result=await new NodeTreeWorkflowSearch({dataset:'math',rounds:1,patience:5,evaluate:async()=>summary(0.5),proposer:{async propose(r){
    const base=r.branches.at(-1)!;n++;
    if(n===1)return {baseBranchId:base.id,anchorNodeId:'answer',operation:'add',node:{id:'linear',template:'cot',dependencies:['answer']}};
    if(n===2)return {baseBranchId:base.id,anchorNodeId:'linear',operation:'rewire',node:{id:'linear',template:'cot',dependencies:['context']}};
    return {baseBranchId:base.id,anchorNodeId:'linear',operation:'remove',removeNodeId:'answer',assembly:{graphs:[{id:'solve',nodeIds:['context','linear']}],entryGraphId:'solve',transitions:{solve:{kind:'end'}},outputNodeId:'linear'}};
  }}}).run();
  assert.equal(n,3);assert.equal(result.nodes.length,4);assert.equal(result.nodes.filter(v=>v.node.id==='linear').length,2);
  assert.equal(result.experiences.length,2);assert.equal(result.nodes.find(v=>v.node.id==='answer')!.statistics.visits,1,'removed node does not receive the new workflow score');
});

test('a normal zero consumes budget; an invalid evaluation never creates optimizer experience',async()=>{
  let state:SearchResumeState|undefined,evals=0;
  const options={dataset:'math' as const,rounds:1,patience:5,proposer:{async propose(r:ExpansionRequest){return assembled(r,'new');}},
    evaluate:async()=>++evals===1?summary(0.8):{...summary(0),valid:false,failedRuns:1},callbacks:{async state(s:SearchResumeState){state=structuredClone(s);}}};
  await assert.rejects(new NodeTreeWorkflowSearch(options).run(),/Invalid evaluation/);
  assert.equal(state!.completedRounds,0);assert.equal(state!.experiences.length,1);assert.ok(state!.nodeConstruction!.pending);
  const result=await new NodeTreeWorkflowSearch({...options,resume:state!,evaluate:async()=>summary(0)}).run();
  assert.equal(state!.completedRounds,1);assert.equal(result.experiences.length,2);assert.equal(result.experiences[1]!.score,0);
});

test('partial construction rejects wrong input types and distinguishes instance IDs from vertex IDs',()=>{
  const base={id:'branch-1',baseBranchId:null,leafVertexId:'node-2',nodes:[{id:'context',template:'context',dependencies:[]},{id:'answer',template:'sample',dependencies:['context']},{id:'updated',template:'update',dependencies:['context']}],vertexByNode:{context:'node-1',answer:'node-2',updated:'node-3'}};
  assert.throws(()=>prepareExpansion('math',base,{baseBranchId:base.id,anchorNodeId:'node-2',operation:'add',node:{id:'new',template:'sample',dependencies:['context']}},'branch-2','node-4',11),/NODE INSTANCE ID.*context.*answer/);
  assert.throws(()=>prepareExpansion('math',base,{baseBranchId:base.id,anchorNodeId:'answer',operation:'add',node:{id:'choose',template:'merge',dependencies:['answer','updated']}},'branch-2','node-4',11),/two guaranteed answer sources/);
  assert.throws(()=>prepareExpansion('math',base,{baseBranchId:base.id,anchorNodeId:'answer',operation:'add',node:{id:'check',template:'verify',dependencies:['updated'],targetNodeId:'updated'}},'branch-2','node-4',11),/must guarantee an answer/);
});

test('on-disk resume hydrates workflow ledger separately from real node tree and recovers exact pending experiment',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'ditto-real-node-resume-'));
  try{
    const store=await RunStore.create(directory,'math');await store.writeManifest({evaluationCodeSha256:'fixture-source'});
    let calls=0,evals=0;
    const complete=()=>({...summary(0.7),results:[{caseId:'fixture#1',valid:true,score:0.7,expected:'PRIVATE',prediction:'PUBLIC',normalizedExpected:'',normalizedPrediction:'',method:'fixture',latencyMs:1,inputTokens:1,outputTokens:1,totalTokens:2}]});
    const options={dataset:'math' as const,rounds:1,patience:5,proposer:{async propose(r:ExpansionRequest){calls++;return assembled(r,'new');}},
      async evaluate(){if(++evals===2)throw Error('HTTP 503');return complete();},callbacks:{async state(s:SearchResumeState){await store.saveResumeState(s);},async workflow(r:WorkflowEvaluation){await store.saveEvaluation(r.id,r.evaluation);}}};
    await assert.rejects(new NodeTreeWorkflowSearch(options).run(),/503/);
    const restored=await loadHistoricalResume(store.directory,0,'fixture-source');
    assert.equal(restored.state.nodeConstruction!.evaluations[0]!.evaluation.results.length,1);
    assert.ok(restored.state.nodes.every(n=>!n.evaluation));
    const result=await new NodeTreeWorkflowSearch({...options,resume:restored.state}).run();
    assert.equal(calls,1);assert.equal(result.experiences.length,2);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('node proposer has all branches, no workflow-parent draw, and omits gold and private judge fields',async()=>{
  let payload:any;
  const rt=createExperimentRuntime({baseUrl:'https://fixture.invalid',apiKey:'fixture',model:'fixture',concurrency:1,timeoutMs:5000},{tools:[],provider:{async invoke(input){
    assert.match(String(input.messages[0]!.content),/REAL fixed Ditto nodes/);payload=JSON.parse(String(input.messages.at(-1)!.content));
    return {message:{role:'assistant',content:JSON.stringify({baseBranchId:'branch-1',anchorNodeId:'context',operation:'add',node:{id:'new',template:'sample',dependencies:['context']}})},finishReason:'stop'};
  }}});
  try{
    await new NodeExpansionProposer(rt.runtime,{provider:rt.providerName,model:rt.model}).propose({dataset:'math',branches:[],vertices:[],priorRejections:[],accept(){},experiences:[{
      searchNodeId:'search-001',parentSearchNodeId:null,node:{} as any,score:0,delta:null,outcome:'root',failures:[{caseId:'x',prediction:'PUBLIC_PREDICTION',expected:'PRIVATE_GOLD'}]}]});
    assert.equal(Object.keys(payload.nodeContracts).length,12);assert.equal(payload.nodeContracts.act.llm,false);assert.match(payload.nodeContracts.actor.boundary,/Only requests/);assert.match(payload.nodeContracts.verify.boundary,/not official grading/);
    assert.ok(!Object.hasOwn(payload,'parent'));assert.match(JSON.stringify(payload),/PUBLIC_PREDICTION/);assert.doesNotMatch(JSON.stringify(payload),/PRIVATE_GOLD/);
  }finally{await rt.close();}
});
