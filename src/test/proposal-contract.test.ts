import assert from 'node:assert/strict';
import test from 'node:test';
import {initialOrganization,validateOrganization} from '../workflow/organization.js';
import {conditionalMathReview} from '../workflow/review-organization.js';

test('proposal feedback names undeclared and missing graph transitions, including equal-sized mistakes',()=>{
  const spec=initialOrganization('math');
  assert.throws(()=>validateOrganization({...spec,transitions:{...spec.transitions,deliver:{kind:'end'}}}),/undeclared graphs: \["deliver"\]/);
  assert.throws(()=>validateOrganization({...spec,transitions:{deliver:{kind:'end'}}}),/missing transitions.*\["solve"\].*undeclared graphs.*\["deliver"\]/);
  assert.throws(()=>validateOrganization({...spec,transitions:{solve:{kind:'next',graphId:'deliver'}}}),/Unknown transition target from solve.*deliver/);
});

test('REFLECT conditions must address its actual output contract, never a silently absent passed port',()=>{
  for(const path of [['passed'],['assessment','missing'],['assessment','passed','missing']]){
    const spec=conditionalMathReview();
    assert.throws(()=>validateOrganization({...spec,transitions:{...spec.transitions,
      check:{kind:'switch',cases:[{when:{sourceNodeId:'checker',path,operator:'equals',value:false},graphId:'repair'}],defaultGraphId:'accept'}}}),/REFLECT.*path/);
  }
  validateOrganization(conditionalMathReview());
});
