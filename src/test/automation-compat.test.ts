import assert from 'node:assert/strict';
import test from 'node:test';
import {automationCompatibility,compatibleAutomationCatalog,HUBSPOT_CATALOG_COMPAT} from '../benchmark/automation-compat.js';
import {OfficialAutomationSession} from '../benchmark/automation.js';
const url='https://api.hubapi.com/crm/v3/objects/deals/{dealId}/associations/contact/{contactId}/{associationType}';
const content=JSON.stringify({results:[{id:'hubspot.crm.deals.contacts.add',method:'PUT',url,parameters:{dealId:{location:'path'},contactId:{location:'path'}},description:'Link a contact to a deal.'},{id:'unrelated',method:'PUT',url}]});
test('catalog compatibility is explicit and the standard environment remains unchanged',()=>{
 assert.equal(automationCompatibility('off'),'off');assert.throws(()=>automationCompatibility('unknown'));
 assert.deepEqual(compatibleAutomationCatalog(content,'off'),{content,corrections:[]});
});

test('task-world bridge presents the corrected catalog, retains the original and dispatches the chosen URL unchanged',async()=>{
 const before=process.env.DITTO_AUTOMATION_COMPAT;process.env.DITTO_AUTOMATION_COMPAT=HUBSPOT_CATALOG_COMPAT;
 const calls:any[]=[];
 try{
  const bridge:any={assertHealthy(){},async request(input:any){calls.push(structuredClone(input));return{content:input.name==='api_search'?content:JSON.stringify({associated:true})};}};
  const session=new OfficialAutomationSession(bridge,'fixture','public-fixture','contract',[]);
  const catalog=await session.call('api_search',{query:'associate contact with deal'});
  const corrected=JSON.parse(catalog.content).results[0].url.replace('{dealId}','deal').replace('{contactId}','contact').replace('{associationType}','3');
  const args={method:'PUT',url:corrected,params:null,body:null};
  const result=await session.call('api_fetch',args);
  assert.equal(JSON.parse(result.content).associated,true);assert.deepEqual(calls.at(-1).arguments,args);
  const event:any=session.trace.find(e=>e.type==='public-api-contract-correction');
  assert.equal(event.originalContent,content);assert.equal(event.corrections[0].originalUrl,url);
 }finally{if(before===undefined)delete process.env.DITTO_AUTOMATION_COMPAT;else process.env.DITTO_AUTOMATION_COMPAT=before;}
});
test('catalog correction fixes only the witnessed endpoint and preserves the complete public contract',()=>{
 const fixed=compatibleAutomationCatalog(content,HUBSPOT_CATALOG_COMPAT),parsed=JSON.parse(fixed.content),original=JSON.parse(content);
 assert.equal(fixed.corrections.length,1);assert.equal(parsed.results[0].url,url.replace('/contact/','/contacts/'));
 assert.deepEqual({...parsed.results[0],url},original.results[0]);assert.deepEqual(parsed.results[1],original.results[1]);
 assert.deepEqual(compatibleAutomationCatalog(fixed.content,HUBSPOT_CATALOG_COMPAT),{content:fixed.content,corrections:[]});
 for(const value of ['not JSON','{}','null'])assert.deepEqual(compatibleAutomationCatalog(value,HUBSPOT_CATALOG_COMPAT),{content:value,corrections:[]});
});
