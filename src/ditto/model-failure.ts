import { AsyncLocalStorage } from 'node:async_hooks';

export interface ModelFailure {
  readonly source: 'model-output';
  readonly code: 'DEGENERATE_OUTPUT' | 'MODEL_CONTEXT_LIMIT' | 'REFLECT_FORMAT_ERROR';
  readonly nodeId?: string;
}
const scope = new AsyncLocalStorage<ModelFailure[]>();
const infrastructure = new AsyncLocalStorage<{failed:boolean}>();
const node = new AsyncLocalStorage<{id?:string;modelFailure:boolean}>();
export function captureModelFailures<T>(run: (records: ModelFailure[]) => T): T {
  const records: ModelFailure[] = [];
  return infrastructure.run({failed:false}, () => scope.run(records, () => run(records)));
}
export function hasProviderFailure(): boolean { return infrastructure.getStore()?.failed === true; }
export function withModelNode<T>(id: unknown, run: () => Promise<T>): Promise<T> {
  const current={...(typeof id === 'string'?{id}:{}),modelFailure:false};
  return node.run(current,async()=>{
    try { return await run(); }
    catch(error) {
      const health=infrastructure.getStore();
      if(health && !current.modelFailure) health.failed=true;
      throw error;
    }
  });
}
/** Capture at fetch time: child-process callbacks do not retain the caller's scope. */
export function modelFailureRecorder(): (value: unknown) => void {
  const records = scope.getStore(), current = node.getStore(), health=infrastructure.getStore();
  return (value) => {
    if (!value || typeof value !== 'object') {if(health)health.failed=true;return;}
    const failure = value as Partial<ModelFailure>;
    if (failure.source !== 'model-output' || !['DEGENERATE_OUTPUT', 'MODEL_CONTEXT_LIMIT', 'REFLECT_FORMAT_ERROR'].includes(failure.code ?? '')) {if(health)health.failed=true;return;}
    if(current)current.modelFailure=true;
    records?.push({ source: 'model-output', code: failure.code!, ...(current?.id ? { nodeId:current.id } : {}) });
  };
}
