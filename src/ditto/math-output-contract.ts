import type { ModelProvider } from '@codesoul-co/ditto/worker/infer';

// Exact formatting sentence from MFlow@437040f src/prompts.ts AGENT_PROMPT.
// The same requirement appears in aflow-seed.ts textPrompts agent/review/integrate.
export const MATH_OUTPUT_CONTRACT = String.raw`For mathematics, use exact quantities and put the final answer in \boxed{...}; for a word or option use \boxed{\text{...}}.`;

/** A fixed dataset output contract, shared by all searched organizations.
 * No finalizer, extra generation, answer extraction or reference lookup.
 */
export function withMathOutputContract(provider:ModelProvider):ModelProvider {
  return {async invoke(input,options) {
    if(input.metadata?.dataset!=='math' || !String(input.metadata?.nodeType).startsWith('INFER.REASONING.') || input.metadata?.phase==='reflect-format-repair')
      return provider.invoke(input,options);
    const structured=['INFER.REASONING.REFLECT','INFER.REASONING.DELIBERATE'].includes(String(input.metadata.nodeType));
    let contract=MATH_OUTPUT_CONTRACT+(structured
      ? ' Apply this formatting inside the result message content when the node returns a mathematical answer. Keep the existing outer JSON schema; an assessment alone does not require an answer.'
      : ' Apply this formatting when returning a mathematical answer, not inside tool arguments.');
    if(input.metadata.nodeType==='INFER.REASONING.REFLECT') {
      const payload=JSON.parse(String(input.messages.at(-1)?.content)) as {mode?:string};
      if(payload.mode==='revise') contract+=String.raw` This request is mode=revise: revisedResult is REQUIRED, with role="assistant" and content containing the full revised solution ending in \boxed{answer}. assessment.summary is an assessment, not the delivered solution. If the solution is correct, confirm it and restate its final answer in revisedResult.content.`;
      else if(payload.mode==='verify')contract+=' This request is mode=verify: assessment.passed must be a boolean.';
    }
    const messages=[...input.messages];
    const firstSystem=messages.findIndex(m=>m.role==='system');
    if(firstSystem>=0 && typeof messages[firstSystem]!.content==='string') {
      const original=messages[firstSystem]!;
      messages[firstSystem]={...original,content:original.content+'\n\n'+contract};
    } else messages.unshift({role:'system',content:contract});
    return provider.invoke({...input,messages},options);
  }};
}
