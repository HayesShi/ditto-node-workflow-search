import type { GraphTransition } from '../domain.js';

/** Only topology is generated. Template implementations and configs are trusted code. */
export interface OrganizationSpec {
  readonly version: 1;
  readonly dataset: 'math' | 'automationbench';
  readonly nodes: readonly { readonly id: string; readonly template: string; readonly dependencies: readonly string[]; readonly feedback?: readonly string[];
    /** Direct result dependency assessed/revised by this REFLECT node. */
    readonly targetNodeId?: string }[];
  readonly graphs: readonly { readonly id: string; readonly nodeIds: readonly string[] }[];
  readonly entryGraphId: string;
  readonly transitions: Readonly<Record<string, GraphTransition>>;
  /** Explicit delivery source on a terminating graph; omitted entries use outputNodeId. */
  readonly outputByGraph?: Readonly<Record<string, string>>;
  readonly outputNodeId: string;
}
