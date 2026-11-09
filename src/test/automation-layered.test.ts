import assert from 'node:assert/strict';
import test from 'node:test';
import {decodeAutomationDecision,automationDecisionAttempt} from '../official-agent/decision-protocol.js';
import {automationLayeredController} from '../official-agent/layered-controller.js';
import {officialBaseline} from '../official-agent/baselines.js';
import {transformOfficialData} from '../official-agent/helpers.js';
import {createToolProgressTracker} from '../official-agent/progress.js';
import {createExecutionEvidence} from '../official-agent/execution-evidence.js';
import {runOfficialAgent} from '../official-agent/executor.js';
import {createExperimentRuntime} from '../ditto/runtime.js';
import {automationScope} from '../benchmark/automation.js';
import {NODE_SYSTEM_PROMPT,REFLECTION_SYSTEM_CONTRACT} from '../graph-agent/system.js';
import type {BenchmarkTask} from '../domain.js';

const tools=['api_search','api_fetch','base64_encode'];
const action={done:false,tool:'api_fetch',arguments:{method:'PATCH',url:'https://service.invalid/records/one',params:null,body:'{"title":"Updated"}'}};
const done={done:true,tool:'',arguments:{}};
const dsml=(name:string,parameters:string)=>`<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="${name}">\n${parameters}\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>`;
const param=(name:string,value:string,literal=false)=>`<｜｜DSML｜｜ parameter name="${name}" string="${literal?'false':'true'}">${value}</｜｜DSML｜｜ parameter>`;

test('protocol conversion preserves one actual model action in JSON, prose, fence and DSML formats',()=>{
 const sources=[JSON.stringify(action),'I located the record.\n'+JSON.stringify(action),'```json\n'+JSON.stringify(action)+'\n```',dsml('api_fetch',param('arguments',JSON.stringify(action.arguments),true)+'\n'+param('tool','api_fetch'))];
 for(const source of sources){const decoded=decodeAutomationDecision(source,tools);assert.deepEqual({done:decoded.done,tool:decoded.tool,arguments:decoded.arguments},action);}
 const text='\nTo: fixture@example.invalid\n\nA body with  whitespace.\n';
 assert.deepEqual(decodeAutomationDecision(dsml('base64_encode',param('text',text)),tools).arguments,{text});
 assert.deepEqual(decodeAutomationDecision(dsml('api_fetch',Object.entries(action.arguments).map(([k,v])=>param(k,typeof v==='string'?v:JSON.stringify(v),v===null)).join('\n')),tools).arguments,action.arguments);
 for(const source of ['{"done":true,"done":false,"tool":"","arguments":{}}',JSON.stringify(action)+'\n'+JSON.stringify(done),dsml('api_fetch',param('arguments','{}',true)+'\n'+param('arguments','{}',true)),dsml('unknown',param('arguments','{}',true)),dsml('api_fetch',param('arguments','{}',true)+'\n'+param('tool','base64_encode'))])assert.equal(automationDecisionAttempt(source,tools).valid,false);
 const multiple=dsml('api_fetch',param('arguments','{}',true)).replace('</｜｜DSML｜｜ calls>','<｜｜DSML｜｜ invoke name="api_fetch"></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>');
 assert.equal(automationDecisionAttempt(multiple,tools).valid,false,'never execute part of a multiple-action response');
});

