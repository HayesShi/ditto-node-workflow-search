import assert from 'node:assert/strict';
import test from 'node:test';
import {createToolProgressTracker} from '../official-agent/progress.js';
import {transformOfficialData} from '../official-agent/helpers.js';
import {automationProgressController} from '../official-agent/progress-controller.js';
import {officialBaseline} from '../official-agent/baselines.js';
import {runOfficialAgent} from '../official-agent/executor.js';
import {createExperimentRuntime} from '../ditto/runtime.js';
import {automationScope} from '../benchmark/automation.js';
import {NODE_SYSTEM_PROMPT,REFLECTION_SYSTEM_CONTRACT} from '../graph-agent/system.js';
import type {BenchmarkTask} from '../domain.js';

const call={name:'api_fetch',arguments:{method:'PUT',url:'https://service.invalid/links/a',params:null,body:null}};
const result=(body:any)=>({status:'success',source:'api_fetch',callId:'actual-call',content:JSON.stringify(body)});
test('host progress counts real repeated domain errors, not successful transport or candidate claims',()=>{
 const tracker=createToolProgressTracker();
 assert.throws(()=>tracker.latest(call),/latest actually executed/);
 for(let count=1;count<=3;count++){
  tracker.record(call,result({error:{code:404,message:'No handler'}}));
  assert.equal(tracker.latest(call).consecutiveEquivalentFailures,count);
  assert.equal(tracker.latest(call).consecutiveEquivalentFailures,count,'reading does not create another execution');
 }
 const cosmetic={...call,arguments:{...call.arguments,params:'{}',body:'{}'}};
 tracker.record(cosmetic,result({error:{message:'No handler',code:404}}));
 assert.equal(tracker.latest(cosmetic).consecutiveEquivalentFailures,4);
 assert.equal(cosmetic.arguments.body,'{}','arguments reach the world unchanged');
 assert.throws(()=>tracker.latest(call),/exact arguments/);
 tracker.record(call,result({error:{code:404,message:'Different resource missing'}}));assert.equal(tracker.latest(call).consecutiveEquivalentFailures,1);
 tracker.record(call,result({}));assert.equal(tracker.latest(call).consecutiveEquivalentFailures,0);
 tracker.record(call,result({error:{code:404,message:'No handler'}}));assert.equal(tracker.latest(call).consecutiveEquivalentFailures,1);
 assert.throws(()=>createToolProgressTracker().latest(call),/latest actually executed/,'resources do not cross tasks');
});

test('compaction retains exact last decision/observation, with authoritative counts and no completion inference',()=>{
 const tracker=createToolProgressTracker();let history:any[]=[{role:'user',content:'Original public task'}];
 const decision={done:false,tool:call.name,arguments:call.arguments};
 for(let count=1;count<=4;count++){
  const observed=result({error:{code:404,message:'No handler'}});tracker.record(call,observed);
  const value={...observed,message:{role:'tool',content:observed.content}};
  const next=transformOfficialData({operation:'tool-history-progress',tool:call.name,decision,value,history,evidence:JSON.stringify(value)},tracker);
  history=next.history;assert.equal(next.complete,false);assert.equal(next.progress.stalled,count>=2);
  assert.equal(history.length,3);assert.deepEqual(JSON.parse(history[1].content),decision);
  assert(history[2].content.startsWith(JSON.stringify(value)));assert.equal(history[2].metadata.frameworkProgress.consecutiveEquivalentFailures,count);
 }
 const before=tracker.latest(call);
 transformOfficialData({operation:'tool-history-progress',tool:call.name,decision,value:{source:call.name,status:'success',message:{}},history,evidence:'public evidence'},tracker);
 assert.deepEqual(tracker.latest(call),before,'transform calls cannot forge more actual tool executions');
 assert.throws(()=>transformOfficialData({operation:'tool-history-progress',tool:call.name,decision,value:{source:call.name,status:'success',message:{}},history,evidence:'public evidence'}),/host execution tracker/);
});

test('standard actor prompt and graphs remain fixed except for declared progress/control paths',()=>{
 const standard:any=officialBaseline('automationbench'),changed:any=automationProgressController();
 assert.deepEqual(changed.config,standard.config);
 assert.deepEqual(changed.graphs.main,standard.graphs.main);
 assert.deepEqual(changed.graphs.action.nodes.slice(0,3),standard.graphs.action.nodes.slice(0,3));
 assert.equal(changed.graphs['progress-audit'].nodes[1].input.mode,'verify');
 assert(!JSON.stringify(changed).includes('MobilePhone'));
});

