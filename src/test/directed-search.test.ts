import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvaluationSummary, WorkflowNodeSpec } from "../domain.js";
import { createRootNode, createInitialSampleNode } from "../workflow/spec.js";
import { searchDirectedWorkflows, type DirectedSearchState } from "../search/directed-search.js";
import { parseWorkflowProposal, directedPlan, directedPlanHash, DirectedWorkflowProposer, type WorkflowProposal } from "../search/directed-proposer.js";
import { RunStore } from "../run/store.js";
import { loadDirectedResume } from "../run/directed-resume.js";
import { GENERATION, PROTOCOL } from "../protocol.js";
import { baselinePromptProfile } from "../benchmark/baseline-prompts.js";
import { discoverCheckpoints } from "../run/checkpoints.js";

function summary(score = .5, valid = true): EvaluationSummary {
  return { score, valid, standardDeviation: 0, repeats: 1, examples: 1, successfulRuns: valid ? 1 : 0,
    failedRuns: valid ? 0 : 1, timeoutRuns: 0, wrongRuns: valid && score < 1 ? 1 : 0,
    inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 1,
    results: [{ caseId: "case-1-repeat-1", prediction: "public-prediction", expected: "PRIVATE-GOLD", normalizedExpected: "PRIVATE-GOLD", normalizedPrediction: "public-prediction", method: "test", score, valid,
      latencyMs: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0,
      ...(!valid ? { error: "PRIVATE-SCORER-ERROR", failureKind: "judge" as const } : {}) }] };
}
function sample(id: string, instruction = id, dependencies: readonly string[] = []): WorkflowNodeSpec {
  return { ...createInitialSampleNode(instruction), id, dependencies };
}
function proposal(nodes: readonly WorkflowNodeSpec[], referenceCandidateId: string | null = null): WorkflowProposal {
  return { referenceCandidateId, rationale: "Use the observed public feedback", nodes };
}

test("optimizer may insert before the solver, delete, replace and rewire anywhere; reference need not be best", async () => {
  const root = createRootNode();
  const snapshots = [
    [root, sample("inserted"), sample("solver", "solver", ["inserted"])],
    [root, sample("replacement")],
    [root, sample("branch-a"), sample("branch-b"), { id: "merge", type: "INFER.REASONING.DELIBERATE" as const,
      graphId: "solve" as const, dependencies: ["branch-a", "branch-b"], config: { mode: "merge" as const, generation: GENERATION } }],
  ];
  let proposed = 0, evaluated = 0;
  const result = await searchDirectedWorkflows({ maxValidEvaluations: 4, patience: 5, taskGoal: "solve", evaluate: async () => summary(++evaluated === 1 ? 1 : .5),
    async propose(request) {
      assert.equal(request.history.length, proposed + 1);
      assert.equal("parent" in request, false);
      return proposal(snapshots[proposed++]!, proposed === 3 ? "search-002" : null);
    } });
  assert.equal(evaluated, 4); assert.equal(result.state.validEvaluations, 4);
  assert.equal(result.best.id, "search-001");
  assert.deepEqual(result.state.history.map(c => c.plan.nodes.length), [2, 3, 2, 4]);
  assert.equal(result.state.history[3]!.referenceCandidateId, "search-002");
});

test("rename-only duplicate and invalid dependencies consume no budget; a valid wrong answer does", async () => {
  let proposed = 0, evaluated = 0;
  const result = await searchDirectedWorkflows({ maxValidEvaluations: 2, patience: 5, taskGoal: "solve", initialInstruction: "seed",
    evaluate: async () => { evaluated++; return summary(0); },
    async propose() {
      proposed++;
      if (proposed === 1) return proposal([{ ...createRootNode(), id: "renamed" }, { ...createInitialSampleNode(), id: "new-solver", config: { ...createInitialSampleNode().config, instruction: "seed" } }]);
      if (proposed === 2) return proposal([createRootNode(), sample("broken", "broken", ["deleted"])]);
      return proposal([createRootNode(), sample("different")]);
    } });
  assert.equal(result.state.proposalFailures, 2); assert.equal(evaluated, 2); assert.equal(result.state.validEvaluations, 2);
  const seed = directedPlan("search-001", [createRootNode(), createInitialSampleNode("seed")]);
  const renamed = directedPlan("search-002", [{ ...createRootNode(), id: "input" }, sample("different-id", "seed")]);
  assert.equal(directedPlanHash(seed), directedPlanHash(renamed));
});

