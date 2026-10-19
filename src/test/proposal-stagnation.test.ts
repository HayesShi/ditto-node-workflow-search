import assert from 'node:assert/strict';
import test from 'node:test';
import {createDitto} from '@codesoul-co/ditto/runtime';
import {createInferWorker,type ModelProvider} from '@codesoul-co/ditto/worker/infer';
import {OrganizationProposer,OrganizationWorkflowSearch,OrganizationProposalRejectedError,OrganizationSearchStalledError} from '../search/organization-search.js';
import {initialOrganization} from '../workflow/organization.js';
import type {OrganizationSpec} from '../workflow/organization-types.js';
import type {SearchResumeState} from '../search/optimizer.js';
import type {EvaluationSummary} from '../domain.js';

const summary=():EvaluationSummary=>({valid:true,score:1,standardDeviation:0,repeats:1,examples:1,successfulRuns:1,failedRuns:0,timeoutRuns:0,wrongRuns:0,
  inputTokens:0,outputTokens:0,totalTokens:0,durationMs:1,results:[{caseId:'fixture#1',valid:true,score:1,prediction:'2',expected:'PRIVATE_REFERENCE',
    normalizedExpected:'',normalizedPrediction:'',method:'fixture',latencyMs:1,inputTokens:0,outputTokens:0,totalTokens:0}]});
const fresh=():OrganizationSpec=>({...initialOrganization('math'),nodes:[...initialOrganization('math').nodes,{id:'second',template:'sample',dependencies:['answer']}],
  graphs:[{id:'solve',nodeIds:['context','answer','second']}],outputNodeId:'second'});

test('a later round sees rejected topology and can produce a new valid candidate without leaking references',async()=>{
  const requests:Array<Record<string,any>>=[];
  const provider:ModelProvider={async invoke(input){
    const payload=JSON.parse(String(input.messages.at(-1)!.content));requests.push(payload);
    return {message:{role:'assistant',content:JSON.stringify(payload.priorRejections.length?fresh():initialOrganization('math'))},finishReason:'stop'};
  }};
  const runtime=createDitto({workers:[createInferWorker({providers:{fixture:provider},defaultProvider:'fixture'})]});
  let saved:SearchResumeState|undefined;let evaluations=0;
  try{
    const result=await new OrganizationWorkflowSearch({dataset:'math',rounds:2,seed:42,topK:4,patience:5,
      proposer:new OrganizationProposer(runtime,{provider:'fixture',model:'fixture'}),async evaluate(){evaluations++;return summary();},
      callbacks:{async state(s){saved=structuredClone(s);}}}).run();
    assert.equal(evaluations,2);assert.equal(result.nodes.length,2);assert.equal(requests.length,4);
    assert.equal(requests[3]!.priorRejections.length,3);assert.equal(requests[3]!.rejections.length,0);
    assert.equal(requests[3]!.evaluatedOrganizations.length,1);
    assert.doesNotMatch(JSON.stringify(requests),/PRIVATE_REFERENCE/);
    assert.equal(saved!.completedRounds,2);assert.equal(saved!.proposalFailures,1);assert.equal(saved!.consecutiveProposalFailures,0);
    assert.equal(saved!.evaluationHistory.length,2,'rejected proposals do not fabricate zero scores');
  }finally{await runtime.close();}
});

test('unbounded repeated proposals stop as an engineering error and that stop survives resume',async()=>{
  let calls=0,evaluations=0;let saved:SearchResumeState|undefined;const events:string[]=[];
  const runtime=createDitto({workers:[createInferWorker({providers:{fixture:{async invoke(){calls++;return {message:{role:'assistant',content:JSON.stringify(initialOrganization('automationbench'))},finishReason:'stop'};}}},defaultProvider:'fixture'})]});
  const options={dataset:'automationbench' as const,rounds:null,seed:42,topK:4,patience:5,
    proposer:new OrganizationProposer(runtime,{provider:'fixture',model:'fixture'}),async evaluate(){evaluations++;return summary();},
    callbacks:{async state(s:SearchResumeState){saved=structuredClone(s);},async event(e:Readonly<Record<string,unknown>>){events.push(String(e.type));}}};
  try{
    await assert.rejects(new OrganizationWorkflowSearch(options).run(),OrganizationSearchStalledError);
    assert.equal(calls,9);assert.equal(evaluations,1);assert.equal(saved!.completedRounds,3);assert.equal(saved!.proposalFailures,3);
    assert.equal(saved!.consecutiveProposalFailures,3);assert.equal(saved!.organizationProposalRejections!.length,9);
    assert.equal(saved!.experiences.length,1);assert.equal(saved!.evaluationHistory.length,1);assert.ok(events.includes('search-stalled'));
    await assert.rejects(new OrganizationWorkflowSearch({...options,resume:saved!}).run(),OrganizationSearchStalledError);
    assert.equal(calls,9,'resume must not reset the stall guard or spend more requests');
  }finally{await runtime.close();}
});

test('a valid evaluated candidate resets the consecutive failure streak, preserving total round accounting',async()=>{
  let attempts=0;let saved:SearchResumeState|undefined;
  const result=await new OrganizationWorkflowSearch({dataset:'math',rounds:5,seed:42,topK:4,patience:5,
    async evaluate(){return summary();},proposer:{async propose(request){if(++attempts===3){request.accept(fresh());return fresh();}throw new OrganizationProposalRejectedError('rejected');}},
    callbacks:{async state(s){saved=structuredClone(s);}}}).run();
  assert.equal(result.nodes.length,2);assert.equal(saved!.completedRounds,5);assert.equal(saved!.proposalFailures,4);
  assert.equal(saved!.consecutiveProposalFailures,2);assert.equal(result.stoppedBecause,'max-rounds');
});
