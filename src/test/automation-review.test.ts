import assert from 'node:assert/strict';
import test from 'node:test';
import {automationReview,automationReviewFeedback} from '../official-agent/automation-review.js';
import {createToolProgressTracker} from '../official-agent/progress.js';
import {createExecutionEvidence} from '../official-agent/execution-evidence.js';
import {automationLayeredController} from '../official-agent/layered-controller.js';
import {officialBaseline} from '../official-agent/baselines.js';
import {createExperimentRuntime} from '../ditto/runtime.js';
import {runOfficialAgent} from '../official-agent/executor.js';
import {automationScope} from '../benchmark/automation.js';
import {NODE_SYSTEM_PROMPT,REFLECTION_SYSTEM_CONTRACT} from '../graph-agent/system.js';
import type {BenchmarkTask} from '../domain.js';
import {createMutationInspector} from '../official-agent/mutation-inspection.js';

async function chainedReadback(queryFails:boolean){
 const base='https://instance.salesforce.com/services/data/v61.0',url=base+'/sobjects/Contact/contact1',queryUrl=base+'/query';
 const calls:{name:string;arguments:any}[]=[];let writes=0,actors=0,reviews=0;
 const task:BenchmarkTask={id:'chained-readback-fixture',dataset:'automationbench',prompt:'Update the contact city to Paris using the available service.',outputInstruction:'Use actual tools.',metadata:{}};
 const settings={baseUrl:'https://example.invalid',apiKey:'offline',model:'mock',concurrency:1,timeoutMs:3000};
 const world:any={tools:['api_search','api_fetch','base64_encode'].map(name=>({name,inputSchema:{type:'object',additionalProperties:true}})),record(){},assertHealthy(){},async call(name:string,args:any){
  calls.push({name,arguments:structuredClone(args)});
  if(name==='api_search')return{content:JSON.stringify({results:[{method:'GET',url:base+'/sobjects/Contact/{id}',parameters:{id:{required:true,location:'path'}}},{method:'GET',url:queryUrl,parameters:{q:{required:true,location:'query'}}}]})};
  if(args.method==='PATCH'){writes++;return{content:'{}'};}
  if(args.url===queryUrl){assert.equal(JSON.parse(args.params).q,"SELECT Id, MailingCity FROM Contact WHERE Id = 'contact1'");return{content:JSON.stringify(queryFails?{error:{code:404,message:'Projection unavailable'}}:{records:[{Id:'contact1',MailingCity:'Paris'}]})};}
  return{content:JSON.stringify({Id:'contact1',AccountId:'account1'})};
 }};
 const runtime=createExperimentRuntime(settings,{provider:{async invoke(input){
  const review=input.metadata?.nodeType==='INFER.REASONING.REFLECT';
  if(review){
   reviews++;const evidence=JSON.parse(String(input.messages.at(-1)?.content)).context[0].content.actualExecution;
   if(!queryFails){assert.equal(evidence.currentResources[0].content.AccountId,'account1');assert.equal(evidence.currentResources[0].content.MailingCity,'Paris');}
  }else{
   actors++;
   if(writes)assert.equal(calls.filter(c=>c.arguments.url===queryUrl).length,1,'queued projection must execute before the next actor decision');
  }
  return{message:{role:'assistant',content:JSON.stringify(review?{assessment:{passed:!queryFails,summary:queryFails?'Actual projection failed; no field observation.':'Complete record and projected field match the requested effects.'},issues:queryFails?[{severity:'error',description:'Projection returned an actual error.'}]:[]}:writes?{done:true,tool:'',arguments:{}}:{done:false,tool:'api_fetch',arguments:{method:'PATCH',url,params:null,body:'{"MailingCity":"Paris"}'}})},finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}};
 }}});
 try{return{run:await automationScope.run(world,()=>runOfficialAgent(automationLayeredController(),task,runtime,settings)),calls,writes,actors,reviews};}finally{await runtime.close();}
}

