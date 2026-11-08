import test from 'node:test';
import assert from 'node:assert/strict';
import {OFFICIAL_BASELINE,validateOfficialDefinition} from '../official-agent/schema.js';
import {officialBaseline} from '../official-agent/baselines.js';
import {DefinitionError} from '../graph-agent/schema.js';

const clone=():any=>structuredClone(OFFICIAL_BASELINE);
const issue=(definition:any,pattern:RegExp)=>assert.throws(()=>validateOfficialDefinition(definition),(error:any)=>error instanceof DefinitionError&&pattern.test(error.path));

test('native static preflight rejects witnessed wrappers and selector contracts before any runtime exists',()=>{
 const d=clone();d.graphs.main.output={answer:{$ref:'nodes.solve.output.message.content'},bad:{$ref:'nodes.context.output.items'}};issue(d,/\/output\/.*\$ref$/);
 for(const input of [{purpose:'summarize',strategy:{kind:'default'}},{purpose:'infer',strategy:'select relevant evidence'}]){
  const def=clone();def.graphs.main.nodes.push({id:'select',type:'CONTEXT.SELECT',dependsOn:['context'],input:{context:{$ref:'nodes.context'},...input}});def.graphs.main.output={answer:{$ref:'nodes.solve.output.message.content'},selected:{$ref:'nodes.select.context'}};
  issue(def,/\/input\/(purpose|strategy)$/);
 }
});

test('literal registered-tool arguments and result shapes share the same preflight contract',()=>{
 for(const [name,args,output]of [
  ['bounded_arithmetic',{a:1,b:2,op:'subtract'},'nodes.act.structuredContent.result'],
  ['literal_text_find',{text:'text',pattern:'t'},'nodes.act.structuredContent.count'],
  ['literal_text_find',{text:'text',needle:'t'},'nodes.act.structuredContent.result'],
 ] as const){
  const def:any={version:1,id:'tool-probe',graphs:{main:{nodes:[{id:'act',type:'INTERACTION.ACT.TOOL',input:{call:{id:'probe',name,arguments:args}}}],output:{$ref:output}}}};
  issue(def,/\/input\/call\/arguments|\/output\/\$ref/);
 }
});

test('literal invalid HTTP message parts are rejected even though native Infer accepts unknown arrays',()=>{
 const d=clone();d.graphs.main.nodes[1].input.messages=[{$ref:'input.host.originalTaskMessage'},{role:'user',content:['incorrect content array']}];
 issue(d,/\/input\/messages\/1\/content\/0$/);
});

test('native preflight preserves dynamic JSON, explicit fallback, literal data and Subgraph projections',()=>{
 const d=clone();d.graphs.main.output={answer:{$ref:'nodes.solve.output.message.content'},fallback:{$ref:'nodes.context.absent',default:'intentional fallback'}};assert.doesNotThrow(()=>validateOfficialDefinition(d));
 const p=clone();p.graphs.main.nodes.push({id:'parsed',type:'HOST.DATA.TRANSFORM',dependsOn:['solve'],input:{operation:'parse',sourceKind:'model-json',value:{$ref:'nodes.solve.output.message.content'}}});p.graphs.main.output={$ref:'nodes.parsed.arbitrary.nested.value'};assert.doesNotThrow(()=>validateOfficialDefinition(p));
 const sub:any={version:1,id:'projected',graphs:{main:{nodes:[{id:'child',kind:'subgraph',graph:'child',input:{$ref:'input'}}],output:{$ref:'nodes.child.output'}},child:{nodes:[{id:'literal',type:'HOST.DATA.TRANSFORM',input:{operation:'coalesce',value:[{$literal:{$ref:'nodes.not-a-real-reference'}}]}}],output:{output:{$ref:'nodes.literal'}}}}};
 assert.doesNotThrow(()=>validateOfficialDefinition(sub));
 for(const dataset of ['drop','humaneval','mbpp','bfcl','automationbench'] as const)assert.doesNotThrow(()=>validateOfficialDefinition(officialBaseline(dataset)));
});
