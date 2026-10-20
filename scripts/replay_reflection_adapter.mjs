/** Offline historical integration replay. Build first; optionally pass a session directory. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sessionRoot = path.resolve(process.argv[2] ?? path.join(repoRoot, "runs/parallel-drop-gsm8k-20261019-1ded01d7"));
const analysisRoot = path.join(sessionRoot, "analysis");
const sourceFiles = new Map();
const hash = value => createHash("sha256").update(value).digest("hex");
async function readSource(filename) {
  const bytes = await fs.readFile(filename);
  sourceFiles.set(filename, hash(bytes));
  return bytes.toString("utf8").replace(/^\uFEFF/, "");
}
const session = JSON.parse(await readSource(path.join(sessionRoot, "session.json")));
const traces = JSON.parse(await readSource(path.join(analysisRoot, "format-failure-traces.json")));
const previousReplay = JSON.parse(await readSource(path.join(analysisRoot, "format-failure-replay.json")));
const importCurrent = name => import(pathToFileURL(path.join(repoRoot, "dist", name)).href);
const { PROTOCOL } = await importCurrent("protocol.js");
assert.equal(PROTOCOL.id, "mflow-fixed-flash-v4", "This format-only replay requires the v4 runtime at d54e3b5; use replay_checker_semantics.mjs for v5");
const { createExperimentRuntime } = await importCurrent("ditto/runtime.js");
const { WorkflowExecutor } = await importCurrent("workflow/executor.js");
const { loadBenchmark } = await importCurrent("benchmark/registry.js");
const { normalizeReflectionResponse } = await importCurrent("ditto/reflection-normalization.js");
const implementationHashes = Object.fromEntries(await Promise.all([
  "dist/ditto/runtime.js", "dist/ditto/reflection-format.js", "dist/ditto/reflection-normalization.js",
  "dist/ditto/reflection-retry.js", "dist/ditto/reflection-schema.js", "dist/ditto/budget-output.js",
  "dist/workflow/executor.js", "dist/benchmark/evaluator.js", "dist/protocol.js", "package-lock.json",
].map(async filename => [filename, hash(await fs.readFile(path.join(repoRoot, filename)))])));

// The injected provider serves saved strings only. Any accidental HTTP path is fatal.
globalThis.fetch = async () => { throw new Error("Network access is forbidden in offline adapter replay"); };
const oldProviderLog = process.env.DITTO_PROVIDER_LOG;
delete process.env.DITTO_PROVIDER_LOG;
const outputRoot = path.join(analysisRoot, `adapter-replay-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`);
await fs.mkdir(outputRoot, { recursive: false });
const datasets = new Map();
for (const dataset of new Set(traces.cases.map(trace => trace.dataset))) {
  const loaded = await loadBenchmark(dataset, { dataDir: session.dataDir, split: "validate", limit: 0 });
  assert.equal(loaded.identity?.verified, true, "Original complete split must pass its pinned hash check");
  const raw = await readSource(path.join(session.dataDir, `${dataset}_validate.jsonl`));
  datasets.set(dataset, {
    loaded,
    rows: new Map(raw.split(/\r?\n/).filter(line => line.trim()).map(line => {
      const row = JSON.parse(line);
      return [String(row.id), line];
    })),
  });
}

const results = [];
try {
  for (const [caseIndex, trace] of traces.cases.entries()) {
    const processInfo = session.processes.find(entry => entry.dataset === trace.dataset);
    assert.ok(processInfo, `Missing original process for ${trace.dataset}`);
    const checkpoint = JSON.parse(await readSource(path.join(processInfo.runDirectory, "checkpoints", trace.candidate + ".json")));
    assert.ok(checkpoint.plan.nodes.every(node => ["CONTEXT.LOAD", "INFER.REASONING.SAMPLE", "INFER.REASONING.REFLECT"].includes(node.type)), "Replay accepts only witnessed text-only plans");
    const oldCase = previousReplay.results.find(item => item.caseId === trace.caseId && item.dataset === trace.dataset);
    assert.ok(oldCase, `Missing original replay for ${trace.caseId}`);
    const nodeForRequest = new Map(oldCase.requests.map(request => [request.requestId, request.nodeId]));
    const savedByNode = new Map();
    for (const call of trace.calls) {
      const nodeId = nodeForRequest.get(call.requestId);
      assert.ok(nodeId, `Missing node mapping for saved request ${call.requestId}`);
      if (!savedByNode.has(nodeId)) savedByNode.set(nodeId, call);
    }
    const originalTask = datasets.get(trace.dataset).loaded.tasks.find(task => task.id === trace.caseId.replace(/#\d+$/, ""));
    assert.ok(originalTask, `Task not found in the verified search split: ${trace.caseId}`);
    const caseRoot = path.join(outputRoot, String(caseIndex + 1).padStart(2, "0"));
    await fs.mkdir(caseRoot);
    const row = datasets.get(trace.dataset).rows.get(String(originalTask.metadata.sourceId));
    assert.ok(row, "Original private reference row must exist");
    // These explicit one-row fixtures exercise the adapter's real private scorer.
    // They are diagnostic replays, never replacement formal datasets or search results.
    await fs.writeFile(path.join(caseRoot, `${trace.dataset}_validate.jsonl`), row + "\n", { flag: "wx" });
    const fixture = await loadBenchmark(trace.dataset, { dataDir: caseRoot, split: "validate", dataMode: "fixture", limit: 0 });
    assert.deepEqual(fixture.tasks, [originalTask], "Public task must be unchanged by replay isolation");
    const eventFile = path.join(caseRoot, "adapter-events.jsonl");
    process.env.DITTO_PROVIDER_LOG = eventFile;
    const requests = [];
    const expectedReflections = [];
    for (const node of checkpoint.plan.nodes.filter(node => node.type === "INFER.REASONING.REFLECT")) {
      const saved = savedByNode.get(node.id);
      assert.ok(saved, `Missing first response for ${node.id}`);
      const normalized = normalizeReflectionResponse(saved.content, node.config.mode);
      expectedReflections.push({ nodeId: node.id, requestId: saved.requestId, rawContent: saved.content, normalizedContent: normalized.content, repairs: normalized.repairs });
    }
    let providerCalls = 0;
    const runtime = createExperimentRuntime({ baseUrl: "https://offline-replay.invalid", model: session.model, apiKey: "offline-replay", concurrency: 1, timeoutMs: 1000 }, {
      provider: { async invoke(input) {
        const nodeId = input.metadata?.nodeId;
        const saved = savedByNode.get(nodeId);
        assert.ok(saved, `Unexpected additional provider call for ${String(nodeId)}`);
        savedByNode.delete(nodeId);
        providerCalls++;
        requests.push({ nodeId, requestId: saved.requestId, originalPromptHash: saved.promptHash, messages: input.messages, rawContent: saved.content });
        return { message: { role: "assistant", content: saved.content }, finishReason: saved.finishReason,
          usage: saved.usage ? {
            inputTokens: saved.usage.prompt_tokens, outputTokens: saved.usage.completion_tokens, totalTokens: saved.usage.total_tokens,
          } : undefined };
      } },
    });
    let summary;
    let scorerEligibleRuns = 0;
    try {
      const executor = new WorkflowExecutor(runtime.runtime, runtime.providerName, runtime.model);
      summary = await fixture.evaluate(async task => {
        const result = await executor.run(checkpoint.plan, task);
        scorerEligibleRuns++;
        return result;
      }, { retryAttempts: 1 });
    } finally { await runtime.close(); }
    const events = (await fs.readFile(eventFile, "utf8")).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    assert.equal(summary.valid, true, `Native worker/scorer replay failed: ${summary.results[0]?.error}`);
    assert.equal(scorerEligibleRuns, 1);
    assert.equal(providerCalls, checkpoint.plan.nodes.filter(node => node.type !== "CONTEXT.LOAD").length, "Only the first historical response is allowed per node");
    assert.equal(savedByNode.size, 0);
    assert.ok(events.length > 0, "Each stopped historical case must have a normalization audit");
    assert.ok(events.every(event => event.outcome === "normalized" && event.attempt === 1), "Historical cases must recover before any repair retry");
    for (const reflection of expectedReflections.filter(item => item.repairs.length)) {
      const event = events.find(item => item.nodeId === reflection.nodeId);
      assert.equal(event?.rawContent, reflection.rawContent, "Raw historical text must remain in the audit");
      assert.equal(event?.normalizedContent, reflection.normalizedContent);
    }
    const finalReflection = expectedReflections.find(item => item.nodeId === checkpoint.plan.outputNodeId);
    const revised = finalReflection && JSON.parse(finalReflection.normalizedContent).revisedResult;
    const expectedAnswer = revised?.content ?? trace.calls[0].content;
    assert.equal(summary.results[0].prediction, expectedAnswer, "Native worker must score the supplied answer without a format envelope");
    const result = { dataset: trace.dataset, caseId: trace.caseId, candidate: trace.candidate, originalError: trace.error,
      recovered: true, scorerCalls: 1, scorerFailures: 0, providerCalls, newModelCalls: 0, retryCalls: 0,
      score: summary.score, finalAnswer: summary.results[0].prediction,
      nativeResult: summary.results[0], reflections: expectedReflections, events, requests };
    results.push(result);
    await fs.writeFile(path.join(caseRoot, "result.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  }
  for (const [filename, originalHash] of sourceFiles) assert.equal(hash(await fs.readFile(filename)), originalHash, `Original artifact changed: ${filename}`);
  const report = { createdAt: new Date().toISOString(), originalSourceCommit: session.sourceCommit,
    implementationRoot: repoRoot, offlineOnly: true, modelCalls: 0, testPartitionsEvaluated: false,
    diagnosticSubsetOnly: true, sourceArtifactsUnchanged: true,
    cases: results.length, recovered: results.filter(result => result.recovered).length,
    scorerCalls: results.reduce((sum, result) => sum + result.scorerCalls, 0), scorerFailures: 0,
    retryCalls: 0, implementationHashes, originalArtifactHashes: Object.fromEntries(sourceFiles), results };
  await fs.writeFile(path.join(outputRoot, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ outputRoot, cases: report.cases, recovered: report.recovered, scorerCalls: report.scorerCalls, scorerFailures: report.scorerFailures, retryCalls: report.retryCalls, modelCalls: 0, sourceArtifactsUnchanged: true }));
} finally {
  if (oldProviderLog === undefined) delete process.env.DITTO_PROVIDER_LOG;
  else process.env.DITTO_PROVIDER_LOG = oldProviderLog;
}
