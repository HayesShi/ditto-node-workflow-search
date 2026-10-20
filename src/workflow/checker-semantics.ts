import type { Message, ReflectOutput } from "@codesoul-co/ditto/worker/infer";
import type { CheckerAudit, ReflectNodeSpec } from "../domain.js";
import { CHECKER_POLICY } from "./checker-policy.js";

export interface ReflectionBinding {
  readonly target: Message;
  readonly targetNodeId: string;
  readonly feedback: readonly CheckerAudit[];
  readonly criteria: readonly string[];
}

export type CheckedReflectionOutput = ReflectOutput & {
  readonly message: Message;
  readonly answerSourceNodeId: string;
  readonly checkerAudit: CheckerAudit;
};

export function applyCheckerSemantics(node: ReflectNodeSpec, output: ReflectOutput, binding: ReflectionBinding): CheckedReflectionOutput {
  const actionable = (check: Pick<CheckerAudit, "assessment" | "issues">): boolean =>
    check.assessment.passed !== true && check.issues.some(issue => issue.severity === "error" && issue.description.trim().length > 0);
  const mayRevise = node.config.mode === "revise" && (binding.feedback.length
    ? binding.feedback.some(check => actionable(check) && (check.mode === "critique" || check.assessment.passed === false))
    : actionable(output));
  const message = mayRevise && output.revisedResult ? output.revisedResult : binding.target;
  const text = (value: Message): string => typeof value.content === "string" ? value.content : JSON.stringify(value.content);
  const audit: CheckerAudit = Object.freeze({
    policy: CHECKER_POLICY, nodeId: node.id, mode: node.config.mode, targetNodeId: binding.targetNodeId,
    originalAnswer: text(binding.target), assessment: structuredClone(output.assessment), issues: structuredClone(output.issues),
    ...(output.revisedResult ? { proposedAnswer: text(output.revisedResult) } : {}),
    finalAnswer: text(message), decision: node.config.mode !== "revise" ? "check-only" : mayRevise ? "revision-adopted" : "preserved-passed-or-no-error",
    feedbackNodeIds: Object.freeze(binding.feedback.map(check => check.nodeId)), criteria: binding.criteria,
  });
  return { ...output, message, answerSourceNodeId: mayRevise ? node.id : binding.targetNodeId, checkerAudit: audit };
}
