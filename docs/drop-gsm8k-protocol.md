# DROP / GSM8K formal evaluation

New benchmark and optimizer calls share `src/model-profile.ts`: official DeepSeek
`deepseek-flash`, thinking disabled, temperature 0, `max_tokens=393216`, `n=1`,
text output and upstream streaming. `top_p`, `reasoning_effort`, and provider seed
are omitted. The local search seed does not control model sampling. The bridge
also enforces these values at HTTP serialization, including nested `extra_body`
overrides. The token value is a requested per-response ceiling, not a guarantee
that the provider will accept or produce that many tokens.

Trajectory steps and the execution Loop use `Number.MAX_SAFE_INTEGER`; there is
no aggregate per-task token or tool-call budget. Program-defined routing,
strategy termination and repeat conditions still determine when a workflow ends.
Protocol `mflow-fixed-flash-v3` distinguishes new runs from historical MATH runs;
historical results are not relabelled or resumed with changed settings.

## Fixed data

The authority is [MFlow at commit 9279d7d91bbce039656f5cd3a6bb539cea75fe85](https://github.com/erwinmsmith/MFlow/tree/9279d7d91bbce039656f5cd3a6bb539cea75fe85),
protocol `aflow-fixed-v1`, with AFlow source commit
`3f457218fc716093fe53f6df8a5d5e6379d66346`. Its data lock takes priority over
older experiment documentation. `src/benchmark/fixed-splits.ts` copies all ten
raw-file SHA-256 identities and counts from MFlow's `data/aflow.lock.json`.

| Dataset | Search (`validate`) | Test |
| --- | ---: | ---: |
| DROP | 200 | 800 |
| GSM8K | 264 | 1055 |
| MATH | 119 | 486 |
| HumanEval | 33 | 131 |
| MBPP | 86 | 341 |

Formal loads hash and parse the same bytes, reject modified files, retain all
rows in their published order and use MFlow task IDs. Even JSON whitespace
changes fail the raw-byte identity check. `--search-limit` and `--test-limit`
must be zero. No random split, stratified sampling, deduplication, passage
regrouping or additional confirmation partition is applied.

Only library callers that explicitly request `dataMode: "fixture"` can load
synthetic data or sample. Such identities are marked `verified: false` and
`protocol: "fixture"`. The formal CLI exposes no fixture switch.

DROP's five published duplicate prompt pairs across search/test and shared
passages are preserved and disclosed in the run identity. This historical split
is not fully overlap-free. Gold answers, GSM8K `cot`, DROP `completion/ref_text`
and private code tests stay on the evaluator side.

## Prompt and scoring contracts

DROP and GSM8K initial requests reproduce the pinned MFlow seed agent prompts
and root `textMessages` format from `src/aflow-seed.ts`, `src/composition.ts` and
`src/types.ts`. GSM8K intentionally uses MFlow's mathematical seed ending with
a boxed answer; DROP requests a concise passage-supported answer. No adapter
output requirement is appended. The optimizer receives the baseline review and
integration seeds as editable references. Prompt search remains part of this
repository's method; this does not reproduce MFlow's multi-agent organization
or a previously selected evolved MFlow artifact.

Run manifests and checkpoints store prompt provenance, hashes and the fixed
root profile. Resume and final evaluation reject changed prompt contracts,
generation settings, metric versions, dataset identities or runtime versions.
Final evaluation uses the frozen best workflow; test results do not select it.

DROP uses MFlow's AFlow-compatible maximum token F1 over pipe-separated gold and
prediction segments, not the native multi-span alignment metric. Empty overlap
scores zero. Mean F1 remains continuous; `details.exactMatch` records whether
F1 equals one. The metric version is `aflow-drop-token-f1-v2`.
GSM8K compares the last regex-extracted number with tolerance `1e-6`, including
comma removal. A fraction or scientific notation is not interpreted as a
symbolic expression. No LLM judge or answer-repair call is added.

## Running

Prepare the exact source files under a local directory (data and credentials
remain ignored), then run from this repository with the configured API key:

```powershell
npm run build
node --env-file-if-exists=.env dist/cli.js search --dataset gsm8k --data-dir ../data/datasets
node --env-file-if-exists=.env dist/cli.js search --dataset drop --data-dir ../data/datasets
node --env-file-if-exists=.env dist/cli.js test --dataset gsm8k --data-dir ../data/datasets --run-dir runs/<frozen-run>
```

Search data alone is used for mutation and selection. Five validation repeats
are repeated evaluations of that same search set, not five folds. Report search
cost separately from final evaluation cost. These changes do not launch a paid
experiment or claim a measured benchmark improvement.

## Failure and recovery semantics

Completed wrong answers remain valid zeroes. A response that ends normally with
`length` is not automatically regenerated or excluded. The application Worker
boundary retains the real finish reason and raw content. For REFLECT and
DELIBERATE it uses schema-valid structured output (including select's actual
candidate); unusable budget-truncated output produces an empty answer scored by
the unchanged private scorer. It never inherits an earlier answer for an unusable
structured response. Generation outcome evidence is saved per case. The published
package and `node_modules` are unchanged. Unresolved provider, execution,
format or scoring faults invalidate the complete candidate evaluation. Invalid
summaries are retained with their original membership, but cannot enter ranking,
parent selection, experience or score backpropagation. Non-finite and out-of-range
scores are evaluator faults. Empty DROP gold and nonnumeric GSM8K gold are
rejected by the private scorer, rather than labelled model errors.

The SDK permits three HTTP attempts for transient failures; authentication,
balance and invalid-request failures are not retried. Whole-workflow retries
apply only to transient errors. Attempt logs and workflow diagnostics retain
known token usage and mark unavailable consumption as unknown. A total request
deadline bounds upstream streaming and SDK retries. An incomplete stream does
not become a successful answer. Do not interpret missing usage as zero cost.

REFLECT may make up to three format attempts after normal `stop` responses that
violate its published output schema. These attempts preserve the target, record
the original responses and consumption, and do not replace ordinary wrong-answer
scoring. A `revise` response must include `revisedResult`, even when confirming
the original answer. `length` does not trigger this format repair.

Proposal inputs distinguish same-Graph DAG dependencies from earlier Graph
outputs carried automatically by Loop state. Proposal failures do not count as
evaluated search rounds. Provider failures stop at the saved boundary, and three
identical invalid proposals stop for inspection rather than repeatedly paying
for the same rejected structure.

Search case recovery binds source/dependency hashes, plan, model, endpoint,
generation, prompt profile, metric, raw data identity, ordered membership and
repeat count. It reuses valid cases only under that identity, preserves earlier
failed attempts, and retries failed cases as complete workflows. A completed
evaluation is not reused as an independent repetition. Final evaluation saves
failures as `test-failed` and refuses a successful completion status; per-case
recovery at that final-test entry point is not implemented.

Formal CLI runs still require the complete fixed split. A separately labelled
engineering diagnostic may verify the complete original file before selecting
predeclared IDs, but its subset scores are not full-partition benchmark results.
Candidate recovery or regression is not evidence of new feedback-driven search.

Optimizer feedback includes public workflow specifications, scores, deltas,
outcomes and predictions. Private reference answers and scorer errors remain in
local evaluation evidence and are omitted from every optimizer request, including
proposal-repair requests. Actual Provider/Worker/Executor/scorer tests enforce
that boundary.

The historical six 100-example diagnostics were generated under an earlier
protocol that sent expected answers to the optimizer and rejected structured
`length` responses downstream. Their scores remain reproducible historical
diagnostics; they are not results for this fixed delivery. Separate repair
validation uses five fixed Search examples per dataset, a fresh baseline and one
feedback-generated candidate, with independent official checks. No independent
Test performance or clean 100-example search is claimed.
