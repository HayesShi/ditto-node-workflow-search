import assert from 'node:assert/strict';
import test from 'node:test';
import {OFFICIAL_BASELINE,officialMutationDiff,validateOfficialChange} from '../official-agent/schema.js';
import {DefinitionError} from '../graph-agent/schema.js';

test('one functional node permits reference wiring plus additional user prompts',()=>{
 const p=structuredClone(OFFICIAL_BASELINE),d:any=structuredClone(p);
 d.graphs.main.nodes.splice(1,0,{id:'select',type:'CONTEXT.SELECT',dependsOn:['context'],input:{context:{$ref:'nodes.context'},purpose:'infer',limit:1}});
 const solve=d.graphs.main.nodes[2];
 solve.dependsOn.push('select');solve.input.messages={$op:'concat',args:[solve.input.messages,[{role:'user',content:{$ref:'nodes.select'}}]]};
 assert.deepEqual(officialMutationDiff(p,d),{added:['select'],removed:[],modified:[],wiringOnly:[],promptChanges:['solve'],count:1});
 assert.doesNotThrow(()=>validateOfficialChange(p,d));
 solve.input.messages.args[1].push({role:'user',content:'Unrelated prompt change'});
 assert.equal(officialMutationDiff(p,d).count,1);assert.doesNotThrow(()=>validateOfficialChange(p,d));
 d.graphs.main.nodes[0].input.resolveReferences=true;
 assert.throws(()=>validateOfficialChange(p,d),(e:any)=>e instanceof DefinitionError&&e.issue.message.includes('actual=2')&&e.issue.message.includes('select')&&e.issue.message.includes('context')&&e.issue.message.includes('promptChangesExcluded'));
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


test('literal data fallback outside Infer prompts still counts as a functional change',()=>{
 const p:any=structuredClone(OFFICIAL_BASELINE);
 p.graphs.main.nodes.splice(1,0,{id:'remember',type:'MEMORY.WRITE',input:{memories:[{key:{$ref:'input.optionalKey',default:'old-key'},content:'public observation'}]}});
 const d:any=structuredClone(p);
 d.graphs.main.nodes[1].input.memories[0].key.default='new-key';
 d.graphs.main.nodes[2].type='INFER.REASONING.TRAJECTORY';d.graphs.main.nodes[2].input.strategy={name:'cot'};
 d.graphs.main.output={$ref:'nodes.solve.output.result.content'};
 assert.deepEqual(officialMutationDiff(p,d).modified,['remember','solve']);
 assert.throws(()=>validateOfficialChange(p,d),/allowed=1 actual=2/);
});

test('user evidence labels and their fallback prompts are free; system edits are not',()=>{
 const p=structuredClone(OFFICIAL_BASELINE),d:any=structuredClone(p);
 d.graphs.main.nodes.splice(1,0,{id:'select',type:'CONTEXT.SELECT',dependsOn:['context'],input:{context:{$ref:'nodes.context'},purpose:'infer',limit:1}});
 d.graphs.main.nodes[2].dependsOn.push('select');
 const added={role:'user',content:{$op:'concat',args:['Grounded evidence: ',{$ref:'nodes.select.context.items.0.content',default:'No selected evidence'}]}};
 d.graphs.main.nodes[2].input.messages.args[1].push(added);
 assert.equal(officialMutationDiff(p,d).count,1);assert.doesNotThrow(()=>validateOfficialChange(p,d));
 added.role='system';
 assert.throws(()=>validateOfficialChange(p,d),/allowed=1 actual=2/);
});

test('several Infer user prompts can change alongside one functional node; strategy and constraints remain functional',()=>{
 const p:any=structuredClone(OFFICIAL_BASELINE);
 p.graphs.main.nodes.push({id:'review',type:'INFER.REASONING.TRAJECTORY',dependsOn:['solve'],input:{model:{$ref:'input.host.model'},generation:{$ref:'input.host.generation'},messages:{$op:'concat',args:[{$ref:'input.host.messages'},[{role:'user',content:{$ref:'nodes.solve.output.message.content'}}]]},strategy:{name:'cot'},constraints:{maxSteps:1}}});
 p.graphs.main.output={$ref:'nodes.review.output.result.content'};
 const d:any=structuredClone(p);
 for(const n of d.graphs.main.nodes.filter((n:any)=>n.type.startsWith('INFER.REASONING.')))n.input.messages.args[1].push({role:'user',content:'Use the requested answer format.'});
 d.graphs.main.nodes[2].input.objective='Check public evidence';d.graphs.main.nodes[0].input.resolveReferences=true;
 assert.deepEqual(officialMutationDiff(p,d).modified,['context']);assert.deepEqual(officialMutationDiff(p,d).promptChanges,['solve','review']);
 assert.doesNotThrow(()=>validateOfficialChange(p,d));
 d.graphs.main.nodes[2].input.constraints.maxSteps=2;
 assert.throws(()=>validateOfficialChange(p,d),/allowed=1 actual=2/);
});
