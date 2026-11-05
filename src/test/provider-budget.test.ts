import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelProvider, SampleInput, SampleOutput } from '@codesoul-co/ditto/worker/infer';
import { admitProviderBudgets, createProviderBudget, ProviderBudgetExceeded, settleProviderBudgets } from '../unified/provider-budget.js';
import { limitProviderConcurrency, withProviderLifecycle } from '../ditto/runtime.js';
import { captureProviderDiagnostics, currentProviderDiagnostics } from '../ditto/provider-diagnostics.js';

const input: SampleInput = { model: { model: 'offline' }, messages: [{ role: 'user', content: 'public' }] };
const output: SampleOutput = { message: { role: 'assistant', content: 'answer' }, finishReason: 'stop', usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } };
const options = () => ({ signal: new AbortController().signal });

test('provider budget includes SDK retries and known failure tokens before admitting another call', async () => {
  const budget = createProviderBudget({ maxCalls: 3, maxTokens: 100 });
  const provider = withProviderLifecycle({ async invoke() {
    currentProviderDiagnostics()?.push({ requestId: 1, attempts: 3, failedAttempts: 2, unknownUsageAttempts: 0,
      usageKnown: true, inputTokens: 9, outputTokens: 3, totalTokens: 12 });
    return output;
  } }, budget);
  await provider.invoke(input, options());
  assert.equal(budget.snapshot().providerCalls, 1);
  assert.equal(budget.snapshot().httpAttempts, 3);
  assert.equal(budget.snapshot().totalTokens, 12);
  await assert.rejects(provider.invoke(input, options()), ProviderBudgetExceeded);
});

test('queued request checks an exhausted budget after acquiring the concurrency slot', async () => {
  let calls = 0;
  const budget = createProviderBudget({ maxCalls: 1, maxTokens: 100 });
  const provider = limitProviderConcurrency(withProviderLifecycle({ async invoke() { calls++; return output; } }, budget), 1);
  const results = await Promise.allSettled([provider.invoke(input, options()), provider.invoke(input, options())]);
  assert.equal(calls, 1);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(budget.snapshot().inFlight, 0);
});

test('parallel provider ledgers stay separate and are appended once to the workflow ledger', async () => {
  const budget = createProviderBudget({ maxCalls: 4, maxTokens: 100 });
  let id = 0;
  const provider = withProviderLifecycle({ async invoke() {
    const requestId = ++id;
    await Promise.resolve();
    currentProviderDiagnostics()?.push({ requestId, attempts: 1, failedAttempts: 0, unknownUsageAttempts: 0,
      usageKnown: true, inputTokens: 4, outputTokens: 2, totalTokens: 6 });
    return output;
  } }, budget);
  await captureProviderDiagnostics(async records => {
    await Promise.all([provider.invoke(input, options()), provider.invoke(input, options())]);
    assert.equal(records.length, 2);
    assert.deepEqual(records.map(row => row.requestId).sort(), [1, 2]);
  });
  assert.equal(budget.snapshot().totalTokens, 12);
  assert.equal(budget.snapshot().httpAttempts, 2);
});

test('provider failures release reservations and preserve unknown usage', async () => {
  const budget = createProviderBudget({ maxCalls: 2, maxTokens: 100 });
  const provider = withProviderLifecycle({ async invoke() { throw Error('HTTP 503'); } }, budget);
  await assert.rejects(provider.invoke(input, options()), /HTTP 503/);
  assert.equal(budget.snapshot().inFlight, 0);
  assert.equal(budget.snapshot().failedAttempts, 1);
  assert.equal(budget.snapshot().unknownUsageAttempts, 1);
});

test('streaming inference participates in the same provider budget', async () => {
  const budget = createProviderBudget({ maxCalls: 1, maxTokens: 100 });
  const native: ModelProvider = { async invoke() { return output; }, async *stream() {
    yield { type: 'text_delta', delta: 'answer' };
    yield { type: 'result', output };
  } };
  const provider = withProviderLifecycle(native, budget);
  for await (const _event of provider.stream!(input, options())) { /* Drain to settle usage. */ }
  assert.equal(budget.snapshot().totalTokens, 6);
  assert.equal(budget.snapshot().inFlight, 0);
  await assert.rejects(provider.invoke(input, options()), ProviderBudgetExceeded);
});

test('restart does not erase charges or uncertainty from abandoned in-flight calls', () => {
  const budget = createProviderBudget({ maxCalls: 10, maxTokens: 100,
    restored: { providerCalls: 3, httpAttempts: 1, inFlight: 2, totalTokens: 6 } });
  assert.equal(budget.snapshot().httpAttempts, 3);
  assert.equal(budget.snapshot().unknownUsageAttempts, 2);
  assert.equal(budget.snapshot().inFlight, 0);
});

