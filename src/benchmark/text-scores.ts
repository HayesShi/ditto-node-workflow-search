import type { ScoreEvidence } from "../domain.js";
import { scoreMathAnswer } from "./math-score.js";

export function normalizeDropAnswer(value: string): string {
  // MFlow aflowDropScore, pinned at 9279d7d91bbce039656f5cd3a6bb539cea75fe85.
  // In this protocol punctuation is deleted, and numbers are not canonicalized.
  return value.toLowerCase()
    .replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, "")
    .replace(/\b(a|an|the)\b/g, " ").trim().split(/\s+/).filter(Boolean).join(" ");
}

/** AFlow-compatible maximum token-F1 across pipe-separated gold/prediction alternatives. */
export function scoreDropAnswer(reference: string, prediction: string): ScoreEvidence {
  const expectedAlternatives = reference.split("|").map((part) => part.trim()).filter(Boolean);
  const predictionAlternatives = prediction.split("|").map((part) => part.trim());
  let best = 0;
  let bestExpected = expectedAlternatives[0] ?? "";
  let bestPrediction = predictionAlternatives[0] ?? "";
  for (const expected of expectedAlternatives) {
    for (const predicted of predictionAlternatives) {
      const score = tokenF1(normalizeDropAnswer(expected), normalizeDropAnswer(predicted));
      if (score > best) {
        best = score;
        bestExpected = expected;
        bestPrediction = predicted;
      }
    }
  }
  return Object.freeze({
    score: best,
    expected: bestExpected,
    prediction,
    normalizedExpected: normalizeDropAnswer(bestExpected),
    normalizedPrediction: normalizeDropAnswer(bestPrediction),
    method: "drop-token-f1-max-alternatives",
    details: Object.freeze({ alternatives: expectedAlternatives.length, exactMatch: best === 1 ? 1 : 0 }),
  });
}

export function extractLastNumber(value: string): number | undefined {
  const matches = value.match(/[-+]?\d+(?:,\d{3})*(?:\.\d+)?|\d+\.\d+/g);
  if (!matches?.length) return undefined;
  const number = Number(matches[matches.length - 1]!.replace(/,/g, ""));
  return Number.isFinite(number) ? number : undefined;
}

export function scoreGsm8kAnswer(reference: string, prediction: string): ScoreEvidence {
  const expectedNumber = extractLastNumber(reference);
  const predictedNumber = extractLastNumber(prediction);
  const matched = expectedNumber !== undefined && predictedNumber !== undefined && Math.abs(expectedNumber - predictedNumber) <= 1e-6;
  return Object.freeze({
    score: matched ? 1 : 0,
    expected: reference,
    prediction,
    normalizedExpected: expectedNumber === undefined ? "" : String(expectedNumber),
    normalizedPrediction: predictedNumber === undefined ? "" : String(predictedNumber),
    method: "gsm8k-last-number-exact",
  });
}

export function scoreCompetitionMathAnswer(reference: string, prediction: string): ScoreEvidence {
  const scored = scoreMathAnswer(reference, prediction);
  return Object.freeze({
    score: scored.score,
    expected: scored.expected,
    prediction,
    normalizedExpected: scored.normalizedExpected,
    normalizedPrediction: scored.normalizedPrediction,
    method: `math-balanced-boxed-${scored.equivalence}`,
    details: Object.freeze({ extraction: scored.extraction, equivalence: scored.equivalence }),
  });
}

function tokenF1(expected: string, prediction: string): number {
  const expectedTokens = expected ? expected.split(" ") : [];
  const predictionTokens = prediction ? prediction.split(" ") : [];
  // AFlow awards no credit without a shared token, including two empty answers.
  if (!expectedTokens.length || !predictionTokens.length) return 0;

  const expectedCounts = counts(expectedTokens);
  const predictionCounts = counts(predictionTokens);
  let common = 0;
  for (const [token, amount] of expectedCounts) common += Math.min(amount, predictionCounts.get(token) ?? 0);
  if (!common) return 0;
  return 2 * common / (expectedTokens.length + predictionTokens.length);
}

function counts(tokens: readonly string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const token of tokens) result.set(token, (result.get(token) ?? 0) + 1);
  return result;
}