test('inspection drains the complete-record and missing-field projection chain before returning to the actor',async()=>{
 const {run,calls,writes,actors,reviews}=await chainedReadback(false);
 assert.equal(run.modelFailure,undefined);assert.equal(writes,1);assert.equal(actors,4);assert.equal(reviews,1);
 assert.deepEqual(calls.map(c=>c.name==='api_search'?'catalog':c.arguments.method==='PATCH'?'write':c.arguments.url.endsWith('/query')?'projection':'record'),['catalog','record','write','record','projection']);
 assert.equal(run.rawNodeOutputs['inspect/history'].evidence.effects[0].status,'witnessed');
});

test('a failed chained projection remains an actual error and is not dispatched forever',async()=>{
 const {run,calls,writes,reviews}=await chainedReadback(true);
 assert.equal(run.modelFailure,undefined);assert.equal(writes,1);assert.equal(reviews,4);
 assert.equal(calls.filter(c=>c.name==='api_fetch'&&c.arguments.url.endsWith('/query')).length,1);
 assert.match(run.answer,/audit budget exhausted/i);
 assert.equal(run.rawNodeOutputs['inspect/history'].evidence.effects[0].status,'unverified');
});

test('independent review separates prior opinions from executed facts and only decodes proposed bytes for display',()=>{
 const raw=Buffer.from('To: sample@example.invalid\r\nSubject: Status\r\n\r\nActual update.').toString('base64url');
 const value={done:false,tool:'api_fetch',arguments:{method:'POST',url:'https://mail.invalid/messages/send',body:JSON.stringify({raw})}};
 const history=[{role:'user',content:'Actual public observation'}, {role:'user',content:'Stale claim: missing record exists',metadata:{frameworkReviewFeedback:true}}];
 const before=structuredClone({value,history});
 const reviewed=automationReview({value,history},createToolProgressTracker());
 assert.equal(reviewed.requiresInspection,false);assert.equal(reviewed.review.history.length,1);
 assert.match(reviewed.review.context.targetSource,/actor-control-decision/);
 assert.match((reviewed.review.context.readablePayload as any).decodedRawText,/Actual update/);
 assert.deepEqual({value,history},before);assert.deepEqual(reviewed.arguments,value.arguments);
 const read=automationReview({value:{...value,arguments:{...value.arguments,method:'GET'}},history},createToolProgressTracker());
 assert.equal(read.requiresInspection,false);
 assert.equal(automationReview({value:{done:true,tool:'',arguments:{}},history},createToolProgressTracker()).requiresInspection,false);
});

test('same-review error contradictions cannot authorize execution, and accepted plans add no fake execution observation',()=>{
 const history=[{role:'user',content:'Public history'}];
 const rejected=automationReviewFeedback({history,stage:'before-action',value:{assessment:{passed:true,summary:'Contradictory'},issues:[{severity:'error',description:'Wrong recipient'}]}});
 assert.equal(rejected.passed,false);assert.equal(rejected.rejections,1);assert.equal(rejected.history.at(-1).metadata.frameworkReviewFeedback,true);
 const passed=automationReviewFeedback({history,value:{assessment:{passed:true,summary:'Plan matches'},issues:[]}});
 assert.equal(passed.passed,true);assert.equal(passed.history,history);
});

test('completion review uses latest witnessed state and original source reads, not reverted plans or stale record queries',()=>{
 const tracker=createToolProgressTracker(),base='https://instance.salesforce.com/services/data/v61.0',url=base+'/sobjects/Contact/contact1';
 const record=(arguments_:any,content:any)=>tracker.record({name:'api_fetch',arguments:arguments_},{status:'success',content:JSON.stringify(content)});
 record({method:'GET',url:'https://mail.invalid/messages/source'},{body:'The new company is Example Ltd.'});
 record({method:'GET',url:base+'/query',params:JSON.stringify({q:"SELECT Id, LastName FROM Contact WHERE Id = 'contact1'"})},{records:[{Id:'contact1',LastName:'Old name'}]});
 record({method:'PATCH',url,body:'{"LastName":"Wrong historical plan","ComputedName":"Ignored proposal"}'},{});
 record({method:'PATCH',url,body:'{"LastName":"Correct name","AccountId":"account1"}'},{});
 record({method:'GET',url},{Id:'contact1',LastName:'Correct name',ComputedName:'Correct display',AccountId:'account1',AccountName:'Example Ltd.'});
 const history=[{role:'assistant',content:'Wrong historical plan'},{role:'user',content:'Old reviewer belief',metadata:{frameworkReviewFeedback:true}}];
 const result=automationReview({value:{done:true,tool:'',arguments:{}},history},tracker);
 assert.deepEqual(result.review.history,[]);
 assert.equal(history.length,2,'the Actor history is retained');
 const actual=result.review.context.actualExecution;
 assert.equal(actual.currentResources[0]?.content.AccountName,'Example Ltd.');
 assert.equal(actual.sourceObservations.length,1);
 assert.match(actual.sourceObservations[0].content.body,/Example Ltd/);
 assert.doesNotMatch(JSON.stringify(actual),/Wrong historical plan|Ignored proposal|Old name|Old reviewer belief/);
 assert.equal(actual.operationsWithoutResourceRead.length,0);
 assert.equal(actual.executedOperations.length,1,'a real acknowledged PATCH remains visible even when historical intentions are omitted');
 assert.equal(actual.executedOperations[0].method,'PATCH');
 assert.equal(tracker.evidence().effects[0]?.status,'conflicting','the ignored request stays in the separate full audit ledger');
 assert.equal(tracker.evidence().latestReadbackConflict,false,'the latest correctly applied PATCH is not treated as the old ignored proposal');
});

