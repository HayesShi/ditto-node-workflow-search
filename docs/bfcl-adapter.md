# BFCL official-world adapter

The main benchmark registry now supports `bfcl`, independently of PR7's generated
JavaScript runner. No private reference or initial world is placed in a public
task or model input. A fresh official conversation is created per workflow
attempt; its registered Interaction tools are `bfcl_state`, `bfcl_call`, and
`bfcl_respond`. Domain argument errors remain observations, while environment
process failures invalidate the measurement.

## Fixed source and data

- MFlow release: `mflow-splits-v1`, publication commit
  `94e5a9942415122724ba09971cfca8aa25cca40f`.
- Protocol: `bfcl-multiturn-family-v1`, Search 200 / Test 600 complete conversations.
- Official Gorilla revision: `6ea57973c7a6097fd7c5915698c54c17c5b1b6c8`.
- Prepare the split with the pinned MFlow `benchmark-splits/splits.py` utility.
  Pass a data directory containing `search.jsonl` and `test.jsonl`.
- The adapter checks the exact ordered **record-content** digest from the
  publication before exposing any public task. It does not replace membership
  verification with matching counts or a random seed. Python canonical JSON is
  used so floating-point formatting matches MFlow's verifier.

Set `DITTO_BFCL_ROOT` to the official
`gorilla/berkeley-function-call-leaderboard` checkout and `DITTO_BFCL_PYTHON` to
its installed Python environment. If omitted, the Python executable falls back
to `DITTO_PROVIDER_PYTHON`, then `python`. Metadata preflight verifies source
revision/cleanliness, imported package location, installed package versions and
the bridge fingerprint. It does not read private Test records.

## Scoring and recovery

The bridge is ported from PR7. Its Conversation/checker implementation matches
the published MFlow environment at the publication above; the companion
`literal_call` helper is inlined. MFlow's unavailable-function and forced-turn
zero conditions are retained and explicitly recorded in the scorer identity.

After execution the private adapter saves the full actual conversation snapshot
before grading, bound to task ID, repeat ID and exact answer. A grading failure
can reuse that same snapshot through `judgeRecovery`; it must not dispatch a new
model attempt or pick a better answer. Official grades, tool observations and
snapshots remain in evaluation evidence, not optimizer tool access. A returned
answer string is not equivalent to submitting a BFCL turn.

Offline tests cover cross-conversation tool isolation, domain errors versus
transport faults, task/repeat/answer-bound scoring recovery, canonical content
verification and rejection of fabricated matching-count splits. They do not
claim a real-model score or successful installation of an absent official
environment. Formal Search/Test should start only after environment preflight.
