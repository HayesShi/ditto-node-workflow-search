import {isDeepStrictEqual} from 'node:util';

type Call={name:string;arguments:Record<string,any>};
const object=(v:any):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const parse=(value:any):any=>{if(typeof value!=='string')return value;try{return JSON.parse(value);}catch{return value;}};
/** A date-only request specifies calendar-day precision. Do not erase times or
 * offsets from a timestamp request, coerce numbers, or normalize arbitrary text. */
function sameRequestedValue(requested:unknown,observed:unknown):boolean{
 if(isDeepStrictEqual(requested,observed))return true;
 if(typeof requested==='string'&&typeof observed==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(requested))return observed===requested+'T00:00:00'||observed===requested+'T00:00:00Z'||observed===requested+'T00:00:00.000'||observed===requested+'T00:00:00.000Z';
 return false;
}
export interface EffectReceipt{method:string;url:string;requestedFields:Record<string,unknown>;status:'unverified'|'witnessed'|'conflicting';mismatchedFields?:string[];}
export function createExecutionEvidence(){
 const receipts=new Map<string,EffectReceipt>();let businessErrors=0;
 return{
  record(call:Call,result:any,businessError:boolean){
   if(businessError){businessErrors++;return;}
   if(call.name!=='api_fetch'||typeof call.arguments.url!=='string')return;
   const {url}=call.arguments,method=String(call.arguments.method).toUpperCase(),content=parse(result?.content??result?.message?.content);
   if(['POST','PUT','PATCH','DELETE'].includes(method)&&object(content)&&!Object.keys(content).length){
    const body=parse(call.arguments.body);
    receipts.set(url,{method,url,requestedFields:object(body)?structuredClone(body):{},status:'unverified'});
   }else if(method==='GET'&&object(content)&&receipts.has(url)){
    const receipt=receipts.get(url)!;
    const mismatched=Object.entries(receipt.requestedFields).filter(([key,value])=>!sameRequestedValue(value,content[key])).map(([key])=>key);
    if(Object.keys(receipt.requestedFields).length)receipts.set(url,{...receipt,status:mismatched.length?'conflicting':'witnessed',...(mismatched.length?{mismatchedFields:mismatched}:{})});
   }
  },
  snapshot(){
   const effects=[...receipts.values()];
   return structuredClone({source:'actual-task-world-observations',businessErrors,effects,reviewRecommended:businessErrors>0||effects.some(e=>e.status!=='witnessed')});
  },
 };
}
