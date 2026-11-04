import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {loadBenchmark,DockerPythonJudge} from '../dist/benchmark/index.js';
import {officialArtifactHash} from '../dist/official-agent/schema.js';
const root=resolve(process.argv[2]),dataDir=resolve(process.argv[3]??'../data/datasets');
const manifest=JSON.parse(await readFile(join(root,'summary.json'),'utf8'));
for(const dataset of ['humaneval','mbpp']){
 const row=manifest.datasets.find(r=>r.dataset===dataset);if(!row)continue;
 const benchmark=await loadBenchmark(dataset,{dataDir,split:'validate',dataMode:'formal',limit:0,codeJudge:new DockerPythonJudge({image:'python:3.13-slim'})});
 if(JSON.stringify(benchmark.identity)!==JSON.stringify(row.dataIdentity))throw Error('Replay data identity changed');
 for(const variant of row.variants){
  const folder=join(root,dataset),definition=JSON.parse(await readFile(join(folder,variant.variant+'.agent.json'),'utf8'));if(officialArtifactHash(definition)!==variant.artifactHash)throw Error('Replay artifact changed');
  const saved=(await readFile(join(folder,variant.variant+'.executions.jsonl'),'utf8')).trim().split('\n').map(JSON.parse),runs=new Map(saved.map(r=>[r.taskId,r]));
  if(runs.size!==saved.length)throw Error('Duplicate recorded attempts');
  const summary=await benchmark.evaluateSearchSubset(row.selection.map(r=>r.id),async task=>{const run=runs.get(task.id);if(!run)throw Error('Missing original generation');return run;},{repeats:1,concurrency:1,retryAttempts:1});
  await writeFile(join(folder,variant.variant+'.regraded.summary.json'),JSON.stringify(summary,null,2));Object.assign(variant,{status:summary.valid?'completed':'invalid-evaluation',score:summary.valid?summary.score:null,valid:summary.valid,validRuns:summary.results.filter(r=>r.valid===true).length,failedRuns:summary.failedRuns,totalTokens:summary.totalTokens,regradedWithoutGeneration:true});
 }
 row.status=row.variants.every(v=>v.valid)?'completed':'invalid-evaluation';
}
await writeFile(join(root,'summary.json'),JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify({regraded:true,newModelCalls:0}));
