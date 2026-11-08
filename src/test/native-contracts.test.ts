import assert from 'node:assert/strict';
import test from 'node:test';
import {createContext} from '@codesoul-co/ditto/worker/context';
import {createMemory} from '@codesoul-co/ditto/worker/memory';
import {createInfer} from '@codesoul-co/ditto/worker/infer';
import {observeExternalResult} from '@codesoul-co/ditto/worker/interaction';
import {createTaskMemory} from '../ditto/task-memory.js';
import {createBenchmarkTools,closeBenchmarkTools} from '../ditto/benchmark-tools.js';
import {NODE_TYPES} from '../graph-agent/schema.js';
import {NATIVE_CONTRACTS,HOST_TOOL_CONTRACTS,nativeOutputSchema} from '../official-agent/native-contracts.js';

test('catalogue covers the registered leaf names and serializes without creating capabilities',()=>{
 assert.deepEqual(Object.keys(NATIVE_CONTRACTS).sort(),[...NODE_TYPES,'HOST.DATA.TRANSFORM'].sort());
 assert.equal(Object.keys(JSON.parse(JSON.stringify(NATIVE_CONTRACTS))).length,NODE_TYPES.length+1);
 assert(!NATIVE_CONTRACTS['INTERACTION.ACT.MCP']);
 assert.match(NATIVE_CONTRACTS['RETRIEVAL.SEARCH']!.notes.join(' '),/only lexical segments/);
});

test('Context catalogue follows actual direct handler output and closed native input enums',async()=>{
 const sdk=createContext();
 const loaded=await sdk.load({sources:[{role:'user',content:'A public context message.'}]});
 assert(Array.isArray(loaded.items));assert(!Object.hasOwn(loaded,'output'));
 const selected=await sdk.select({context:loaded,purpose:'infer',limit:1,strategy:{kind:'default'}});
 assert.deepEqual(selected.context.items,loaded.items);assert.equal(selected.purpose,'infer');assert(!Object.hasOwn(selected,'output'));
 const selection=NATIVE_CONTRACTS['CONTEXT.SELECT']!;
 assert.deepEqual(selection.inputSchema.properties?.purpose?.enum,['infer','memory']);
 assert.equal(selection.outputSchema.properties?.context?.type,'object');assert(!selection.outputSchema.properties?.output);
 await assert.rejects(sdk.select({context:loaded,purpose:'summarize'} as never),/purpose must be infer or memory/);
 await assert.rejects(sdk.select({context:loaded,purpose:'infer',strategy:'default'} as never),/strategy must be an object/);
 const updated=await sdk.update({context:loaded,add:[{id:'another',content:'Additional public material.'}]});
 const compressed=await sdk.compress({context:updated,maxItems:1});assert.equal(compressed.items.length,1);
 for(const type of ['CONTEXT.LOAD','CONTEXT.UPDATE','CONTEXT.COMPRESS'])assert.equal(NATIVE_CONTRACTS[type]!.outputSchema.properties?.items?.type,'array');
});

test('Memory, Infer and Cache catalogue retains the actual NodeResult envelopes and hit wrappers',async()=>{
 const memory=createMemory(createTaskMemory());
 const written=await memory.write({memories:[{key:'note',content:'public evidence'}]});assert.equal(written.status,'success');assert(Array.isArray(written.output));
 const hits=await memory.search({query:'public',limit:1});assert.equal(hits.status,'success');assert.equal(hits.output?.[0]?.memory.content,'public evidence');
 assert.equal(NATIVE_CONTRACTS['MEMORY.SEARCH']!.outputSchema.properties?.output?.items?.properties?.memory?.type,'object');
 assert.equal(NATIVE_CONTRACTS['MEMORY.WRITE']!.outputSchema.properties?.output?.type,'array');
 const infer=createInfer({defaultProvider:'offline',providers:{offline:{async invoke(){return{message:{role:'assistant',content:'public answer'},finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}};}}}});
 const sampled=await infer.reasoning.sample({model:{model:'fixture'},messages:[{role:'user',content:'Public task'}]});assert.equal(sampled.status,'success');assert.equal(sampled.output?.message.content,'public answer');
 const key={scope:'sample',key:'working'};await infer.cache.write({key,value:'public cached value'});
 const cached=await infer.cache.lookup({key});assert.equal(cached.output?.hit,true);assert.equal(cached.output?.value,'public cached value');
 assert.equal(NATIVE_CONTRACTS['INFER.CACHE.LOOKUP']!.outputSchema.properties?.output?.properties?.hit?.type,'boolean');
});

test('registered pure tool schemas and native ACT/OBSERVE paths distinguish arithmetic from literal matches',async()=>{
 const tools=createBenchmarkTools();
 try{
  for(const tool of tools)assert.deepEqual(HOST_TOOL_CONTRACTS[tool.name]!.inputSchema,tool.inputSchema);
  const arithmetic=tools.find(tool=>tool.name==='bounded_arithmetic')!;
  const outcome=await arithmetic.execute({expression:'2+3'},{} as never);
  const result={...outcome,callId:'public-arithmetic',source:arithmetic.name};
  const observed=observeExternalResult({result});assert.equal(observed.status,'success');assert.deepEqual(observed.structuredContent,{result:5});assert(!Object.hasOwn(observed,'output'));
  const arithmeticShape=nativeOutputSchema('INTERACTION.ACT.TOOL',{call:{name:'bounded_arithmetic'}});
  assert.equal(arithmeticShape.properties?.structuredContent?.properties?.result?.type,'number');
  const literalShape=nativeOutputSchema('INTERACTION.ACT.TOOL',{call:{name:'literal_text_find'}});
  assert.equal(literalShape.properties?.structuredContent?.properties?.matches?.type,'array');assert(!literalShape.properties?.structuredContent?.properties?.result);
  const automationShape=nativeOutputSchema('INTERACTION.ACT.TOOL',{call:{name:'api_fetch'}});
  assert.equal(automationShape.properties?.content?.type,'string');assert(!automationShape.properties?.structuredContent);
  assert.equal(nativeOutputSchema('HOST.DATA.TRANSFORM',{operation:'evidence'}).type,'string');
 }finally{await closeBenchmarkTools(tools);}
});
