import assert from "node:assert/strict";
import test from "node:test";
import { normalizeReflectionResponse } from "../ditto/reflection-normalization.js";
import { assertReflectionRetryPreserves, reflectionRetryAnchor } from "../ditto/reflection-retry.js";

const source = {
  assessment: { passed: false, summary: "Incorrect arithmetic" },
  issues: [{ severity: "error", description: "Wrong value", suggestedFix: null, code: "keep" }],
  revisedResult: { role: "assistant", content: "11", metadata: { origin: "model", extra: [false, 0, null] } },
  other: { retained: true },
};
const corrected = {
  ...source,
  issues: [{ severity: "error", description: "Wrong value", code: "keep" }],
};

test("retry anchor omits only null suggestedFix while retaining every issue and substantive value", () => {
  const content = JSON.stringify(source);
  assert.throws(() => normalizeReflectionResponse(content, "revise"), /suggestedFix/);
  const anchor = reflectionRetryAnchor(content, "revise");
  assert.ok(anchor);
  assert.deepEqual(JSON.parse(anchor), corrected);
  assertReflectionRetryPreserves(anchor, JSON.stringify(corrected));
  assertReflectionRetryPreserves(anchor, content);
  assert.equal(JSON.stringify(source), content, "The source evidence must remain immutable");
});

test("retries cannot flip verdicts, remove findings, rewrite answers, summaries or unknown metadata", () => {
  const anchor = reflectionRetryAnchor(JSON.stringify(source), "revise")!;
  for (const changed of [
    { ...corrected, assessment: { ...corrected.assessment, passed: true } },
    { ...corrected, assessment: { ...corrected.assessment, summary: "Now correct" } },
    { ...corrected, issues: [] },
    { ...corrected, issues: [{ ...corrected.issues[0], severity: "info" }] },
    { ...corrected, issues: [{ ...corrected.issues[0], description: "Different finding" }] },
    { ...corrected, issues: [{ ...corrected.issues[0], suggestedFix: "Invented fix" }] },
    { ...corrected, revisedResult: { ...corrected.revisedResult, content: "7" } },
    { ...corrected, revisedResult: { ...corrected.revisedResult, metadata: {} } },
    { ...corrected, other: {} },
  ]) assert.throws(() => assertReflectionRetryPreserves(anchor, JSON.stringify(changed)), /changed response values/);
});

test("missing substantive fields, ambiguity and nulls outside optional fixes cannot create anchors", () => {
  for (const [content, mode] of [
    ["not JSON", "verify"],
    [JSON.stringify({ assessment: { summary: "No verdict" }, issues: [] }), "verify"],
    [JSON.stringify({ assessment: source.assessment }), "verify"],
    [JSON.stringify({ assessment: source.assessment, issues: [] }), "revise"],
    [JSON.stringify({ assessment: { ...source.assessment, passed: null }, issues: [] }), "verify"],
    [JSON.stringify({ ...source, revisedResult: null }), "revise"],
    [JSON.stringify({ ...source, issues: [{ severity: "error", description: null, suggestedFix: null }] }), "verify"],
    ['{"assessment":{"passed":false,"passed":true,"summary":"ambiguous"},"issues":[]}', "verify"],
    [JSON.stringify({ ...source, assessment: { ...source.assessment, issues: [] } }), "verify"],
    ['{"assessment":{"passed":false,"summary":"raw "quote""},"issues":[]}', "verify"],
  ] as const) assert.equal(reflectionRetryAnchor(content, mode), undefined);
  assert.equal(reflectionRetryAnchor([], "verify"), undefined);
});

test("safe syntax and field placement repairs remain available to retry anchors", () => {
  const nested = JSON.stringify({ assessment: { ...source.assessment, issues: source.issues, revisedResult: source.revisedResult }, other: source.other });
  const anchor = reflectionRetryAnchor(nested + "}", "revise");
  assert.ok(anchor);
  assert.deepEqual(JSON.parse(anchor), corrected);
  assertReflectionRetryPreserves(anchor, "```json\n" + JSON.stringify(corrected, null, 2) + "\n```");
  const escaped = String.raw`{"assessment":{"passed":false,"summary":"literal \]"},"issues":[]}`;
  assert.ok(reflectionRetryAnchor(escaped, "verify"));
});

test("duplicate keys and lossy numeric serialization stay refused during retry preparation", () => {
  const duplicate = '{"assessment":{"passed":false,"summary":"ok"},"issues":[],"other":{"x":1,"x":2}}';
  assert.equal(reflectionRetryAnchor(duplicate, "verify"), undefined);
  const numeric = '{"assessment":{"passed":false,"summary":"ok"},"issues":[{"severity":"error","description":"wrong","suggestedFix":null}],"other":-0}';
  assert.equal(reflectionRetryAnchor(numeric, "verify"), undefined);
  const anchor = reflectionRetryAnchor(JSON.stringify(corrected), "verify")!;
  assert.throws(() => assertReflectionRetryPreserves(anchor, duplicate), /Ambiguous duplicate/);
});
