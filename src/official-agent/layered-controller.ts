import type {AgentDefinition} from '@codesoul-co/ditto/runtime';
import {automationProgressController} from './progress-controller.js';
import {validateOfficialDefinition} from './schema.js';

export const AUTOMATION_LAYERED_CONTROLLER_VERSION='automation-layered-controller-v2';
export interface AutomationLayeredPolicy{readonly failureThreshold?:number;readonly maxAudits?:number;readonly maxProtocolFailures?:number;}
const ref=(path:string)=>({$ref:path});
const op=(name:string,...args:any[])=>({$op:name,args});

/** Runtime protocol recovery and evidence-gated control; all business actions remain model outputs. */
export function automationLayeredController(policy:AutomationLayeredPolicy={}):AgentDefinition{
 const maxProtocolFailures=policy.maxProtocolFailures??2;
 if(!Number.isSafeInteger(maxProtocolFailures)||maxProtocolFailures<1||maxProtocolFailures>3)throw Error('Invalid protocol recovery budget');
 const definition:any=structuredClone(automationProgressController({failureThreshold:policy.failureThreshold??2,maxAudits:policy.maxAudits??4,verifyCompletion:false,compactRepeatedFailures:true}));
 const decision=definition.graphs.main.nodes.find((n:any)=>n.id==='decision');
 decision.input={...decision.input,operation:'decision-attempt',protocolFailures:ref('input.protocolFailures'),maxProtocolFailures};
 const history=definition.graphs.action.nodes.find((n:any)=>n.id==='history');
 history.input.operation='tool-history-layered';
 const loop=definition.loop;
 loop.state={...loop.state,protocolFailures:0,evidence:{source:'actual-task-world-observations',businessErrors:0,effects:[],reviewRecommended:false},protocol:{}};
 loop.steps.decision.input={...loop.steps.decision.input,protocolFailures:ref('state.protocolFailures')};
 loop.steps.decision.assign={...loop.steps.decision.assign,protocol:ref('result.protocol')};
 loop.steps.decision.transitions=[
  {when:op('eq',ref('result.valid'),false),next:'protocol-error'},
  {when:op('and',ref('result.done'),ref('state.evidence.reviewRecommended')),next:'progress-audit'},
  {when:ref('result.done'),end:'completed-without-extra-review'},
  {next:'action'},
 ];
 loop.steps.action.assign={...loop.steps.action.assign,evidence:ref('result.evidence')};
 definition.graphs['protocol-error']={nodes:[{id:'protocol-evidence',type:'HOST.DATA.TRANSFORM',input:{operation:'evidence',value:ref('input.protocol')}}],output:op('concat',ref('input.history'),[{role:'user',content:ref('nodes.protocol-evidence')}])};
 loop.steps['protocol-error']={graph:'protocol-error',input:{history:ref('state.history'),protocol:ref('state.protocol')},assign:{history:ref('result'),protocolFailures:op('add',ref('state.protocolFailures'),1)},transitions:[{next:'decision'}]};
 loop.steps['progress-audit'].input={...loop.steps['progress-audit'].input,evidence:ref('state.evidence')};
 definition.graphs['progress-audit'].nodes.find((n:any)=>n.id==='audit-review').input.context=[{id:'actual-execution-evidence',content:ref('input.evidence')}];
 return validateOfficialDefinition(definition);
}
