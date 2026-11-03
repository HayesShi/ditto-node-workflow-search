import type { RegisteredTool } from '@codesoul-co/ditto/worker/interaction';
import type { JsonObject } from '@codesoul-co/ditto/contracts';
import { BFCL_TOOLS, bfclScope } from '../benchmark/bfcl.js';

/** Tools are bound to one official conversation, never a process-global world. */
export function createBfclTools(): readonly RegisteredTool[] {
  const session=bfclScope.getStore();if(!session)return [];
  return session.tools.map(descriptor=>({
    name:descriptor.name,description:descriptor.description??'Official BFCL conversation interface',inputSchema:descriptor.inputSchema as JsonObject,
    effects:descriptor.name==='bfcl_state'?['read']:['read','write'],
    validate(args){if(!args||typeof args!=='object'||Array.isArray(args))throw Error('BFCL tool arguments must be an object');},
    async execute(args){
      if(bfclScope.getStore()!==session||!(BFCL_TOOLS as readonly string[]).includes(descriptor.name))throw Error('BFCL tool invoked outside its registered conversation');
      session.assertHealthy();const result=await session.call(descriptor.name,args);
      // Domain errors remain actual observations; transport faults throw above.
      return{status:'success',content:JSON.stringify(result),structuredContent:result as JsonObject};
    },
  }));
}