test('opaque mutation receipts are uncertainty signals; actual readbacks establish matching or conflicting fields',()=>{
 const evidence=createExecutionEvidence(),call={name:action.tool,arguments:action.arguments};
 evidence.record(call,{content:'{}'},false);assert.equal(evidence.snapshot().effects[0]?.status,'unverified');assert.equal(evidence.snapshot().reviewRecommended,true);
 evidence.record({name:'api_fetch',arguments:{method:'GET',url:action.arguments.url}},{content:'{"title":"Old"}'},false);
 assert.equal(evidence.snapshot().effects[0]?.status,'conflicting');assert.deepEqual(evidence.snapshot().effects[0]?.mismatchedFields,['title']);
 evidence.record({name:'api_fetch',arguments:{method:'GET',url:action.arguments.url}},{content:'{"title":"Updated"}'},false);
 assert.equal(evidence.snapshot().effects[0]?.status,'witnessed');assert.equal(evidence.snapshot().reviewRecommended,false);
 evidence.record(call,{content:'{"error":{"code":404}}'},true);assert.equal(evidence.snapshot().reviewRecommended,true);
 assert.equal(createExecutionEvidence().snapshot().reviewRecommended,false,'task state is isolated');
});

test('receipt comparison respects requested date precision and object key order without hiding real differences',()=>{
 const check=(requested:unknown,observed:unknown)=>{
  const evidence=createExecutionEvidence(),url='https://service.invalid/records/date';
  evidence.record({name:'api_fetch',arguments:{method:'PATCH',url,body:JSON.stringify({value:requested})}},{content:'{}'},false);
  evidence.record({name:'api_fetch',arguments:{method:'GET',url}},{content:JSON.stringify({value:observed})},false);
  return evidence.snapshot().effects[0]?.status;
 };
 for(const actual of ['2026-03-31','2026-03-31T00:00:00','2026-03-31T00:00:00Z','2026-03-31T00:00:00.000Z'])assert.equal(check('2026-03-31',actual),'witnessed');
 for(const actual of ['2026-04-01T00:00:00','2026-03-31T15:00:00','2026-03-31T00:00:00+08:00'])assert.equal(check('2026-03-31',actual),'conflicting');
 assert.equal(check('2026-03-31T15:00:00Z','2026-03-31T16:00:00Z'),'conflicting');
 assert.equal(check(3,'3'),'conflicting');
 assert.equal(check({a:1,b:2},{b:2,a:1}),'witnessed');
});

test('actual unchanged observations reveal interleaved successful read loops; new returned data resets the signal',()=>{
 const tracker=createToolProgressTracker();let history:any[]=[];
 const record=(id:string,value:number)=>{
  const decision={done:false,tool:'api_fetch',arguments:{method:'GET',url:'https://service.invalid/'+id}};
  const observed={source:decision.tool,status:'success',callId:'different-each-time',content:JSON.stringify({value}),message:{role:'tool',content:JSON.stringify({value})}};
  tracker.record({name:decision.tool,arguments:decision.arguments},observed);
  const result=transformOfficialData({operation:'tool-history-layered',tool:decision.tool,decision,value:observed,history,evidence:JSON.stringify(observed)},tracker);
  history=result.history;return result.progress;
 };
 assert.equal(record('a',1).consecutiveUnchangedObservations,0);
 assert.equal(record('b',1).consecutiveUnchangedObservations,0);
 assert.equal(record('a',1).stalled,false);
 assert.equal(record('b',1).stalled,true);
 assert.equal(record('a',2).consecutiveUnchangedObservations,0,'changed actual resource data is new evidence');
 assert.equal(history.length,10,'successful observations retain the full standard history');
});

test('successful layered histories exactly match standard histories while evidence remains separate',()=>{
 const tracker=createToolProgressTracker(),value={source:'api_fetch',status:'success',message:{role:'tool',content:'{}'},content:'{}'};
 tracker.record({name:action.tool,arguments:action.arguments},value);
 const input={tool:action.tool,decision:action,value,history:[],evidence:'Actual observation'};
 const standard=transformOfficialData({operation:'tool-history',...input});
 const layered=transformOfficialData({operation:'tool-history-layered',...input},tracker);
 assert.deepEqual(layered.history,standard.history);assert.equal(layered.evidence.reviewRecommended,true);
 const base:any=officialBaseline('automationbench'),changed:any=automationLayeredController();
 assert.deepEqual(changed.config,base.config);assert.deepEqual(changed.graphs.main.nodes[0],base.graphs.main.nodes[0]);
});