test('receipt ledger retains separate creates and earlier PATCH fields and compares nested echoed fields',()=>{
 const evidence=createExecutionEvidence(),url='https://service.invalid/records/one';
 const write=(method:string,body:any,result:any={})=>evidence.record({name:'api_fetch',arguments:{method,url,body:JSON.stringify(body)}},{content:JSON.stringify(result)},false);
 write('PATCH',{first:'A'});write('PATCH',{second:'B'});
 assert.deepEqual(evidence.snapshot().effects[0]?.requestedFields,{first:'A',second:'B'});
 evidence.record({name:'api_fetch',arguments:{method:'GET',url}},{content:JSON.stringify({first:'A',second:'B',extra:true})},false);
 assert.equal(evidence.snapshot().effects[0]?.status,'witnessed');
 write('PUT',{ticket:{status:'closed'}},{ticket:{status:'closed',id:'one'}});
 assert.equal(evidence.snapshot().effects[0]?.status,'witnessed');
 write('POST',{title:'first'},{id:'created-one'});write('POST',{title:'second'},{id:'created-two'});
 assert.equal(evidence.snapshot().effects.length,3);
 assert.equal(evidence.snapshot().mutationCount,5);
 assert.equal(evidence.snapshot().recentObservations.length,6);
});

test('omitted fields are unknown coverage, not contradictory values; actual projected reads verify matching resource fields',()=>{
 const evidence=createExecutionEvidence(),url='https://instance.salesforce.com/services/data/v61.0/sobjects/Contact/record1';
 evidence.record({name:'api_fetch',arguments:{method:'PATCH',url,body:'{"MailingCity":"Denver"}'}},{content:'{}'},false);
 evidence.record({name:'api_fetch',arguments:{method:'GET',url}},{content:'{"Id":"record1","Name":"Public contact"}'},false);
 assert.equal(evidence.snapshot().effects[0]?.status,'unverified');
 assert.deepEqual(evidence.snapshot().effects[0]?.unobservedFields,['MailingCity']);
 assert.equal(evidence.snapshot().effects[0]?.mismatchedFields,undefined);
 const projected=(type:string,id:string,value:any)=>evidence.record({name:'api_fetch',arguments:{method:'GET',url:'https://instance.salesforce.com/services/data/v61.0/query',params:JSON.stringify({q:`SELECT Id, MailingCity FROM ${type} WHERE Id = '${id}'`})}},{content:JSON.stringify({records:[{Id:id,MailingCity:value}]})},false);
 projected('Account','record1','Denver');assert.equal(evidence.snapshot().effects[0]?.status,'unverified','a different object type cannot witness this write');
 projected('Contact','different','Denver');assert.equal(evidence.snapshot().effects[0]?.status,'unverified');
 projected('Contact','record1','Denver');assert.equal(evidence.snapshot().effects[0]?.status,'witnessed');
 projected('Contact','record1',null);assert.equal(evidence.snapshot().effects[0]?.status,'conflicting','an explicitly returned null differs from an omitted field');
});

