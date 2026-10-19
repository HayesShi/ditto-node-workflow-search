import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import type { ModelProvider, SampleInput } from "@codesoul-co/ditto/worker/infer";
import { createExperimentRuntime } from "../ditto/runtime.js";
import { WorkflowExecutor } from "../workflow/executor.js";
import { evaluateTasks } from "../benchmark/evaluator.js";
import { scoreDropAnswer } from "../benchmark/text-scores.js";
import { NextNodeProposer } from "../search/proposer.js";
import { NodeWorkflowSearch } from "../search/optimizer.js";
import { createInitialSampleNode, createRootNode, materializeAgentPlan } from "../workflow/spec.js";
import { GENERATION } from "../protocol.js";
import type { WorkflowNodeSpec } from "../domain.js";

const settings = { baseUrl: "https://api.deepseek.com", model: "deepseek-flash", apiKey: "fixture", concurrency: 3, timeoutMs: 5000 };
const task = { id: "drop:fixture", dataset: "drop" as const, prompt: "Public question", outputInstruction: "", metadata: {} };
const response = (content: string, finishReason: "stop" | "length" = "stop") => ({ message: { role: "assistant" as const, content }, finishReason, usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } });
const reflect = (mode = "revise"): WorkflowNodeSpec => ({ id: "reflect-1", type: "INFER.REASONING.REFLECT", graphId: "refine", dependencies: [], config: { mode: mode as "revise", criteria: ["correctness"], generation: GENERATION } });
const golden = "PRIVATE_GOLD_96e019_DO_NOT_SEND";

test("real optimizer Provider input isolates gold and private scorer errors through feedback and repair", async () => {
  let optimizerCalls = 0;
  const experiment = createExperimentRuntime(settings, { provider: { async invoke(input) {
    const wire = JSON.stringify(input);
    assert.ok(!wire.includes(golden), "private scorer gold must never enter a provider request");
    assert.ok(!wire.includes("PRIVATE_SCORER_ERROR"), "private scoring errors must never enter a provider request");
    if (input.metadata?.role === "optimizer") {
      optimizerCalls++;
      if (optimizerCalls === 1) return response("invalid proposal");
      const { id: _id, ...proposal } = reflect();
      return response(JSON.stringify(proposal));
    }
    return input.metadata?.nodeType === "INFER.REASONING.REFLECT"
      ? response(JSON.stringify({ assessment: { summary: "checked" }, issues: [], revisedResult: { role: "assistant", content: "2" } }))
      : response("2");
  } } });
  try {
    const executor = new WorkflowExecutor(experiment.runtime, experiment.providerName, experiment.model);
    const actual = new NextNodeProposer(experiment.runtime, experiment.providerName, experiment.model);
    await new NodeWorkflowSearch({ seed: 42, rounds: 1, topK: 4, patience: 5,
      evaluate: plan => evaluateTasks([task], { expectedLabel: () => golden, score: async (_id, answer) => scoreDropAnswer(golden, answer) }, t => executor.run(plan, t)),
      proposer: { propose(request) {
        // Also exercise sanitization of retained local private scorer diagnostics.
        return actual.propose({ ...request, experiences: request.experiences.map(item => ({ ...item, failures: item.failures.map(failure => ({ ...failure, error: "PRIVATE_SCORER_ERROR" })) })) });
      } },
    }).run();
    assert.equal(optimizerCalls, 2, "the repaired proposal request must also stay isolated");
  } finally { await experiment.close(); }
});

