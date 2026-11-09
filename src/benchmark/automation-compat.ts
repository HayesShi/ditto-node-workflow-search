/** Explicit environment repair, separate from workflow/framework improvements. */
export const HUBSPOT_CATALOG_COMPAT='hubspot-association-catalog-v1' as const;
export type AutomationCompatibility='off'|typeof HUBSPOT_CATALOG_COMPAT;
export function automationCompatibility(value=process.env.DITTO_AUTOMATION_COMPAT??'off'):AutomationCompatibility{
 if(value!=='off'&&value!==HUBSPOT_CATALOG_COMPAT)throw Error('Unknown DITTO_AUTOMATION_COMPAT mode');
 return value;
}
const documented='https://api.hubapi.com/crm/v3/objects/deals/{dealId}/associations/contact/{contactId}/{associationType}';
const implemented=documented.replace('/associations/contact/','/associations/contacts/');

/** Repair the public catalog, never rewrite an executed action or fabricate success. */
export function compatibleAutomationCatalog(content:string,mode:AutomationCompatibility){
 const corrections:{endpointId:string;originalUrl:string;correctedUrl:string}[]=[];
 if(mode==='off')return{content,corrections};
 let catalog:any;try{catalog=JSON.parse(content);}catch{return{content,corrections};}
 if(!catalog||!Array.isArray(catalog.results))return{content,corrections};
 for(const entry of catalog.results){
  if(entry?.id!=='hubspot.crm.deals.contacts.add'||entry.method!=='PUT'||entry.url!==documented)continue;
  corrections.push({endpointId:entry.id,originalUrl:entry.url,correctedUrl:implemented});
  entry.url=implemented;
 }
 return{content:corrections.length?JSON.stringify(catalog):content,corrections};
}