test('a rejected grouped gate leaves no phantom reservation or event in either ordering', async () => {
  for (const blockedFirst of [false, true]) {
    const events: string[] = [];
    const available = createProviderBudget({ maxCalls: 2, maxTokens: 100, onEvent: event => { events.push(event.phase); } });
    const exhausted = createProviderBudget({ maxCalls: 1, maxTokens: 100, restored: { providerCalls: 1, httpAttempts: 1 } });
    const budgets = blockedFirst ? [exhausted, available] : [available, exhausted];
    const before = budgets.map(budget => budget.snapshot());
    let calls = 0;
    const provider = withProviderLifecycle({ async invoke() { calls++; return output; } }, {
      beforeProviderCall: request => admitProviderBudgets(request, budgets),
      afterProviderCall: event => settleProviderBudgets(event, budgets),
    });
    await assert.rejects(provider.invoke(input, options()), ProviderBudgetExceeded);
    assert.equal(calls, 0);
    assert.deepEqual(budgets.map(budget => budget.snapshot()), before);
    assert.deepEqual(events, []);
    // The rejected group did not consume capacity needed by another legitimate caller.
    await withProviderLifecycle({ async invoke() { return output; } }, available).invoke(input, options());
    assert.equal(available.snapshot().providerCalls, 1);
    assert.equal(available.snapshot().inFlight, 0);
    assert.deepEqual(events, ['admitted', 'settled']);
  }
});

test('parallel grouped admission reserves all gates before yielding and settles each ledger once', async () => {
  const events: string[][] = [[], []];
  const budgets = events.map(log => createProviderBudget({ maxCalls: 1, maxTokens: 100, onEvent: event => { log.push(event.phase + ':' + event.role); } }));
  let calls = 0;
  const provider = withProviderLifecycle({ async invoke() { calls++; return output; } }, {
    // Accidentally repeating a ledger must not charge it twice.
    beforeProviderCall: request => admitProviderBudgets(request, [...budgets, budgets[0]!]),
    afterProviderCall: event => settleProviderBudgets(event, [...budgets, budgets[0]!]),
  });
  const request = { ...input, metadata: { role: 'actor' } };
  const results = await Promise.allSettled([provider.invoke(request, options()), provider.invoke(request, options())]);
  assert.equal(calls, 1);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.deepEqual(budgets[0]!.snapshot(), budgets[1]!.snapshot());
  assert.equal(budgets[0]!.snapshot().totalTokens, 6);
  assert.equal(budgets[0]!.snapshot().inFlight, 0);
  assert.deepEqual(events, [['admitted:actor', 'settled:actor'], ['admitted:actor', 'settled:actor']]);
});

test('admission persistence failure rolls back the whole group before provider execution', async () => {
  const first = createProviderBudget({ maxCalls: 2, maxTokens: 100 });
  const second = createProviderBudget({ maxCalls: 2, maxTokens: 100, onEvent: event => { if (event.phase === 'admitted') throw Error('admission persistence failed'); } });
  const budgets = [first, second], before = budgets.map(budget => budget.snapshot());
  let calls = 0;
  const provider = withProviderLifecycle({ async invoke() { calls++; return output; } }, {
    beforeProviderCall: request => admitProviderBudgets(request, budgets),
    afterProviderCall: event => settleProviderBudgets(event, budgets),
  });
  await assert.rejects(provider.invoke(input, options()), /admission persistence failed/);
  assert.equal(calls, 0);
  assert.deepEqual(budgets.map(budget => budget.snapshot()), before);
});

test('settlement persistence failure still charges every grouped ledger for the real request', async () => {
  const first = createProviderBudget({ maxCalls: 2, maxTokens: 100, onEvent: event => { if (event.phase === 'settled') throw Error('settlement persistence failed'); } });
  const second = createProviderBudget({ maxCalls: 2, maxTokens: 100 });
  const budgets = [first, second];
  let calls = 0;
  const provider = withProviderLifecycle({ async invoke() { calls++; return output; } }, {
    beforeProviderCall: request => admitProviderBudgets(request, budgets),
    afterProviderCall: event => settleProviderBudgets(event, budgets),
  });
  await assert.rejects(provider.invoke(input, options()), /settlement persistence failed/);
  assert.equal(calls, 1);
  assert.deepEqual(first.snapshot(), second.snapshot());
  assert.equal(second.snapshot().httpAttempts, 1);
  assert.equal(second.snapshot().totalTokens, 6);
  assert.equal(second.snapshot().inFlight, 0);
});
