import type {AgentDefinition} from '@codesoul-co/ditto/runtime';
import {officialBaseline} from './baselines.js';
import {validateOfficialDefinition} from './schema.js';

export const AUTOMATION_PROGRESS_CONTROLLER_VERSION='automation-progress-controller-v2';
export interface AutomationProgressPolicy{
 readonly failureThreshold?:number;readonly maxAudits?:number;readonly verifyCompletion?:boolean;
 readonly compactRepeatedFailures?:boolean;
}
const ref=(path:string)=>({$ref:path});
const op=(name:string,...args:any[])=>({$op:name,args});

/** Experimental framework controller. Business decisions still use the unmodified standard strategy.
 * It neither supplies field mappings nor repairs API calls. All observations remain public.
 * Reviewer judgments are evidence for the actor, never an alternative benchmark scorer.
 */
export function automationProgressController(policy:AutomationProgressPolicy={}):AgentDefinition{
 const threshold=policy.failureThreshold??2,maxAudits=policy.maxAudits??3;
 if(!Number.isSafeInteger(threshold)||threshold<2||threshold>10||!Number.isSafeInteger(maxAudits)||maxAudits<1||maxAudits>10)throw Error('Invalid progress-controller bounds');
 const definition:any=officialBaseline('automationbench');
 const history=definition.graphs.action.nodes.find((n:any)=>n.id==='history');
 history.input={...history.input,operation:'tool-history-progress',progressThreshold:threshold,compactRepeatedFailures:policy.compactRepeatedFailures??true};
 definition.graphs['progress-audit']={nodes:[
  // Review the actual control decision under the same frozen response contract.
  // The host's display-only finalAnswer default is not a model completion claim.
  {id:'audit-target',type:'HOST.DATA.TRANSFORM',input:{operation:'json',value:{done:ref('input.decision.done'),tool:ref('input.decision.tool'),arguments:ref('input.decision.arguments')}}},
  {id:'audit-review',type:'INFER.REASONING.REFLECT',dependsOn:['audit-target'],input:{model:ref('input.host.model'),generation:ref('input.host.generation'),messages:op('concat',ref('input.host.messages'),op('concat',ref('input.history'),[{role:'user',content:ref('config.strategy')}])),target:{result:{role:'assistant',content:ref('nodes.audit-target')}},mode:'verify'}},
  {id:'audit-evidence',type:'HOST.DATA.TRANSFORM',dependsOn:['audit-review'],input:{operation:'evidence',value:{assessment:ref('nodes.audit-review.output.assessment'),issues:ref('nodes.audit-review.output.issues')}}},
 ],output:{passed:ref('nodes.audit-review.output.assessment.passed'),history:op('concat',ref('input.history'),[{role:'user',content:ref('nodes.audit-evidence')}])}};
 definition.graphs['progress-exhausted']={nodes:[{id:'exhausted',type:'HOST.DATA.TRANSFORM',input:{operation:'text',value:'Framework audit budget exhausted. The requested effects may remain incomplete; consult the retained actual tool observations.'}}],output:ref('nodes.exhausted')};
 const loop=definition.loop;
 loop.state={...loop.state,stalled:false,audits:0};
 if(policy.verifyCompletion!==false)loop.steps.decision.transitions=[{when:ref('result.done'),next:'progress-audit'},{next:'action'}];
 loop.steps.action.assign={...loop.steps.action.assign,stalled:ref('result.progress.stalled')};
 loop.steps.action.transitions=[{when:ref('state.stalled'),next:'progress-audit'},{next:'decision'}];
 const input={task:ref('input.task'),host:ref('input.host'),history:ref('state.history'),decision:ref('state.decision')};
 loop.steps['progress-audit']={graph:'progress-audit',input,assign:{history:ref('result.history'),audits:op('add',ref('state.audits'),1)},transitions:[
  {when:op('and',ref('state.decision.done'),ref('result.passed')),end:'completed-after-audit'},
  {when:op('gte',ref('state.audits'),maxAudits),next:'progress-exhausted'},
  {next:'decision'},
 ]};
 loop.steps['progress-exhausted']={graph:'progress-exhausted',input,assign:{final:ref('result')},transitions:[{end:'audit-budget-exhausted'}]};
 return validateOfficialDefinition(definition);
}
