import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatasetName } from "../domain.js";
import { validateDirectedState, type DirectedSearchState } from "../search/directed-search.js";

/** Restore the exact latest state, including a partially evaluated pending candidate. */
export async function loadDirectedResume(directory: string, completed: number, dataset: DatasetName): Promise<{
  manifest: Record<string, unknown>; state: DirectedSearchState;
}> {
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as Record<string, unknown>;
  const state = JSON.parse(await readFile(join(directory, "resume-state.json"), "utf8")) as DirectedSearchState;
  validateDirectedState(state, dataset);
  if (state.validEvaluations !== completed) throw new Error("--resume-round must equal the latest completed valid-evaluation count; historical branches require a separate run");
  return { manifest, state };
}
