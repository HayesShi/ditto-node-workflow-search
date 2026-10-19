// Diagnostic only. Historical solver replies are fixed; no Test or gold enters model requests.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHttpProvider} from '@codesoul-co/ditto/worker/infer';
import {Sandbox} from '@codesoul-co/ditto/runtime/sandbox';
import {createExperimentRuntime} from '../dist/ditto/runtime.js';
import {modelFailureRecorder} from '../dist/ditto/model-failure.js';
import {runOrganization} from '../dist/workflow/organization-executor.js';
import {buildOrganizationPlan} from '../dist/workflow/organization.js';
import {conditionalMathReview} from '../dist/workflow/review-organization.js';
import {MFlowMathScorer} from '../dist/benchmark/mflow-math-scorer.js';
import {currentExecutionIdentity} from '../dist/run/execution-identity.js';
import {loadProviderSettings} from '../dist/config.js';
import {PythonTransport} from '../dist/ditto/python-transport.js';

const root=process.cwd(), archive=process.argv[2], out=process.argv[3], live=process.argv.includes('--live');
if(!archive||!out)throw new Error('Usage: node --env-file=.env scripts/validate-conditional-review.mjs ARCHIVE OUT [--live]');
fs.mkdirSync(out,{recursive:true});
if(fs.existsSync(path.join(out,'manifest.json')))throw new Error('Refusing to overwrite diagnostics');
const all=JSON.parse(fs.readFileSync(path.join(archive,'all-stage-evidence.json'),'utf8'));
const rowOption=process.argv.find(v=>v.startsWith('--rows='));
const requestedRows=rowOption?rowOption.slice(7).split(',').map(Number):undefined;
if(requestedRows?.some(n=>!Number.isSafeInteger(n)||!all.some(c=>c.row===n)))throw new Error('Unknown diagnostic row');
const selected=requestedRows?all.filter(c=>requestedRows.includes(c.row)):live?all.filter(c=>[1,3,10,16,17,44,64,79,92,98,101,103,108,113,119].includes(c.row)):all;
const identity=await currentExecutionIdentity(root);
const spec=conditionalMathReview();
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify({kind:live?'cached-solver-live-conditional-review':'recorded-replies-conditional-routing',
  identity,rows:selected.map(c=>c.row),organization:spec,note:'Targeted module diagnosis, not formal search accuracy. Gold is used only by the external scorer.'},null,2));
const scorer=new MFlowMathScorer(new Map(all.map(c=>[c.caseId,c.reference])));
await scorer.preflight();
const settings=live?{...loadProviderSettings(),concurrency:2}:{baseUrl:'http://127.0.0.1:1',apiKey:'offline',model:'deepseek-flash',concurrency:1,timeoutMs:10000};
if(live&&(new URL(settings.baseUrl).hostname!=='api.deepseek.com'||settings.model!=='deepseek-flash'))throw new Error('Unexpected diagnostic provider');
process.env.DITTO_PROVIDER_LOG=path.resolve(out,'provider.jsonl');
const transport=live?new PythonTransport(settings,{profile:'math'}):undefined;
const real=live?createHttpProvider({kind:'openai-compatible',baseUrl:settings.baseUrl,apiKey:settings.apiKey,maxTokensField:'max_tokens',sandbox:new Sandbox(root,{network:[new URL(settings.baseUrl).origin]}),fetch:transport.fetch,providerOptions:{thinking:{type:'disabled'},response_format:{type:'text'}},timeoutMs:2**31-1}):undefined;
const results=[];
try{
  for(const c of selected){
    const queues=new Map();
    for(const s of c.stages){const q=queues.get(s.nodeId)??[];q.push(s);queues.set(s.nodeId,q);}
    const calls=[];
    const cached=createHttpProvider({kind:'openai-compatible',baseUrl:'http://127.0.0.1:1',apiKey:'offline',maxTokensField:'max_tokens',sandbox:new Sandbox(root,{network:['http://127.0.0.1:1']}),
      async fetch(url,init){
        const nodeId=calls.at(-1);const s=queues.get(nodeId)?.shift();
        if(!s)throw new Error(`Missing recorded reply ${c.row}/${nodeId}`);
        if(s.phase==='error'){
          modelFailureRecorder()({source:'model-output',code:s.rawResponse.modelFailureCode});
          return new Response(JSON.stringify({error:{message:'Recorded model-output failure',code:s.rawResponse.modelFailureCode}}),{status:s.status,headers:{'content-type':'application/json'}});
        }
        return new Response(JSON.stringify(s.rawResponse.response),{status:200,headers:{'content-type':'application/json'}});
      }});
    const requests=[];
    const rt=createExperimentRuntime(settings,{tools:[],provider:{async invoke(input,options){
      const id=String(input.metadata?.nodeId);calls.push(id);
      const trace={nodeId:id,messages:input.messages}; requests.push(trace);
      try {
        const reply=await (live&&id!=='solver'?real.invoke(input,options):cached.invoke(input,options));
        trace.output=reply; return reply;
      } catch(error) { trace.error=String(error); throw error; }
    }}});
    let record;
    try{
      const run=await runOrganization(rt.runtime,{provider:rt.providerName,model:rt.model},buildOrganizationPlan(spec),{id:c.caseId.replace(/#1$/,''),dataset:'math',prompt:c.problem,outputInstruction:'',metadata:{}});
      const evidence=await scorer.score(c.caseId,run.answer);
      const solver=c.stages.find(s=>s.nodeId==='solver');
      const solverEvidence=solver?.phase==='response'?await scorer.score(c.caseId,solver.rawContent):{score:0};
      const accepted=run.executedGraphIds.includes('accept');
      if(accepted){assert.ok(!calls.includes('fixer'));assert.equal(run.answer,solver.rawContent);}
      record={row:c.row,valid:true,historicalFinalScore:c.candidate.score,solverScore:solverEvidence.score,score:evidence.score,accepted,calls,executedGraphIds:run.executedGraphIds,answer:run.answer,modelFailures:run.modelFailures};
    }catch(error){record={row:c.row,valid:false,error:String(error),calls};}
    finally{await rt.close();}
    results.push(record);
    fs.appendFileSync(path.join(out,'results.jsonl'),JSON.stringify(record)+'\n');
    fs.appendFileSync(path.join(out,'requests.jsonl'),JSON.stringify({row:c.row,requests})+'\n');
    console.log(JSON.stringify({completed:results.length,total:selected.length,row:c.row,valid:record.valid,score:record.score,accepted:record.accepted}));
  }
}finally{await transport?.close();}
const valid=results.filter(r=>r.valid);
const summary={kind:live?'cached-solver-live-review':'offline-routing-replay',total:results.length,valid:valid.length,
  historicalFinalCorrect:valid.reduce((n,r)=>n+r.historicalFinalScore,0),solverCorrect:valid.reduce((n,r)=>n+r.solverScore,0),conditionalCorrect:valid.reduce((n,r)=>n+r.score,0),
  accepted:valid.filter(r=>r.accepted).length,remainingWrong:valid.filter(r=>!r.score).map(r=>r.row),
  invalid:results.filter(r=>!r.valid).map(r=>({row:r.row,error:r.error})),
  executionIdentityUnchanged:JSON.stringify(identity)===JSON.stringify(await currentExecutionIdentity(root))};
fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary));
if(valid.length!==results.length||!summary.executionIdentityUnchanged)process.exitCode=1;
