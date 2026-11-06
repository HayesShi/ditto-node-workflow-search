import assert from 'node:assert/strict';
import test from 'node:test';
import type {BenchmarkTask} from '../domain.js';
import {automationScope,type AutomationSession} from '../benchmark/automation.js';
import {createExperimentRuntime} from '../ditto/runtime.js';
import {officialBaseline} from '../official-agent/baselines.js';
import {runOfficialAgent} from '../official-agent/executor.js';
import {NODE_SYSTEM_PROMPT} from '../graph-agent/system.js';
import {AUTOMATION_DECISION_INSTRUCTION} from '../graph-agent/automation-baseline.js';
import {AUTOMATION_INITIAL_GUIDANCE,INITIAL_USER_STRATEGIES} from '../official-agent/task-strategies.js';

const settings={baseUrl:'https://example.invalid',apiKey:'offline',model:'mock',concurrency:1,timeoutMs:3000};

test('manual initialization reaches native SAMPLE as user material with the original task and frozen system intact',async()=>{
 for(const dataset of ['drop','mbpp','humaneval'] as const){
  const instruction=INITIAL_USER_STRATEGIES[dataset];assert(instruction);
  const definition={...officialBaseline(dataset),config:{strategy:instruction}};
  const task:BenchmarkTask={id:'public-initialization-fixture',dataset,prompt:'PUBLIC_TASK_SPECIFICATION',outputInstruction:'PUBLIC_OUTPUT_REQUIREMENT',metadata:{}};
  const requests:any[]=[];
  const shared=createExperimentRuntime(settings,{provider:{async invoke(input){requests.push(input);return{message:{role:'assistant',content:'FINAL_PUBLIC_ARTIFACT'},finishReason:'stop',usage:{inputTokens:2,outputTokens:1,totalTokens:3}};}}});
  try{
   const result=await runOfficialAgent(definition,task,shared,settings);
   assert.equal(requests.length,1);assert.equal(result.modelFailure,undefined);
   const messages=requests[0].messages;
   assert.deepEqual(messages.filter((m:any)=>m.role==='system').map((m:any)=>m.content),[NODE_SYSTEM_PROMPT]);
   assert(messages.some((m:any)=>m.role==='user'&&m.content===instruction));
   assert(messages.some((m:any)=>m.role==='user'&&m.content.includes(task.prompt)&&m.content.includes(task.outputInstruction)));
  }finally{await shared.close();}
 }
});

test('Automation manual suffix preserves JSON decisions and registered execution followed by actual observations',async()=>{
 const definition={...officialBaseline('automationbench'),config:{strategy:AUTOMATION_DECISION_INSTRUCTION+'\n\n'+AUTOMATION_INITIAL_GUIDANCE}};
 const requests:any[]=[];const actions:{name:string;arguments:unknown}[]=[];
 const world:AutomationSession={
  tools:[{name:'api_fetch',description:'Public fixture endpoint',inputSchema:{type:'object',properties:{method:{type:'string'},url:{type:'string'},params:{type:['string','null']},body:{type:['string','null']}},required:['method','url','params','body']}}],
  assertHealthy(){},record(){},async call(name,args){actions.push({name,arguments:structuredClone(args)});return{content:JSON.stringify({id:'ACTUAL_OBSERVED_RESOURCE'})};},
 };
 const decision={done:false,tool:'api_fetch',arguments:{method:'GET',url:'https://fixture.invalid/resource',params:null,body:null}};
 const shared=createExperimentRuntime(settings,{provider:{async invoke(input){requests.push(input);return{message:{role:'assistant',content:JSON.stringify(requests.length===1?decision:{done:true,tool:'',arguments:{}})},finishReason:'stop',usage:{inputTokens:2,outputTokens:1,totalTokens:3}};}}});
 const task:BenchmarkTask={id:'public-automation-initialization-fixture',dataset:'automationbench',prompt:'Read the public fixture resource.',outputInstruction:'Use the declared JSON decision contract.',metadata:{}};
 try{
  const result=await automationScope.run(world,()=>runOfficialAgent(definition,task,shared,settings));
  assert.equal(result.modelFailure,undefined);assert.equal(requests.length,2);assert.deepEqual(actions,[{name:'api_fetch',arguments:decision.arguments}]);
  for(const input of requests){
   assert.deepEqual(input.messages.filter((m:any)=>m.role==='system').map((m:any)=>m.content),[NODE_SYSTEM_PROMPT]);
   assert(input.messages.some((m:any)=>m.role==='user'&&m.content===AUTOMATION_DECISION_INSTRUCTION+'\n\n'+AUTOMATION_INITIAL_GUIDANCE));
  }
  assert.match(JSON.stringify(requests[1].messages),/ACTUAL_OBSERVED_RESOURCE/);
 }finally{await shared.close();}
});