test("engineering failures are excluded and the optimizer receives no placeholder score", async () => {
  let evaluated = 0;
  const result = await searchDirectedWorkflows({ maxValidEvaluations: 2, patience: 5, taskGoal: "solve",
    evaluate: async () => summary(.7, ++evaluated !== 2),
    async propose(request) {
      if (request.history.length === 2) { assert.equal(request.history[1]!.status, "invalid"); assert.equal(request.history[1]!.evaluation, undefined); }
      return proposal([createRootNode(), sample(`solver-${evaluated}`)]);
    } });
  assert.equal(evaluated, 3); assert.equal(result.state.validEvaluations, 2);
});

test("interrupted pending candidate resumes without reproposing or spending budget twice", async () => {
  let saved: DirectedSearchState | undefined;
  await assert.rejects(searchDirectedWorkflows({ maxValidEvaluations: 1, patience: 5, taskGoal: "solve",
    propose: async () => { throw Error("must not propose"); }, evaluate: async () => { throw Error("interrupted"); },
    save: async state => { saved = structuredClone(state); } }), /interrupted/);
  assert.equal(saved!.validEvaluations, 0); assert.equal(saved!.pending!.id, "search-001");
  const result = await searchDirectedWorkflows({ maxValidEvaluations: 1, patience: 5, taskGoal: "solve", resume: saved!,
    propose: async () => { throw Error("must not repropose"); }, evaluate: async () => summary() });
  assert.equal(result.state.validEvaluations, 1); assert.equal(result.state.history.length, 1);
});

test("only completed valid experiments enter the retained AFlow convergence rule", async () => {
  let evaluated = 0;
  const result = await searchDirectedWorkflows({ maxValidEvaluations: 20, patience: 5, taskGoal: "solve",
    evaluate: async () => { evaluated++; return summary(.5); },
    propose: async () => proposal([createRootNode(), sample(`solver-${evaluated}`)]) });
  assert.equal(result.stoppedBecause, "converged"); assert.equal(result.state.validEvaluations, 6);
});

test("full snapshot parser protects fixed generation, dangling dependencies and checker chains", () => {
  const valid = proposal([createRootNode(), sample("solver")]);
  assert.deepEqual(parseWorkflowProposal(JSON.stringify(valid)).nodes, valid.nodes);
  assert.throws(() => parseWorkflowProposal(JSON.stringify(proposal([createRootNode(), sample("solver", "solver", ["gone"])]))));
  assert.throws(() => parseWorkflowProposal(JSON.stringify({ ...valid, nodes: [createRootNode(), { ...sample("solver"), config: { ...createInitialSampleNode().config, generation: { temperature: .2, maxTokens: 10 } } }] })));
  const verify: WorkflowNodeSpec = { id: "verify", type: "INFER.REASONING.REFLECT", graphId: "refine", dependencies: [], config: { mode: "verify", criteria: ["Check demonstrated arithmetic errors"], generation: GENERATION } };
  const revise: WorkflowNodeSpec = { ...verify, id: "revise", config: { ...verify.config, mode: "revise" } };
  assert.throws(() => parseWorkflowProposal(JSON.stringify(proposal([createRootNode(), sample("solver"), verify, revise])), "gsm8k"));
  assert.doesNotThrow(() => parseWorkflowProposal(JSON.stringify(proposal([createRootNode(), sample("solver"), verify, { ...revise, dependencies: ["verify"] }])), "gsm8k"));
});

