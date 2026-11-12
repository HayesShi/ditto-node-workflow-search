import assert from 'node:assert/strict';
import test from 'node:test';
import {OFFICIAL_BASELINE,officialMutationDiff,validateOfficialChange} from '../official-agent/schema.js';
import {DefinitionError} from '../graph-agent/schema.js';

test('one functional node permits required reference wiring without permitting a second prompt change',()=>{
 const p=structuredClone(OFFICIAL_BASELINE),d:any=structuredClone(p);
 d.graphs.main.nodes.splice(1,0,{id:'select',type:'CONTEXT.SELECT',dependsOn:['context'],input:{context:{$ref:'nodes.context'},purpose:'infer',limit:1}});
 const solve=d.graphs.main.nodes[2];
 solve.dependsOn.push('select');solve.input.messages={$op:'concat',args:[solve.input.messages,[{role:'user',content:{$ref:'nodes.select'}}]]};
 assert.deepEqual(officialMutationDiff(p,d),{added:['select'],removed:[],modified:[],wiringOnly:['solve'],count:1});
 assert.doesNotThrow(()=>validateOfficialChange(p,d));
 solve.input.messages.args[1].push({role:'user',content:'Unrelated prompt change'});
 assert.throws(()=>validateOfficialChange(p,d),(e:any)=>e instanceof DefinitionError&&e.issue.message.includes('actual=2')&&e.issue.message.includes('select')&&e.issue.message.includes('solve')&&e.issue.repairHint.includes('Restore'));
});

test('replacement keeps ID; renaming and deletion list exact differences instead of claiming leaf status',()=>{
 const d:any=structuredClone(OFFICIAL_BASELINE);
 d.graphs.main.nodes[1].id='replacement';d.graphs.main.nodes.shift();d.graphs.main.nodes[0].dependsOn=[];
 d.graphs.main.output={$ref:'nodes.replacement.output.message.content'};
 assert.throws(()=>validateOfficialChange(OFFICIAL_BASELINE,d),(e:any)=>e.issue.message.includes('actual=3')&&e.issue.message.includes('replacement')&&e.issue.message.includes('context')&&e.issue.message.includes('solve'));
 const replacement:any=structuredClone(OFFICIAL_BASELINE);
 replacement.graphs.main.nodes[1].type='INFER.REASONING.TRAJECTORY';replacement.graphs.main.nodes[1].input.strategy={name:'cot'};
 replacement.graphs.main.output={$ref:'nodes.solve.output.result.content'};
 assert.doesNotThrow(()=>validateOfficialChange(OFFICIAL_BASELINE,replacement));
});


test('literal fallback changes cannot disguise a second functional edit as reference wiring',()=>{
 const d:any=structuredClone(OFFICIAL_BASELINE);
 d.graphs.main.nodes[0].input.sources[0].content.default='Injected fallback instruction';
 d.graphs.main.nodes[1].type='INFER.REASONING.TRAJECTORY';d.graphs.main.nodes[1].input.strategy={name:'cot'};
 d.graphs.main.output={$ref:'nodes.solve.output.result.content'};
 assert.deepEqual(officialMutationDiff(OFFICIAL_BASELINE,d).modified,['context','solve']);
 assert.throws(()=>validateOfficialChange(OFFICIAL_BASELINE,d),/allowed=1 actual=2/);
});
