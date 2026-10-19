import { AsyncLocalStorage } from "node:async_hooks";
import type { WorkerDefinition } from "@codesoul-co/ditto/worker";
import type { ModelProvider, NodeResult, SampleOutput, Message } from "@codesoul-co/ditto/worker/infer";
import { validateReflectionResponse } from "./reflection-schema.js";
import type { GenerationOutcome } from "../domain.js";

/** Application policy for normal budget exhaustion; transport faults never enter here. */
export function budgetOutputBoundary() {
  const responses = new AsyncLocalStorage<SampleOutput[]>();
  return {
    provider(provider: ModelProvider): ModelProvider {
      return { async invoke(input, options) {
        const output = await provider.invoke(input, options);
        if (output.finishReason === "length") responses.getStore()?.push(output);
        return output; // Keep the real finish reason visible to the published Worker.
      } };
    },
    worker(worker: WorkerDefinition): WorkerDefinition {
      return { ...worker, instantiate() {
        const original = worker.instantiate();
        return { ...original, execute(node, input, context) {
          if (node !== "INFER.REASONING.REFLECT" && node !== "INFER.REASONING.DELIBERATE") return original.execute(node, input, context);
          return responses.run([], async () => {
            const result = await original.execute(node, input, context) as NodeResult<unknown>;
            const response = responses.getStore()?.at(-1);
            if (!response || result.status === "success" || result.error?.code !== "INCOMPLETE_MODEL_OUTPUT") return result;
            const request = input as { mode: string; metadata?: Record<string, unknown>; candidates?: { id: string; result: Message }[]; selectCount?: number };
            let output: Record<string, unknown>;
            let parseError: string | undefined;
            try {
              const parsed = parseObject(response.message.content);
              if (node === "INFER.REASONING.REFLECT") {
                validateReflectionResponse(response.message.content, request.mode);
                output = { assessment: parsed.assessment, issues: parsed.issues, ...(parsed.revisedResult ? { revisedResult: parsed.revisedResult } : {}) };
              } else {
                validateDeliberation(parsed, request);
                output = { ...parsed, result: request.mode === "select"
                  ? request.candidates!.find(candidate => candidate.id === (parsed.selectedCandidateIds as string[])[0])!.result : parsed.result };
              }
            } catch (error) {
              parseError = error instanceof Error ? error.message : String(error);
              // Do not silently fall back to an earlier correct answer for unusable output.
              output = { message: { role: "assistant", content: "" }, finishReason: "length" };
            }
            const generationOutcome: GenerationOutcome = {
              nodeId: String(request.metadata?.nodeId ?? node), nodeType: node,
              finishReason: "length", usable: parseError === undefined, content: response.message.content,
              ...(parseError ? { parseError } : {}),
            };
            const { error: _error, ...base } = result;
            return { ...base, status: "success", output: { ...output, ...(response.usage ? { usage: response.usage } : {}), generationOutcome } };
          });
        } };
      } };
    },
  };
}

function parseObject(content: unknown): Record<string, unknown> {
  if (typeof content !== "string") throw Error("Structured output must be text");
  const value: unknown = JSON.parse(content.replace(/^\s*```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, ""));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Structured output must be an object");
  return value as Record<string, unknown>;
}

/** Published 0.1.1 DELIBERATE output constraints; no output repair or coercion. */
function validateDeliberation(value: Record<string, unknown>, input: { mode: string; candidates?: { id: string; result: Message }[]; selectCount?: number }): void {
  const result = value.result as Message | undefined;
  if (!result || typeof result !== "object" || !["assistant", "user", "system", "tool"].includes(result.role) ||
      typeof result.content !== "string" && !Array.isArray(result.content)) throw Error("Invalid result message");
  if (result.metadata !== undefined && (!result.metadata || typeof result.metadata !== "object" || Array.isArray(result.metadata))) throw Error("Invalid result metadata");
  const ids = new Set(input.candidates?.map(candidate => candidate.id));
  const selected = value.selectedCandidateIds;
  if (selected !== undefined && (!Array.isArray(selected) || new Set(selected).size !== selected.length || selected.some(id => typeof id !== "string" || !ids.has(id)))) throw Error("Invalid selected IDs");
  if (input.mode === "select" && (!Array.isArray(selected) || selected.length !== (input.selectCount ?? 1))) throw Error("select requires exactly selectCount IDs");
  if (value.assessments !== undefined) {
    if (!Array.isArray(value.assessments)) throw Error("Invalid assessments");
    const seen = new Set();
    for (const raw of value.assessments) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("Invalid assessment");
      const item = raw as Record<string, unknown>;
      if (!ids.has(String(item.candidateId)) || seen.has(item.candidateId)) throw Error("Unknown or repeated assessed ID");
      seen.add(item.candidateId);
      if (item.score !== undefined && (typeof item.score !== "number" || !Number.isFinite(item.score))) throw Error("Invalid score");
      if (item.accepted !== undefined && typeof item.accepted !== "boolean") throw Error("Invalid accepted flag");
      if (item.summary !== undefined && typeof item.summary !== "string") throw Error("Invalid assessment summary");
    }
  }
  if (value.decisionSummary !== undefined && typeof value.decisionSummary !== "string") throw Error("Invalid decision summary");
}
