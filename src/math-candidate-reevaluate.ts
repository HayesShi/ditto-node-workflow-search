/** Re-evaluate an existing searched candidate under a new engineering protocol.
 * Does not resume the optimizer, reuse old scores, or access the Test split.
 */
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { loadProviderSettings } from './config.js';
import { mathAdapter } from './benchmark/math.js';
import { evaluateTasks } from './benchmark/evaluator.js';
import { MFlowMathScorer } from './benchmark/mflow-math-scorer.js';
import { createExperimentRuntime } from './ditto/runtime.js';
import { mathPythonIdentity } from './ditto/python-tool.js';
import { WorkflowExecutor } from './workflow/executor.js';
import { validateOrganizationPlan } from './workflow/organization.js';
import { currentExecutionIdentity, assertExecutionIdentity } from './run/execution-identity.js';
import { pythonExecutionIdentity } from './run/python-identity.js';
import type { AgentPlanSpec } from './domain.js';

const args = process.argv.slice(2);
function arg(name: string, fallback?: string): string {
  const i = args.indexOf(`--${name}`);
  const value = i >= 0 ? args[i + 1] : fallback;
  if (!value || value.startsWith('--')) throw Error(`Missing --${name}`);
  return value;
}
const checkpointPath = resolve(arg('checkpoint'));
const dataDir = resolve(arg('data-dir'));
const output = resolve(arg('output-dir'));
// mkdir without recursive on leaf refuses accidental overwrite or mixed results.
await mkdir(resolve(output, '..'), {recursive:true});
await mkdir(output);
process.env.DITTO_PROVIDER_LOG = join(output, 'provider.jsonl');
const checkpointBytes = await readFile(checkpointPath);
const checkpoint = JSON.parse(checkpointBytes.toString('utf8')) as {plan:AgentPlanSpec};
const plan = checkpoint.plan;
validateOrganizationPlan(plan);
if (plan.organization?.dataset !== 'math') throw Error('Only MATH organization candidates are supported');
const sha = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const planSha256 = sha(JSON.stringify(plan));
const sourcePlan = structuredClone(plan);
const bytes = await readFile(join(dataDir, 'math_validate.jsonl'));
const dataSha256 = sha(bytes);
if (dataSha256 !== '0ade63e8c9fe01fb8964fa22f73423be5e1c78addc9942808de464cabab188c0') throw Error('MFlow full search data hash differs');
const loaded = await mathAdapter.load({dataDir, split:'validate', limit:0, seed:42});
if (loaded.tasks.length !== 119) throw Error('Expected all 119 search tasks');
const rowNumbers = args.includes('--rows') ? arg('rows').split(',').map(Number) : undefined;
if (rowNumbers && rowNumbers.some(n=>!Number.isSafeInteger(n) || n<1 || n>119)) throw Error('Invalid smoke rows');
const tasks = loaded.tasks.filter(t=>!rowNumbers || rowNumbers.includes(Number(t.id.split(':')[2])));
if (rowNumbers && tasks.length !== new Set(rowNumbers).size) throw Error('Smoke selection differs');
// References remain private to the scorer. The executor receives only loaded public tasks.
const rawRows = bytes.toString('utf8').trim().split(/\r?\n/).map(line=>JSON.parse(line) as {problem:string;solution:string});
const refs = new Map(loaded.tasks.map(t=>{
  const row = rawRows[Number(t.id.split(':')[2])-1]!;
  if (row.problem !== t.prompt) throw Error('Private reference/task binding differs');
  return [t.id,row.solution] as const;
}));
const scorer = new MFlowMathScorer(refs);
await scorer.preflight();
const settings = loadProviderSettings();
const python = await pythonExecutionIdentity('math');
const mathPython = await mathPythonIdentity();
const identity = {...await currentExecutionIdentity(process.cwd()),python,mathPython,providerTimeoutMs:settings.timeoutMs};
const manifest = {status:'running',startedAt:new Date().toISOString(),purpose:rowNumbers?'regression-smoke':'same-candidate-full-search-reevaluation',
  checkpointPath,checkpointSha256:sha(checkpointBytes),planId:plan.id,planSha256,organization:plan.organization,
  executionIdentity:identity,model:settings.model,endpoint:settings.baseUrl,dataSha256,
  split:'validate',examples:tasks.length,repeats:1,concurrency:settings.concurrency,taskIds:tasks.map(t=>t.id),oldScoresReused:false,testSplitAccessed:false};
await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2));
await writeFile(join(output,'plan.json'),JSON.stringify(plan,null,2));
const experiment = createExperimentRuntime(settings,{profile:'math',mathPython});
const executor = new WorkflowExecutor(experiment.runtime,experiment.providerName,experiment.model);
let completed=0, correct=0, invalid=0;
try {
  const summary = await evaluateTasks(tasks,scorer,async task=>{
    assertExecutionIdentity(identity,{...await currentExecutionIdentity(process.cwd()),python,mathPython,providerTimeoutMs:settings.timeoutMs});
    if(!isDeepStrictEqual(plan,sourcePlan)) throw Error('Frozen candidate changed');
    return executor.run(plan,task);
  },{repeats:1,concurrency:settings.concurrency,onCase:async progress=>{
    completed=progress.completed; correct+=Number(progress.result.valid && progress.result.score===1); invalid+=Number(!progress.result.valid);
    await appendFile(join(output,'cases.jsonl'),JSON.stringify(progress.result)+'\n');
    const status={updatedAt:new Date().toISOString(),completed,total:tasks.length,correct,invalid,lastCase:progress.result.caseId,lastScore:progress.result.score};
    await writeFile(join(output,'progress.json'),JSON.stringify(status,null,2));
    console.log(JSON.stringify(status));
  }});
  assertExecutionIdentity(identity,{...await currentExecutionIdentity(process.cwd()),python:await pythonExecutionIdentity('math'),mathPython:await mathPythonIdentity(),providerTimeoutMs:settings.timeoutMs});
  if(sha(await readFile(join(dataDir,'math_validate.jsonl'))) !== dataSha256 || sha(await readFile(checkpointPath)) !== manifest.checkpointSha256) throw Error('Frozen data/checkpoint changed');
  await writeFile(join(output,'summary.json'),JSON.stringify(summary,null,2));
  await writeFile(join(output,'manifest.json'),JSON.stringify({...manifest,status:summary.valid?'completed':'invalid',finishedAt:new Date().toISOString()},null,2));
  console.log(JSON.stringify({done:true,valid:summary.valid,examples:summary.examples,score:summary.score,wrong:summary.wrongRuns,invalid:summary.failedRuns}));
  if(!summary.valid) process.exitCode=2;
} catch(error) {
  await writeFile(join(output,'failure.json'),JSON.stringify({error:error instanceof Error?error.message:String(error),completed},null,2));
  throw error;
} finally { await experiment.close(); }
