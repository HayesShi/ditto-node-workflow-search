import assert from 'node:assert/strict';
import test from 'node:test';
import {DefinitionError} from '../graph-agent/schema.js';
import {OFFICIAL_BASELINE,validateOfficialChange} from '../official-agent/schema.js';
import {officialBaseline} from '../official-agent/baselines.js';
import {OFFICIAL_PROPOSAL_SCHEMA,validateProposalEnvelope,validateMutationExplanation} from '../official-agent/proposal-contract.js';

const clone=(value:unknown):any=>structuredClone(value);
const envelope=(extra:Record<string,unknown>={})=>({rationale:'Test one publicly justified mechanism; preserve working behavior.',definition:clone(OFFICIAL_BASELINE),...extra});
function issue(run:()=>unknown,path:string,detail:RegExp):void{
 assert.throws(run,(error:unknown)=>{
  assert(error instanceof DefinitionError,'A malformed proposal must return a structured DefinitionError, not a raw TypeError');
  assert.equal(error.issue.path,path);assert.match(error.issue.message,detail);assert(error.issue.repairHint.trim());return true;
 });
}
function connectedAddition():any{
 const child=clone(OFFICIAL_BASELINE),solve=child.graphs.main.nodes[1];
 child.graphs.main.nodes.splice(1,0,
  {id:'compute',type:'INTERACTION.ACT.TOOL',input:{call:{id:'public-find',name:'literal_text_find',arguments:{text:{$ref:'input.task.prompt'},needle:'49'}}}},
  {id:'observe',type:'INTERACTION.OBSERVE',dependsOn:['compute'],input:{result:{$ref:'nodes.compute'}}},
  {id:'render',type:'HOST.DATA.TRANSFORM',dependsOn:['observe'],input:{operation:'evidence',value:{$ref:'nodes.observe'}}});
 solve.dependsOn=['render'];solve.input.messages={$op:'concat',args:[solve.input.messages,[{role:'user',content:{$ref:'nodes.render'}}]]};return child;
}
const mutation=()=>({primaryNodeId:'compute',auxiliary:[{nodeId:'observe',reason:'Expose the actual tool result.'},{nodeId:'render',reason:'Feed observed evidence into the existing solver.'}]});

test('proposal envelope describes official graphs and loops while keeping metadata outside definition',()=>{
 for(const dataset of ['drop','automationbench','bfcl'] as const){
  const input=envelope({definition:officialBaseline(dataset)}),value=validateProposalEnvelope(input);
  assert.equal(value.definition,input.definition);assert.equal(value.rationale,input.rationale);
 }
 const schema=OFFICIAL_PROPOSAL_SCHEMA;
 assert.deepEqual(schema.required,['rationale','definition']);assert.equal(schema.properties.rationale.type,'string');
 assert.equal(schema.properties.mutation.properties.auxiliary.type,'array');assert.equal(schema.properties.mutation.properties.auxiliary.maxItems,0);assert(Object.isFrozen(schema));assert(Object.isFrozen(schema.$defs.node));
 issue(()=>validateProposalEnvelope(envelope({definition:{...clone(OFFICIAL_BASELINE),mutation:mutation()}})),'/definition/mutation',/Unknown field/);
});

test('malformed rationale gives a precise string contract rather than a vague envelope rejection',()=>{
 const input=envelope({rationale:{publicEvidence:'Public passage',change:'One node'}});
 issue(()=>validateProposalEnvelope(input),'/rationale',/string.*object/);assert.equal(typeof input.rationale,'object','Validation must not silently stringify an optimizer object');
 issue(()=>validateProposalEnvelope(envelope({rationale:'   '})),'/rationale',/whitespace/);
 issue(()=>validateProposalEnvelope(envelope({rationale:'x'.repeat(8001)})),'/rationale',/8000/);
 issue(()=>validateProposalEnvelope({definition:OFFICIAL_BASELINE}),'/rationale',/missing/);
 issue(()=>validateProposalEnvelope({rationale:'Valid rationale'}),'/definition',/missing/);
 issue(()=>validateProposalEnvelope(envelope({'unknown/key~':true})),'/unknown~1key~0',/Unknown field/);
});

