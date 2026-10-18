import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { createExperimentRuntime } from "../ditto/runtime.js";
import { WorkflowExecutor } from "../workflow/executor.js";
import { createRootNode, createInitialSampleNode, materializeAgentPlan } from "../workflow/spec.js";
import { evaluateTasks } from "../benchmark/evaluator.js";
import { scoreGsm8kAnswer } from "../benchmark/text-scores.js";

test("real Python HTTP transport classifies faults, retains attempts, and scores length outputs", async () => {
  let status = 200;
  let mode = "stop";
  let calls = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain request */ }
    calls++;
    if (mode === "timeout") return;
    if (status !== 200) {
      response.writeHead(status, { "content-type": "application/json", "retry-after": "0" });
      response.end(JSON.stringify({ error: { message: "fixture rejection" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
    chunk({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "4" } }] });
    if (mode !== "incomplete") {
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: mode }] });
      chunk({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
    }
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const experiment = createExperimentRuntime({ baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "fixture", apiKey: "offline", concurrency: 2, timeoutMs: 10_000 });
  const executor = new WorkflowExecutor(experiment.runtime, experiment.providerName, experiment.model);
  const plan = materializeAgentPlan("search-001", [createRootNode(), createInitialSampleNode("")]);
  const task = { id: "gsm8k:fixture", dataset: "gsm8k" as const, prompt: "2+2?", outputInstruction: "", metadata: {} };
  const scorer = { expectedLabel: () => "4", async score(_id: string, answer: string) { return scoreGsm8kAnswer("4", answer); } };
  const evaluate = () => evaluateTasks([task], scorer, t => executor.run(plan, t), { retryAttempts: 1 });
  try {
    for (const rejected of [401, 402, 429, 500]) {
      status = rejected; calls = 0;
      const summary = await evaluate();
      assert.equal(summary.valid, false);
      assert.equal(summary.results[0]?.failureKind, "provider");
      assert.equal(calls, rejected < 429 ? 1 : 3);
      assert.equal(summary.providerAttemptCount, calls);
      assert.equal(summary.tokenUsageStatus, "known-lower-bound");
    }
    status = 200;
    for (const ending of ["stop", "length"]) {
      mode = ending;
      const summary = await evaluate();
      assert.equal(summary.valid, true);
      assert.equal(summary.score, 1);
      assert.equal(summary.totalTokens, 4);
      assert.equal(summary.providerAttemptCount, 1);
    }
    mode = "incomplete";
    const incomplete = await evaluate();
    assert.equal(incomplete.valid, false);
    assert.equal(incomplete.tokenUsageStatus, "known-lower-bound");
    mode = "timeout";
    const timeout = await evaluate();
    assert.equal(timeout.valid, false);
    assert.equal(timeout.results[0]?.failureKind, "timeout");
  } finally {
    await experiment.close();
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
});
