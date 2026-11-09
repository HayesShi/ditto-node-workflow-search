import {createHash} from 'node:crypto';
import {BindingContractError} from '../graph-agent/bindings.js';
import {createExecutionEvidence} from './execution-evidence.js';

export const TOOL_PROGRESS_VERSION='actual-tool-progress-v2';
type Call={name:string;arguments:Record<string,unknown>};
const object=(v:any):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const stable=(v:any):string=>JSON.stringify(v,(_k,item)=>object(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const hash=(v:unknown)=>createHash('sha256').update(stable(v)).digest('hex');

/** Equivalence is for counting only. Actual tool arguments are never rewritten. */
function requestIdentity(call:Call){
 const args=structuredClone(call.arguments);
 if(call.name==='api_fetch')for(const key of ['params','body']){
  if(args[key]===null||args[key]===undefined){args[key]=null;continue;}
  if(typeof args[key]==='string')try{const value=JSON.parse(args[key]);args[key]=object(value)&&Object.keys(value).length===0?null:value;}catch{/* malformed JSON stays exact */}
 }
 return{name:call.name,arguments:args};
}
function publicError(result:any):unknown{
 if(result?.status!=='success')return{status:result?.status??'unknown',error:result?.error??null};
 let body=result?.content??result?.message?.content;
 if(typeof body==='string')try{body=JSON.parse(body);}catch{return null;}
 if(!object(body))return null;
 if(body.error!==undefined&&body.error!==null&&body.error!==false&&body.error!=='')return{error:body.error};
 if(body.ok===false||body.success===false||Number(body.status_code)>=400||Number(body.status)>=400||['error','failed'].includes(body.status))return body;
 return null;
}
export interface ToolProgress {
 readonly version:typeof TOOL_PROGRESS_VERSION;readonly observationIndex:number;readonly groupId:string;
 readonly businessError:boolean;readonly consecutiveEquivalentFailures:number;
 readonly consecutiveUnchangedObservations:number;
 readonly requestComparison:'same-request-except-empty-optional-arguments';
}
export interface ToolProgressTracker {
 record(call:Call,result:unknown):void;
 latest(call:Call):ToolProgress;
 evidence():ReturnType<ReturnType<typeof createExecutionEvidence>['snapshot']>;
}
/** Created by the host once per task. Reading/forging candidate history cannot increment it. */
export function createToolProgressTracker():ToolProgressTracker{
 let sequence=0,previous:ToolProgress|undefined,lastCallHash:string|undefined;
 const evidence=createExecutionEvidence(),seenObservations=new Set<string>();
 return{
  record(call,result){
   const failure=publicError(result),groupId=hash([requestIdentity(call),failure]);
   // Include the actual returned data, excluding the per-call transport ID.
   // Repeated successful GETs can stall just as repeated errors can. Counting
   // across interleaved requests also detects A/B/A/B loops without changing or
   // suppressing any tool execution. A genuinely new observation resets it.
   const native=result as any;
   let content=native?.content??native?.message?.content;
   if(typeof content==='string')try{content=JSON.parse(content);}catch{/* preserve non-JSON observations */}
   const observationKey=hash([requestIdentity(call),native?.status??'unknown',content??null,native?.error??null]);
   const consecutiveUnchangedObservations=seenObservations.has(observationKey)?(previous?.consecutiveUnchangedObservations??0)+1:0;
   seenObservations.add(observationKey);
   evidence.record(call,result,failure!==null);
   previous={version:TOOL_PROGRESS_VERSION,observationIndex:++sequence,groupId,businessError:failure!==null,
    consecutiveEquivalentFailures:failure===null?0:previous?.businessError&&previous.groupId===groupId?previous.consecutiveEquivalentFailures+1:1,
    consecutiveUnchangedObservations,
    requestComparison:'same-request-except-empty-optional-arguments'};
   lastCallHash=hash({name:call.name,arguments:call.arguments});
  },
  latest(call){
   if(!previous||hash({name:call.name,arguments:call.arguments})!==lastCallHash)throw new BindingContractError('Progress history must reference the latest actually executed official tool and its exact arguments');
   return structuredClone(previous);
  },
  evidence:()=>evidence.snapshot(),
 };
}

/** Successful observations keep the baseline message bytes; counters live in host state. */
export function layeredHistory(input:any,tracker:ToolProgressTracker|undefined){
 const result=progressHistory(input,tracker);
 result.progress.stalled ||= result.progress.consecutiveUnchangedObservations>=(input.progressThreshold??2);
 if(!result.progress.businessError)result.history[result.history.length-1]={role:'user',content:input.evidence};
 return{...result,evidence:tracker!.evidence()};
}

export function progressHistory(input:any,tracker:ToolProgressTracker|undefined){
 if(!tracker)throw new BindingContractError('Progress observation requires a task-local host execution tracker');
 const threshold=input.progressThreshold??2;
 if(!Number.isSafeInteger(threshold)||threshold<2||threshold>10)throw new BindingContractError('Progress threshold must be an integer from 2 through 10');
 if(input.compactRepeatedFailures!==undefined&&typeof input.compactRepeatedFailures!=='boolean')throw new BindingContractError('compactRepeatedFailures must be boolean');
 const decision={done:false,tool:input.decision.tool,arguments:structuredClone(input.decision.arguments)};
 const recorded=tracker.latest({name:decision.tool,arguments:decision.arguments});
 const progress={...recorded,stalled:recorded.consecutiveEquivalentFailures>=threshold};
 let history=input.history;
 const prior=history.at(-1)?.metadata?.frameworkProgress;
 // Keep the actual last action/result plus an authoritative execution count.
 // Complete, uncompressed action traces remain in executor/benchmark artifacts.
 if(input.compactRepeatedFailures!==false&&progress.businessError&&prior?.groupId===progress.groupId&&prior.observationIndex===progress.observationIndex-1&&history.at(-2)?.metadata?.toolExecutedDecision===true)history=history.slice(0,-2);
 return{complete:false,progress,history:[...history,
  {role:'assistant',content:JSON.stringify(decision),metadata:{toolExecutedDecision:true}},
  {role:'user',content:input.evidence+'\nFramework execution observation (counts actual calls; not a task-completion judgment):\n'+JSON.stringify(progress),metadata:{frameworkProgress:progress}},
 ]};
}
