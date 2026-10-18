import assert from "node:assert/strict";
import test from "node:test";
import { GENERATION } from "../protocol.js";
import { NextNodeProposer, parseNodeProposal } from "../search/proposer.js";
import { createDitto } from "@codesoul-co/ditto/runtime";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInitialSampleNode, createRootNode } from "../workflow/spec.js";

test("proposal input distinguishes legal local dependencies from automatic prior Graph inputs", async () => {
  const runtime = createDitto({ workers: [createInferWorker({ defaultProvider: "fixture", providers: {
    fixture: { async invoke(input) {
      const request = JSON.parse(String(input.messages.at(-1)?.content));
      assert.deepEqual(request.availableDependenciesByGraph, { solve: ["sample-1"], refine: [] });
      assert.equal(request.priorGraphInputs.length, 2);
      assert.match(request.dependencyRule, /REFLECT automatically receives/);
      return { message: { role: "assistant", content: JSON.stringify({ type: "INFER.REASONING.REFLECT", graphId: "refine", dependencies: [],
        config: { mode: "revise", criteria: ["correctness"], generation: GENERATION } }) }, finishReason: "stop" };
    } },
  } })] });
  try {
    const proposal = await new NextNodeProposer(runtime, "fixture", "fixture").propose({
      path: [createRootNode(), createInitialSampleNode()], experiences: [], taskGoal: "fixture",
    });
    assert.deepEqual(proposal.dependencies, []);
  } finally { await runtime.close(); }
});

test("optimizer parser accepts exactly one allowlisted Ditto Node proposal", () => {
  const proposal = parseNodeProposal(`\`\`\`json
  {
    "type":"INFER.REASONING.REFLECT",
    "graphId":"refine",
    "dependencies":[],
    "config":{
      "mode":"revise",
      "criteria":["correctness","output contract"],
      "generation":{"temperature":${GENERATION.temperature},"maxTokens":${GENERATION.maxTokens}}
    }
  }
  \`\`\``);

  assert.deepEqual(proposal, {
    type: "INFER.REASONING.REFLECT",
    graphId: "refine",
    dependencies: [],
    config: {
      mode: "revise",
      criteria: ["correctness", "output contract"],
      generation: { temperature: GENERATION.temperature, maxTokens: GENERATION.maxTokens },
    },
  });
  assert.equal("id" in proposal, false, "IDs must be assigned only by trusted code");
});

test("optimizer parser rejects unknown Nodes and executable-code fields", () => {
  assert.throws(() => parseNodeProposal(JSON.stringify({
    type: "INFER.REASONING.UNKNOWN",
    graphId: "solve",
    dependencies: [],
    config: {},
  })), /Unsupported or non-searchable Ditto Node/);

  assert.throws(() => parseNodeProposal(JSON.stringify({
    type: "INFER.REASONING.SAMPLE",
    graphId: "solve",
    dependencies: [],
    config: {
      role: "solver",
      instruction: "Solve the task.",
      generation: { temperature: GENERATION.temperature, maxTokens: 512 },
    },
    code: "process.exit(0)",
  })), /Unexpected field: code/);

  const valid = JSON.stringify({
    type: "INFER.REASONING.SAMPLE",
    graphId: "solve",
    dependencies: [],
    config: {
      role: "solver",
      instruction: "Solve the task.",
      generation: { temperature: GENERATION.temperature, maxTokens: 512 },
    },
  });
  assert.throws(() => parseNodeProposal(`${valid}\n${valid}`), /exactly one Node proposal/);
});

test("optimizer parser enforces Graph placement and dependency shape", () => {
  assert.throws(() => parseNodeProposal(JSON.stringify({
    type: "INFER.REASONING.TRAJECTORY",
    graphId: "refine",
    dependencies: [],
    config: {
      instruction: "Solve the task.",
      strategy: "cot",
      options: { rounds: 1 },
      generation: { temperature: GENERATION.temperature, maxTokens: GENERATION.maxTokens },
      maxSteps: 8,
    },
  })), /TRAJECTORY graphId must be solve/);

  assert.throws(() => parseNodeProposal(JSON.stringify({
    type: "INFER.REASONING.DELIBERATE",
    graphId: "solve",
    dependencies: ["trajectory-1", "trajectory-1"],
    config: {
      mode: "select",
      generation: { temperature: GENERATION.temperature, maxTokens: GENERATION.maxTokens },
    },
  })), /dependencies must not contain duplicates/);

  assert.throws(() => parseNodeProposal(JSON.stringify({
    type: "INFER.REASONING.TRAJECTORY",
    graphId: "solve",
    dependencies: [],
    config: {
      instruction: "Solve the task.",
      strategy: "tot",
      options: { breadth: 2, depth: 2 },
      generation: { temperature: GENERATION.temperature, maxTokens: GENERATION.maxTokens },
      maxSteps: 8,
    },
  })), /Missing tot option: beamWidth/);
});
