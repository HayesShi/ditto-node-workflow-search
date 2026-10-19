import type { OrganizationSpec } from './organization-types.js';

/** Example searchable topology, never appended to other searched plans. */
export function conditionalMathReview(): OrganizationSpec {
  return {
    version: 1, dataset: 'math', entryGraphId: 'solve', outputNodeId: 'solver',
    nodes: [
      {id:'context',template:'context',dependencies:[]},
      {id:'solver',template:'sample',dependencies:['context']},
      {id:'checker',template:'verify',dependencies:['context','solver'],targetNodeId:'solver'},
      {id:'accepted',template:'output',dependencies:['solver']},
      {id:'fixer',template:'revise',dependencies:['context','solver','checker'],targetNodeId:'solver'},
    ],
    graphs: [
      {id:'solve',nodeIds:['context','solver']},
      {id:'check',nodeIds:['checker']},
      {id:'accept',nodeIds:['accepted']},
      {id:'repair',nodeIds:['fixer']},
    ],
    transitions: {
      solve:{kind:'next',graphId:'check'},
      check:{kind:'switch',cases:[{when:{sourceNodeId:'checker',path:['assessment','passed'],operator:'equals',value:false},graphId:'repair'}],defaultGraphId:'accept'},
      accept:{kind:'end'},repair:{kind:'end'},
    },
    outputByGraph:{accept:'solver',repair:'fixer'},
  };
}
