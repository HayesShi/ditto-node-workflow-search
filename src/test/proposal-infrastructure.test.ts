import assert from 'node:assert/strict';
import test from 'node:test';
import { createDitto } from '@codesoul-co/ditto/runtime';
import { createInferWorker, type ModelProvider } from '@codesoul-co/ditto/worker/infer';
import type { EvaluationSummary } from '../domain.js';
import { OrganizationProposer, OrganizationProposalRejectedError, OrganizationWorkflowSearch } from '../search/organization-search.js';
import type { SearchResumeState } from '../search/optimizer.js';
import { buildOrganizationPlan, initialOrganization, validateOrganization } from '../workflow/organization.js';
import type { OrganizationSpec } from '../workflow/organization-types.js';

function summary(): EvaluationSummary {
  return { valid: true, score: 1, standardDeviation: 0, repeats: 1, examples: 1,
    successfulRuns: 1, failedRuns: 0, timeoutRuns: 0, wrongRuns: 0,
    inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 1,
    results: [{ caseId: 'fixture#1', valid: true, score: 1, prediction: '2', expected: '2',
      normalizedExpected: '2', normalizedPrediction: '2', method: 'fixture', latencyMs: 1,
      inputTokens: 0, outputTokens: 0, totalTokens: 0 }] };
}

test('optimizer HTTP failure preserves the completed baseline and spends no search round; that state resumes', async () => {
  const outage = new Error('Model provider returned HTTP 503');
  let saved: SearchResumeState | undefined;
  let evaluations = 0;
  let proposals = 0;
  const events: string[] = [];
  const options = { dataset: 'math' as const, rounds: 1, seed: 42, topK: 4, patience: 5, maxDepth: 10,
    async evaluate() { evaluations++; return summary(); },
    proposer: { async propose(): Promise<OrganizationSpec> { proposals++; throw outage; } },
    callbacks: {
      async state(state: SearchResumeState) { saved = structuredClone(state); },
      async event(event: Readonly<Record<string, unknown>>) { events.push(String(event.type)); },
    },
  };
  await assert.rejects(new OrganizationWorkflowSearch(options).run(), error => error === outage);
  assert.equal(evaluations, 1);
  assert.equal(proposals, 1);
  assert.equal(saved!.completedRounds, 0);
  assert.equal(saved!.proposalFailures, 0);
  assert.equal(saved!.nodes.length, 1);
  assert.equal(saved!.evaluationHistory.length, 1);
  assert.equal(saved!.pendingOrganization, undefined);
  assert.ok(saved!.bestLeafId);
  assert.equal(events.includes('proposal-failed'), false);

  const candidate: OrganizationSpec = { ...initialOrganization('math'),
    nodes: [...initialOrganization('math').nodes, { id: 'second', template: 'sample', dependencies: ['answer'] }],
    graphs: [{ id: 'solve', nodeIds: ['context', 'answer', 'second'] }], outputNodeId: 'second' };
  const resumed = await new OrganizationWorkflowSearch({ ...options, resume: saved!,
    proposer: { async propose(request) { proposals++; request.accept(candidate); return candidate; } },
  }).run();
  assert.equal(evaluations, 2, 'the completed baseline is not evaluated again');
  assert.equal(proposals, 2);
  assert.equal(resumed.nodes.length, 2);
  assert.equal(saved!.completedRounds, 1);
  assert.equal(saved!.proposalFailures, 0);
});

test('only typed rejected candidates consume a proposal-failure round', async () => {
  let saved: SearchResumeState | undefined;
  let evaluations = 0;
  let proposals = 0;
  const events: Readonly<Record<string, unknown>>[] = [];
  const result = await new OrganizationWorkflowSearch({ dataset: 'math', rounds: 1, seed: 42, topK: 4, patience: 5,
    async evaluate() { evaluations++; return summary(); },
    proposer: { async propose() { proposals++; throw new OrganizationProposalRejectedError('Optimizer organization rejected: duplicate'); } },
    callbacks: { async state(state) { saved = structuredClone(state); }, async event(event) { events.push(event); } },
  }).run();
  assert.equal(evaluations, 1);
  assert.equal(proposals, 1);
  assert.equal(saved!.completedRounds, 1);
  assert.equal(saved!.proposalFailures, 1);
  assert.equal(events.filter(event => event.type === 'proposal-failed').length, 1);
  assert.equal(result.stoppedBecause, 'max-rounds');
  assert.equal(result.nodes.length, 1);
});

test('unbounded Automation search exits on unknown or provider faults instead of swallowing them forever', async () => {
  for (const fault of [new Error('Model provider returned HTTP 503'), new TypeError('Unexpected optimizer runtime failure')]) {
    let proposals = 0;
    let saved: SearchResumeState | undefined;
    let falseRejections = 0;
    await assert.rejects(new OrganizationWorkflowSearch({ dataset: 'automationbench', rounds: null, seed: 42, topK: 4, patience: 5,
      async evaluate() { return summary(); },
      proposer: { async propose() { proposals++; throw fault; } },
      callbacks: { async state(state) { saved = structuredClone(state); }, async event(event) {
        // Make a regression fail promptly instead of allowing the test to loop forever.
        if (event.type === 'proposal-failed' && ++falseRejections === 3) throw new Error('Infrastructure failure was swallowed repeatedly');
      } },
    }).run(), error => error === fault);
    assert.equal(proposals, 1);
    assert.equal(falseRejections, 0);
    assert.equal(saved!.completedRounds, 0);
    assert.equal(saved!.proposalFailures, 0);
  }
});

test('organization JSON and acceptance failures retain the original bounded three-response policy', async () => {
  for (const invalidJson of [true, false]) {
    let calls = 0;
    const provider: ModelProvider = { async invoke() {
      calls++;
      return { message: { role: 'assistant', content: invalidJson ? '{broken' : JSON.stringify(initialOrganization('math')) }, finishReason: 'stop' };
    } };
    const runtime = createDitto({ workers: [createInferWorker({ providers: { fixture: provider }, defaultProvider: 'fixture' })] });
    try {
      await assert.rejects(new OrganizationProposer(runtime, { provider: 'fixture', model: 'fixture' }).propose({
        parent: buildOrganizationPlan(initialOrganization('math')), experiences: [],
        accept(spec) { validateOrganization(spec); throw new Error('Duplicate organization'); },
      }), OrganizationProposalRejectedError);
      assert.equal(calls, 3);
    } finally { await runtime.close(); }
  }
});

test('a provider NodeResult failure retains its HTTP evidence and is never treated as malformed candidate JSON', async () => {
  let calls = 0;
  const provider: ModelProvider = { async invoke() {
    calls++;
    if (calls === 1) return { message: { role: 'assistant', content: '{broken' }, finishReason: 'stop' };
    throw new Error('Model provider returned HTTP 503');
  } };
  const runtime = createDitto({ workers: [createInferWorker({ providers: { fixture: provider }, defaultProvider: 'fixture' })] });
  try {
    await assert.rejects(new OrganizationProposer(runtime, { provider: 'fixture', model: 'fixture' }).propose({
      parent: buildOrganizationPlan(initialOrganization('math')), experiences: [], accept: validateOrganization,
    }), error => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof OrganizationProposalRejectedError, false);
      assert.match(error.message, /Optimizer request failed.*HTTP 503/);
      assert.deepEqual(error.cause, { code: 'EXECUTION_FAILED', message: 'Model provider returned HTTP 503' });
      return true;
    });
    assert.equal(calls, 2, 'a failed provider response must not enter the JSON-repair loop');
  } finally { await runtime.close(); }
});