test("optimizer prompt includes all histories but never references, private scorer errors or Test artifacts", async () => {
  const run = await searchDirectedWorkflows({ maxValidEvaluations: 1, patience: 5, taskGoal: "solve", propose: async () => { throw Error(); }, evaluate: async () => summary() });
  let captured = "";
  const runtime = { async run(_graph: unknown, input: { request: string }) {
    captured = input.request;
    return { proposal: { status: "success", output: { message: { content: JSON.stringify(proposal([createRootNode(), sample("edited")])) } } } };
  } };
  const proposer = new DirectedWorkflowProposer(runtime as never, "provider", "model");
  await proposer.propose({ taskGoal: "solve", history: [...run.state.history,
    { ...run.state.history[0]!, id: "search-002", status: "invalid", evaluation: summary(0, false), failureCounts: { judge: 1 } }] });
  assert.equal(JSON.parse(captured).workflowHistory.length, 2);
  assert.match(captured, /public-prediction/); assert.doesNotMatch(captured, /PRIVATE-GOLD|PRIVATE-SCORER-ERROR/);
});

test("flat candidates persist and resume with checkpoints and frozen plans; legacy state rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "ditto-directed-"));
  const store = await RunStore.create(root, "gsm8k");
  await store.writeManifest({ dataset: "gsm8k", model: "model", endpoint: "endpoint", metricProfile: "metric", dittoVersion: "0.1.1", protocol: PROTOCOL, promptProfile: baselinePromptProfile("gsm8k") });
  const result = await searchDirectedWorkflows({ dataset: "gsm8k", maxValidEvaluations: 1, patience: 5, taskGoal: "solve",
    propose: async () => { throw Error(); }, evaluate: async plan => { await store.saveCheckpoint(plan); return summary(); }, save: state => store.saveDirectedState(state) });
  await store.saveDirectedBest(result.best, 1, "valid-budget");
  assert.deepEqual(await store.readBestPlan(), result.best.plan);
  assert.equal((await discoverCheckpoints(store.directory)).length, 1);
  assert.equal((await loadDirectedResume(store.directory, 1, "gsm8k")).state.validEvaluations, 1);
  await assert.rejects(loadDirectedResume(store.directory, 0, "gsm8k"), /latest completed/);
  assert.equal(JSON.parse(await readFile(join(store.directory, "workflow-history.json"), "utf8")).length, 1);
  await assert.rejects(searchDirectedWorkflows({ maxValidEvaluations: 1, patience: 5, taskGoal: "solve", resume: { schemaVersion: 1 } as never,
    propose: async () => { throw Error(); }, evaluate: async () => summary() }), /Unsupported/);
});
import { createDitto } from "@codesoul-co/ditto/runtime";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { WorkflowExecutor } from "../workflow/executor.js";
import { parseArguments } from "../config.js";

test("moved sample-1 actually consumes newly inserted prerequisite output", async () => {
  const calls: string[] = [];
  const runtime = createDitto({ workers: [createContextWorker(), createInferWorker({ defaultProvider: "fixture", providers: {
    fixture: { async invoke(input) {
      const text = JSON.stringify(input.messages); calls.push(text);
      return { message: { role: "assistant", content: calls.length === 1 ? "INSERTED_EVIDENCE" : "7" }, finishReason: "stop" };
    } },
  } })] });
  try {
    const plan = directedPlan("search-002", [createRootNode(), sample("inserted"), sample("sample-1", "integrate", ["inserted"])]);
    const answer = await new WorkflowExecutor(runtime, "fixture", "fixture").run(plan, {
      id: "gsm8k:validate:fixture", dataset: "gsm8k", prompt: "What is 3 + 4?", outputInstruction: "Return final number", metadata: {},
    });
    assert.equal(answer.answer, "7"); assert.match(calls[1]!, /INSERTED_EVIDENCE/);
  } finally { await runtime.close(); }
});

test("CLI rejects obsolete parent/depth flags and accepts resume with zero valid experiments", () => {
  assert.throws(() => parseArguments(["search", "--top-k", "4"]), /no sampled parents/);
  assert.throws(() => parseArguments(["search", "--maximum-depth", "10"]), /no sampled parents/);
  assert.equal(parseArguments(["search", "--resume-dir", "run", "--resume-round", "0"]).resumeRound, 0);
});
