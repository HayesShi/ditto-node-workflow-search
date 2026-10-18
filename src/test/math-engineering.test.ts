import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelProvider } from '@codesoul-co/ditto/worker/infer';
import { createExperimentRuntime } from '../ditto/runtime.js';
import { WorkflowExecutor } from '../workflow/executor.js';
import { buildOrganizationPlan } from '../workflow/organization.js';
import type { OrganizationSpec } from '../workflow/organization-types.js';
import { modelFailureRecorder } from '../ditto/model-failure.js';
import { evaluateTasks } from '../benchmark/evaluator.js';

const spec:OrganizationSpec={version:1,dataset:'math',entryGraphId:'solve',graphs:[{id:'solve',nodeIds:['context','solver']},{id:'review',nodeIds:['checker','fixer','answer']}],
  nodes:[{id:'context',template:'context',dependencies:[]},{id:'solver',template:'sample',dependencies:['context']},
    {id:'checker',template:'verify',dependencies:['context','solver']},{id:'fixer',template:'revise',dependencies:['context','solver','checker']},
    {id:'answer',template:'output',dependencies:['fixer']}],outputNodeId:'answer',transitions:{solve:{kind:'next',graphId:'review'},review:{kind:'end'}}};
const task={id:'math:fixture',dataset:'math' as const,prompt:'TASK_MARKER: compute 1+1',outputInstruction:'',metadata:{}};
const response=(content:string)=>({message:{role:'assistant' as const,content},finishReason:'stop' as const,usage:{inputTokens:1,outputTokens:1,totalTokens:2}});
const settings={baseUrl:'https://fixture.invalid',model:'fixture',apiKey:'fixture',concurrency:3,timeoutMs:5000};

test('searched checker/fixer receive one target, original task and explicitly wired assessment; rewiring changes result',async()=>{
  for(const wired of [true,false]) {
    const provider:ModelProvider={async invoke(input){
      const node=input.metadata?.nodeId;
      if(node==='solver') {
        assert.notEqual((input.model.providerOptions?.response_format as any)?.type,'json_object');
        return response('UNIQUE_SOLVER_MARKER');
      }
      assert.equal((input.model.providerOptions?.response_format as any)?.type,'json_object');
      const serialized=JSON.stringify(input.messages);
      assert.equal(serialized.split('UNIQUE_SOLVER_MARKER').length-1,1);
      assert.match(serialized,/TASK_MARKER/);
      if(node==='checker') return response(JSON.stringify({assessment:{summary:'CHECKER_ASSESSMENT',passed:false},issues:[{severity:'error',description:'CHECKER_ISSUE'}]}));
      assert.equal(serialized.includes('CHECKER_ASSESSMENT'),wired);
      assert.equal(serialized.includes('CHECKER_ISSUE'),wired);
      return response(JSON.stringify({assessment:{summary:'fixed',passed:true},issues:[],revisedResult:{role:'assistant',content:wired?'2':'3'}}));
    }};
    const experiment=createExperimentRuntime(settings,{provider,tools:[]});
    try {
      const organization={...spec,nodes:spec.nodes.map(n=>n.id==='fixer' && !wired?{...n,dependencies:['context','solver']}:n)};
      const run=await new WorkflowExecutor(experiment.runtime,experiment.providerName,experiment.model).run(buildOrganizationPlan(organization),task);
      assert.equal(run.answer,wired?'2':'3');
    } finally {await experiment.close();}
  }
});

test('exhausted JSON format is model-output zero after exactly three responses; actual provider failure stays invalid',async()=>{
  for(const failure of ['format','provider','DEGENERATE_OUTPUT','MODEL_CONTEXT_LIMIT']) {
    let calls=0;
    const experiment=createExperimentRuntime(settings,{tools:[],provider:{async invoke(input){
      if(input.metadata?.nodeId==='solver') return response('2');
      calls++;
      if(failure==='provider') throw Error('HTTP 402');
      if(failure!=='format') {
        modelFailureRecorder()({source:'model-output',code:failure});
        throw Error('transport preserved typed model provenance');
      }
      return response('not JSON');
    }}});
    try {
      const executor=new WorkflowExecutor(experiment.runtime,experiment.providerName,experiment.model);
      const summary=await evaluateTasks([task],{expectedLabel(){return '2';},async score(_id,prediction){return {score:Number(prediction==='2'),expected:'2',prediction,normalizedExpected:'',normalizedPrediction:'',method:'fixture'};}},t=>executor.run(buildOrganizationPlan(spec),t));
      assert.equal(summary.valid,failure!=='provider');
      assert.equal(summary.score,0);
      assert.equal(calls,failure==='format'?3:1);
      if(failure!=='provider') assert.equal(summary.results[0]?.modelFailures?.[0]?.code,failure==='format'?'REFLECT_FORMAT_ERROR':failure);
    } finally {await experiment.close();}
  }
});
