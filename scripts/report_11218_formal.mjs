import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const root=resolve(process.argv[2]);
const read=async file=>{try{return JSON.parse((await readFile(join(root,file),'utf8')).replace(/^\uFEFF/,''));}catch{return null;}};
const profile=await read('profile.json'),runs=[];
for(const dataset of ['drop','automationbench']){
 const prefix=dataset+'/search/',manifest=await read(prefix+'manifest.json'),state=await read(prefix+'search-state.json');
 const test=await read(prefix+'test/manifest.json'),testState=await read(prefix+'test/evaluations/'+test?.candidateId+'/checkpoint.json');
 const frozen=await read(prefix+'frozen-selection.json');
 let completedTest=testState?.cases?.length??0;
 if(frozen){const cp=await read(prefix+'test/evaluations/'+frozen.id+'/checkpoint.json');completedTest=cp?.cases?.length??completedTest;}
 const candidates=[];
 for(const h of state?.history??[]){
  if(h.status==='valid'){
   await mkdir(join(root,dataset,'candidates'),{recursive:true});
   await writeFile(join(root,dataset,'candidates',h.id+'.json'),JSON.stringify(h.definition,null,2)+'\n');
  }
  candidates.push({id:h.id,parentId:h.parentId,round:h.designRound,status:h.status,direction:h.explorationDirection,score:h.evaluation?.score,stage:h.evaluation?.examples,rationale:h.rationale,errors:h.publicErrors,
   ...(h.status==='valid'?{nodes:Object.fromEntries(Object.entries(h.definition.graphs).map(([name,g])=>[name,g.nodes.map(n=>({id:n.id,type:n.type??'subgraph',dependsOn:n.dependsOn??[]}))]))}:{})});
 }
 const pending=state?.pending?.id,cp=pending?await read(prefix+'evaluations/'+pending+'/checkpoint.json'):null;
 runs.push({dataset,search:{status:manifest?.status??'not-started',valid:state?.validEvaluations??0,rounds:state?.designRoundsCompleted??0,stopReason:manifest?.stoppedBecause,best:manifest?.best,pending,completedPendingCases:cp?.cases?.length??0,usage:await read(prefix+'provider-budget.json'),candidates},
 test:{status:test?.status??'not-started',score:test?.status==='test-completed'?test.score:null,completed:completedTest,expected:(dataset==='drop'?800:600)*3,usage:await read(prefix+'test/provider-budget.json')},frozenId:frozen?.id});
}
const completed=runs.every(r=>r.test.status==='test-completed'&&r.test.completed===r.test.expected);
const report={name:'11218-formal',at:new Date().toISOString(),status:completed?'completed':'running',deliveryDeadlineAt:profile.deliveryDeadlineAt,deadlineReached:Date.now()>=Date.parse(profile.deliveryDeadlineAt),profile,runs};
await writeFile(join(root,'summary.json'),JSON.stringify(report,null,2)+'\n');
const score=n=>typeof n==='number'?(n*100).toFixed(4)+'%':'—';
const md=['# 11218 正式搜索与冻结 Test','',`状态：${report.status}；更新时间：${report.at}；交付时点：${profile.deliveryDeadlineAt}。`,'','| 数据集 | 完整候选数 | Search 状态 / 停止原因 | Search 最佳 | Test 完成量 | Test 分数 |','|---|---:|---|---:|---:|---:|',...runs.map(r=>`| ${r.dataset} | ${r.search.valid} | ${r.search.status} / ${r.search.stopReason??'进行中'} | ${score(r.search.best?.score)} | ${r.test.completed}/${r.test.expected} | ${score(r.test.score)} |`),'',
 '每候选使用完整固定 Search 200题×5。停止条件为 Top-3 收敛、20个完整候选上限或交付时间预算；时间截止不标为收敛。完整候选完成后冻结选择，再执行 DROP 800题×3、Automation 600题×3。Test 不反馈优化器。',
 '完整候选定义在各数据集 candidates/；summary.json 保留每轮父候选、节点组合、公开修改理由和失败诊断。评分前的答案和最终世界按原官方规则判分；评分后的大型细节外置 case-events.jsonl，指标和原始答案不改写。',
 '若交付时点尚未完成全部 Test，本页明确显示未完成数量；后台继续运行，不把部分 Test 均分冒充最终成绩。'];
await writeFile(join(root,'README.zh-CN.md'),md.join('\n')+'\n');
console.log(JSON.stringify({status:report.status,runs:runs.map(r=>({dataset:r.dataset,valid:r.search.valid,test:r.test.status}))}));
