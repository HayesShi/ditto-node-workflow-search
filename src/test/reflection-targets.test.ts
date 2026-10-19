import assert from 'node:assert/strict';
import test from 'node:test';
import {createExperimentRuntime} from '../ditto/runtime.js';
import {WorkflowExecutor} from '../workflow/executor.js';
import {buildOrganizationPlan,validateOrganization,requireExplicitReflectionTargets} from '../workflow/organization.js';
import type {OrganizationSpec} from '../workflow/organization-types.js';
import {OrganizationProposer} from '../search/organization-search.js';

const original:OrganizationSpec={version:1,dataset:'math',entryGraphId:'solve',outputNodeId:'answer',
  nodes:[{id:'context',template:'context',dependencies:[]},{id:'solver',template:'sample',dependencies:['context']},
    {id:'alternative',template:'sample',dependencies:['context']},
    {id:'checker',template:'verify',dependencies:['context','solver'],targetNodeId:'solver'},
    {id:'fixer',template:'revise',dependencies:['context','solver','alternative','checker'],targetNodeId:'solver'},
    {id:'answer',template:'output',dependencies:['fixer']}],
  graphs:[{id:'solve',nodeIds:['context','solver','alternative']},{id:'review',nodeIds:['checker','fixer','answer']}],
  transitions:{solve:{kind:'next',graphId:'review'},review:{kind:'end'}}};
const settings={baseUrl:'https://fixture.invalid',apiKey:'fixture',model:'fixture',concurrency:3,timeoutMs:5000};
const response=(content:string)=>({message:{role:'assistant' as const,content},finishReason:'stop' as const});

test('searched reflection target is exact, despite a checker proposing its own wrong answer',async()=>{
  for(const target of ['solver','alternative']){
    const runtime=createExperimentRuntime(settings,{tools:[],provider:{async invoke(input){
      if(input.metadata?.nodeId==='solver')return response('ORIGINAL_19');
      if(input.metadata?.nodeId==='alternative')return response('ALTERNATIVE_23');
      const payload=JSON.parse(String(input.messages.at(-1)!.content));
      if(input.metadata?.nodeId==='checker')return response(JSON.stringify({assessment:{passed:false,summary:'CHECKER_CLAIM'},
        issues:[{severity:'error',description:'CHECKER_ISSUE'}],revisedResult:{role:'assistant',content:'WRONG_20'}}));
      assert.equal(payload.target.result.content,target==='solver'?'ORIGINAL_19':'ALTERNATIVE_23');
      assert.match(JSON.stringify(payload.messages),/CHECKER_CLAIM/);
      assert.match(JSON.stringify(payload.messages),/WRONG_20/,'explicitly wired checker evidence is still present');
      return response(JSON.stringify({assessment:{passed:true,summary:'done'},issues:[],revisedResult:payload.target.result}));
    }}});
    try{
      const spec={...original,nodes:original.nodes.map(n=>n.id==='fixer'?{...n,targetNodeId:target}:n)};
      const run=await new WorkflowExecutor(runtime.runtime,runtime.providerName,runtime.model).run(buildOrganizationPlan(spec),
        {id:'fixture',dataset:'math',prompt:'Original task',outputInstruction:'',metadata:{}});
      assert.equal(run.answer,target==='solver'?'ORIGINAL_19':'ALTERNATIVE_23');
    }finally{await runtime.close();}
  }
});

test('target binding is validated, participates in identity, and cannot alter fixed node capabilities',()=>{
  const plan=buildOrganizationPlan(original);
  const changed={...original,nodes:original.nodes.map(n=>n.id==='fixer'?{...n,targetNodeId:'alternative'}:n)};
  assert.notEqual(plan.id,buildOrganizationPlan(changed).id);
  assert.deepEqual(plan.nodes,buildOrganizationPlan(changed).nodes,'only input binding changes, not node implementations/config');
  for(const target of ['unknown','context','checker']){
    assert.throws(()=>validateOrganization({...original,nodes:original.nodes.map(n=>n.id==='fixer'?{...n,targetNodeId:target}:n)}),/target/);
  }
  assert.throws(()=>validateOrganization({...original,nodes:original.nodes.map(n=>n.id==='solver'?{...n,targetNodeId:'context'}:n)}),/target/);
  const legacy={...original,nodes:original.nodes.map(({targetNodeId,...n})=>n)};
  validateOrganization(legacy);
  assert.throws(()=>requireExplicitReflectionTargets(legacy),/targetNodeId/);
});

test('new model proposals must declare reflection targets before acceptance',async()=>{
  let calls=0;
  const legacy={...original,nodes:original.nodes.map(({targetNodeId,...n})=>n)};
  const runtime=createExperimentRuntime(settings,{tools:[],provider:{async invoke(){calls++;return response(JSON.stringify(legacy));}}});
  try{
    await assert.rejects(new OrganizationProposer(runtime.runtime,{provider:runtime.providerName,model:runtime.model}).propose({parent:buildOrganizationPlan(original),experiences:[],accept:validateOrganization}),/require targetNodeId/);
    assert.equal(calls,3);
  }finally{await runtime.close();}
});
