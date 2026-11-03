import { AsyncLocalStorage } from "node:async_hooks";
import type { NodeType } from "@codesoul-co/ditto/contracts";
import type { WorkerDefinition } from "@codesoul-co/ditto/worker";

export interface CapabilityCompletion {
  readonly nodeType: NodeType;
  readonly graphId: string;
  readonly nodeId: string;
  readonly output: unknown;
}

export interface CapabilityInvocation extends Omit<CapabilityCompletion, "output"> {
  readonly input: unknown;
}

/** Host policy hooks at the actual native dispatch boundary, never a JSON interpreter. */
export interface CapabilityExecutionPolicy {
  readonly before?: (event: CapabilityInvocation) => unknown;
  readonly after?: (event: CapabilityCompletion) => unknown;
}

const completions = new AsyncLocalStorage<(event: CapabilityCompletion) => void>();
const policies = new AsyncLocalStorage<CapabilityExecutionPolicy>();

export function captureCapabilityExecution<T>(policy: CapabilityExecutionPolicy, operation: () => Promise<T>): Promise<T> {
  return policies.run(policy, operation);
}

/** Each concurrent workflow owns its completion ledger; nested calls retain that scope. */
export function captureCapabilityOutputs<T>(
  onComplete: (event: CapabilityCompletion) => void,
  operation: () => Promise<T>,
): Promise<T> {
  return completions.run(onComplete, operation);
}

/** Observe public Worker execution without changing contracts, routing or Graph scheduling. */
export function observeCapabilityWorkers(workers: readonly WorkerDefinition[]): WorkerDefinition[] {
  return workers.map(worker => ({
    ...worker,
    instantiate() {
      const executor = worker.instantiate();
      return {
        async execute(node, input, context) {
          const scope = context.execution;
          const prepared = scope && policies.getStore()?.before
            ? policies.getStore()!.before!({ nodeType: node, graphId: scope.graphId, nodeId: scope.nodeId, input }) : input;
          const output = await executor.execute(node, prepared, context);
          if (scope) completions.getStore()?.({ nodeType: node, graphId: scope.graphId, nodeId: scope.nodeId, output });
          return scope && policies.getStore()?.after
            ? policies.getStore()!.after!({ nodeType: node, graphId: scope.graphId, nodeId: scope.nodeId, output }) : output;
        },
        ...(executor.dispose ? { dispose: () => executor.dispose!() } : {}),
      };
    },
  }));
}