test('projection uses only discovered query contracts and fields from actual writes, preserving the source arguments',()=>{
 const inspector=createMutationInspector(),queryUrl='https://instance.salesforce.com/services/data/v61.0/query';
 inspector.record({name:'api_search',arguments:{query:'read records'}},{content:JSON.stringify({results:[{method:'GET',url:queryUrl,parameters:{q:{location:'query',required:true}}}]})},false);
 const call={name:'api_fetch',arguments:{method:'PATCH',url:'https://instance.salesforce.com/services/data/v61.0/sobjects/Contact/record1',body:'{"MailingCity":"Denver"}'}};
 const before=structuredClone(call);
 inspector.record(call,{content:'{}'},false);
 const read=inspector.followup()!;assert.equal(read.arguments.url,queryUrl);
 assert.equal(JSON.parse(read.arguments.params!).q,"SELECT Id, MailingCity FROM Contact WHERE Id = 'record1'");
 assert.deepEqual(call,before);
 inspector.record({name:read.tool,arguments:read.arguments},{content:'{"records":[{"Id":"record1","MailingCity":"Denver"}]}'},false);
 assert.equal(inspector.followup(),null);
});

test('readback retains the complete record before supplementing omitted fields and verifies a created resource',()=>{
 const inspector=createMutationInspector(),evidence=createExecutionEvidence(),base='https://instance.salesforce.com/services/data/v61.0';
 const record=(call:any,result:any)=>{inspector.record(call,{content:JSON.stringify(result)},false);evidence.record(call,{content:JSON.stringify(result)},false);};
 record({name:'api_search',arguments:{query:'public catalog'}},{results:[{method:'GET',url:base+'/sobjects/{type}/{id}'},{method:'GET',url:base+'/query',parameters:{q:{location:'query',required:true}}}]});
 record({name:'api_fetch',arguments:{method:'POST',url:base+'/sobjects/Account',body:'{"Name":"New company"}'}},{id:'created1',success:true});
 let read=inspector.followup()!;assert.equal(read.arguments.url,base+'/sobjects/Account/created1');
 record({name:read.tool,arguments:read.arguments},{Id:'created1',Name:'New company'});
 assert.equal(evidence.snapshot().effects[0]?.status,'witnessed');assert.equal(inspector.followup(),null);
 const url=base+'/sobjects/Contact/contact1';
 record({name:'api_fetch',arguments:{method:'PATCH',url,body:'{"LastName":"Unchanged","MailingCity":"New city"}'}},{});
 read=inspector.followup()!;assert.equal(read.arguments.url,url,'complete relationship view is read first');
 record({name:read.tool,arguments:read.arguments},{Id:'contact1',LastName:'Unchanged',AccountId:'created1',AccountName:'New company'});
 read=inspector.followup()!;assert.equal(JSON.parse(read.arguments.params!).q,"SELECT Id, MailingCity FROM Contact WHERE Id = 'contact1'");
 record({name:read.tool,arguments:read.arguments},{records:[{Id:'contact1',MailingCity:'New city'}]});
 assert.equal(evidence.snapshot().effects[1]?.status,'witnessed','supplement merges with the current full view');
 assert.equal(inspector.followup(),null);
});

test('explicit ISO offsets compare instants without erasing actual time, local-zone, type or precision differences',()=>{
 const state=(requested:any,observed:any)=>{const e=createExecutionEvidence(),url='https://service.invalid/event/one';e.record({name:'api_fetch',arguments:{method:'POST',url,body:JSON.stringify({start_time:requested})}},{content:JSON.stringify({start_time:observed})},false);return e.snapshot().effects[0]?.status;};
 assert.equal(state('2026-02-28T15:00:00Z','2026-02-28T15:00:00+00:00'),'witnessed');
 assert.equal(state('2026-02-28T15:00:00Z','2026-02-28T23:00:00+08:00'),'witnessed');
 assert.equal(state('2026-02-28T15:00:00Z','2026-02-28T15:00:00+08:00'),'conflicting');
 assert.equal(state('2026-02-28T15:00:00','2026-02-28T15:00:00Z'),'conflicting');
 assert.equal(state('2026-02-28T15:00:00.001Z','2026-02-28T15:00:00.002+00:00'),'conflicting');
 assert.equal(state('2026-02-28T15:00:00.0001Z','2026-02-28T15:00:00Z'),'conflicting');
 assert.equal(state('2026-02-30T15:00:00Z','2026-03-02T15:00:00+00:00'),'conflicting');
 assert.equal(state(0,'1970-01-01T00:00:00Z'),'conflicting');
});

