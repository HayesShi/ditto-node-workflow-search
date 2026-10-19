import assert from 'node:assert/strict';
import test from 'node:test';
import {createExperimentRuntime} from '../ditto/runtime.js';
import {runOrganization} from '../workflow/organization-executor.js';
import {buildOrganizationPlan,validateOrganization} from '../workflow/organization.js';
import {conditionalMathReview} from '../workflow/review-organization.js';

const settings={baseUrl:'https://fixture.invalid',apiKey:'fixture',model:'fixture',concurrency:1,timeoutMs:5000};
const response=(content:string)=>({message:{role:'assistant' as const,content},finishReason:'stop' as const});
for(const passed of [true,false]) test(`conditional review: passed=${passed} delivers the declared branch result`,async()=>{
  const calls:string[]=[];
  const rt=createExperimentRuntime(settings,{tools:[],provider:{async invoke(input){
    const id=String(input.metadata?.nodeId); calls.push(id);
    if(id==='solver')return response('ORIGINAL_19');
    if(id==='checker')return response(JSON.stringify({assessment:{passed,summary:'CHECK'},issues:[],revisedResult:{role:'assistant',content:'UNTRUSTED_20'}}));
    assert.equal(id,'fixer');
    const payload=JSON.parse(String(input.messages.at(-1)!.content));
    assert.equal(payload.target.result.content,'ORIGINAL_19');
    assert.match(JSON.stringify(payload.messages),/UNTRUSTED_20/);
    return response(JSON.stringify({assessment:{passed:true,summary:'done'},issues:[],revisedResult:{role:'assistant',content:'REVISED_23'}}));
  }}});
  try{
    const result=await runOrganization(rt.runtime,{provider:rt.providerName,model:rt.model},buildOrganizationPlan(conditionalMathReview()),{id:'branch',dataset:'math',prompt:'task',outputInstruction:'',metadata:{}});
    assert.equal(result.answer,passed?'ORIGINAL_19':'REVISED_23');
    assert.deepEqual(calls,passed?['solver','checker']:['solver','checker','fixer']);
    assert.equal(result.executedGraphIds.includes('repair'),!passed);
  }finally{await rt.close();}
});

test('branch delivery rejects unavailable, optional and nonterminal output sources and participates in plan identity',()=>{
  const spec=conditionalMathReview();
  validateOrganization(spec);
  for(const outputByGraph of [{accept:'fixer'},{accept:'checker'},{solve:'solver'},{unknown:'solver'}])
    assert.throws(()=>validateOrganization({...spec,outputByGraph}),/output|terminating/i);
  assert.notEqual(buildOrganizationPlan(spec).id,buildOrganizationPlan({...spec,outputByGraph:{accept:'solver',repair:'solver'}}).id);
});

test('malformed checker assessment cannot take the passing branch',async()=>{
  const calls:string[]=[];
  const rt=createExperimentRuntime(settings,{tools:[],provider:{async invoke(input){
    const id=String(input.metadata?.nodeId);calls.push(id);
    if(id==='solver')return response('ORIGINAL_19');
    assert.equal(id,'checker');
    return response('{"assessment":{"passed":"true","summary":"invalid"},"issues":[]}');
  }}});
  try{
    const result=await runOrganization(rt.runtime,{provider:rt.providerName,model:rt.model},buildOrganizationPlan(conditionalMathReview()),{id:'invalid',dataset:'math',prompt:'task',outputInstruction:'',metadata:{}});
    assert.equal(result.answer,'');
    assert.ok(result.modelFailures?.some(f=>f.code==='REFLECT_FORMAT_ERROR'));
    assert.ok(!result.executedGraphIds.includes('accept'));
    assert.ok(!calls.includes('fixer'));
  }finally{await rt.close();}
});
