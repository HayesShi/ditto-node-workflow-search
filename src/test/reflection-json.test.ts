import assert from 'node:assert/strict';
import test from 'node:test';
import { reflectionJson } from '../ditto/reflection-json.js';
import { withReflectionFormatRepair,validateReflectionResponse } from '../ditto/reflection-format.js';
import { withMathOutputContract,MATH_OUTPUT_CONTRACT } from '../ditto/math-output-contract.js';
import type { ModelProvider,SampleInput } from '@codesoul-co/ditto/worker/infer';

const input:SampleInput={model:{model:'fixture'},metadata:{dataset:'math',nodeId:'fixer',nodeType:'INFER.REASONING.REFLECT'},messages:[
  {role:'system',content:'Published schema'},
  {role:'user',content:JSON.stringify({mode:'revise',target:{result:{role:'assistant',content:'PRIVATE_TASK_TARGET'}}})}]};
const value={assessment:{passed:false,summary:'Wrong numerical answer remains wrong'},issues:[],revisedResult:{role:'assistant',content:String.raw`\boxed{3}`}};

test('syntax recovery preserves payload, quote/bracket characters and LaTeX without selecting an answer',()=>{
  const original=JSON.stringify(value);
  const fixed=reflectionJson(original+'}}');
  assert.deepEqual(JSON.parse(fixed.content),value);
  assert.deepEqual(fixed.repairs,['extra-object-closers']);
  const bad=String.raw`{"assessment":{"summary":"A brace } and quote \" remain data"},"issues":[],"revisedResult":{"role":"assistant","content":"\\boxed{3} \]"}}}`;
  const result=reflectionJson(bad);
  assert.deepEqual(result.repairs,['invalid-backslash-escape','extra-object-closers']);
  assert.equal(JSON.parse(result.content).revisedResult.content,String.raw`\boxed{3} \]`);
  validateReflectionResponse(result.content,'revise');
  assert.deepEqual(reflectionJson(original),{content:original,repairs:[]});
});

test('syntax recovery rejects multiple objects, prose, truncation and missing schema fields',()=>{
  for(const bad of [JSON.stringify(value)+'{}',JSON.stringify(value)+' done',JSON.stringify(value).slice(0,-1),'{"a":[}'])assert.throws(()=>reflectionJson(bad));
  assert.throws(()=>validateReflectionResponse(reflectionJson('{"assessment":{"summary":"ok"},"issues":null}}').content,'verify'),/assessment.passed/);
});

test('recoverable syntax takes one response, including length, and records raw evidence',async()=>{
  for(const finishReason of ['stop','length'] as const){
    let calls=0;
    const raw=JSON.stringify(value)+'}';
    const provider=withReflectionFormatRepair({async invoke(){calls++;return {message:{role:'assistant',content:raw},finishReason,usage:{inputTokens:2,outputTokens:3,totalTokens:5}};}});
    const result=await provider.invoke(input,{signal:new AbortController().signal});
    assert.equal(calls,1);assert.equal(result.finishReason,finishReason);assert.equal(result.usage?.totalTokens,5);
    assert.deepEqual(JSON.parse(String(result.message.content)),value);
    assert.deepEqual((result.message.metadata?.reflectionSyntax as any).repairs,['extra-object-closers']);
    assert.match((result.message.metadata?.reflectionSyntax as any).rawSha256,/^[a-f0-9]{64}$/);
  }
});

test('MFlow boxed contract is shared by math answer nodes and absent from Automation and syntax repairs',async()=>{
  const captured:SampleInput[]=[];
  const provider:ModelProvider=withMathOutputContract({async invoke(request){captured.push(request);return {message:{role:'assistant',content:'3'},finishReason:'stop'};}});
  for(const nodeType of ['INFER.REASONING.SAMPLE','INFER.REASONING.TRAJECTORY','INFER.REASONING.REFLECT','INFER.REASONING.DELIBERATE']){
    await provider.invoke({...input,metadata:{dataset:'math',nodeType}},{signal:new AbortController().signal});
    assert.ok(String(captured.at(-1)!.messages[0]!.content).includes(MATH_OUTPUT_CONTRACT));
    assert.equal(captured.at(-1)!.messages.length,input.messages.length);
  }
  for(const metadata of [{dataset:'automationbench',nodeType:'INFER.REASONING.SAMPLE'},{...input.metadata,phase:'reflect-format-repair'},{dataset:'math',kind:'optimizer'}]){
    const original={...input,metadata};await provider.invoke(original,{signal:new AbortController().signal});assert.equal(captured.at(-1),original);
  }
});

test('format repair cannot change an existing answer or assessment, or invent a missing answer',async()=>{
  const source=JSON.stringify({...value,issues:null});
  const contents=[source,JSON.stringify({...value,revisedResult:{role:'assistant',content:String.raw`\boxed{2}`}}),JSON.stringify(value)];
  let calls=0;
  const repaired=withReflectionFormatRepair({async invoke(request){
    if(calls>0){
      assert.equal(JSON.parse(String(request.messages.at(-1)!.content)).invalidOutput,source);
      assert.doesNotMatch(JSON.stringify(request.messages),/PRIVATE_TASK_TARGET/);
    }
    return {message:{role:'assistant',content:contents[calls++]!},finishReason:'stop'};
  }});
  assert.equal(JSON.parse(String((await repaired.invoke(input,{signal:new AbortController().signal})).message.content)).revisedResult.content,value.revisedResult.content);
  assert.equal(calls,3);
  calls=0;
  await assert.rejects(withReflectionFormatRepair({async invoke(){
    calls++;
    return {message:{role:'assistant',content:calls===1?source:JSON.stringify({...value,revisedResult:{role:'assistant',content:'2'}})},finishReason:calls===1?'stop':'length'};
  }}).invoke(input,{signal:new AbortController().signal}),/REFLECT_FORMAT_ERROR/);
  assert.equal(calls,2,'a received length response is never regenerated to get a preferred answer');
  calls=0;
  const missing=JSON.stringify({assessment:{passed:true,summary:'The answer is 17'},issues:[]});
  const invented=JSON.stringify({assessment:{passed:true,summary:'The answer is 17'},issues:[],revisedResult:{role:'assistant',content:'17'}});
  await assert.rejects(withReflectionFormatRepair({async invoke(){return {message:{role:'assistant',content:calls++===0?missing:invented},finishReason:'stop'};}}).invoke(input,{signal:new AbortController().signal}),/REFLECT_FORMAT_ERROR/);
  assert.equal(calls,3);
});
