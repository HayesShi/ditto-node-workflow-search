# AutomationBench framework diagnosis, 2026-11-09

Base commit: `98621f318d88c5cb71ecc9e3952b0ac399978dba`.
The standard Actor strategy and system prompts remain unchanged. The optimizer was
not invoked for this mechanism comparison. Each Search task ran once; these are
not the formal five-repeat Search results or held-out Test results.

## Prompt identity

This comparison uses the repository's standard execution prompts, unchanged:

- `src/graph-agent/system.ts`: `NODE_SYSTEM_PROMPT`, version
  `ditto-node-system-unified-v1`.
- `src/graph-agent/automation-baseline.ts`:
  `AUTOMATION_DECISION_INSTRUCTION`, used by
  `officialBaseline('automationbench')` in `src/official-agent/baselines.ts`.
- Reviews use Ditto 0.1.5 native REFLECT with the unchanged
  `REFLECTION_SYSTEM_CONTRACT`. Actual tool observations and review results are
  execution evidence; they do not replace the fixed Actor instruction.

The standard optimizer prompt in `prompts/official-optimizer-system.en.md`
(`ditto-official-agent-json-v1`, SHA-256
`b56a5e7f102616b05482d9c88a67fd7a2bcd7cb91ff46a4aee99f1b2fb0a46f6`)
is recorded for provenance with `invoked: false`. No optimizer, prompt pool or
automatic workflow search was invoked in this comparison.

Both arms use `deepseek-flash`, temperature 0, `maxTokens: 393216`, and
`firstTaskRepeat: false`. Each Search/validate task is evaluated once. The scripts
read data from `data/automationbench` by default, or from
`DITTO_AUTOMATION_DATA` when set.

| Execution | Passed | Model calls | Known tokens |
| --- | --- | --- | --- |
| Standard baseline | 193/200 (96.5%) | 1,147 | 4,051,885 |
| Progress tracking, stalled-call reflection and completion review | 184/200 (92%) | 1,376 | ≥5,705,464 |

The framework prototype is not selected as an improvement. Twelve previously
successful tasks failed with non-JSON model output. Including one existing
failure, 13 of the 16 failed cases ended at the strict decision parser, with prose
plus JSON or DeepSeek DSML tool-call text. The remaining failures include a phone
field mismatch, a sheet append without established column alignment, and a
resolution-email task whose root cause is not yet established from public traces.
The six attempts without usage prevent an exact token comparison.

Three old zero-score cases received one point in the new evaluation. These scores
do not by themselves establish full business completion: the HubSpot association
continued returning 404, despite a one-point grade after the controller stopped.
Actual tool observations and the official score are recorded separately.

## HubSpot contract repair

The public `api_search` catalog advertises
`.../associations/contact/{contactId}/{associationType}`. The pinned local router
accepts `.../associations/contacts/{contactId}/{associationType}`. This is a local
dispatch mismatch, not a network outage.

`DITTO_AUTOMATION_COMPAT=hubspot-association-catalog-v1` corrects only the published
URL for `hubspot.crm.deals.contacts.add`. The session retains the original catalog
and correction event. It does not rewrite model-selected actions, supply task
solutions, alter source worlds, or change the scorer. Compatibility is off by
default and is part of the recorded environment identity.

With this repair, the original standard workflow completed the diagnosed task in
four model calls and 7,675 tokens. The actual association operation returned
`associated: true` for the requested contact. The old standard execution consumed
60 calls and 761,075 tokens while repeating the mismatched endpoint. This is a
single-case compatibility result and is not merged into the 200-case result.

Run the explicit single-case regression with the configured provider environment:

```powershell
node --experimental-vm-modules --env-file=.env scripts/automation_hubspot_diagnostic.mjs
```

The next framework hypotheses follow the observed errors: distinguish model
protocol failure, API dispatch failure, and unmet task effects; recover each at
its own layer; and request completion review only when execution evidence is
missing or conflicting. Output normalization must preserve the original action
and reject ambiguous or multiple action requests. The layered-controller
evaluation below implements these hypotheses.

