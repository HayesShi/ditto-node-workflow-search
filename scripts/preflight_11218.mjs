import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {parseOfficialProposal} from '../dist/official-agent/search.js';
import {validateOfficialDefinition,validateOfficialChange,validateOfficialExploration,officialMutationDiff,OFFICIAL_MUTATION_LIMITS} from '../dist/official-agent/schema.js';

const output=resolve(process.argv[2]??'../output/11218');
const source=resolve('../output/drop-automation-formal-20261112/drop/search/search-state.json');
const state=JSON.parse(await readFile(source,'utf8'));
const report={at:new Date().toISOString(),modelCalls:0,judgeCalls:0,oldExperimentUntouched:true,mutationPolicy:OFFICIAL_MUTATION_LIMITS,directionResourcePolicy:'shared-global-budget-no-direction-caps-v1',rows:[]};
for(const item of state.history){
 if(!item.definition)continue;
 const row={id:item.id,oldStatus:item.status};
 try{validateOfficialDefinition(item.definition,item.toolArtifacts);row.definitionValid=true;}catch(error){row.definitionError=error.issue??error.message;}
 if(item.parentId){
  const parent=state.history.find(p=>p.id===item.parentId);
  row.diff=officialMutationDiff(parent.definition,item.definition);
  try{
   const proposal=item.rawResponse?parseOfficialProposal(item.rawResponse):item;
   validateOfficialChange(parent.definition,proposal.definition,proposal.mutation,parent.toolArtifacts,proposal.toolArtifacts);
   if(item.explorationDirection)validateOfficialExploration(parent.definition,proposal.definition,item.explorationDirection);
   row.newPreflight='accepted';
  }catch(error){row.newPreflight='rejected';row.diagnostic=error.issue??{message:error.message};}
 }
 report.rows.push(row);
}
report.oldMeasuredDefinitionsPreserved=report.rows.filter(r=>r.oldStatus==='valid').every(r=>r.definitionValid===true);
for(const file of ['src/official-agent/runner.ts','src/unified/runner.ts']){
 const text=await readFile(file,'utf8');
 if(text.includes('createDirectionBudget')||text.includes('directionBudget?.'))throw Error('Independent direction budget still wired: '+file);
}
report.summary={definitions:report.rows.length,accepted:report.rows.filter(r=>r.newPreflight==='accepted').length,rejected:report.rows.filter(r=>r.newPreflight==='rejected').length};
if(!report.oldMeasuredDefinitionsPreserved)throw Error('Previously measured definition no longer executes under the native definition protocol');
await mkdir(output,{recursive:true});await writeFile(output+'/preflight.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({passed:true,...report.summary,oldMeasuredDefinitionsPreserved:true,modelCalls:0,output}));
