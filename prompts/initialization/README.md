# Optional user-side initialization assets

`pr10/` preserves the four reviewed strategy cards and construction template from
PR10 at `d9e51796b57407f1c083a44252ee0b44c832f67b`. `pr7/` preserves the five-dataset
prompt pool from PR7 at `b641010f240ced610a45625653375816829c87e4`.
`PROVENANCE.json` records source paths and byte hashes.

The official JSON search keeps its historical baseline by default. Selecting
`pr10-selected` explicitly supplies the saved strategy for an editable user slot;
selecting `pr7-guidance` supplies an optional public strategy pool. These are
initialization hypotheses, not current-backend quality claims. The source cards'
historical research scores never enter optimizer or execution messages.

`manual-seeded` selects the versioned public-task user guidance in
`src/official-agent/task-strategies.ts`, the existing Automation JSON contract
with its public execution guidance, or the current BFCL decision strategy.
Select it explicitly with `--initialization manual-seeded`; the default baseline
is retained. Its snapshot includes the exact strategy text and content digest.
The initial small Search checks supported the short DROP strategy, while the
MBPP proposal regressed and is not recommended over its original baseline.
These are Search-subset observations, not independent Test results; see
`docs/five-dataset-baseline-validation-20261107.zh-CN.md`.

The PR7 pool's old A-specific resource reminders and Worker-registration claims
are retained only as source provenance. The loader does not inject them into the
new official runtime. Actual capabilities and permissions come from the current
host catalogue. All strategies remain subordinate to the fixed task answer
contract and frozen system templates.

The loader snapshots and deeply freezes the selected values and records their
content identities. Existing runs must retain that snapshot; they must not reload
today's assets during resume or Test. No default Test export or automatic Test
selection behavior from PR10 is introduced by these assets.
