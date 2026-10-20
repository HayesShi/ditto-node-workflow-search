/** Offline saved-response contract replay. This does not measure new-prompt model accuracy. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sessionRoot = path.resolve(process.argv[2] ?? path.join(root, "runs/parallel-drop-gsm8k-20261019-1ded01d7"));
const originalHashes = new Map();
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
async function json(filename) { const bytes = await fs.readFile(filename); originalHashes.set(filename, digest(bytes)); return JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")); }
async function lines(filename, visit) {
  const stream = createReadStream(filename); const hash = createHash("sha256");
  stream.on("data", chunk => hash.update(chunk));
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) if (line.trim()) visit(JSON.parse(line));
  originalHashes.set(filename, hash.digest("hex"));
}
const session = await json(path.join(sessionRoot, "session.json"));
const traces = await json(path.join(sessionRoot, "analysis/format-failure-traces.json"));
const matched = [];
await lines(path.join(sessionRoot, "analysis/checker-bias-audit-20261020/matched-first-checks.jsonl"), value => matched.push(value));
const fromDist = name => import(pathToFileURL(path.join(root, "dist", name)).href);
const { PROTOCOL } = await fromDist("protocol.js");
const { createExperimentRuntime } = await fromDist("ditto/runtime.js");
const { WorkflowExecutor } = await fromDist("workflow/executor.js");
const { materializeAgentPlan } = await fromDist("workflow/spec.js");
const { validateCheckerCriteria } = await fromDist("workflow/checker-policy.js");
const { loadBenchmark } = await fromDist("benchmark/registry.js");
assert.equal(PROTOCOL.checkerPolicy, "checker-semantics-v1");
globalThis.fetch = async () => { throw Error("Network forbidden in historical checker replay"); };
delete process.env.DITTO_PROVIDER_LOG;
const outputRoot = path.join(sessionRoot, "analysis", `checker-semantics-replay-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`);
await fs.mkdir(outputRoot);
const loaded = new Map(), rawRows = new Map(), checkpoints = new Map(), samples = new Map();
for (const dataset of ["drop", "gsm8k"]) {
  const benchmark = await loadBenchmark(dataset, { dataDir: session.dataDir, split: "validate", limit: 0 });
  assert.equal(benchmark.identity.verified, true);
  loaded.set(dataset, benchmark);
  const rows = new Map();
  await lines(path.join(session.dataDir, `${dataset}_validate.jsonl`), value => rows.set(String(value.id), value));
  rawRows.set(dataset, rows);
  const run = session.processes.find(entry => entry.dataset === dataset);
  for (const candidate of dataset === "gsm8k" ? ["search-002"] : ["search-002", "search-004"]) {
    checkpoints.set(`${dataset}/${candidate}`, await json(path.join(run.runDirectory, "checkpoints", `${candidate}.json`)));
    const values = new Map();
    await lines(path.join(run.runDirectory, "evaluations", candidate, "samples.jsonl"), value => values.set(value.caseId, value));
    samples.set(`${dataset}/${candidate}`, values);
  }
}
const wanted = new Map([["drop", new Set()], ["gsm8k", new Set()]]);
for (const row of samples.get("gsm8k/search-002").values()) for (const call of row.providerDiagnostics ?? []) wanted.get("gsm8k").add(call.requestId);
for (const trace of traces.cases) for (const call of trace.calls) wanted.get(trace.dataset).add(call.requestId);
for (const id of ["drop:4656#1", "drop:3023#1"]) for (const call of samples.get("drop/search-002").get(id).providerDiagnostics) wanted.get("drop").add(call.requestId);
const responses = new Map();
for (const dataset of ["drop", "gsm8k"]) {
  const values = new Map();
  await lines(session.processes.find(entry => entry.dataset === dataset).providerLog, entry => {
    if (entry.phase === "response" && wanted.get(dataset).has(entry.id)) values.set(entry.id,
      { id: entry.id, content: entry.response.choices[0].message.content, finishReason: entry.finishReason, usage: entry.usage });
  });
  responses.set(dataset, values);
}

// Migration is explicit and written to the new report. No old checkpoint is edited.
function migrate(dataset, candidate) {
  const original = checkpoints.get(`${dataset}/${candidate}`).plan;
  const changes = []; let latestChecker;
  const nodes = original.nodes.map(source => {
    const node = structuredClone(source);
    if (node.type !== "INFER.REASONING.REFLECT") return node;
    node.config.criteria = node.config.criteria.map(criterion => {
      try { validateCheckerCriteria(dataset, [criterion]); return criterion; }
      catch { changes.push({ nodeId: node.id, removedCriterion: criterion }); return "Check the passage-grounded answer, allowing computed numeric results and exact extracted spans according to the task contract"; }
    });
    if (node.config.mode === "revise" && latestChecker && !node.dependencies.includes(latestChecker)) {
      node.dependencies.push(latestChecker); changes.push({ nodeId: node.id, addedDependency: latestChecker });
    }
    if (node.config.mode !== "revise") latestChecker = node.id;
    return node;
  });
  return { plan: materializeAgentPlan(`historical-diagnostic-${dataset}-${candidate}`, nodes), originalPlanId: original.id, changes };
}
const migrations = Object.fromEntries([...checkpoints.keys()].map(key => [key, migrate(...key.split("/"))]));
let active;
const runtime = createExperimentRuntime({ baseUrl: "https://offline.invalid", model: session.model, apiKey: "offline", concurrency: 1, timeoutMs: 1000 }, { provider: {
  async invoke(input) {
    const saved = active.queue.get(input.metadata?.nodeId);
    assert.ok(saved, `Unexpected replay call ${input.metadata?.nodeId}`);
    active.queue.delete(input.metadata.nodeId);
    active.requests.push({ nodeId: input.metadata.nodeId, savedRequestId: saved.requestId ?? saved.id, messages: input.messages });
    if (input.metadata.nodeType === "INFER.REASONING.REFLECT") {
      const payload = JSON.parse(String(input.messages.at(-1).content));
      assert.equal(payload.criteria[0].id, "application-checker-policy");
      if (payload.mode === "revise" && active.requiresFeedback) {
        const feedback = payload.context.find(value => value.id.startsWith("checker-feedback:"));
        assert.ok(feedback, "Revision must receive structured checker findings");
        assert.equal(feedback.content.originalAnswer.content, active.originalAnswer);
        assert.deepEqual(payload.target.result.content, active.originalAnswer);
      }
    }
    return { message: { role: "assistant", content: saved.content }, finishReason: saved.finishReason ?? "stop",
      ...(saved.usage ? { usage: { inputTokens: saved.usage.prompt_tokens, outputTokens: saved.usage.completion_tokens, totalTokens: saved.usage.total_tokens } } : {}) };
  },
} });
const executor = new WorkflowExecutor(runtime.runtime, runtime.providerName, runtime.model);
async function runCase(dataset, candidate, row, trace) {
  const migration = migrations[`${dataset}/${candidate}`];
  const solver = migration.plan.nodes.find(node => node.type === "INFER.REASONING.SAMPLE");
  const reflects = migration.plan.nodes.filter(node => node.type === "INFER.REASONING.REFLECT");
  const queue = new Map();
  let replayMode;
  if (trace) {
    queue.set(solver.id, trace.calls[0]);
    if (reflects.length === 2) { queue.set(reflects[0].id, trace.calls[1]); queue.set(reflects[1].id, trace.calls[2]); }
    else queue.set(reflects[0].id, trace.calls[1]);
    replayMode = "first-saved-malformed-response";
  } else {
    const ids = row.providerDiagnostics.map(call => call.requestId);
    queue.set(solver.id, responses.get(dataset).get(ids[0]));
    queue.set(reflects[0].id, responses.get(dataset).get(ids.at(-1)));
    replayMode = "terminal-saved-response";
  }
  assert.ok([...queue.values()].every(Boolean));
  active = { queue, requests: [], requiresFeedback: reflects.length === 2, originalAnswer: queue.get(solver.id).content };
  const taskId = row.caseId.replace(/#\d+$/, "");
  const task = loaded.get(dataset).tasks.find(task => task.id === taskId);
  const result = await executor.run(migration.plan, task);
  assert.equal(queue.size, 0);
  return { result, replayMode, requests: active.requests, originalAnswer: active.originalAnswer };
}

try {
  const gsmRecords = [], repeats = new Map();
  const gsmEvaluation = await loaded.get("gsm8k").evaluate(async task => {
    const repeat = (repeats.get(task.id) ?? 0) + 1; repeats.set(task.id, repeat);
    const caseId = `${task.id}#${repeat}`;
    const old = samples.get("gsm8k/search-002").get(caseId);
    assert.ok(old);
    const trace = old.valid ? undefined : traces.cases.find(trace => trace.dataset === "gsm8k" && trace.caseId === caseId);
    try {
      const replay = await runCase("gsm8k", "search-002", old, trace);
      assert.equal(replay.result.answer, replay.originalAnswer, "Verify cannot replace the actual historical target");
      gsmRecords.push({ caseId, oldValid: old.valid, oldScore: old.score, ...replay });
      return replay.result;
    } catch (error) {
      gsmRecords.push({ caseId, oldValid: old.valid, oldScore: old.score, refused: true, error: error.message,
        originalAnswer: active.originalAnswer, requests: active.requests });
      throw error;
    }
  }, { repeats: 5, concurrency: 1, retryAttempts: 1 });
  await fs.writeFile(path.join(outputRoot, "gsm8k-private-evaluation.json"), JSON.stringify(gsmEvaluation));
  const scores = new Map(gsmEvaluation.results.filter(row => row.valid).map(row => [row.caseId, row.score]));
  const gsmSummary = { cases: gsmRecords.length, valid: gsmEvaluation.valid, completed: gsmEvaluation.validRuns,
    refused: gsmEvaluation.results.filter(row => !row.valid).map(row => ({ caseId: row.caseId, error: row.error })),
    diagnosticCorrect: gsmEvaluation.results.filter(row => row.valid && row.score === 1).length,
    priorValid: gsmRecords.filter(row => row.oldValid).length,
    preventedWrongReplacement: gsmRecords.filter(row => !row.refused && row.oldValid && row.oldScore === 0 && scores.get(row.caseId) === 1).map(row => row.caseId),
    lostHelpfulReplacement: gsmRecords.filter(row => !row.refused && row.oldValid && row.oldScore === 1 && scores.get(row.caseId) === 0).map(row => row.caseId),
    invalidRecovered: gsmRecords.filter(row => !row.refused && !row.oldValid).length,
    correctTargetFalseVerdicts: matched.filter(row => row.dataset === "gsm8k" && row.targetScore === 1 && row.verdict === false).map(row => ({
      requestId: row.requestId, cases: row.sampleReferences.map(ref => ({ caseId: ref.caseId, completed: scores.has(ref.caseId), score: scores.get(ref.caseId) })),
    })) };
  await fs.writeFile(path.join(outputRoot, "gsm8k-records.json"), JSON.stringify(gsmRecords));
  await fs.writeFile(path.join(outputRoot, "gsm8k-private-evaluation.json"), JSON.stringify(gsmEvaluation));

  const selected = [...traces.cases, ...["drop:4656#1", "drop:3023#1"].map(caseId => ({ dataset: "drop", candidate: "search-002", caseId }))];
  const selectedResults = [];
  for (const [index, item] of selected.entries()) {
    const old = samples.get(`${item.dataset}/${item.candidate}`).get(item.caseId);
    const task = loaded.get(item.dataset).tasks.find(task => task.id === item.caseId.replace(/#\d+$/, ""));
    const fixtureDir = path.join(outputRoot, `case-${index + 1}`); await fs.mkdir(fixtureDir);
    await fs.writeFile(path.join(fixtureDir, `${item.dataset}_validate.jsonl`), JSON.stringify(rawRows.get(item.dataset).get(String(task.metadata.sourceId))) + "\n");
    const fixture = await loadBenchmark(item.dataset, { dataDir: fixtureDir, split: "validate", dataMode: "fixture", limit: 0 });
    let replay;
    const evaluation = await fixture.evaluate(async () => { replay = await runCase(item.dataset, item.candidate, old, item.calls ? item : undefined); return replay.result; }, { retryAttempts: 1 });
    assert.equal(evaluation.valid, true);
    selectedResults.push({ caseId: item.caseId, dataset: item.dataset, originalError: old.error, oldScore: old.score,
      score: evaluation.score, prediction: evaluation.results[0].prediction, ...replay });
  }
  await fs.writeFile(path.join(outputRoot, "selected-results.json"), JSON.stringify(selectedResults, null, 2));
  const newHashes = Object.fromEntries(await Promise.all([
    "dist/workflow/executor.js", "dist/workflow/checker-policy.js", "dist/workflow/checker-semantics.js", "dist/workflow/spec.js",
    "dist/search/proposer.js", "dist/search/optimizer.js", "dist/protocol.js", "dist/ditto/reflection-format.js", "package-lock.json",
  ].map(async file => [file, digest(await fs.readFile(path.join(root, file)))])));
  for (const [file, hash] of originalHashes) assert.equal(digest(await fs.readFile(file)), hash, `Original evidence changed: ${file}`);
  const summary = { createdAt: new Date().toISOString(), protocol: PROTOCOL.id, originalSourceCommit: session.sourceCommit,
    offlineOnly: true, modelCalls: 0, testPartitionsEvaluated: false, newPromptAccuracyMeasured: false,
    interpretation: "Saved-response contract replay; prompts and explicitly migrated plans differ. Counts are diagnostic, not new formal model results or new paid usage.",
    gsm8k: gsmSummary, stoppedCases: { recovered: selectedResults.filter(row => row.originalError).length,
      correct: selectedResults.filter(row => row.originalError && row.score === 1).length },
    dropExamples: selectedResults.filter(row => !row.originalError).map(row => ({ caseId: row.caseId, oldScore: row.oldScore, score: row.score })),
    migrations, implementationHashes: newHashes, originalArtifactHashes: Object.fromEntries(originalHashes) };
  await fs.writeFile(path.join(outputRoot, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ outputRoot, modelCalls: 0, testPartitionsEvaluated: false, newPromptAccuracyMeasured: false,
    cases: gsmSummary.cases, completed: gsmSummary.completed, refused: gsmSummary.refused.length,
    preventedWrongReplacement: gsmSummary.preventedWrongReplacement.length, lostHelpfulReplacement: gsmSummary.lostHelpfulReplacement.length,
    stoppedCases: summary.stoppedCases, dropExamples: summary.dropExamples }));
} finally { await runtime.close(); }
