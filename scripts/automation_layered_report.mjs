import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
const root=resolve(process.argv[2]??'runs/automation-layered-20261109/comparison');
// A later controller can be compared to the retained one-pass baseline without
// paying to execute that same baseline again. Its actual identity stays visible.
const baselineDirectory=resolve(process.argv[3]??join(root,'baseline-fixed'));
const read=async p=>{try{return JSON.parse(await readFile(p,'utf8'));}catch(e){if(e.code==='ENOENT')return undefined;throw e;}};
const lines=async p=>{try{return(await readFile(p,'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);}catch(e){if(e.code==='ENOENT')return[];throw e;}};
const parse=x=>{try{return JSON.parse(x);}catch{return x;}};
const arms={};
for(const name of ['baseline-fixed','layered']){
 const directory=name==='baseline-fixed'?baselineDirectory:join(root,name),checkpoint=await read(join(directory,'evaluations',name,'checkpoint.json'));
 const manifest=await read(join(directory,'manifest.json'));
 const tasks=new Map((await read(join(directory,'tasks-public.json'))??[]).map(t=>[t.id,t]));
 const rows=[...new Map((checkpoint?.cases??[]).map(r=>[r.caseId,r])).values()];
 const traces=new Map((await lines(join(directory,'evaluations',name,'public-traces.jsonl'))).map(t=>[t.taskId,t]));
 const cases=rows.map(row=>{
  const taskId=row.caseId.replace(/#[1-9]\d*$/,'');const run=traces.get(taskId);let pending;
  const actions=[],reviews=[],protocols=[],decisions=[];let evidence;
  for(const event of run?.events??[]){
   const output=event.output;
   if(output?.node==='INFER.REASONING.SAMPLE')decisions.push({content:output.output?.message?.content,usage:output.output?.usage});
   if(output?.node==='INFER.REASONING.REFLECT')reviews.push(output.output);
   if(output?.protocol)protocols.push({valid:output.valid,...output.protocol});
   if(output?.evidence&&output?.progress)evidence=output.evidence;
   if(output?.done===false&&typeof output.tool==='string')pending={tool:output.tool,arguments:output.arguments};
   if(output?.callId&&typeof output.source==='string'&&Object.hasOwn(output,'content')){actions.push({index:actions.length+1,decision:pending,status:output.status,response:parse(output.content)});pending=undefined;}
  }
  return{caseId:row.caseId,taskId,valid:row.valid===true,score:row.valid===true?row.score:null,question:tasks.get(taskId)?.prompt,actorCalls:decisions.length,auditCalls:reviews.length,auditExhausted:(run?.events??[]).some(e=>e.graphId==='progress-exhausted'),totalTokens:row.totalTokens,latencyMs:row.latencyMs,usageStatus:row.tokenUsageStatus,actions,reviews,protocols,evidence,finalModelOutput:decisions.at(-1)?.content,modelFailure:run?.modelFailure};
 });
 const valid=cases.filter(c=>c.valid),failed=valid.filter(c=>c.score<1);
 const totals={completed:rows.length,total:tasks.size,valid:valid.length,passed:valid.filter(c=>c.score===1).length,failed:failed.length,invalid:cases.length-valid.length,accuracy:valid.length?valid.reduce((s,c)=>s+c.score,0)/valid.length:null,actorCalls:cases.reduce((s,c)=>s+c.actorCalls,0),auditCalls:cases.reduce((s,c)=>s+c.auditCalls,0),normalizedOutputs:cases.flatMap(c=>c.protocols).filter(p=>p.valid&&p.recovered).length,invalidProtocolOutputs:cases.flatMap(c=>c.protocols).filter(p=>!p.valid).length,protocolFailureCases:failed.filter(c=>c.modelFailure?.code==='MODEL_OUTPUT_FORMAT').length};
 const usage=await read(join(directory,'provider-budget.json'));
 totals.meanTaskSeconds=valid.length?valid.reduce((sum,c)=>sum+(c.latencyMs??0),0)/valid.length/1000:null;
 totals.auditExhaustedCases=cases.filter(c=>c.auditExhausted).length;
 totals.officialPassWithAuditExhausted=cases.filter(c=>c.score===1&&c.auditExhausted).map(c=>c.taskId);
 arms[name]={directory,status:manifest?.status,identity:manifest?.identity,totals,usage,cases};
 const markdown=['# AutomationBench 单次诊断：'+name,`\n完成 ${totals.completed}/${totals.total}；通过 ${totals.passed}；失败 ${totals.failed}；无效 ${totals.invalid}。`, '\n只列公开题目、模型输出、实际动作和观察；没有参考答案或隐藏状态。'];
 if(totals.officialPassWithAuditExhausted.length)markdown.push('\n官方通过但检查预算耗尽（保留检查分歧，不能称为检查器确认完成）：\n'+totals.officialPassWithAuditExhausted.map(id=>'- '+id).join('\n'));
 for(const c of failed){markdown.push(`\n## ${c.taskId}\n\n题目：${c.question}\n\n得分 ${c.score}；Actor ${c.actorCalls} 次；审核 ${c.auditCalls} 次；token ${c.totalTokens}。`);for(const a of c.actions)markdown.push(`\n\`\`\`json\n${JSON.stringify(a,null,2)}\n\`\`\``);markdown.push(`\n审核\n\n\`\`\`json\n${JSON.stringify(c.reviews,null,2)}\n\`\`\`\n\n执行证据\n\n\`\`\`json\n${JSON.stringify(c.evidence??null,null,2)}\n\`\`\`\n\n最终模型输出\n\n\`\`\`text\n${c.finalModelOutput}\n\`\`\``);}
 await writeFile(join(directory,'failure-cases.md'),markdown.join('\n'));
 await writeFile(join(directory,'diagnostic-public.json'),JSON.stringify(arms[name],null,2));
}
const before=new Map(arms['baseline-fixed'].cases.filter(c=>c.valid).map(c=>[c.caseId,c]));
const paired=arms.layered.cases.filter(c=>c.valid&&before.has(c.caseId));
const sum=(cases,key)=>cases.reduce((s,c)=>s+(c[key]??0),0);
const referenceCases=paired.map(c=>before.get(c.caseId));
const difference={commonValidTasks:paired.length,baselinePassed:referenceCases.filter(c=>c.score===1).length,layeredPassed:paired.filter(c=>c.score===1).length,scoreDelta:paired.length?paired.reduce((s,c)=>s+c.score-before.get(c.caseId).score,0)/paired.length:null,baselineTokens:sum(referenceCases,'totalTokens'),layeredTokens:sum(paired,'totalTokens'),improved:paired.filter(c=>c.score>before.get(c.caseId).score).map(c=>c.taskId),regressed:paired.filter(c=>c.score<before.get(c.caseId).score).map(c=>c.taskId)};
await writeFile(join(root,'diagnostic-public.json'),JSON.stringify({protocol:'single-pass-search-diagnostic-same-corrected-tool-catalog',arms,paired:difference},null,2));
const compact={updatedAt:new Date().toISOString(),arms:Object.fromEntries(Object.entries(arms).map(([name,a])=>[name,{directory:a.directory,status:a.status,controller:a.identity?.controller,model:a.identity?.model,totals:a.totals,usage:a.usage}])),paired:difference,failures:Object.fromEntries(Object.entries(arms).map(([name,a])=>[name,a.cases.filter(c=>c.valid&&c.score<1).map(c=>({taskId:c.taskId,question:c.question?.split('USER:').at(-1)?.trim(),modelFailure:c.modelFailure}))]))};
await writeFile(join(root,'diagnostic-summary.json'),JSON.stringify(compact,null,2));
console.log(JSON.stringify(compact,null,2));