for (const nodeType of ["REFLECT", "DELIBERATE"] as const) {
  for (const mode of nodeType === "REFLECT" ? ["revise", "verify", "critique"] : ["select", "merge", "consensus", "debate"]) {
    for (const usable of [true, false]) {
      test(`${nodeType} ${mode} normal length ${usable ? "usable" : "partial"} reaches scoring without regeneration`, async () => {
        let calls = 0;
        const provider: ModelProvider = { async invoke(input) {
          calls++;
          if (input.metadata?.nodeType !== `INFER.REASONING.${nodeType}`) return response("2");
          const content = !usable ? "{partial" : JSON.stringify(nodeType === "REFLECT"
            ? { assessment: { passed: true, summary: "checked" }, issues: [], ...(mode === "revise" ? { revisedResult: { role: "assistant", content: "2" } } : {}) }
            : { result: { role: "assistant", content: "2" }, ...(mode === "select" ? { selectedCandidateIds: ["sample-1"] } : {}) });
          return response(content, "length");
        } };
        const experiment = createExperimentRuntime(settings, { provider });
        try {
          const initial = createInitialSampleNode();
          const nodes: WorkflowNodeSpec[] = [createRootNode(), initial];
          if (nodeType === "REFLECT") nodes.push(reflect(mode));
          else nodes.push({ ...initial, id: "sample-2", config: { ...initial.config, instruction: "Solve the public task independently" } }, { id: "deliberate-1", type: "INFER.REASONING.DELIBERATE", graphId: "solve", dependencies: ["sample-1", "sample-2"], config: { mode: mode as "select", generation: GENERATION } });
          const plan = materializeAgentPlan("length-fixture", nodes);
          const executor = new WorkflowExecutor(experiment.runtime, experiment.providerName, experiment.model);
          const result = await evaluateTasks([task], { expectedLabel: () => "2", score: async (_id, answer) => scoreDropAnswer("2", answer) }, t => executor.run(plan, t));
          assert.equal(result.valid, true);
          assert.equal(result.score, usable ? 1 : 0);
          assert.equal(result.results[0]?.prediction, usable ? "2" : "");
          assert.equal(calls, nodeType === "REFLECT" ? 2 : 3);
          assert.equal(result.totalTokens, calls * 5);
          const evidence = result.results[0] as unknown as { generationOutcomes: { finishReason: string; usable: boolean; content: unknown }[] };
          assert.equal(evidence.generationOutcomes.at(-1)?.finishReason, "length");
          assert.equal(evidence.generationOutcomes.at(-1)?.usable, usable);
          if (!usable) assert.equal(evidence.generationOutcomes.at(-1)?.content, "{partial");
        } finally { await experiment.close(); }
      });
    }
  }
}

test("actual HTTP stream length is scored; incomplete stream and service errors remain invalid", async () => {
  let scenario: "length" | "disconnect" | "service" | "stop-repair" | "ambiguous" = "length";
  let calls = 0;
  let repairs = 0;
  const server = createServer(async (request, reply) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    const input = JSON.parse(raw) as { messages: SampleInput["messages"] };
    calls++;
    const reflecting = String(input.messages[0]?.content).startsWith("Assess the supplied target");
    if (reflecting && scenario === "service") { reply.writeHead(402); reply.end('{"error":{"message":"insufficient balance"}}'); return; }
    reply.writeHead(200, { "content-type": "text/event-stream" });
    const repairing = reflecting && scenario === "stop-repair" && repairs++ === 0;
    const content = !reflecting ? "2" : scenario === "ambiguous" ? "{bad" : JSON.stringify({ assessment: { summary: "checked" },
      issues: [{ severity: "info", description: "checked", ...(repairing ? { suggestedFix: null } : {}) }], revisedResult: { role: "assistant", content: "2" } });
    const finish = reflecting && scenario === "disconnect" ? null : reflecting && scenario === "length" ? "length" : "stop";
    reply.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: finish }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })}\n\n${reflecting && scenario === "disconnect" ? "" : "data: [DONE]\n\n"}`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const experiment = createExperimentRuntime({ ...settings, baseUrl: `http://127.0.0.1:${address.port}` });
  try {
    const executor = new WorkflowExecutor(experiment.runtime, experiment.providerName, experiment.model);
    const plan = materializeAgentPlan("http-length", [createRootNode(), createInitialSampleNode(), reflect()]);
    for (const state of ["length", "disconnect", "service", "stop-repair", "ambiguous"] as const) {
      scenario = state; calls = 0;
      const result = await evaluateTasks([task], { expectedLabel: () => "2", score: async (_id, answer) => scoreDropAnswer("2", answer) }, t => executor.run(plan, t), { retryAttempts: 1 });
      assert.equal(result.valid, state === "length" || state === "stop-repair");
      assert.equal(calls, state === "stop-repair" ? 3 : 2);
      if (result.valid) assert.equal(result.score, 1);
    }
  } finally { await experiment.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
