import assert from 'node:assert/strict';
import test from 'node:test';
import {parseArguments} from '../config.js';

test('CLI accepts completed boundary zero after the baseline and rejects invalid recovery boundaries',()=>{
  const args=['search','--dataset','math','--resume-dir','saved','--resume-round'];
  assert.equal(parseArguments([...args,'0']).resumeRound,0);
  assert.equal(parseArguments([...args,'1']).resumeRound,1);
  for(const bad of ['-1','0.5','1001','NaN'])assert.throws(()=>parseArguments([...args,bad]),/resume-round/);
  assert.throws(()=>parseArguments(['search','--resume-round','0']),/both/);
  assert.throws(()=>parseArguments(['test','--run-dir','saved','--resume-dir','saved','--resume-round','0']),/search resume/);
});