test('mutation shape errors are rejected before semantic code can call array methods',()=>{
 const child=connectedAddition();
 issue(()=>validateOfficialChange(OFFICIAL_BASELINE,child,mutation()),'/mutation/auxiliary',/allowed=0.*actual=2/);
 const invalid={primaryNodeId:'compute',auxiliary:{observe:'Expose result'}};
 issue(()=>validateProposalEnvelope(envelope({definition:child,mutation:invalid})),'/mutation/auxiliary',/array.*object/);
 issue(()=>validateOfficialChange(OFFICIAL_BASELINE,child,invalid as any),'/mutation/auxiliary',/array.*object/);
 issue(()=>validateMutationExplanation({primaryNodeId:'compute',auxiliary:[{nodeId:'observe'}]}),'/mutation/auxiliary/0/reason',/missing/);
 issue(()=>validateMutationExplanation({primaryNodeId:'compute',auxiliary:[{nodeId:'observe',reason:42}]}),'/mutation/auxiliary/0/reason',/string.*number/);
 issue(()=>validateMutationExplanation({primaryNodeId:'compute',auxiliary:[null]}),'/mutation/auxiliary/0',/object.*null/);
 issue(()=>validateMutationExplanation({primaryNodeId:'compute',auxiliary:[],summary:'Not supported'}),'/mutation/summary',/Unknown field/);
});

test('mutation companion validation preserves membership and connectivity requirements',()=>{
 issue(()=>validateMutationExplanation({primaryNodeId:'compute',auxiliary:[{nodeId:'compute',reason:'The primary is not its own companion.'}]}),'/mutation/auxiliary/0/nodeId',/primary/);
 issue(()=>validateMutationExplanation({primaryNodeId:'compute',auxiliary:[{nodeId:'observe',reason:'Observe.'},{nodeId:'observe',reason:'Duplicate.'}]}),'/mutation/auxiliary/1/nodeId',/Duplicate/);
 const child=connectedAddition(),bad=mutation();bad.auxiliary[1]!.nodeId='missing';
 issue(()=>validateOfficialChange(OFFICIAL_BASELINE,child,bad),'/mutation/auxiliary',/allowed=0/);
 const disconnected=connectedAddition();disconnected.graphs.main.nodes[2].dependsOn=[];
 // The compiler rejects a now undeclared reference before the mutation can waive the DAG contract.
 assert.throws(()=>validateOfficialChange(OFFICIAL_BASELINE,disconnected,mutation()),DefinitionError);
});

test('proposal tools require their actual declaration schema and never coerce bad artifacts',()=>{
 const tool={name:'public_helper',description:'Transform explicit public inputs.',inputSchema:{type:'object',properties:{}},executeSource:'args => args'};
 assert.equal(validateProposalEnvelope(envelope({toolArtifacts:[tool]})).toolArtifacts?.[0],tool);
 issue(()=>validateProposalEnvelope(envelope({toolArtifacts:{public_helper:tool}})),'/toolArtifacts',/array.*object/);
 const {inputSchema:omitted,...withoutSchema}=tool;
 issue(()=>validateProposalEnvelope(envelope({toolArtifacts:[withoutSchema]})),'/toolArtifacts/0/inputSchema',/missing/);
 issue(()=>validateProposalEnvelope(envelope({toolArtifacts:[{...tool,inputSchema:{type:'array'}}]})),'/toolArtifacts/0/inputSchema/type',/object/);
 issue(()=>validateProposalEnvelope(envelope({toolArtifacts:[{...tool,executeSource:{function:'not text'}}]})),'/toolArtifacts/0/executeSource',/string.*object/);
});
