import {isDeepStrictEqual} from 'node:util';

type Call={name:string;arguments:Record<string,any>};
const object=(v:any):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const parse=(value:any):any=>{if(typeof value!=='string')return value;try{return JSON.parse(value);}catch{return value;}};
/** A date-only request specifies calendar-day precision. Do not erase times or
 * offsets from a timestamp request, coerce numbers, or normalize arbitrary text. */
function sameRequestedValue(requested:unknown,observed:unknown):boolean{
 if(isDeepStrictEqual(requested,observed))return true;
 if(object(requested)&&object(observed))return Object.entries(requested).every(([key,value])=>Object.hasOwn(observed,key)&&sameRequestedValue(value,observed[key]));
 if(typeof requested==='string'&&typeof observed==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(requested))return observed===requested+'T00:00:00'||observed===requested+'T00:00:00Z'||observed===requested+'T00:00:00.000'||observed===requested+'T00:00:00.000Z';
 // Explicitly zoned ISO instants may serialize UTC as Z or +00:00. Compare
 // instants only at supported millisecond precision; never guess a local zone.
 const instant=(value:unknown)=>{
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value))return;
  const day=Date.parse(value.slice(0,10)+'T00:00:00Z');
  if(!Number.isFinite(day)||new Date(day).toISOString().slice(0,10)!==value.slice(0,10))return;
  const time=Date.parse(value);return Number.isFinite(time)?time:undefined;
 };
 const left=instant(requested),right=instant(observed);
 if(left!==undefined&&right!==undefined)return left===right;
 return false;
}
export interface EffectReceipt{method:string;url:string;resourceUrl?:string;requestedFields:Record<string,unknown>;status:'unverified'|'witnessed'|'conflicting';mismatchedFields?:string[];unobservedFields?:string[];}
export function createExecutionEvidence(){
 const receipts=new Map<string,EffectReceipt>(),mutationObservations=new Map<string,any>(),createdTargets=new Map<string,string>(),resourceViews=new Map<string,Record<string,unknown>>(),readObservations=new Map<string,any>(),recentObservations:any[]=[];let businessErrors=0,mutationCount=0,index=0,latestReadbackConflict=false;
 const reconcile=(receipt:EffectReceipt,content:Record<string,unknown>):EffectReceipt=>{
  const mismatched:string[]=[],unobserved:string[]=[];
  const compare=(requested:Record<string,unknown>,observed:Record<string,unknown>,prefix='')=>{for(const [key,value]of Object.entries(requested)){
   const path=prefix+key;
   if(!Object.hasOwn(observed,key))unobserved.push(path);
   else if(object(value)&&object(observed[key]))compare(value,observed[key],path+'.');
   else if(!sameRequestedValue(value,observed[key]))mismatched.push(path);
  }};
  compare(receipt.requestedFields,content);
  return{method:receipt.method,url:receipt.url,...(receipt.resourceUrl?{resourceUrl:receipt.resourceUrl}:{}),requestedFields:receipt.requestedFields,status:mismatched.length?'conflicting':unobserved.length?'unverified':'witnessed',...(mismatched.length?{mismatchedFields:mismatched}:{}),...(unobserved.length?{unobservedFields:unobserved}:{})};
 };
 const readback=(key:string,receipt:EffectReceipt,content:Record<string,unknown>)=>{
  const latestBody=parse(mutationObservations.get(key)?.request.arguments.body);
  // Route a new ignored write once; an older rejected intention must not make
  // every later, correctly applied write appear to have failed again.
  latestReadbackConflict||=reconcile({...receipt,requestedFields:object(latestBody)?latestBody:{}},content).status==='conflicting';
  return reconcile(receipt,content);
 };
 return{
  record(call:Call,result:any,businessError:boolean){
   index++;
   latestReadbackConflict=false;
   if(businessError)businessErrors++;
   if(call.name!=='api_fetch'||typeof call.arguments.url!=='string')return;
   const {url}=call.arguments,method=String(call.arguments.method).toUpperCase(),content=parse(result?.content??result?.message?.content);
   recentObservations.push({observationIndex:index,request:structuredClone(call),businessError,content:structuredClone(content??null)});
   if(method==='GET')readObservations.set(JSON.stringify([url,parse(call.arguments.params)??null]),recentObservations.at(-1));
   if(recentObservations.length>8)recentObservations.shift();
   if(businessError)return;
   if(['POST','PUT','PATCH','DELETE'].includes(method)){
    mutationCount++;
    const body=parse(call.arguments.body);
    // PATCH updates retain earlier fields; PUT replaces them. Separate POSTs can
    // create separate resources at the same collection URL and cannot overwrite receipts.
    const key=method==='POST'?`${url}#${index}`:url,previous=method==='PATCH'?receipts.get(key):undefined;
    mutationObservations.set(key,{observationIndex:index,request:structuredClone(call),transportStatus:result?.status??null,content:structuredClone(content??null)});
    const createdId=method==='POST'&&object(content)&&(typeof content.id==='string'||typeof content.id==='number')?String(content.id):undefined;
    if(createdId)createdTargets.set(key,url.replace(/\/$/,'')+'/'+encodeURIComponent(createdId));
    const receipt:EffectReceipt={method,url,requestedFields:{...previous?.requestedFields,...(object(body)?structuredClone(body):{})},status:'unverified'};
    resourceViews.delete(createdTargets.get(key)??url);
    const keys=Object.keys(receipt.requestedFields);
    receipts.set(key,object(content)&&keys.length&&keys.every(key=>Object.hasOwn(content,key))?reconcile(receipt,content):receipt);
   }else if(method==='GET'&&object(content)){
    resourceViews.set(url,structuredClone(content));
    for(const [key,receipt]of receipts)if((receipt.resourceUrl??createdTargets.get(key)??receipt.url)===url&&Object.keys(receipt.requestedFields).length){
     receipts.set(key,readback(key,{...receipt,...(createdTargets.has(key)?{resourceUrl:url}:{})},content));
    }
    // A supported read-only projection can expose fields omitted by a record's
    // display response. Bind it by the actual query's object type AND record ID.
    const base=/^(https?:\/\/[^/?#]+\/services\/data\/v\d+\.\d+)\/query$/.exec(url),params=parse(call.arguments.params);
    const query=typeof params?.q==='string'?/^SELECT Id(?:, [A-Za-z_][A-Za-z0-9_]*)* FROM ([A-Za-z_][A-Za-z0-9_]*) WHERE Id = '([A-Za-z0-9_-]+)'$/.exec(params.q):null;
    if(base&&query&&Array.isArray(content.records)){
     const resource=base[1]+'/sobjects/'+query[1]+'/'+query[2];
     const rows=content.records.filter((row:any)=>object(row)&&row.Id===query[2]);
     if(rows.length===1){
      const view={...resourceViews.get(resource),...rows[0]};resourceViews.set(resource,view);
      for(const [key,receipt]of receipts)if((receipt.resourceUrl??createdTargets.get(key)??receipt.url)===resource){
       receipts.set(key,readback(key,{...receipt,...(createdTargets.has(key)?{resourceUrl:resource}:{})},view));
      }
     }
    }
   }
  },
  snapshot(){
   const effects=[...receipts.values()];
   const written=new Set(effects.map(effect=>effect.resourceUrl??effect.url));
   const currentResources=[...resourceViews].filter(([url])=>written.has(url)).map(([url,content])=>({url,content}));
   const operationsWithoutResourceRead=[...receipts].filter(([,effect])=>!resourceViews.has(effect.resourceUrl??effect.url)||!!effect.unobservedFields?.length).map(([key])=>mutationObservations.get(key));
   const executedOperations=[...mutationObservations.values()].map(observation=>({observationIndex:observation.observationIndex,method:observation.request.arguments.method,url:observation.request.arguments.url,transportStatus:observation.transportStatus,acknowledgment:observation.content}));
   const sourceObservations=[...readObservations.values()].filter(observation=>{
    if(written.has(observation.request.arguments.url))return false;
    const base=/^(https?:\/\/[^/?#]+\/services\/data\/v\d+\.\d+)\/query$/.exec(observation.request.arguments.url),params=parse(observation.request.arguments.params);
    const type=typeof params?.q==='string'?/\bFROM\s+([A-Za-z_][A-Za-z0-9_]*)\b/i.exec(params.q)?.[1]:undefined;
    const rows=observation.content?.records;
    // An earlier query of the subsequently changed record is historical, not
    // the latest state. Its original bytes remain in the full public trace.
    return !(base&&type&&Array.isArray(rows)&&rows.length&&rows.every((row:any)=>object(row)&&typeof row.Id==='string'&&written.has(base[1]+'/sobjects/'+type+'/'+row.Id)));
   });
   return structuredClone({source:'actual-task-world-observations',businessErrors,mutationCount,effects,recentObservations,currentResources,sourceObservations,operationsWithoutResourceRead,executedOperations,latestReadbackConflict,reviewRecommended:businessErrors>0||mutationCount>0});
  },
 };
}
