import {BindingContractError} from '../graph-agent/bindings.js';
import type {ToolProgressTracker} from './progress.js';

const object=(v:any):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const parse=(v:unknown)=>{if(typeof v!=='string')return v;try{return JSON.parse(v);}catch{return v;}};

/** Display-only decoding. The candidate's bytes and actual tool arguments are unchanged. */
function readablePayload(decision:any){
 const body=parse(decision.arguments?.body);
 if(!object(body))return body??null;
 const raw=typeof body.raw==='string'?body.raw:object(body.message)?body.message.raw:undefined;
 if(typeof raw!=='string'||raw.length>1000000||!/^[A-Za-z0-9_+/-]*={0,2}$/.test(raw))return body;
 return{encodedBody:body,decodedRawText:Buffer.from(raw,'base64url').toString('utf8'),source:'supplied action body; decoded for display only'};
}

/** Independent reviews see actual observations, rather than earlier reviewer beliefs. */
export function automationReview(input:any,tracker?:ToolProgressTracker){
 if(!tracker||!Array.isArray(input.history)||!object(input.value))throw new BindingContractError('Automation review requires actual task-local evidence, a decision and history');
 const decision=input.value;
 const action=decision.valid!==false&&decision.done===false;
 const inspection=input.inspectMutations===true&&action?tracker.inspection({name:decision.tool,arguments:decision.arguments}):null;
 const evidence=tracker.evidence();
 const stateView=decision.done||input.stage==='completion-or-stall';
 // A past requested value is an Actor intention, not a user requirement. When
 // the actual resource has been read, verify that state against the original
 // task. Keep request/acknowledgment evidence for sends and uncovered fields.
 const actualExecution=stateView?{source:evidence.source,currentResources:evidence.currentResources,sourceObservations:evidence.sourceObservations,executedOperations:evidence.executedOperations,operationsWithoutResourceRead:evidence.operationsWithoutResourceRead}:evidence;
 return{...decision,requiresInspection:inspection!==null,inspection,review:{
  // A completion judgment concerns current effects, not superseded Actor plans.
  // Stall diagnosis still retains the actual trajectory; neither path inherits
  // previous reviewer opinions. The Actor keeps the entire execution history.
  history:stateView?[]:input.history.filter((m:any)=>m.metadata?.frameworkReviewFeedback!==true),
  context:{stage:decision.done?'proposed-completion':input.stage==='completion-or-stall'?'observed-stall':'proposed-action',targetSource:'actor-control-decision; execution is recorded separately',
   actualExecution,proposedAction:{done:decision.done,tool:decision.tool,arguments:decision.arguments},
   decodedPayloads:stateView?evidence.operationsWithoutResourceRead.map(observation=>({url:observation.request.arguments.url,payload:readablePayload(observation.request)})):evidence.effects.map(effect=>({url:effect.url,status:effect.status,payload:readablePayload({arguments:{body:JSON.stringify(effect.requestedFields)}})})),
   readablePayload:readablePayload(decision)},
 }};
}

export function automationReviewFeedback(input:any){
 if(!Array.isArray(input.history)||!object(input.value)||!object(input.value.assessment)||!Array.isArray(input.value.issues))throw new BindingContractError('Review feedback requires the actual native assessment, issues and prior history');
 // A contradictory passed flag must not override a concrete error from the same review.
 const passed=input.value.assessment.passed===true&&!input.value.issues.some((issue:any)=>issue.severity==='error');
 return{passed,rejections:passed?0:1,history:passed?input.history:[...input.history,{
  role:'user',content:JSON.stringify({source:'independent-framework-review',stage:input.stage,
   assessment:input.value.assessment,issues:input.value.issues}),metadata:{frameworkReviewFeedback:true},
 }]};
}
