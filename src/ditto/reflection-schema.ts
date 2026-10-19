import type { SampleOutput } from "@codesoul-co/ditto/worker/infer";

/** Mirrors @codesoul-co/ditto@0.1.1 reflect/schema.js; no coercion or normalization. */
export function validateReflectionResponse(content: SampleOutput["message"]["content"], mode: string): void {
  let result: Record<string, unknown>;
  try {
    if (typeof content !== "string") throw new Error();
    result = object(JSON.parse(content.replace(/^\s*```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "")), "model output");
  } catch { throw new Error("Model must return a valid JSON object"); }
  const assessment = object(result.assessment, "assessment");
  text(assessment.summary, "assessment.summary", true);
  if (assessment.passed !== undefined && typeof assessment.passed !== "boolean") throw new Error("assessment.passed must be boolean");
  if (mode === "verify" && typeof assessment.passed !== "boolean") throw new Error("verify requires assessment.passed");
  if (!Array.isArray(result.issues)) throw new Error("issues must be an array");
  for (const raw of result.issues) {
    const issue = object(raw, "issue");
    if (!["info", "warning", "error"].includes(String(issue.severity))) throw new Error("Invalid issue severity");
    text(issue.description, "issue.description");
    if (issue.suggestedFix !== undefined) text(issue.suggestedFix, "suggestedFix", true);
  }
  if (result.revisedResult !== undefined) message(result.revisedResult);
  if (mode === "revise") message(result.revisedResult);
}
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, empty = false): void {
  if (typeof value !== "string" || (!empty && !value.trim())) throw new Error(`${name} must be a string${empty ? "" : " (nonempty)"}`);
}
function message(value: unknown): void {
  const record = object(value, "message");
  if (!["system", "user", "assistant", "tool"].includes(String(record.role))) throw new Error("Invalid message role");
  if (typeof record.content !== "string" && !Array.isArray(record.content)) throw new Error("Invalid message content");
  if (record.metadata !== undefined) object(record.metadata, "message.metadata");
}
