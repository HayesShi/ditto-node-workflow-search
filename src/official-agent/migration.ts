import type {AgentDefinition,AgentNode} from '@codesoul-co/ditto/runtime';
import {validateDefinition,topologicalNodes,type GraphDefinition,type Source,DefinitionError} from '../graph-agent/schema.js';
import {validateOfficialDefinition} from './schema.js';
import {DATA_TRANSFORM_NODE} from './helpers.js';

/** Explicit single-pass legacy import. Unsupported control is diagnosed, never silently approximated. */
export function migrateLegacyDefinition(source:unknown):{definition:AgentDefinition;toolArtifacts:GraphDefinition['tools'];migration:{sourceProtocol:string;semanticChanges:string[]}}{
 const old=validateDefinition(source);
 if(old.graphs.length!==1||old.loop.transitions[old.graphs[0]!.id]?.kind!=='end'||Object.keys(old.loop.stateUpdates??{}).length)throw new DefinitionError('Automatic migration supports single-pass Graphs only; explicitly port Loop state/control before execution','/loop');
 const originals=new Map(old.graphs[0]!.nodes.map(n=>[n.id,n])),nodes:AgentNode[]=[];let serial=0;
 const rawPath=(id:string,path:(string|number)[])=>{const type=originals.get(id)?.type;if(!type)throw new DefinitionError('Unknown legacy producer','/graphs');return['nodes',id,...(type.startsWith('INFER.')||type.startsWith('MEMORY.')?['output']:[]),...path].join('.');};
 const dependencies=(v:any):string[]=>{if(!v||typeof v!=='object')return[];if(v.$literal!==undefined)return[];if(typeof v.$ref==='string'&&v.$ref.startsWith('nodes.'))return[v.$ref.split('.')[1]];return [...new Set(Object.values(v).flatMap(dependencies))];};
 const primitive=(operation:string,value:any,sourceKind?:string)=>{const id=`transform-${++serial}`;nodes.push({id,type:DATA_TRANSFORM_NODE,dependsOn:dependencies(value),input:{operation,value,...(sourceKind?{sourceKind}:{})}});return{$ref:`nodes.${id}`};};
 const binding=(s:any):any=>{
  if(s===null||typeof s!=='object')return s;if(Array.isArray(s))return s.map(binding);
  if(s.from){
   if(s.from==='literal')return{$literal:s.value};
   if(s.from==='task'){if(s.extract)throw new DefinitionError('Legacy numeric extraction needs an explicit registered helper','/binding');return{$ref:`input.task.${s.field}`};}
   if(s.from==='join')return primitive('concat',s.parts.flatMap((p:any,i:number)=>i?[s.separator,binding(p)]:[binding(p)]));
   if(s.from==='previous')throw new DefinitionError('Previous bindings require explicit Loop migration','/binding');
   const type=originals.get(s.nodeId)?.type,root={$ref:rawPath(s.nodeId,[])};
   if(s.view==='memory-ids')return primitive('memory-ids',root);
   if(s.view==='answer')return{$ref:rawPath(s.nodeId,type==='INFER.REASONING.SAMPLE'?['message','content']:type==='INFER.REASONING.REFLECT'?['revisedResult','content']:['result','content'])};
   if(s.view==='context')return{$ref:rawPath(s.nodeId,type==='CONTEXT.SELECT'?['context']:[])};
   if(s.view==='evidence'&&type?.startsWith('CONTEXT.'))return{$ref:rawPath(s.nodeId,type==='CONTEXT.SELECT'?['context','items']:['items'])};
   return root;
  }
  if(Object.hasOwn(s,'literal'))return{$literal:s.literal};
  if(s.ref){const [space,id,...path]=s.ref;if(space==='task')return{$ref:`input.task.${id}${path.length?'.'+path.join('.'):''}`};if(space!=='nodes')throw new DefinitionError('State/prior binding needs explicit control migration','/binding');return{$ref:rawPath(id,path)};}
  if(s.json!==undefined)return primitive('json',binding(s.json));
  if(s.parse!==undefined){const b=binding(s.parse);return primitive('parse',b,s.parse?.ref&&originals.get(s.parse.ref[1])?.config.outputFormat==='json'?'model-json':undefined);}
  if(s.concat)return primitive('concat',s.concat.map(binding));
  if(s.coalesce){const parts=s.coalesce.map(binding).map((b:any)=>b?.$ref?{...b,default:null}:b);return primitive('coalesce',parts);}
  if(s.append)return{$op:'append',args:s.append.map(binding)};
  if(s.get){let b=binding(s.get.value);for(const key of s.get.path)b={$op:'at',args:[b,key]};return b;}
  return Object.fromEntries(Object.entries(s).map(([key,value])=>[key,binding(value)]));
 };
 for(const n of topologicalNodes(old.graphs[0]!)){
  const c=n.config;let input:any;
  if(n.type==='CONTEXT.LOAD')input={sources:c.sources.map((s:Source)=>({role:'user',content:binding(s)}))};
  else if(['CONTEXT.SELECT','CONTEXT.UPDATE','CONTEXT.COMPRESS'].includes(n.type))input={context:binding(c.context),...(n.type==='CONTEXT.SELECT'?{purpose:'infer',strategy:{kind:'default'}}:{}),...(c.query!==undefined?{query:binding(c.query)}:{}),...(c.limit?{limit:c.limit}:{}),...(c.maxTokens?{maxTokens:c.maxTokens}:{}),...(c.maxItems?{maxItems:c.maxItems}:{}),...(c.add!==undefined?{add:[{id:`${n.id}-added`,content:binding(c.add)}]}:{}),...(c.removeIds?{removeIds:c.removeIds}:{})};
  else if(n.type==='MEMORY.WRITE')input={memories:[{key:n.id,content:binding(c.content)}]};
  else if(n.type==='MEMORY.GET'||n.type==='MEMORY.DELETE')input={ids:binding(c.ids)};
  else if(n.type==='MEMORY.SEARCH')input={query:binding(c.query),limit:c.limit??3};
  else if(n.type==='MEMORY.QUERY')input={filter:c.filter??{},limit:c.limit??3};
  else if(n.type==='INTERACTION.ACT.TOOL')input={call:{id:`${n.id}-call`,name:c.tool,arguments:binding(c.arguments)}};
  else if(n.type==='INTERACTION.OBSERVE')input={result:binding(c.result)};
  else if(n.type==='RETRIEVAL.SEARCH')input={query:{content:binding(c.query)},target:{name:'task-public'},limit:c.limit??5};
  else if(n.type==='INFER.REASONING.SAMPLE'){
   const messages:any[]=[...(c.instruction?[{role:'user',content:c.instruction}]:[]),...(c.user!==undefined?[{role:'user',content:binding(c.user)}]:[])];
   if(c.evidence?.length)messages.push({role:'user',content:primitive('evidence',c.evidence.map(binding))});
   if(c.outputFormat==='json')messages.push({role:'user',content:'Declared node artifact: return strict JSON only.'});
   input={model:{$ref:'input.host.model'},generation:{$ref:'input.host.generation'},messages:{$op:'concat',args:[{$ref:'input.host.messages'},messages]}};
  }else throw new DefinitionError(`Explicit native port required for legacy ${n.type}`,'/graphs');
  nodes.push({id:n.id,type:n.type,dependsOn:[...new Set([...n.dependencies,...dependencies(input)])],input});
 }
 const answer=old.output.answer!==undefined?binding(old.output.answer):binding({from:'node',nodeId:old.output.nodeId,view:'answer'});
 const definition:AgentDefinition={version:1,id:'migrated-ditto-agent',graphs:{main:{nodes,output:answer}}};
 return{definition:validateOfficialDefinition(definition,old.tools),toolArtifacts:old.tools,migration:{sourceProtocol:'legacy-version-'+old.version,semanticChanges:['Official native input/result bindings; immutable host task/system presentation. Revalidate quality under this new runtime identity.']}};
}
