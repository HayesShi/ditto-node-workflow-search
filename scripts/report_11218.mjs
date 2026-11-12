import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {validateOfficialDefinition,validateOfficialChange,officialMutationDiff,OFFICIAL_MUTATION_LIMITS} from '../dist/official-agent/schema.js';
const root=resolve(process.argv[2]??'../output/11218');
const read=async name=>{try{return JSON.parse((await readFile(root+'/'+name,'utf8')).replace(/^\uFEFF/,''));}catch{return null;}};
const rows=[];
for(const [dataset,directory]of [['drop','drop'],['automationbench','automationbench-final']]){
 const manifest=await read(directory+'/manifest.json'),state=await read(directory+'/search-state.json'),summary=await read(directory+'/summary.json');
 if(!manifest||!state)continue;
 const candidates=[];
 await mkdir(root+'/candidates/'+dataset,{recursive:true});
 for(const h of state.history.filter(x=>x.status==='valid')){
  validateOfficialDefinition(h.definition,h.toolArtifacts);
  const parent=state.history.find(p=>p.id===h.parentId);
  if(parent)validateOfficialChange(parent.definition,h.definition,h.mutation,parent.toolArtifacts,h.toolArtifacts);
  await writeFile(root+'/candidates/'+dataset+'/'+h.id+'.json',JSON.stringify(h.definition,null,2)+'\n');
  candidates.push({id:h.id,parentId:h.parentId,direction:h.explorationDirection??'baseline',score:h.evaluation.score,examples:h.evaluation.examples,repeats:h.evaluation.repeats,
   diff:parent?officialMutationDiff(parent.definition,h.definition):null,
   graphs:Object.fromEntries(Object.entries(h.definition.graphs).map(([k,g])=>[k,{nodes:g.nodes.map(n=>({id:n.id,type:n.type??'subgraph',dependsOn:n.dependsOn??[]})),output:g.output}])),
   rationale:h.rationale,zeroes:h.evaluation.results.filter(r=>r.score===0).length,partial:h.evaluation.results.filter(r=>r.score>0&&r.score<1).length});
 }
 rows.push({dataset,directory,status:manifest.status,sourceCommit:manifest.sourceIdentity.commit,sourceSha256:manifest.sourceIdentity.sha256,taskIds:manifest.taskIds,
  summary,usage:manifest.usage??await read(directory+'/provider-budget.json'),candidates,
  rejected:state.history.filter(x=>x.status!=='valid').map(x=>({id:x.id,status:x.status,round:x.designRound,direction:x.explorationDirection,errors:x.publicErrors,issues:x.publicIssues}))});
}
const report={name:'11218',at:new Date().toISOString(),status:rows.length===2&&rows.every(x=>x.status==='passed')?'completed':'running',formalTest:false,formalScore:false,
 mutationLimits:OFFICIAL_MUTATION_LIMITS,directionResourcePolicy:'shared-global-budget-no-direction-caps-v1',finalPolicyReplayPassed:true,runs:rows,
 startupFailures:await Promise.all(['automationbench','automationbench-retry1'].map(async directory=>{const m=await read(directory+'/manifest.json');return{directory,status:m?.status,error:m?.error,usage:m?.usage};})),
 limitations:['One repeat of a small fixed Search subset; scores are not formal Test results.','DROP Memory candidate replaced answering with passage storage; its low score is a measured strategy failure.','DROP Interaction candidate used constant 1+1; execution success does not establish task-relevant tool use.','Raw wrong-path proposals and their same-round repairs remain recorded; invalid evaluations are excluded from scored candidates.','The last schema clarification and nonempty literal fallback guard were checked by regression and final-policy replay; model-run source identities above are retained.']};
await writeFile(root+'/summary.json',JSON.stringify(report,null,2)+'\n');
const pct=n=>(n*100).toFixed(2)+'%';
const lines=['# 11218 小规模验证','',`状态：${report.status}。仅固定 Search 子集，各重复一次；未运行 Test。`,'','单次新增、删除、功能修改合计最多 1 个节点；必要引用接线和依赖边单独计算。所有方向共享全局预算，无独立方向上限。','','| 数据集 | 候选 | 方向 | 得分 |','|---|---|---|---|'];
for(const run of rows)for(const c of run.candidates)lines.push(`| ${run.dataset} | ${c.id} | ${c.direction} | ${pct(c.score)} |`);
lines.push('','每个有效候选的独立定义位于 candidates/；完整组合、差分、修改理由和拒绝诊断见 summary.json。','',
'DROP Memory 候选把原文存储结果当答案输出，属于低质量工作流；Interaction 候选使用固定 1+1，仅验证接口执行，不能据此认为工具组合已优化到位。',
'Automation 首次启动漏传数据目录，第一次重试未克隆只读配置，两次均在模型调用前退出；失败记录保留。数据路径和克隆已修正，bootstrap/ 下两组启动预检均为零模型调用。',
'原正式实验 Automation 因 Node 堆内存耗尽退出，旧暂停点保留，没有用新规则覆盖旧记录。',
'最终 schema 说明与非空字面 fallback 计数补正通过回归及已接受候选重放；真实模型运行各自的 sourceCommit/sourceSha256 保留在 summary.json。');
await writeFile(root+'/README.zh-CN.md',lines.join('\n')+'\n');
console.log(JSON.stringify({name:report.name,status:report.status,runs:rows.map(r=>({dataset:r.dataset,status:r.status,valid:r.candidates.length,best:r.summary?.bestId})),output:root}));
