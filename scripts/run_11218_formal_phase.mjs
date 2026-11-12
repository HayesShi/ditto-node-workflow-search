import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {runUnifiedExperiment} from '../dist/official-agent/runner.js';
import {automationLayeredController} from '../dist/official-agent/layered-controller.js';
const [directory,dataset,command]=process.argv.slice(2);
if(!directory||!['drop','automationbench'].includes(dataset)||!['search','test'].includes(command))throw Error('Usage: root dataset search|test');
const root=resolve(directory),profile=JSON.parse((await readFile(join(root,'profile.json'),'utf8')).replace(/^\uFEFF/,''));
const searchRoot=join(root,dataset,'search');
const exists=async file=>{try{await readFile(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
const resume=await exists(join(searchRoot,command==='test'?'test/manifest.json':'manifest.json'));
const options={command,dataset,projectRoot:process.cwd(),dataDir:resolve(dataset==='drop'?'../data/datasets':process.env.DITTO_AUTOMATION_DATA),
 resume,offlineOnly:false,maxValidEvaluations:20,maxDesignRounds:100000,maxProposalAttempts:3,seed:42,
 concurrency:profile.concurrency[dataset],maxCalls:dataset==='drop'?50000:250000,maxTokens:dataset==='drop'?100000000:1000000000,
 requestMs:600000,workflowMs:null,dockerImage:'python:3.13-slim',
 ...(command==='search'?{searchDeadlineAt:Date.parse(profile.searchDeadlineAt),initialization:'baseline',...(dataset==='automationbench'?{initialDefinition:structuredClone(automationLayeredController())}:{})}:{}),
 ...(command==='test'||resume?{runDir:searchRoot}:{outputDir:searchRoot})};
await mkdir(join(root,dataset),{recursive:true});
await writeFile(join(root,dataset,command+'-invocation.json'),JSON.stringify({at:new Date().toISOString(),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),options},null,2));
await runUnifiedExperiment(options);
if(command==='test'){
 const manifest=JSON.parse(await readFile(join(searchRoot,'test/manifest.json'),'utf8'));
 const summary=JSON.parse(await readFile(join(searchRoot,'test/summary.json'),'utf8'));
 const expected=(dataset==='drop'?800:600)*3;
 if(manifest.status!=='test-completed'||summary.valid!==true||summary.results.length!==expected)throw Error('Test did not finish all fixed cases');
}