const settings={baseUrl:'https://example.invalid',apiKey:'offline',model:'mock',concurrency:1,timeoutMs:3000};
const task:BenchmarkTask={id:'public-layered-fixture',dataset:'automationbench',prompt:'Update the requested record title.',outputInstruction:'Use tools.',metadata:{}};
async function integration(responses:string[],observation:any){
 let actors=0,audits=0,actions=0;
 const world:any={tools:tools.map(name=>({name,inputSchema:{type:'object',additionalProperties:true}})),record(){},assertHealthy(){},async call(){actions++;return{content:JSON.stringify(observation)};}};
 const runtime=createExperimentRuntime(settings,{provider:{async invoke(input){
  const review=input.metadata?.nodeType==='INFER.REASONING.REFLECT';
  const systems=input.messages.filter(m=>m.role==='system').map(m=>m.content);
  if(review){
   audits++;assert.equal(systems[1],REFLECTION_SYSTEM_CONTRACT);
   const payload=JSON.parse(String(input.messages.at(-1)?.content));
   assert(payload.messages.some((m:any)=>m.content===(officialBaseline('automationbench').config as any).strategy));
   if(payload.context[0].content.effects.length)assert.equal(payload.context[0].content.effects[0].status,'unverified');
  }else{assert.deepEqual(systems,[NODE_SYSTEM_PROMPT]);assert(actors<responses.length);}
  return{message:{role:'assistant',content:review?JSON.stringify({assessment:{passed:true,summary:'The actual observed action is consistent with this task.'},issues:[]}):responses[actors++]!},finishReason:'stop',usage:{inputTokens:2,outputTokens:1,totalTokens:3}};
 }}});
 try{const run=await automationScope.run(world,()=>runOfficialAgent(automationLayeredController(),task,runtime,settings));return{run,actors,audits,actions};}finally{await runtime.close();}
}

test('protocol failure returns evidence for one same-contract retry without executing a malformed action',async()=>{
 const value=await integration(['Not a decision',JSON.stringify(action),JSON.stringify(done)],{title:'Updated'});
 assert.equal(value.run.modelFailure,undefined);assert.equal(value.actions,1);assert.equal(value.actors,3);assert.equal(value.audits,0);
 assert.equal(value.run.state.protocolFailures,1);assert(value.run.trace.some(e=>(e.output as any)?.protocol?.rawContent==='Not a decision'));
 const exhausted=await integration(['Invalid response','Still invalid'],{});
 assert.equal(exhausted.run.modelFailure?.code,'MODEL_OUTPUT_FORMAT');assert.equal(exhausted.actions,0);assert.equal(exhausted.actors,2);
});

test('only uncertain execution evidence triggers completion review; a substantive successful observation does not',async()=>{
 const certain=await integration([JSON.stringify(action),JSON.stringify(done)],{title:'Updated'});
 assert.equal(certain.run.modelFailure,undefined);assert.equal(certain.audits,0);
 const uncertain=await integration([JSON.stringify(action),JSON.stringify(done)],{});
 assert.equal(uncertain.run.modelFailure,undefined);assert.equal(uncertain.audits,1);
 const converted=await integration([dsml('api_fetch',param('arguments',JSON.stringify(action.arguments),true)),JSON.stringify(done)],{title:'Updated'});
 assert.equal(converted.run.modelFailure,undefined);assert.equal(converted.actions,1);assert.equal(converted.audits,0);
});

test('unchanged successful reads trigger a standard review before the outer Loop is exhausted',async()=>{
 const read=(id:string)=>JSON.stringify({done:false,tool:'api_fetch',arguments:{method:'GET',url:'https://service.invalid/'+id}});
 const result=await integration([read('a'),read('b'),read('a'),read('b'),JSON.stringify(done)],{title:'Updated'});
 assert.equal(result.run.modelFailure,undefined);assert.equal(result.actions,4);assert.equal(result.actors,5);assert.equal(result.audits,1);
});