test('read-only inspection exposes actual fields before writing; the actor chooses corrected arguments under the frozen strategy',async()=>{
 const task:BenchmarkTask={id:'review-fixture',dataset:'automationbench',prompt:'Set the record title to Approved.',outputInstruction:'Use tools.',metadata:{}};
 const settings={baseUrl:'https://example.invalid',apiKey:'offline',model:'mock',concurrency:1,timeoutMs:3000};
 const action=(title:string)=>({done:false,tool:'api_fetch',arguments:{method:'PATCH',url:'https://service.invalid/records/one',params:null,body:JSON.stringify({title})}});
 const decisions=[action('Wrong'),action('Wrong'),action('Approved'),{done:true,tool:'',arguments:{}}];
 const executed:any[]=[];let actors=0,reviews=0,storedTitle='Before';
 const world:any={tools:['api_fetch','api_search','base64_encode'].map(name=>({name,inputSchema:{type:'object',additionalProperties:true}})),record(){},assertHealthy(){},async call(name:string,args:any){
  executed.push({name,arguments:structuredClone(args)});
  if(name==='api_fetch'&&args.method==='PATCH')storedTitle=JSON.parse(args.body).title;
  return{content:JSON.stringify(name==='api_search'?{results:[{method:'GET',url:'https://service.invalid/records/{id}',parameters:{id:{required:true,location:'path'}}}]}:args.method==='GET'?{title:storedTitle,allowedTitle:'Approved'}:{title:storedTitle})};
 }};
 const runtime=createExperimentRuntime(settings,{provider:{async invoke(input){
  const reviewing=input.metadata?.nodeType==='INFER.REASONING.REFLECT';
  if(!reviewing){
   assert.deepEqual(input.messages.filter(m=>m.role==='system').map(m=>m.content),[NODE_SYSTEM_PROMPT]);
   assert(actors<decisions.length);
   if(actors===2)assert(input.messages.some(m=>String(m.content).includes('allowedTitle')),'the changed action is chosen after seeing the real read');
   return{message:{role:'assistant',content:JSON.stringify(decisions[actors++])},finishReason:'stop',usage:{inputTokens:2,outputTokens:1,totalTokens:3}};
  }
  reviews++;const payload=JSON.parse(String(input.messages.at(-1)?.content));
  assert.equal(input.messages.filter(m=>m.role==='system')[1]?.content,REFLECTION_SYSTEM_CONTRACT);
  assert(payload.messages.some((m:any)=>m.content===(officialBaseline('automationbench').config as any).strategy));
  assert(!payload.messages.some((m:any)=>m.metadata?.frameworkReviewFeedback===true));
  assert.equal(executed.length,4);assert.equal(payload.context[0].content.actualExecution.currentResources[0].content.title,'Approved');
  return{message:{role:'assistant',content:JSON.stringify({assessment:{passed:true,summary:'Matches the task and actual evidence.'},issues:[]})},finishReason:'stop',usage:{inputTokens:2,outputTokens:1,totalTokens:3}};
 }}});
 try{
  const run=await automationScope.run(world,()=>runOfficialAgent(automationLayeredController(),task,runtime,settings));
  assert.equal(run.modelFailure,undefined);assert.equal(executed.length,4);assert.equal(reviews,1);
  assert.equal(executed[0].name,'api_search');assert.equal(executed[1].arguments.method,'GET');
  assert.deepEqual(executed[2].arguments,action('Approved').arguments);
  assert.equal(executed[3].arguments.method,'GET','actual readback follows the single actual write');
 }finally{await runtime.close();}
});

