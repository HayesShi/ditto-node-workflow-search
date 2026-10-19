import assert from 'node:assert/strict';
import test from 'node:test';
import { preservesJsonPayload } from '../ditto/reflection-preservation.js';
import { withReflectionFormatRepair, type ReflectionRepairEvent } from '../ditto/reflection-format.js';
import type { SampleInput } from '@codesoul-co/ditto/worker/infer';

const value={assessment:{passed:false,summary:'Keep this assessment, even if mistaken'},issues:[],revisedResult:{role:'assistant',content:String.raw`\boxed{3}`}};
const valid=JSON.stringify(value);
const input:SampleInput={model:{model:'fixture'},metadata:{nodeType:'INFER.REASONING.REFLECT',nodeId:'fixer'},
  messages:[{role:'user',content:JSON.stringify({mode:'revise',target:{result:{role:'assistant',content:'PRIVATE_TASK_TARGET'}}})}]};

test('unparseable punctuation repairs preserve literals, containers and field order',()=>{
  for(const source of [valid.slice(0,-1)+',}',valid.replace('"issues":[]','"issues":[,]'),valid.replace('"issues":[]','"issues"::[]')]) {
    assert.throws(()=>JSON.parse(source));
    assert.equal(preservesJsonPayload(source,valid),true);
  }
  const source=valid.replace('},"issues"',',"},"issues"');
  assert.throws(()=>JSON.parse(source));
  assert.equal(preservesJsonPayload(source,valid),true,'same ,"} pattern as the archived case 44');
  assert.equal(preservesJsonPayload('```json\n'+source+'\n```',valid),true);
});

test('syntax proof cannot change answers, assessments, punctuation inside strings or JSON structure',()=>{
  const source=valid.slice(0,-1)+',}';
  const changed=[
    {...value,assessment:{...value.assessment,passed:true}},
    {...value,assessment:{...value.assessment,summary:'Different assessment'}},
    {...value,revisedResult:{role:'assistant',content:String.raw`\boxed{4}`}},
    {...value,revisedResult:{role:'assistant',content:'3'}},
    {...value,issues:[{severity:'error',description:'New claim'}]},
  ];
  for(const candidate of changed)assert.equal(preservesJsonPayload(source,JSON.stringify(candidate)),false);
  for(const [before,after] of [['1,2','12'],['a b','ab'],['a:b','ab'],['a\\nb','anb']]){
    const original=JSON.stringify({...value,revisedResult:{role:'assistant',content:before}}).slice(0,-1)+',}';
    assert.equal(preservesJsonPayload(original,JSON.stringify({...value,revisedResult:{role:'assistant',content:after}})),false);
  }
  for(const original of [valid+'{}',valid+' another answer',valid.slice(0,-1),valid.replace('"issues":[]','"issues":{}')])
    assert.equal(preservesJsonPayload(original,valid),false);
  const missing=JSON.stringify({assessment:value.assessment,issues:[]}).slice(0,-1)+',}';
  assert.equal(preservesJsonPayload(missing,valid),false,'a missing answer cannot be invented');
});

test('format repair accepts a proven syntax-only recovery and still rejects changed content first',async()=>{
  const source=valid.replace('},"issues"',',"},"issues"');
  const changed=JSON.stringify({...value,revisedResult:{role:'assistant',content:'4'}});
  let calls=0;const events:ReflectionRepairEvent[]=[];
  const result=await withReflectionFormatRepair({async invoke(request){
    if(calls>0){assert.doesNotMatch(JSON.stringify(request.messages),/PRIVATE_TASK_TARGET/);assert.equal(JSON.parse(String(request.messages.at(-1)!.content)).invalidOutput,source);}
    return {message:{role:'assistant',content:[source,changed,valid][calls++]!},finishReason:'stop',usage:{inputTokens:2,outputTokens:3,totalTokens:5}};
  }},event=>{events.push(event);}).invoke(input,{signal:new AbortController().signal});
  assert.equal(result.message.content,valid);assert.equal(calls,3);assert.equal(result.usage?.totalTokens,15);
  assert.equal(events.at(-1)?.preservation,'syntax-token-proof');
  assert.match(events.at(-1)!.sourceSha256!,/^[a-f0-9]{64}$/);
});

test('ambiguous mixed responses stay rejected and received length output is never regenerated',async()=>{
  let calls=0;
  await assert.rejects(withReflectionFormatRepair({async invoke(){
    return {message:{role:'assistant',content:calls++===0?valid+' prose '+valid:valid},finishReason:'stop'};
  }}).invoke(input,{signal:new AbortController().signal}),/Cannot establish content preservation/);
  assert.equal(calls,3);
  calls=0;
  const result=await withReflectionFormatRepair({async invoke(){calls++;return {message:{role:'assistant',content:valid.slice(0,-1)+',}'},finishReason:'length'};}})
    .invoke(input,{signal:new AbortController().signal});
  assert.equal(calls,1);assert.equal(result.finishReason,'length');
});
