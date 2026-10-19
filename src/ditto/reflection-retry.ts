import { isDeepStrictEqual } from "node:util";
import type { SampleOutput } from "@codesoul-co/ditto/worker/infer";
import { prepareReflectionRetryAnchor } from "./reflection-normalization.js";

/** Missing or ambiguous substantive information cannot be reconstructed as a format retry. */
export function reflectionRetryAnchor(content: SampleOutput["message"]["content"], mode: string): string | undefined {
  try { return prepareReflectionRetryAnchor(content, mode); }
  catch { return undefined; }
}

/** Compare every supplied value, allowing only unavailable optional fixes to be omitted. */
export function assertReflectionRetryPreserves(anchor: string, normalized: string): void {
  // The anchor was checked in its actual mode. Critique still checks every supplied
  // field here; strict equality rejects missing verify/revise fields as well.
  const before: unknown = JSON.parse(prepareReflectionRetryAnchor(anchor, "critique"));
  const after: unknown = JSON.parse(prepareReflectionRetryAnchor(normalized, "critique"));
  if (!isDeepStrictEqual(before, after)) throw new Error("REFLECT format correction changed response values");
}
