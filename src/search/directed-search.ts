import { isDeepStrictEqual } from "node:util";
import type { AgentPlanSpec, DatasetName, EvaluationSummary } from "../domain.js";
import { assertValidEvaluation } from "../benchmark/evaluator.js";
import { createInitialSampleNode, createRootNode } from "../workflow/spec.js";
import { checkAFlowConvergence } from "./convergence.js";
import { ProposalValidationError } from "./proposer.js";
import { DIRECTED_SEARCH_POLICY, directedPlan, directedPlanHash, type WorkflowProposal, type WorkflowProposalRequest } from "./directed-proposer.js";

export interface PendingDirectedCandidate {
  readonly id: string;
  readonly plan: AgentPlanSpec;
  readonly planHash: string;
  readonly referenceCandidateId: string | null;
  readonly rationale: string;
}
export interface DirectedCandidate extends PendingDirectedCandidate {
  readonly status: "valid" | "invalid";
  readonly evaluation?: EvaluationSummary;
  readonly failureCounts?: Readonly<Record<string, number>>;
}
export interface DirectedSearchState {
  readonly schemaVersion: 2;
  readonly policy: typeof DIRECTED_SEARCH_POLICY;
  readonly validEvaluations: number;
  readonly nextCandidateIndex: number;
  readonly proposalFailures: number;
  readonly history: readonly DirectedCandidate[];
  readonly pending?: PendingDirectedCandidate;
}
export interface DirectedSearchOptions {
  readonly dataset?: DatasetName;
  readonly maxValidEvaluations: number;
  readonly patience: number;
  readonly taskGoal: string;
  readonly initialInstruction?: string;
  readonly propose: (request: WorkflowProposalRequest) => Promise<WorkflowProposal>;
  readonly evaluate: (plan: AgentPlanSpec) => Promise<EvaluationSummary>;
  readonly resume?: DirectedSearchState;
  readonly save?: (state: DirectedSearchState) => Promise<void>;
  readonly candidate?: (candidate: DirectedCandidate, state: DirectedSearchState) => Promise<void>;
  readonly event?: (value: Readonly<Record<string, unknown>>) => Promise<void>;
}

/** Candidate provenance is model-chosen. No sampled parent, tree backpropagation or append-only expansion. */
export async function searchDirectedWorkflows(options: DirectedSearchOptions): Promise<{
  readonly state: DirectedSearchState; readonly best: DirectedCandidate; readonly stoppedBecause: "valid-budget" | "converged";
}> {
  if (!Number.isSafeInteger(options.maxValidEvaluations) || options.maxValidEvaluations < 1 || !Number.isSafeInteger(options.patience) || options.patience < 1) throw new Error("Invalid valid-experiment budget or convergence patience");
  let state: DirectedSearchState = options.resume ? structuredClone(options.resume) : {
    schemaVersion: 2, policy: DIRECTED_SEARCH_POLICY, validEvaluations: 0, nextCandidateIndex: 1, proposalFailures: 0, history: [],
  };
  validateDirectedState(state, options.dataset);
  if (state.validEvaluations > options.maxValidEvaluations) throw new Error("Resume contains more valid experiments than the requested budget");
  const event = options.event ?? (async () => undefined);
  const save = async () => options.save?.(state);
  let repeatedFailure = "", repeatedCount = 0;
  let stoppedBecause: "valid-budget" | "converged" = "valid-budget";
  while (state.validEvaluations < options.maxValidEvaluations) {
    const valid = state.history.filter(candidate => candidate.status === "valid");
    if (!state.pending && checkAFlowConvergence(valid.map(candidate => candidate.evaluation!), 3, 0, options.patience).converged) { stoppedBecause = "converged"; break; }
    if (!state.pending) {
      const id = `search-${String(state.nextCandidateIndex).padStart(3, "0")}`;
      let pending: PendingDirectedCandidate;
      if (!state.history.length) {
        const plan = directedPlan(id, [createRootNode(), createInitialSampleNode(options.initialInstruction)], options.dataset);
        pending = { id, plan, planHash: directedPlanHash(plan), referenceCandidateId: null, rationale: "Frozen initial solver seed; this valid evaluation counts toward the total budget." };
      } else {
        const prepare = (proposal: WorkflowProposal): PendingDirectedCandidate => {
          if (proposal.referenceCandidateId !== null && !state.history.some(candidate => candidate.id === proposal.referenceCandidateId)) throw new ProposalValidationError("referenceCandidateId is not in the public workflow history");
          let plan: AgentPlanSpec;
          try { plan = directedPlan(id, proposal.nodes, options.dataset); }
          catch (error) { throw new ProposalValidationError(error instanceof Error ? error.message : String(error)); }
          const planHash = directedPlanHash(plan);
          if (state.history.some(candidate => candidate.planHash === planHash)) throw new ProposalValidationError("Duplicate workflow (renaming IDs alone is not a new experiment)");
          return { id, plan, planHash, referenceCandidateId: proposal.referenceCandidateId, rationale: proposal.rationale };
        };
        try {
          const proposal = await options.propose({ ...(options.dataset ? { dataset: options.dataset } : {}), taskGoal: options.taskGoal, history: state.history,
            validate: value => void prepare(value) });
          pending = prepare(proposal); // Custom proposers are also validated here.
        } catch (error) {
          if (!(error instanceof ProposalValidationError)) { await save(); throw error; }
          state = { ...state, proposalFailures: state.proposalFailures + 1 }; await save();
          await event({ type: "proposal-failed", validEvaluations: state.validEvaluations, error: error.message });
          repeatedCount = repeatedFailure === error.message ? repeatedCount + 1 : 1; repeatedFailure = error.message;
          if (repeatedCount >= 3 || state.proposalFailures >= 100) throw new Error("Repeated invalid/duplicate workflow proposals require repair; no valid-experiment budget was consumed");
          continue;
        }
      }
      state = { ...state, pending, nextCandidateIndex: state.nextCandidateIndex + 1 };
      await save();
      await event({ type: "candidate-proposed", candidateId: pending.id, referenceCandidateId: pending.referenceCandidateId,
        validEvaluations: state.validEvaluations, planHash: pending.planHash, nodeCount: pending.plan.nodes.length });
    }
    const pending = state.pending!;
    let evaluation: EvaluationSummary;
    try { evaluation = await options.evaluate(pending.plan); }
    catch (error) { await save(); await event({ type: "evaluation-interrupted", candidateId: pending.id, validEvaluations: state.validEvaluations }); throw error; }
    let accepted = true;
    try { assertCompleteDirectedEvaluation(evaluation); } catch { accepted = false; }
    const failureCounts = Object.fromEntries(["provider", "execution", "timeout", "judge"].map(kind => [kind, evaluation.results.filter(row => row.failureKind === kind).length]));
    const candidate: DirectedCandidate = accepted ? { ...pending, status: "valid", evaluation }
      : { ...pending, status: "invalid", failureCounts }; // No placeholder score or private errors in optimizer feedback.
    const { pending: _pending, ...completed } = state;
    state = { ...completed, validEvaluations: state.validEvaluations + (accepted ? 1 : 0), history: [...state.history, candidate] };
    await save();
    await options.candidate?.(candidate, state);
    await event({ type: accepted ? "valid-experiment-completed" : "invalid-experiment-excluded", candidateId: candidate.id,
      validEvaluations: state.validEvaluations, budget: options.maxValidEvaluations, ...(accepted ? { score: evaluation.score } : { failureCounts }) });
    if (accepted) { repeatedFailure = ""; repeatedCount = 0; }
    else {
      repeatedCount = repeatedFailure === "invalid-evaluation" ? repeatedCount + 1 : 1; repeatedFailure = "invalid-evaluation";
      if (repeatedCount >= 3) throw new Error("Three invalid workflow evaluations require inspection; remaining valid-experiment budget is preserved");
    }
  }
  const best = [...state.history].filter(candidate => candidate.status === "valid").sort((a, b) => b.evaluation!.score - a.evaluation!.score || a.id.localeCompare(b.id))[0];
  if (!best) throw new Error("No completed valid experiment is available");
  return { state, best, stoppedBecause };
}

