import assert from "node:assert/strict";
import test from "node:test";
import { evaluateTasks } from "./evaluator.js";
import { NodeWorkflowSearch } from "../search/optimizer.js";
import { scoreDropAnswer } from "./text-scores.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RunStore } from "../run/store.js";

const task = { id: "drop:fixture", dataset: "drop" as const, prompt: "public question", outputInstruction: "", metadata: {} };
const scorer = { expectedLabel: () => "red blue", score: async (_id: string, answer: string) => scoreDropAnswer("red blue", answer) };
const run = (answer: string) => ({ answer, inputTokens: 3, outputTokens: 2, totalTokens: 5, executedNodeIds: [], executedGraphIds: [] });

test("authentication failures are retained, invalid and never retried as whole workflows", async () => {
  let calls = 0;
  const summary = await evaluateTasks([task], scorer, async () => { calls++; throw new Error("HTTP 401"); });
  assert.equal(calls, 1);
  assert.equal((summary as { valid?: boolean }).valid, false);
  assert.equal(summary.examples, 1);
  assert.equal(summary.failedRuns, 1);
});

test("invalid evaluation cannot drive baseline feedback or candidate generation", async () => {
  let proposals = 0;
  const summary = await evaluateTasks([task], scorer, async () => { throw new Error("HTTP 402"); }, { retryAttempts: 1 });
  await assert.rejects(new NodeWorkflowSearch({ rounds: 2, seed: 42, topK: 4, patience: 5,
    evaluate: async () => summary, proposer: { async propose() { proposals++; throw new Error("should not propose"); } },
  }).run(), /invalid/i);
  assert.equal(proposals, 0);
});

test("wrong, empty and partial DROP answers remain valid continuous scores", async () => {
  for (const [answer, score] of [["wrong", 0], ["", 0], ["red", 2 / 3]] as const) {
    const result = await evaluateTasks([task], scorer, async () => run(answer));
    assert.equal(result.score, score);
    assert.equal(result.failedRuns, 0);
  }
});

test("scorer faults preserve the answer and paid usage instead of disappearing", async () => {
  const summary = await evaluateTasks([task], { ...scorer, async score() { throw new Error("broken scorer"); } }, async () => run("red"));
  assert.equal((summary as { valid?: boolean }).valid, false);
  assert.equal(summary.results[0]?.prediction, "red");
  assert.equal(summary.totalTokens, 5);
});

test("final-test publication retains failures and refuses a complete status", async () => {
  const root = await mkdtemp(join(tmpdir(), "ditto-final-publication-"));
  try {
    const store = await RunStore.create(root, "fixture");
    const summary = await evaluateTasks([task], scorer, async () => { throw new Error("HTTP 402"); }, { retryAttempts: 1 });
    await assert.rejects(store.finishTest({ status: "frozen", selectedIds: [task.id] }, summary), /Invalid evaluation/);
    assert.equal((await store.readManifest()).status, "test-failed");
    const saved = await readFile(join(store.directory, "test", "samples.jsonl"), "utf8");
    assert.equal(JSON.parse(saved.trim()).valid, false);
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), "ditto-final-publication-")));
    await rm(root, { recursive: true, force: true });
  }
});