test('Loop audits only after repeated real errors or proposed completion, then actor chooses the actual repair',async()=>{
 const settings={baseUrl:'https://example.invalid',apiKey:'offline',model:'mock',concurrency:1,timeoutMs:3000};
 const task:BenchmarkTask={id:'public-progress-fixture',dataset:'automationbench',prompt:'Create the requested link using the authorized service.',outputInstruction:'Use tools.',metadata:{}};
 const decisions=[{done:false,tool:'api_fetch',arguments:call.arguments},{done:false,tool:'api_fetch',arguments:call.arguments},{done:false,tool:'api_fetch',arguments:{...call.arguments,url:'https://service.invalid/links-correct/a'}},{done:true,tool:'',arguments:{}}];
 let actor=0,audits=0;const executed:string[]=[];
 const world:any={tools:['api_fetch','api_search','base64_encode'].map(name=>({name,inputSchema:{type:'object',additionalProperties:true}})),record(){},assertHealthy(){},async call(_name:string,args:any){executed.push(args.url);return{content:JSON.stringify(args.url.includes('links-correct')?{linked:true}:{error:{code:404,message:'No handler'}})};}};
 const runtime=createExperimentRuntime(settings,{provider:{async invoke(input){
  const reviewer=input.metadata?.nodeType==='INFER.REASONING.REFLECT';
  const systems=input.messages.filter(m=>m.role==='system').map(m=>m.content);
  if(reviewer){
   assert.equal(systems.length,2);assert.match(String(systems[0]),/^Assess the supplied target against the criteria\./);assert.equal(systems[1],REFLECTION_SYSTEM_CONTRACT);
   const payload=JSON.parse(String(input.messages.at(-1)?.content));
   assert(!JSON.stringify(payload.target).includes('End of declared agent execution.'));
   assert(payload.messages.some((m:any)=>m.content===(officialBaseline('automationbench').config as any).strategy),'reviewer sees the same existing completion-response contract');
  }
  else assert.deepEqual(systems,[NODE_SYSTEM_PROMPT]);
  if(reviewer){audits++;assert.equal(executed.length,audits===1?2:3);return{message:{role:'assistant',content:JSON.stringify({assessment:{passed:audits===2,summary:audits===1?'The same endpoint failed twice; the requested link has not been created.':'Actual service observation confirms the requested link.'},issues:audits===1?[{id:'failed-operation',severity:'error',description:'The repeated actual 404 responses show the requested operation did not execute.'}]:[]})},finishReason:'stop',usage:{inputTokens:2,outputTokens:1,totalTokens:3}};}
  assert(actor<decisions.length);return{message:{role:'assistant',content:JSON.stringify(decisions[actor++])},finishReason:'stop',usage:{inputTokens:2,outputTokens:1,totalTokens:3}};
 }}});
 try{
  const run=await automationScope.run(world,()=>runOfficialAgent(automationProgressController(),task,runtime,settings));
  assert.equal(run.modelFailure,undefined);assert.equal(audits,2);assert.equal(actor,4);assert.equal(executed.length,3);
  assert.equal(run.state.audits,2);assert.equal(run.rawNodeOutputs['action/history'].progress.consecutiveEquivalentFailures,0);
  assert.equal(run.trace.filter(e=>e.nodeId==='act').length,3,'compaction cannot delete audit traces');
 }finally{await runtime.close();}
});

test('repeated real errors terminate at the audit budget instead of repeating indefinitely',async()=>{
 const settings={baseUrl:'https://example.invalid',apiKey:'offline',model:'mock',concurrency:1,timeoutMs:3000};
 const task:BenchmarkTask={id:'public-stalled-fixture',dataset:'automationbench',prompt:'Create the requested link.',outputInstruction:'Use tools.',metadata:{}};
 let actor=0,audits=0,actions=0;
 const world:any={tools:[{name:'api_fetch',inputSchema:{type:'object',additionalProperties:true}}],record(){},assertHealthy(){},async call(){actions++;return{content:JSON.stringify({error:{code:404,message:'No handler'}})};}};
 const runtime=createExperimentRuntime(settings,{provider:{async invoke(input){
  const review=input.metadata?.nodeType==='INFER.REASONING.REFLECT';
  if(review)audits++;else actor++;
  return{message:{role:'assistant',content:JSON.stringify(review?{assessment:{passed:false,summary:'Actual calls continue to fail.'},issues:[{id:'still-failing',severity:'error',description:'The operation returned 404.'}]}:{done:false,tool:call.name,arguments:call.arguments})},finishReason:'stop',usage:{inputTokens:2,outputTokens:1,totalTokens:3}};
 }}});
 try{
  const run=await automationScope.run(world,()=>runOfficialAgent(automationProgressController({maxAudits:2}),task,runtime,settings));
  assert.equal(run.modelFailure,undefined);assert.equal(audits,2);assert.equal(actor,3);assert.equal(actions,3);
  assert.match(run.answer,/audit budget exhausted/i);
 }finally{await runtime.close();}
});
