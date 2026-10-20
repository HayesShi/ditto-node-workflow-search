import assert from "node:assert/strict";
import test from "node:test";
import type { ModelProvider, SampleInput } from "@codesoul-co/ditto/worker/infer";
import type { BenchmarkTask, ReflectNodeSpec } from "../domain.js";
import { createExperimentRuntime } from "../ditto/runtime.js";
import { WorkflowExecutor } from "../workflow/executor.js";
import { createInitialSampleNode, createRootNode, materializeAgentPlan } from "../workflow/spec.js";
import { checkerContract, validateCheckerCriteria } from "../workflow/checker-policy.js";
import { NextNodeProposer } from "../search/proposer.js";
import { GENERATION } from "../protocol.js";

const task: BenchmarkTask = { id: "drop:fixture", dataset: "drop", prompt: "The score was 10-9. By how many points?", outputInstruction: "", metadata: {} };
const reflect = (id: string, mode: ReflectNodeSpec["config"]["mode"], dependencies: readonly string[] = []): ReflectNodeSpec => ({
  id, type: "INFER.REASONING.REFLECT", graphId: "refine", dependencies, config: { mode, criteria: ["Task correctness"], generation: GENERATION },
});
const response = (passed: boolean, severity: "info" | "warning" | "error" | undefined, answer?: string) => ({
  assessment: { passed, summary: passed ? "Original answer is correct" : "Inspect the stated quantities" },
  issues: severity ? [{ severity, description: "The stated 10-9 requires subtracting 9 from 10", suggestedFix: "Use the computed difference" }] : [],
  ...(answer === undefined ? {} : { revisedResult: { role: "assistant", content: answer } }),
});

async function fixture(outputs: Record<string, string>, inspect: (input: SampleInput) => void = () => undefined) {
  const requests: SampleInput[] = [];
  const provider: ModelProvider = { async invoke(input) {
    inspect(input); requests.push(input);
    const content = outputs[String(input.metadata?.nodeId)];
    assert.notEqual(content, undefined, "Unexpected native node invocation");
    return { message: { role: "assistant", content: content! }, finishReason: "stop", usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } };
  } };
  const runtime = createExperimentRuntime({ baseUrl: "https://offline.invalid", model: "fixture", apiKey: "offline", concurrency: 3, timeoutMs: 1000 }, { provider });
  return { runtime, requests, executor: new WorkflowExecutor(runtime.runtime, runtime.providerName, runtime.model) };
}

test("verify and critique cannot replace the checked answer; original proposal and verdict remain auditable", async () => {
  for (const mode of ["verify", "critique"] as const) {
    const f = await fixture({ "sample-1": "1", checker: JSON.stringify(response(false, "error", "10-9")) });
    try {
      const result = await f.executor.run(materializeAgentPlan("check", [createRootNode(), createInitialSampleNode(), reflect("checker", mode)]), task);
      assert.equal(result.answer, "1");
      assert.equal(result.checkerAudits?.[0]?.proposedAnswer, "10-9");
      assert.equal(result.checkerAudits?.[0]?.assessment.passed, false);
      assert.equal(result.checkerAudits?.[0]?.decision, "check-only");
      assert.equal(result.totalTokens, 6, "Checks are real native calls, not synthetic model responses");
      const payload = JSON.parse(String(f.requests[1]!.messages.at(-1)!.content));
      assert.match(payload.criteria[0].description, /Derived numeric answers need not occur verbatim/);
    } finally { await f.runtime.close(); }
  }
});

test("revise receives the original answer and structured findings and can correct a demonstrated error", async () => {
  const f = await fixture({ "sample-1": "10", checker: JSON.stringify(response(false, "error", "discard this advisory answer")),
    revision: JSON.stringify(response(false, "error", "1")) }, input => {
    if (input.metadata?.nodeId !== "revision") return;
    const payload = JSON.parse(String(input.messages.at(-1)!.content));
    assert.equal(payload.target.result.content, "10");
    const feedback = payload.context.find((item: { id: string }) => item.id === "checker-feedback:revision").content;
    assert.equal(feedback.originalAnswer.content, "10");
    assert.equal(feedback.checks[0].nodeId, "checker");
    assert.equal(feedback.checks[0].assessment.passed, false);
    assert.equal(feedback.checks[0].issues[0].severity, "error");
    assert.ok(!JSON.stringify(feedback).includes("discard this advisory answer"));
  });
  try {
    const plan = materializeAgentPlan("revision", [createRootNode(), createInitialSampleNode(), reflect("checker", "verify"), reflect("revision", "revise", ["checker"])]);
    const result = await f.executor.run(plan, task);
    assert.equal(result.answer, "1");
    assert.deepEqual(result.checkerAudits?.[1]?.feedbackNodeIds, ["checker"]);
    assert.equal(result.checkerAudits?.[1]?.targetNodeId, "sample-1");
    assert.equal(result.checkerAudits?.[1]?.decision, "revision-adopted");
    assert.deepEqual(f.requests.map(input => input.metadata?.nodeId), ["sample-1", "checker", "revision"]);
  } finally { await f.runtime.close(); }
});

