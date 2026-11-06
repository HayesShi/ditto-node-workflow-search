import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import test from 'node:test';
import {extractPythonCandidate} from './docker-python-judge.js';

const entry='def answer(x):\n    return helper(x)';
const support='import module_that_must_not_be_executed\n\ndef helper(x):\n    return x';
const fenced=(blocks:readonly string[])=>blocks.map(block=>'```python\n'+block+'\n```').join('\n');

test('trusted AST extraction retries one startup timeout then performs real syntax classification without executing support code',t=>{
 const execute=childProcess.execFileSync;const optionsSeen:any[]=[];let calls=0;
 t.mock.method(childProcess,'execFileSync',(...args:any[])=>{
  calls++;optionsSeen.push(args[2]);
  if(calls===1)throw Object.assign(new Error('Injected Python startup timeout'),{code:'ETIMEDOUT'});
  return execute.apply(childProcess,args as [any,any,any]);
 });syncBuiltinESMExports();
 try{
  assert.equal(extractPythonCandidate(fenced([support,entry,'assert answer(1) == 1']),'def answer(x):','answer'),support+'\n\n'+entry);
  assert.equal(calls,2);assert.deepEqual(optionsSeen.map(options=>options.timeout),[30000,30000]);
  assert.equal(optionsSeen[0].input,optionsSeen[1].input);
 }finally{t.mock.restoreAll();syncBuiltinESMExports();}
});

test('candidate syntax errors are classified once and never select a later valid implementation',t=>{
 const execute=childProcess.execFileSync;let calls=0;
 t.mock.method(childProcess,'execFileSync',(...args:any[])=>{calls++;return execute.apply(childProcess,args as [any,any,any]);});syncBuiltinESMExports();
 try{
  const invalid='def answer(x):\n    return x +';
  assert.equal(extractPythonCandidate(fenced([invalid,'def answer(x):\n    return x']),'def answer(x):','answer'),invalid);
  assert.equal(calls,1);
 }finally{t.mock.restoreAll();syncBuiltinESMExports();}
});

test('trusted parser process failures and invalid protocol output are surfaced without retry',t=>{
 for(const scenario of ['process','json','schema'] as const){
  let calls=0;const failure=Object.assign(new Error('Injected trusted parser failure'),{code:'ENOENT'});
  t.mock.method(childProcess,'execFileSync',()=>{calls++;if(scenario==='process')throw failure;return scenario==='json'?'not-json':'[]';});syncBuiltinESMExports();
  try{
   assert.throws(()=>extractPythonCandidate(fenced([support,entry]),'def answer(x):','answer'),scenario==='process'?(error:unknown)=>error===failure:scenario==='json'?SyntaxError:/Invalid Python support-block syntax classification/);
   assert.equal(calls,1);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();}
 }
});

test('a second trusted parser timeout remains an infrastructure failure after exactly two attempts',t=>{
 let calls=0;const failure=Object.assign(new Error('Injected repeated Python startup timeout'),{code:'ETIMEDOUT'});
 t.mock.method(childProcess,'execFileSync',()=>{calls++;throw failure;});syncBuiltinESMExports();
 try{
  assert.throws(()=>extractPythonCandidate(fenced([support,entry]),'def answer(x):','answer'),(error:unknown)=>error===failure);
  assert.equal(calls,2);
 }finally{t.mock.restoreAll();syncBuiltinESMExports();}
});