test('inspection discovers public GET contracts, reads positional layout once, and never invents an unsupported read',()=>{
 const inspector=createMutationInspector();
 const call={name:'api_fetch',arguments:{method:'POST',url:'https://sheets.invalid/v4/spreadsheets/example/values/Log!A1:E1:append',body:JSON.stringify({values:[['2026-01-01','call','Person','notes','done']]})}};
 const discover=inspector.next(call)!;assert.equal(discover.tool,'api_search');
 inspector.record({name:discover.tool,arguments:discover.arguments},{content:JSON.stringify({results:[{method:'GET',url:'https://sheets.invalid/v4/spreadsheets/{spreadsheetId}/values/{range}'}]})},false);
 const read=inspector.next(call)!;assert.equal(read.tool,'api_fetch');assert.match((read.arguments as any).url,/Log!A1:ZZ1$/);
 inspector.record({name:read.tool,arguments:read.arguments},{content:JSON.stringify({range:'Log!A1:ZZ1',values:[['Date','Type','Contact','Company','Notes','Outcome']]})},false);
 assert.equal(inspector.next(call),null,'observed layout is not repeatedly queried');
 const unknown=createMutationInspector(),query=unknown.next(call)!;
 unknown.record({name:query.tool,arguments:query.arguments},{content:'{"results":[]}'},false);
 assert.equal(unknown.next(call),null,'no matching public read contract means no fabricated GET');
 const failed=createMutationInspector(),patch={name:'api_fetch',arguments:{method:'PATCH',url:'https://service.invalid/records/missing'}};
 failed.record({name:'api_search',arguments:{query:'catalog'}},{content:JSON.stringify({results:[{method:'GET',url:'https://service.invalid/records/{id}'}]})},false);
 const first=failed.next(patch)!;
 failed.record({name:first.tool,arguments:first.arguments},{content:'{"error":{"code":404}}'},true);
 assert.equal(failed.next(patch),null,'failed inspection is retained as evidence, not repeated forever');
});

test('an ignored write enters review on its real readback despite changing timestamp metadata',async()=>{
 const settings={baseUrl:'https://example.invalid',apiKey:'offline',model:'mock',concurrency:1,timeoutMs:3000};
 const task:BenchmarkTask={id:'ignored-write-fixture',dataset:'automationbench',prompt:'Set the record title to Approved.',outputInstruction:'Use tools.',metadata:{}};
 const patch=(title:string)=>JSON.stringify({done:false,tool:'api_fetch',arguments:{method:'PATCH',url:'https://service.invalid/records/one',params:null,body:JSON.stringify({title})}});
 const decisions=[patch('Wrong'),patch('Wrong'),patch('Wrong'),patch('Approved'),JSON.stringify({done:true,tool:'',arguments:{}})];
 let actors=0,reviews=0,title='Before',revision=0;
 const world:any={tools:['api_fetch','api_search','base64_encode'].map(name=>({name,inputSchema:{type:'object',additionalProperties:true}})),record(){},assertHealthy(){},async call(name:string,args:any){
  if(name==='api_search')return{content:JSON.stringify({results:[{method:'GET',url:'https://service.invalid/records/{id}'}]})};
  if(args.method==='PATCH'){revision++;if(JSON.parse(args.body).title==='Approved')title='Approved';return{content:'{}'};}
  return{content:JSON.stringify({title,LastModifiedDate:'revision-'+revision})};
 }};
 const runtime=createExperimentRuntime(settings,{provider:{async invoke(input){
  if(input.metadata?.nodeType!=='INFER.REASONING.REFLECT')return{message:{role:'assistant',content:decisions[actors++]!},finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}};
  reviews++;
  const context=JSON.parse(String(input.messages.at(-1)?.content)).context[0].content;
  assert.equal(context.actualExecution.executedOperations[0].method,'PATCH');
  if(reviews===1){assert.equal(actors,3);assert.equal(context.stage,'observed-stall');assert.equal(title,'Before');}
  const passed=title==='Approved';
  return{message:{role:'assistant',content:JSON.stringify({assessment:{passed,summary:passed?'Actual title is correct.':'The acknowledged write did not change the actual title.'},issues:passed?[]:[{severity:'error',description:'Actual title remains Before; the requested change has not taken effect.'}]})},finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}};
 }}});
 try{const run=await automationScope.run(world,()=>runOfficialAgent(automationLayeredController(),task,runtime,settings));assert.equal(run.modelFailure,undefined);assert.equal(title,'Approved');assert.equal(reviews,2);assert.equal(actors,5);}finally{await runtime.close();}
});
