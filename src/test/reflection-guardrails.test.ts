import assert from "node:assert/strict";
import test from "node:test";
import type { ModelProvider, SampleInput, SampleOutput } from "@codesoul-co/ditto/worker/infer";
import { withReflectionFormatRepair } from "../ditto/reflection-format.js";
import { normalizeReflectionResponse } from "../ditto/reflection-normalization.js";
import { GENERATION } from "../protocol.js";

const input: SampleInput = { model: { model: "offline" }, generation: GENERATION,
  metadata: { nodeType: "INFER.REASONING.REFLECT", nodeId: "verify", taskId: "fixture" },
  messages: [{ role: "user", content: JSON.stringify({ mode: "verify", target: { result: { role: "assistant", content: "7" } } }) }] };
const signal = (): { signal: AbortSignal } => ({ signal: new AbortController().signal });

test("reflection envelope normalization retains false verdict, issue severity, fixes and revised content", () => {
  const assessment = { passed: false, summary: "Incorrect, despite a well formed response.", issues: [
    { severity: "error", description: "Wrong value", suggestedFix: "Use the supplied quantities" },
  ], revisedResult: { role: "assistant", content: "The supplied revision remains 11." } };
  const result = normalizeReflectionResponse(JSON.stringify({ assessment }), "verify");
  assert.deepEqual(JSON.parse(result.content), { assessment: { passed: false, summary: assessment.summary }, issues: assessment.issues, revisedResult: assessment.revisedResult });
});

test("missing or string verdicts and ambiguous issues never become accepted structured output", async () => {
  const invalid = [
    { assessment: { summary: "Correct answer" }, issues: [] },
    { assessment: { summary: "Correct answer", passed: "false" }, issues: [] },
    { assessment: { summary: "Correct answer", passed: true }, issues: "none" },
    { assessment: { summary: "Correct answer", passed: false, issues: [] }, issues: [{ severity: "error", description: "Conflicting findings" }] },
    { assessment: { summary: "Correct answer", passed: false }, issues: [{ severity: "error", description: "Wrong value", suggestedFix: null }] },
  ];
  for (const [index, value] of invalid.entries()) {
    let calls = 0;
    const original = JSON.stringify(value);
    const provider: ModelProvider = { async invoke() { calls++; return { message: { role: "assistant", content: original }, finishReason: "stop" }; } };
    await assert.rejects(withReflectionFormatRepair(provider).invoke(input, signal()), /REFLECT_FORMAT_ERROR/);
    assert.equal(calls, index === invalid.length - 1 ? 3 : 1,
      "Ambiguous or missing substantive fields must fail before format retries");
    assert.equal(JSON.stringify(value), original);
  }
});

test("HTTP errors retain identity and length stops retain the original partial response", async () => {
  for (const status of [400, 401, 402, 403, 429, 500]) {
    let calls = 0;
    const failure = new Error(`HTTP ${status}`);
    await assert.rejects(withReflectionFormatRepair({ async invoke() { calls++; throw failure; } }).invoke(input, signal()), error => error === failure);
    assert.equal(calls, 1, "Format repair must not reinterpret transport retries");
  }
  const partial: SampleOutput = { message: { role: "assistant", content: '{"assessment":' }, finishReason: "length" };
  let calls = 0;
  const output = await withReflectionFormatRepair({ async invoke() { calls++; return partial; } }).invoke(input, signal());
  assert.equal(output, partial);
  assert.equal(calls, 1);
});

test("unknown input or output usage remains unknown after structural repair and cumulative retries", async () => {
  const valid = JSON.stringify({ assessment: { passed: false, summary: "Incorrect" }, issues: [{ severity: "error", description: "Wrong" }] });
  const contents = [JSON.stringify({ assessment: { passed: false, summary: "Incorrect" }, issues: [{ severity: "error", description: "Wrong", suggestedFix: null }] }), valid];
  let calls = 0;
  const output = await withReflectionFormatRepair({ async invoke() {
    const content = contents[calls++]!;
    return { message: { role: "assistant", content }, finishReason: "stop", usage: calls === 1 ? { outputTokens: 3 } : { inputTokens: 2, outputTokens: 4, totalTokens: 6 } };
  } }).invoke(input, signal());
  assert.equal(calls, 2);
  assert.deepEqual(output.usage, { outputTokens: 7 });
  const audit = output.message.metadata?.reflectionFormat as { usageKnown: boolean; observations: unknown[] };
  assert.equal(audit.usageKnown, false);
  assert.equal(audit.observations.length, 2);
  assert.equal(JSON.parse(String(output.message.content)).assessment.passed, false);
});

test("audit failures cannot trigger format retries for an already normalized response", async () => {
  let calls = 0;
  const failure = new Error("Audit write failed");
  const content = JSON.stringify({ assessment: { passed: false, summary: "Incorrect", issues: [{ severity: "error", description: "Wrong value" }] } });
  await assert.rejects(withReflectionFormatRepair({ async invoke() {
    calls++;
    return { message: { role: "assistant", content }, finishReason: "stop" };
  } }, () => { throw failure; }).invoke(input, signal()), error => error === failure);
  assert.equal(calls, 1, "Audit errors must not buy another model assessment");
});

test("format retries cannot flip a known verdict, remove issues, or replace the revised answer", async () => {
  const original = { assessment: { passed: false, summary: "Incorrect" }, issues: [{ severity: "error", description: "Wrong value", suggestedFix: null }],
    revisedResult: { role: "assistant", content: "11" } };
  const repaired = { ...original, issues: [{ severity: "error", description: "Wrong value" }] };
  const changes = [
    { ...repaired, assessment: { passed: true, summary: "Correct" }, issues: [] },
    { ...repaired, revisedResult: { role: "assistant", content: "7" } },
    { ...repaired, issues: [] },
  ];
  for (const changed of changes) {
    let calls = 0;
    await assert.rejects(withReflectionFormatRepair({ async invoke() {
      return { message: { role: "assistant", content: JSON.stringify(calls++ === 0 ? original : changed) }, finishReason: "stop" };
    } }).invoke(input, signal()), /REFLECT_FORMAT_ERROR/);
    assert.equal(calls, 3);
  }
  let calls = 0;
  const output = await withReflectionFormatRepair({ async invoke() {
    return { message: { role: "assistant", content: JSON.stringify(calls++ === 0 ? original : repaired) }, finishReason: "stop" };
  } }).invoke(input, signal());
  assert.equal(calls, 2);
  assert.deepEqual(JSON.parse(String(output.message.content)), repaired);
});

test("an unparseable first response cannot be used as permission to regenerate substantive findings", async () => {
  let calls = 0;
  await assert.rejects(withReflectionFormatRepair({ async invoke() {
    calls++;
    return { message: { role: "assistant", content: "not JSON" }, finishReason: "stop" };
  } }).invoke(input, signal()), /substantive fields cannot be safely preserved/);
  assert.equal(calls, 1);
});
