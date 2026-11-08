import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {parseOfficialProposal} from '../dist/official-agent/search.js';
import {validateOfficialDefinition,validateOfficialChange,validateOfficialExploration} from '../dist/official-agent/schema.js';

const root=resolve(process.argv[2]??'../output/three-candidate-search-20261107');
const output=resolve(process.argv[3]??'../output/proposal-contract-repair-20261107/replay.json');
const report={modelCalls:0,toolCalls:0,privateJudgeCalls:0,rows:[]};
for(const dataset of ['drop','humaneval','mbpp','automationbench']){
 const state=JSON.parse(await readFile(join(root,dataset,'search-state.json'),'utf8'));
 for(const attempt of state.history){
  if(!attempt.parentId){validateOfficialDefinition(attempt.definition);continue;}
  let rejection;
  let definitionRejection;
  if(attempt.definition){try{validateOfficialDefinition(attempt.definition,attempt.toolArtifacts);}catch(error){definitionRejection={path:error.path??'definition',message:error.message};}}
  try{
   const parsed=parseOfficialProposal(attempt.rawResponse);
   const parent=state.history.find(row=>row.id===attempt.parentId);
   validateOfficialChange(parent.definition,parsed.definition,parsed.mutation,parent.toolArtifacts,parsed.toolArtifacts);
   if(attempt.explorationDirection)validateOfficialExploration(parent.definition,parsed.definition,attempt.explorationDirection);
  }catch(error){rejection={path:error.path??'proposal',message:error.message,repairHint:error.repairHint??error.issue?.repairHint};}
  const expectedRejection=['invalid-proposal','invalid-evaluation'].includes(attempt.status);
  const expectationMet=attempt.status==='valid'?!definitionRejection:attempt.status==='invalid-evaluation'?!!definitionRejection:!!rejection;
  report.rows.push({dataset,id:attempt.id,oldStatus:attempt.status,rejectedBeforeExecution:expectedRejection&&!!rejection,executionDefinitionPreserved:attempt.status==='valid'&&!definitionRejection,expectationMet,...(rejection?{rejection}:{}),...(definitionRejection?{definitionRejection}:{})});
 }
}
report.passed=report.rows.every(row=>row.expectationMet);
await mkdir(resolve(output,'..'),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({passed:report.passed,attempts:report.rows.length,invalidRejected:report.rows.filter(r=>r.rejectedBeforeExecution).length,validDefinitionsPreserved:report.rows.filter(r=>r.executionDefinitionPreserved).length,modelCalls:0,output}));
if(!report.passed)process.exitCode=1;