export function assertCompleteDirectedEvaluation(value: EvaluationSummary): void {
  assertValidEvaluation(value);
  if (value.valid !== true || value.results.length !== value.examples * value.repeats || new Set(value.results.map(row => row.caseId)).size !== value.results.length) throw new Error("Valid-experiment budget requires a complete unique case/repeat collection");
}
export function validateDirectedState(state: DirectedSearchState, dataset?: DatasetName): void {
  if (state.schemaVersion !== 2 || state.policy !== DIRECTED_SEARCH_POLICY || !Number.isSafeInteger(state.validEvaluations) || state.validEvaluations < 0 || !Number.isSafeInteger(state.nextCandidateIndex) || state.nextCandidateIndex < 1) throw new Error("Unsupported optimizer-directed search state");
  const ids = new Set<string>(), hashes = new Set<string>(); let count = 0;
  for (const candidate of [...state.history, ...(state.pending ? [state.pending] : [])]) {
    if (!/^search-\d+$/.test(candidate.id) || ids.has(candidate.id) || hashes.has(candidate.planHash) || Number(candidate.id.slice(7)) >= state.nextCandidateIndex) throw new Error("Duplicate or inconsistent candidate state");
    if (candidate.referenceCandidateId !== null && !ids.has(candidate.referenceCandidateId)) throw new Error("Candidate reference is not an earlier observed workflow");
    const rebuilt = directedPlan(candidate.id, candidate.plan.nodes, dataset);
    if (!isDeepStrictEqual(rebuilt, candidate.plan) || directedPlanHash(rebuilt) !== candidate.planHash) throw new Error("Candidate plan/state hash mismatch");
    ids.add(candidate.id); hashes.add(candidate.planHash);
    if ("status" in candidate) {
      const completed = candidate as DirectedCandidate;
      if (completed.status === "valid") { if (!completed.evaluation) throw new Error("Valid candidate lacks evaluation"); assertCompleteDirectedEvaluation(completed.evaluation); count++; }
      else if (completed.status !== "invalid" || completed.evaluation !== undefined) throw new Error("Invalid candidate cannot carry a ranking score");
    }
  }
  if (count !== state.validEvaluations) throw new Error("Valid-experiment budget accounting mismatch");
}