Large execution artifacts are kept under ignored `runs/` directories. The
framework driver saves the definition, standard prompt identities, code snapshot,
case checkpoints and public tool traces for its actual run.

## Layered recovery, first complete evaluation

The repaired HubSpot catalog is enabled in both arms. This separates the common
environment repair from the controller change. Standard Actor config and system
prompts are unchanged; the optimizer is not invoked. This is a one-pass mechanism
comparison on Search200, not an automatic search result or held-out Test.

| Execution | Passed | Provider calls | Known tokens |
| --- | --- | --- | --- |
| Standard, repaired catalog | 194/200 (97.0%) | 1,089 | 3,335,780 |
| Layered controller v1 | 195/200 (97.5%) | 1,187 | 4,193,150 |

Both evaluations completed 200 valid tasks with no unknown usage and no protocol
failure. One case improved (`email_sf_contact_assistant_update`); no previously
passing case failed in this comparison. The 13 earlier failed model responses
were also decoded offline with their original action arguments preserved. This
offline recovery count is not an additional benchmark score.

Remaining v1 zero-score tasks: `email_sf_contact_mobile_update`,
`email_sf_contact_account_update`, `sheets_log_sales_call`,
`zendesk_resolve_email`, and `demo_request_zoom_email`. Their public questions,
actual actions, observations, reviews and final model responses are written to
`layered/failure-cases.md` by `scripts/automation_layered_report.mjs`.

The account-change task consumed 672,123 tokens while repeatedly returning to
the same already-observed Contact query after an Account endpoint returned 404.
The date-change task also showed a framework comparison defect: the requested
date `2026-03-31` was returned as `2026-03-31T00:00:00`, incorrectly labeled a
conflict and followed by unnecessary reviews. These are public-trajectory
observations, not changes to a benchmark answer or scorer.

## Controller v2 correctness repair

V2 compares returned values with deep object equality and honors date-only
request precision for a matching midnight serialization. It preserves genuine
timestamp/time-zone differences, scalar types and different calendar dates.
The task-local progress observer also counts unchanged actual observations
across interleaved requests, so A/B/A/B read loops can reach the existing review
path. It never suppresses a tool call or chooses replacement business arguments.
The review allowance increases from two to four to leave room for corrections.
Successful Actor history remains byte-identical to the standard history.

All 382 active tests in the PR passed (8 optional tests skipped). Offline replay preserved
all 13 earlier decoded actions, removed the false date conflict, and detected
the retained account-query loop at action 20 of 59. These replay facts do not
predict a new accuracy or claim saved tokens. V2 live results are recorded
separately under `runs/automation-layered-v2-20261109/comparison`.

V2 completed all 200 valid cases: **196/200 (98.0%)**, with 1,154 provider
invocations, 1,155 HTTP attempts and at least 3,755,991 tokens. One underlying
attempt has unknown usage; its eventual model response was usable and its task
passed. Token consumption is therefore a lower bound, not an exact total.
There were no protocol-failure cases. Compared with the same standard baseline,
both the assistant-update and account-change cases improved; no case regressed.
The date-change task passed without an audit and its readback receipt matched.

Four cases still scored zero: `email_sf_contact_mobile_update`,
`sheets_log_sales_call`, `zendesk_resolve_email` and `demo_request_zoom_email`.
In the account-change case, actual tool observations confirmed creation of the
new Account and the Contact's association with it, and the official score was
one. However, all four reviews insisted that the missing original Account itself
must be renamed, and the controller ended at its audit limit. This is an explicit
reviewer/official-score disagreement, not reviewer-confirmed completion. No
benchmark label or hidden state is supplied to the controller to resolve it.
The combined v2 change improves this one-pass comparison by one percentage point;
this result does not isolate the contributions of its individual mechanisms.

```powershell
# Each task once; use a separate directory for each frozen controller version.
node --experimental-vm-modules --env-file=.env scripts/automation_layered_comparison.mjs runs/automation-layered-v2-20261109/comparison layered-only
node scripts/automation_layered_report.mjs runs/automation-layered-v2-20261109/comparison runs/automation-layered-20261109/comparison/baseline-fixed
```
