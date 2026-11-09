import type {AgentDefinition} from '@codesoul-co/ditto/runtime';
import {automationProgressController} from './progress-controller.js';
import {validateOfficialDefinition} from './schema.js';

export const AUTOMATION_LAYERED_CONTROLLER_VERSION='automation-layered-controller-v9';
export interface AutomationLayeredPolicy{readonly failureThreshold?:number;readonly maxAudits?:number;readonly maxProtocolFailures?:number;readonly inspectMutations?:boolean;}
const ref=(path:string)=>({$ref:path});
const op=(name:string,...args:any[])=>({$op:name,args});

/** Runtime protocol recovery and evidence-gated control; all business actions remain model outputs. */
export function automationLayeredController(policy:AutomationLayeredPolicy={}):AgentDefinition{
 const maxProtocolFailures=policy.maxProtocolFailures??2;
 if(!Number.isSafeInteger(maxProtocolFailures)||maxProtocolFailures<1||maxProtocolFailures>3)throw Error('Invalid protocol recovery budget');
 const definition:any=structuredClone(automationProgressController({failureThreshold:policy.failureThreshold??2,maxAudits:policy.maxAudits??4,verifyCompletion:false,compactRepeatedFailures:true}));
 const decision=definition.graphs.main.nodes.find((n:any)=>n.id==='decision');
 decision.input={...decision.input,operation:'decision-attempt',protocolFailures:ref('input.protocolFailures'),maxProtocolFailures};
 definition.graphs.main.nodes.push({id:'review-input',type:'HOST.DATA.TRANSFORM',dependsOn:['decision'],input:{operation:'automation-review',value:ref('nodes.decision'),history:ref('input.history'),inspectMutations:policy.inspectMutations??true}});
 definition.graphs.main.output=ref('nodes.review-input');
 const history=definition.graphs.action.nodes.find((n:any)=>n.id==='history');
 history.input.operation='tool-history-layered';
 const loop=definition.loop;
 loop.state={...loop.state,protocolFailures:0,review:{},evidence:{source:'actual-task-world-observations',businessErrors:0,effects:[],reviewRecommended:false},protocol:{}};
 loop.steps.decision.input={...loop.steps.decision.input,protocolFailures:ref('state.protocolFailures')};
 loop.steps.decision.assign={...loop.steps.decision.assign,protocol:ref('result.protocol'),review:ref('result.review'),inspection:ref('result.inspection')};
 loop.steps.decision.transitions=[
  {when:op('eq',ref('result.valid'),false),next:'protocol-error'},
  {when:op('and',ref('result.done'),ref('state.evidence.reviewRecommended')),next:'progress-audit'},
  {when:ref('result.done'),end:'completed-without-extra-review'},
  {when:ref('result.requiresInspection'),next:'inspect'},
  {next:'action'},
 ];
 loop.steps.action.assign={...loop.steps.action.assign,evidence:ref('result.evidence'),inspection:ref('result.inspection')};
 if(policy.inspectMutations!==false)loop.steps.action.transitions.unshift({when:ref('result.requiresInspection'),next:'inspect'});
 definition.graphs['protocol-error']={nodes:[{id:'protocol-evidence',type:'HOST.DATA.TRANSFORM',input:{operation:'evidence',value:ref('input.protocol')}}],output:op('concat',ref('input.history'),[{role:'user',content:ref('nodes.protocol-evidence')}])};
 loop.steps['protocol-error']={graph:'protocol-error',input:{history:ref('state.history'),protocol:ref('state.protocol')},assign:{history:ref('result'),protocolFailures:op('add',ref('state.protocolFailures'),1)},transitions:[{next:'decision'}]};
 // Review keeps the unchanged native verifier and original task contract.
 const reviewGraph=(stage:string)=>({nodes:[
  {id:'review-input',type:'HOST.DATA.TRANSFORM',input:{operation:'automation-review',value:ref('input.decision'),history:ref('input.history'),stage}},
  {id:'audit-target',type:'HOST.DATA.TRANSFORM',input:{operation:'json',value:{done:ref('input.decision.done'),tool:ref('input.decision.tool'),arguments:ref('input.decision.arguments')}}},
  {id:'audit-review',type:'INFER.REASONING.REFLECT',dependsOn:['review-input','audit-target'],input:{model:ref('input.host.model'),generation:ref('input.host.generation'),messages:op('concat',ref('input.host.messages'),op('concat',ref('nodes.review-input.review.history'),[{role:'user',content:ref('config.strategy')}])),target:{result:{role:'assistant',content:ref('nodes.audit-target')}},mode:'verify',context:[{id:'actual-execution-evidence',content:ref('nodes.review-input.review.context')}]}},
  {id:'feedback',type:'HOST.DATA.TRANSFORM',dependsOn:['audit-review'],input:{operation:'automation-review-feedback',value:ref('nodes.audit-review.output'),history:ref('input.history'),stage}},
 ],output:ref('nodes.feedback')});
 definition.graphs['progress-audit']=reviewGraph('completion-or-stall');
 definition.graphs.inspect=structuredClone(definition.graphs.action);
 loop.steps.inspect={graph:'inspect',input:{task:ref('input.task'),host:ref('input.host'),history:ref('state.history'),decision:ref('state.inspection')},assign:{history:ref('result.history'),evidence:ref('result.evidence'),stalled:ref('result.progress.stalled')},transitions:[{when:ref('state.stalled'),next:'progress-audit'},{next:'decision'}]};
 return validateOfficialDefinition(definition);
}