test("passed checks, ambiguity warnings and absent evidence preserve the original despite a model rewrite", async () => {
  for (const check of [response(true, undefined), response(false, "warning"), response(false, "info"), response(false, undefined)]) {
    const f = await fixture({ "sample-1": "1", checker: JSON.stringify(check), revision: JSON.stringify(response(false, "error", "10-9")) });
    try {
      const plan = materializeAgentPlan("preserve", [createRootNode(), createInitialSampleNode(), reflect("checker", "verify"), reflect("revision", "revise", ["checker"])]);
      const result = await f.executor.run(plan, task);
      assert.equal(result.answer, "1");
      assert.equal(result.checkerAudits?.[1]?.proposedAnswer, "10-9");
      assert.equal(result.checkerAudits?.[1]?.decision, "preserved-passed-or-no-error");
    } finally { await f.runtime.close(); }
  }
});

test("critique findings without an optional passed field can guide a revision", async () => {
  const critique = { assessment: { summary: "The difference should be 1, not 10" }, issues: [{ severity: "error", description: "10-9=1" }] };
  const f = await fixture({ "sample-1": "10", checker: JSON.stringify(critique), revision: JSON.stringify(response(false, "error", "1")) });
  try {
    const result = await f.executor.run(materializeAgentPlan("critique", [createRootNode(), createInitialSampleNode(), reflect("checker", "critique"), reflect("revision", "revise", ["checker"])]), task);
    assert.equal(result.answer, "1");
    assert.deepEqual(result.checkerAudits?.[1]?.feedbackNodeIds, ["checker"]);
  } finally { await f.runtime.close(); }
});

test("a checker for an earlier answer is not treated as evidence against a new finalizer answer", async () => {
  const f = await fixture({ "sample-1": "10", checker: JSON.stringify(response(false, "error")), finalizer: "1", revision: JSON.stringify(response(true, undefined, "999")) });
  try {
    const finalizer = { id: "finalizer", type: "INFER.REASONING.SAMPLE" as const, graphId: "refine" as const, dependencies: ["checker"],
      config: { role: "finalizer" as const, instruction: "Finalize the answer", generation: GENERATION } };
    const result = await f.executor.run(materializeAgentPlan("fresh-target", [createRootNode(), createInitialSampleNode(), reflect("checker", "verify"), finalizer, reflect("revision", "revise", ["checker", "finalizer"])]), task);
    assert.equal(result.answer, "1");
    assert.deepEqual(result.checkerAudits?.[1]?.feedbackNodeIds, []);
    assert.equal(result.checkerAudits?.[1]?.targetNodeId, "finalizer");
  } finally { await f.runtime.close(); }
});

test("a standalone revise needs an actionable error and cannot rewrite a passed answer", async () => {
  for (const check of [response(true, undefined, "10-9"), response(false, "warning", "10-9"), response(false, "error", "2")]) {
    const f = await fixture({ "sample-1": "1", revision: JSON.stringify(check) });
    try {
      const result = await f.executor.run(materializeAgentPlan("standalone", [createRootNode(), createInitialSampleNode(), reflect("revision", "revise")]), task);
      assert.equal(result.answer, check.issues[0]?.severity === "error" ? "2" : "1");
    } finally { await f.runtime.close(); }
  }
});

test("missing checker dependencies and conflicting DROP criteria fail before a provider call", async () => {
  const nodes = [createRootNode(), createInitialSampleNode(), reflect("checker", "verify"), reflect("revision", "revise")];
  assert.throws(() => materializeAgentPlan("bad", nodes), /explicitly depend/);
  const f = await fixture({ "sample-1": "1" });
  try {
    const badCriterion = { ...reflect("checker", "verify"), config: { ...reflect("checker", "verify").config, criteria: ["Numeric and span answers match the passage exactly"] } };
    const plan = materializeAgentPlan("bad-rule", [createRootNode(), createInitialSampleNode(), badCriterion]);
    await assert.rejects(f.executor.run(plan, task), /conflict with passage-grounded arithmetic/);
    assert.equal(f.requests.length, 0);
  } finally { await f.runtime.close(); }
  validateCheckerCriteria("drop", ["Extracted entity spans match the passage exactly", "Check the arithmetic"]);
  assert.match(checkerContract("gsm8k"), /another hypothetical interpretation/);
});

test("the real proposer receives the dataset contract and repairs an invalid checker rule", async () => {
  let calls = 0;
  const runtime = createExperimentRuntime({ baseUrl: "https://offline.invalid", model: "fixture", apiKey: "offline", concurrency: 1, timeoutMs: 1000 }, { provider: {
    async invoke(input) {
      const request = JSON.parse(String(input.messages.at(-1)!.content));
      assert.match(request.checkerContract, /passage-grounded/);
      if (calls) assert.match(request.previousProposalError, /DROP checker criteria conflict/);
      return { message: { role: "assistant", content: JSON.stringify({ type: "INFER.REASONING.REFLECT", graphId: "refine", dependencies: [],
        config: { mode: "verify", criteria: [calls++ ? "Check the computed difference" : "Numeric and span answers match the passage exactly"], generation: GENERATION } }) }, finishReason: "stop" };
    },
  } });
  try {
    const proposed = await new NextNodeProposer(runtime.runtime, runtime.providerName, runtime.model).propose({ dataset: "drop", taskGoal: "DROP", path: [createRootNode(), createInitialSampleNode()], experiences: [] });
    assert.equal(calls, 2);
    assert.equal(proposed.type, "INFER.REASONING.REFLECT");
  } finally { await runtime.close(); }
});
