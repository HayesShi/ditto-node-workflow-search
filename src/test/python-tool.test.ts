import assert from 'node:assert/strict';
import test from 'node:test';
import { Sandbox, type SandboxCommand, type SandboxExecutor } from '@codesoul-co/ditto/runtime/sandbox';
import { BASELINE_PYTHON_IMAGE, createPythonTool, withMathPythonScope, assertMathPythonHealthy } from '../ditto/python-tool.js';
import { createExperimentRuntime } from '../ditto/runtime.js';
import { buildOrganizationPlan, initialOrganization } from '../workflow/organization.js';
import { WorkflowExecutor } from '../workflow/executor.js';
import { evaluateTasks } from '../benchmark/evaluator.js';
import type { ModelProvider } from '@codesoul-co/ditto/worker/infer';

type Execution = 'success' | 'syntax' | 'infrastructure' | 'timeout';
function fixture(mode: Execution = 'success') {
  const commands: SandboxCommand[] = [];
  const executor: SandboxExecutor = { async run(command) {
    commands.push(command);
    if (command.args[0] === 'rm') return {stdout:'',stderr:'',exitCode:0};
    if (mode === 'timeout') throw new DOMException('Command timed out','TimeoutError');
    if (mode === 'infrastructure') return {stdout:'',stderr:'daemon unavailable',exitCode:125};
    const started = command.args.at(-2)!;
    return {stdout:started+(mode === 'success'?'2\n':''),stderr:mode === 'syntax'?'SyntaxError: invalid syntax':'',exitCode:mode === 'syntax'?1:0};
  } };
  const sandbox = new Sandbox(process.cwd(), {execute:true}, executor);
  return {commands, sandbox};
}
const tool = createPythonTool(BASELINE_PYTHON_IMAGE);
function context(sandbox: Sandbox, signal = new AbortController().signal) {
  return {services:{sandbox},signal} as Parameters<typeof tool.execute>[1];
}

test('Python tool preserves baseline isolation, argument contract, result and cleanup',async()=>{
  const {commands,sandbox}=fixture();
  const code='print(1+1)\n# literal shell syntax: $(do_not_run)';
  assert.equal((await tool.execute({code},context(sandbox))).content,'2\n');
  const run=commands[0]!;
  for (const value of ['--network','none','--read-only','--cap-drop','ALL','256m','65534:65534',BASELINE_PYTHON_IMAGE]) assert.ok(run.args.includes(value));
  assert.equal(run.args.at(-1),code,'source is passed as an argument, never interpolated into a shell command');
  assert.match(run.args.at(-4)!,/timeout -s KILL 30 python -B -I/);
  assert.equal(commands[1]?.args[0],'rm');
  assert.equal(commands[1]?.args.at(-1),run.args[run.args.indexOf('--name')+1]);
  for (const args of [{},{code:1},{code:''},{code:'print(2)',extra:1}]) assert.equal((await tool.execute(args,context(sandbox))).error?.code,'PYTHON_ARGUMENTS');
  assert.equal(commands.length,2,'malformed arguments do not run Docker');
});

test('generated-code errors and timeouts are observations; Docker failure invalidates execution',async()=>{
  for (const mode of ['syntax','timeout'] as const) await withMathPythonScope(async()=>{
    const f=fixture(mode); const result=await tool.execute({code:'bad'},context(f.sandbox));
    assert.equal(result.status,'failed');assert.equal(result.error?.code,mode==='syntax'?'PYTHON_EXECUTION':'PYTHON_TIMEOUT');
    assertMathPythonHealthy();assert.equal(f.commands.at(-1)?.args[0],'rm');
  });
  await withMathPythonScope(async()=>{
    const f=fixture('infrastructure');
    await assert.rejects(tool.execute({code:'print(2)'},context(f.sandbox)),/TOOL_INFRASTRUCTURE/);
    assert.throws(assertMathPythonHealthy,/TOOL_INFRASTRUCTURE/);
    assert.equal(f.commands.at(-1)?.args[0],'rm');
  });
});

test('searched MATH organization routes Python observations back to the actor and returns the final answer',async()=>{
  const f=fixture();let calls=0;
  const provider:ModelProvider={async invoke(input){
    assert.equal(input.actions?.[0]?.name,'python');
    calls++;
    if(calls===1)return {message:{role:'assistant',content:''},finishReason:'action_request',actionRequests:[{id:'python-1',name:'python',arguments:{code:'print(1+1)'}}]};
    assert.ok(input.messages.some(m=>m.role==='tool'&&String(m.content).includes('2')),'actual observation reaches the next model call');
    return {message:{role:'assistant',content:'2'},finishReason:'stop'};
  }};
  const wrapped={...tool,execute:(args:Parameters<typeof tool.execute>[0],ctx:Parameters<typeof tool.execute>[1])=>tool.execute(args,{...ctx,services:{...ctx.services,sandbox:f.sandbox}})};
  const experiment=createExperimentRuntime({baseUrl:'https://example.invalid',apiKey:'fixture',model:'fixture',timeoutMs:5000,concurrency:1},{provider,tools:[wrapped]});
  try{
    const spec={...initialOrganization('automationbench'),dataset:'math' as const};
    const result=await new WorkflowExecutor(experiment.runtime,experiment.providerName,experiment.model).run(buildOrganizationPlan(spec),{id:'math-python',dataset:'math',prompt:'What is 1+1?',outputInstruction:'',metadata:{}});
    assert.equal(result.answer,'2');assert.equal(calls,2);assert.ok(result.executedNodeIds.includes('act'));
    assert.equal(f.commands.filter(c=>c.args[0]==='run').length,1);
  }finally{await experiment.close();}
});

test('Python infrastructure failure cannot become a valid zero through Interaction error wrapping',async()=>{
  const f=fixture('infrastructure');let calls=0;
  const experiment=createExperimentRuntime({baseUrl:'https://example.invalid',apiKey:'fixture',model:'fixture',timeoutMs:5000,concurrency:1},{
    provider:{async invoke(){calls++;return {message:{role:'assistant',content:''},finishReason:'action_request',actionRequests:[{id:'1',name:'python',arguments:{code:'print(2)'}}]};}},
    tools:[{...tool,execute:(args,ctx)=>tool.execute(args,{...ctx,services:{...ctx.services,sandbox:f.sandbox}})}],
  });
  let scored=0;
  try{
    const task={id:'math-python',dataset:'math' as const,prompt:'What is 1+1?',outputInstruction:'',metadata:{}};
    const plan=buildOrganizationPlan({...initialOrganization('automationbench'),dataset:'math'});
    const result=await evaluateTasks([task],{expectedLabel:()=>'',async score(){scored++;throw Error('Must not score a Docker outage');}},()=>new WorkflowExecutor(experiment.runtime,experiment.providerName,experiment.model).run(plan,task),{retryAttempts:1});
    assert.equal(result.valid,false);assert.equal(scored,0);assert.equal(calls,1);assert.match(result.results[0]?.error??'',/TOOL_INFRASTRUCTURE/);
  }finally{await experiment.close();}
});
