type Call={name:string;arguments:Record<string,any>};
const parse=(v:any):any=>{if(typeof v!=='string')return v;try{return JSON.parse(v);}catch{return v;}};
const object=(v:any):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);

/** Read-only prerequisites are derived from the proposed resource, never task names or labels. */
function target(call:Call){
 if(call.name!=='api_fetch'||typeof call.arguments.url!=='string')return;
 const method=String(call.arguments.method).toUpperCase(),body=parse(call.arguments.body);
 let url:URL;try{url=new URL(call.arguments.url);}catch{return;}
 if(['POST','PUT','PATCH'].includes(method)&&object(body)&&Array.isArray(body.values)&&body.values.every(Array.isArray)&&url.pathname.includes('/values/')){
  const prefix=url.pathname.slice(0,url.pathname.indexOf('/values/')+8),range=decodeURIComponent(url.pathname.slice(prefix.length)).replace(/:append$/,'');
  if(!range.includes('!'))return;
  const sheet=range.slice(0,range.lastIndexOf('!'));
  const readUrl=url.origin+prefix+sheet+'!A1:ZZ1';
  return{key:'layout:'+url.origin+prefix+sheet,url:readUrl,query:'sheets values get fetch range'};
 }
 if(['PATCH','PUT'].includes(method)){
  // Parameterized or command-style endpoints are not assumed to be resource reads.
  if(url.search||url.hash||url.pathname.includes(':')||/\/(?:send|batchUpdate|search|query)$/.test(url.pathname))return;
  const service=url.hostname.split('.').at(-2)??'',parts=url.pathname.split('/').filter(Boolean);
  return{key:'resource:'+url.href,url:call.arguments.url,query:[service,'get fetch record',...parts.slice(-2,-1)].join(' ')};
 }
}

function matches(template:string,url:string){
 const expression=template.split(/(\{[A-Za-z_][A-Za-z0-9_]*\})/).map(part=>/^\{/.test(part)?'[^/?#]+':part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('');
 return new RegExp('^'+expression+'$').test(url);
}

export function createMutationInspector(){
 const contracts=new Map<string,any>(),searched=new Set<string>(),attemptedReads=new Set<string>(),observedResources=new Set<string>(),readbacks=new Map<string,any>(),writtenFields=new Map<string,string[]>();
 const supports=(url:string)=>[...contracts.values()].some(endpoint=>matches(endpoint.url,url)&&!Object.values(endpoint.parameters??{}).some((parameter:any)=>parameter?.required===true&&parameter.location==='query'));
 const read=(url:string)=>({done:false,tool:'api_fetch',arguments:{method:'GET',url,params:null,body:null}});
 const projection=(resource:string,requestedFields:string[])=>{
  const record=/^(https?:\/\/[^/?#]+\/services\/data\/v\d+\.\d+)\/sobjects\/([A-Za-z_][A-Za-z0-9_]*)\/([A-Za-z0-9_-]+)$/.exec(resource);
  if(!record)return;
  const queryUrl=record[1]+'/query',contract=contracts.get(queryUrl);
  const fields=requestedFields.filter(field=>field!=='Id'&&/^[A-Za-z_][A-Za-z0-9_]*$/.test(field));
  if(!fields.length||!contract?.parameters?.q||contract.parameters.q.location!=='query')return;
  return{done:false,tool:'api_fetch',arguments:{method:'GET',url:queryUrl,params:JSON.stringify({q:`SELECT Id, ${fields.join(', ')} FROM ${record[2]} WHERE Id = '${record[3]}'`}),body:null}};
 };
 return{
  record(call:Call,result:any,businessError:boolean){
   const content=parse(result?.content??result?.message?.content);
   if(call.name==='api_search'){
    if(typeof call.arguments.query==='string')searched.add(call.arguments.query);
    if(!businessError&&Array.isArray(content?.results))for(const endpoint of content.results){
     if(endpoint?.method==='GET'&&typeof endpoint.url==='string')contracts.set(endpoint.url,endpoint);
    }
   }
   if(call.name==='api_fetch'&&String(call.arguments.method).toUpperCase()==='GET'&&typeof call.arguments.url==='string'){
    for(const [resource,pending]of readbacks)if(call.arguments.url===pending.arguments.url&&(call.arguments.params??null)===(pending.arguments.params??null)){
     readbacks.delete(resource);
     // Preserve the complete resource view (including relationships), then
     // supplement only fields omitted by that view with a public projection.
     if(call.arguments.url===resource){
      const missing=(writtenFields.get(resource)??[]).filter(field=>!object(content)||!Object.hasOwn(content,field));
      const supplement=projection(resource,missing);if(supplement)readbacks.set(resource,supplement);
     }
    }
    attemptedReads.add(call.arguments.url);
    if(!businessError){
     observedResources.add('resource:'+call.arguments.url);
     if(object(content)&&Array.isArray(content.values)&&Array.isArray(content.values[0])&&typeof content.range==='string'&&/!A1(?::[A-Z]+\d*)?$/.test(content.range)){
      const url=new URL(call.arguments.url),prefix=url.pathname.slice(0,url.pathname.indexOf('/values/')+8),range=decodeURIComponent(content.range);
      if(url.pathname.includes('/values/'))observedResources.add('layout:'+url.origin+prefix+range.slice(0,range.lastIndexOf('!')));
     }
    }
   }
   if(!businessError&&call.name==='api_fetch'&&typeof call.arguments.url==='string'){
    const method=String(call.arguments.method).toUpperCase();
    const createdId=method==='POST'&&object(content)&&(typeof content.id==='string'||typeof content.id==='number')?String(content.id):undefined;
    const resource=createdId?call.arguments.url.replace(/\/$/,'')+'/'+encodeURIComponent(createdId):call.arguments.url;
    if(['PATCH','PUT'].includes(method)||createdId&&supports(resource)){
     const fields=Object.keys(parse(call.arguments.body)??{}),prior=method==='PATCH'?writtenFields.get(resource)??[]:[];
     writtenFields.set(resource,[...new Set([...prior,...fields])]);
     const request=supports(resource)?read(resource):projection(resource,writtenFields.get(resource)!);
     if(request)readbacks.set(resource,request);
    }
   }
  },
  next(call:Call){
   const wanted=target(call);
   if(!wanted||observedResources.has(wanted.key)||attemptedReads.has(wanted.url))return null;
   if(supports(wanted.url))return read(wanted.url);
   if(!searched.has(wanted.query))return{done:false,tool:'api_search',arguments:{query:wanted.query,top_k:10}};
   return null; // No public GET contract: do not invent or dispatch a read endpoint.
  },
  followup(){return readbacks.values().next().value??null;},
 };
}
