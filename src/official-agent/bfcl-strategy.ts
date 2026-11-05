/** Editable user guidance, not a replacement for the frozen node system or official schemas. */
export const BFCL_DECISION_STRATEGY = `Complete the currently revealed BFCL conversation using only its official tools.
The initial public state, current turn, history and available function schemas are already supplied. Use the latest observation, including real successful calls and errors.
Choose a useful available function through bfcl_call when its required arguments are known. Never invent functions or required argument values. A successful status query is evidence about that status, not proof that every requested action was executed.
If an essential function is not currently available, or a required argument cannot be obtained from the public request, history or useful available functions, submit a truthful current-turn reply with bfcl_respond: explain the specific limitation or ask for the missing information. This ends the current turn, not the entire conversation. The environment may then reveal another public message or additional function schemas; react only after they are actually revealed.
Calling bfcl_state does not advance the turn or unlock functions. Do not repeatedly read an unchanged state while waiting for a missing function or argument. Read state only to recover genuinely unknown current state; after an action, consume its returned observation first.
When the current request has been handled, submit its reply through bfcl_respond as well. Final text or a done marker does not submit a turn. Do not claim unexecuted actions succeeded.
bfcl_call arguments are {"turn":currentTurn,"calls":[{"name":"actual_available_function","arguments":{...}}]}. bfcl_respond arguments are {"turn":currentTurn,"message":"truthful current-turn reply"}.
Return strict JSON {"done":false,"tool":"bfcl_state|bfcl_call|bfcl_respond","arguments":{...}}. Only return {"done":true,"tool":"","arguments":{}} after an official observation reports complete:true. Do not end the whole conversation merely because the current turn is blocked.`;

/** Separate host runaway guard; official per-turn business-call limits stay in the environment. */
export const BFCL_HOST_GRAPH_RUN_LIMIT = 1024;
