import {defineWorker,type WorkerNodes} from '@codesoul-co/ditto/worker';
import {BindingContractError,ModelOutputFormatError} from '../graph-agent/bindings.js';

export const DATA_TRANSFORM_NODE='HOST.DATA.TRANSFORM';
/** Trusted data primitives absent from the official expression language. No Graph/Loop scheduling or executable candidate text. */
export function transformOfficialData(input:any):any{
 const value=input?.value;
 switch(input?.operation){
  case'json':return JSON.stringify(value);
  case'text':return typeof value==='string'?value:JSON.stringify(value);
  case'parse':{
   if(typeof value!=='string')throw new BindingContractError('HOST.DATA.TRANSFORM parse requires string value');
   try{return JSON.parse(value);}catch{
    if(input.sourceKind==='model-json')throw new ModelOutputFormatError('Model did not produce its declared JSON artifact');
    throw new BindingContractError('HOST.DATA.TRANSFORM parse received invalid non-model JSON');
   }
  }
  case'decision':{
   let d:any;try{d=JSON.parse(value);}catch{throw new ModelOutputFormatError('Task-world decision must be strict JSON');}
   if(!d||typeof d!=='object'||typeof d.done!=='boolean'||typeof d.tool!=='string'||!d.arguments||typeof d.arguments!=='object'||Array.isArray(d.arguments))throw new ModelOutputFormatError('Decision requires done:boolean, tool:string and arguments:object');
   if(d.done&&d.tool!==''||!d.done&&(!Array.isArray(input.allowedTools)||!input.allowedTools.includes(d.tool)))throw new ModelOutputFormatError('Decision tool is not a permitted official tool (empty when done)');
   return{done:d.done,tool:d.tool,arguments:d.arguments,finalAnswer:typeof d.finalAnswer==='string'?d.finalAnswer:'End of declared agent execution.'};
  }
  case'concat':if(!Array.isArray(value)||value.some(v=>v!==null&&typeof v==='object'))throw new BindingContractError('Text concat requires scalar array');return value.map(v=>v==null?'':String(v)).join('');
  case'memory-ids':{const records=Array.isArray(value)?value:value?.items;if(!Array.isArray(records))throw new BindingContractError('Memory ID projection requires records');return records.map((v:any)=>v.id??v.memory?.id);}
  case'coalesce':if(!Array.isArray(value))throw new BindingContractError('Coalesce requires array');return value.find(v=>v!==null&&v!==undefined)??null;
  case'evidence':return `Evidence supplied by declared upstream nodes (source labels identify origin, not correctness):\nSource: ${JSON.stringify(input.provenance??[])}\nValue:\n${JSON.stringify(value)}`;
  default:throw new BindingContractError('Unknown HOST.DATA.TRANSFORM operation');
 }
}
export function createOfficialDataWorker(){return defineWorker({type:'host-data',nodes:{[DATA_TRANSFORM_NODE]:async(input:unknown)=>transformOfficialData(input)} as WorkerNodes});}
