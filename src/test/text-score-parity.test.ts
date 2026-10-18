import assert from "node:assert/strict";
import test from "node:test";
import { extractLastNumber, normalizeDropAnswer, scoreDropAnswer, scoreGsm8kAnswer } from "../benchmark/text-scores.js";

// Independent reference from MFlow 9279d7d91bbce039656f5cd3a6bb539cea75fe85:
// src/grading.ts aflowDropScore and GSM8K branch, src/data.ts numeric score.
// Keep the reference's token matching and numeric parsing separate from production helpers.
function baselineDrop(gold: string, prediction: string): { score: 0 | 1; f1: number } {
  const tokens = (text: string) => text.toLowerCase()
    .replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, "")
    .replace(/\b(a|an|the)\b/g, " ").trim().split(/\s+/).filter(Boolean);
  let f1 = 0;
  for (const answer of gold.split("|").filter((part) => part.trim())) {
    const expected = tokens(answer);
    for (const part of prediction.split("|")) {
      const actual = tokens(part);
      const remaining = [...expected];
      let common = 0;
      for (const token of actual) {
        const index = remaining.indexOf(token);
        if (index >= 0) {
          common++;
          remaining.splice(index, 1);
        }
      }
      if (common) f1 = Math.max(f1, 2 * common / (expected.length + actual.length));
    }
  }
  return { score: f1 === 1 ? 1 : 0, f1 };
}

function baselineGsm8k(gold: string, prediction: string): 0 | 1 {
  const lastNumber = (text: string) => text.match(/[-+]?\d+(?:,\d{3})*(?:\.\d+)?|\d+\.\d+/g)?.at(-1) ?? "";
  const parse = (text: string) => {
    const clean = text.trim().replaceAll(",", "");
    return /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(clean) ? Number(clean) : NaN;
  };
  const expected = parse(lastNumber(gold));
  const actual = parse(lastNumber(prediction));
  return Number.isFinite(expected) && Number.isFinite(actual) && Math.abs(expected - actual) <= 1e-6 ? 1 : 0;
}

test("DROP matches pinned MFlow token F1 and binary exact match on alternatives and normalization", () => {
  const values = [
    "", " ", "|", "||", "a", "an", "the", "The a an", "!!!", "the|a|!",
    "The red fox", "fox|red fox", "red fox dog", "red cat", "red red fox", "red fox fox",
    "San Francisco | New York", "new york|Boston", "New-York", "New York", "York",
    "100", "1,000", "1000", "1.0", "1", "-5", "5", "-5.0", "5.0",
    "X\\Y", "XY", "C++", "c", "‘Fox’", "ＦＯＸ", "İ", "i", "i̇",
    "a+b=c", "abc", "  red\n\tfox  ", "answer: red fox because red fox", "fox || cat |",
  ];
  for (const reference of values) {
    for (const prediction of values) {
      const expected = baselineDrop(reference, prediction);
      const actual = scoreDropAnswer(reference, prediction);
      const label = JSON.stringify({ reference, prediction });
      assert.equal(actual.score, expected.f1, label);
      assert.equal(actual.details?.exactMatch, expected.score, label);
    }
  }
});

test("DROP empty normalization receives zero and punctuation/number rules preserve baseline quirks", () => {
  assert.equal(scoreDropAnswer("the", "a").score, 0);
  assert.equal(scoreDropAnswer("!", "?").score, 0);
  assert.equal(scoreDropAnswer("", "").score, 0);
  assert.equal(scoreDropAnswer("red fox dog", "red cat").score, 2 / 5);
  assert.equal(scoreDropAnswer("red red fox", "red fox fox").score, 2 / 3);
  assert.equal(scoreDropAnswer("New-York", "New York").score, 0);
  assert.equal(scoreDropAnswer("1.0", "1").score, 0);
  assert.equal(scoreDropAnswer("red fox", "red|fox").score, 2 / 3);
  assert.equal(scoreDropAnswer("red|fox", "fox").score, 1);
  assert.equal(normalizeDropAnswer("The A an [X]\\Y + = - _ `"), "xy");
});

test("GSM8K matches pinned MFlow last-number extraction and tolerance", () => {
  const values = [
    "", "none", "####", "0", "-0", "+5", "-5", "-5.25", "1,234", "1,23", "1,234,567.89",
    "1.", ".5", "-.5", "1e3", "-1e-3", "1/2", "2/1", "Answer: 1234.\nCheck: 2",
    "0.5", "0.5000009", "0.5000011", "42", "work 100 -> #### 42", "9".repeat(400),
  ];
  for (const reference of values) {
    for (const prediction of values) {
      assert.equal(scoreGsm8kAnswer(reference, prediction).score, baselineGsm8k(reference, prediction), JSON.stringify({ reference, prediction }));
    }
  }
});

test("GSM8K deliberately preserves the baseline regex instead of parsing mathematical notation", () => {
  assert.equal(extractLastNumber("1,234.50"), 1234.5);
  assert.equal(extractLastNumber("1e3"), 3);
  assert.equal(extractLastNumber("1/2"), 2);
  assert.equal(extractLastNumber(".5"), 5);
  assert.equal(extractLastNumber("-1e-3"), -3);
  assert.equal(scoreGsm8kAnswer("1234", "Answer: 1234. Check: 2").score, 0);
  assert.equal(scoreGsm8kAnswer("0.5", "0.5000009").score, 1);
  assert.equal(scoreGsm8kAnswer("0.5", "0.5000011").score, 0);
});
