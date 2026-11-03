# Internal blueprint review boards

Use the saved blueprint as the source of truth. The human view places source speech, planner Chinese translations, narration, caption cards, labels and bound delivery pictures together. The planner view retains technical diagnostics. Neither is the Storyboard sent to creators.

```sh
npm run board:clipmentor-blueprint -- /path/to/candidate.json --view human --bindings /path/to/new-contact-project.json --bindings /path/to/existing-partner-project.json --out /path/to/internal-board
```

A saved project ID can replace the candidate path. The read-only `render_clipmentor_review_board` tool uses the same implementation and the original product artifact reader. Generation reads local full-resolution media and writes an offline HTML artifact; it does not call a model or edit a project.

Missing optional Chinese remains visible as missing. When several copies supply Chinese, they must agree; an older copy without the field cannot hide a later conflict. Original label positions are validated before presentation. Registered delivery pictures and evidence cannot be replaced by older external bindings. Geometry stays associated with its supplying project and line, including when independent projects reuse section IDs.

Source speech is model transcription unless separately heard and verified. `original_claim.meaning_zh` and `labels_zh` are planner translations for internal reading and are excluded from the independent reviewer projection. The board does not judge semantic coverage, audio alignment or final-film quality. Provided review history is not overwritten by a candidate's unreviewed flag, and the board does not certify a production approval.

Achievement openings may report results, ask an observational question or use a supported comparison. No sample sentence is pre-approved: historical “same product, but why this video…” wording is not an evidence-free default. Writing and review criteria remain in [planning](../src/agent/skills/clipmentor/references/planning.md) and the existing delivery review. This feature does not restore spent calls, restamp old reviews or start production.

Verification uses synthetic dependencies and temporary media:

```sh
node scripts/run-check.mjs server/clipmentor/blueprint-review-board-human-context.verify.ts
node scripts/run-check.mjs server/clipmentor/blueprint-review-board.verify.ts
node scripts/run-check.mjs src/clipmentor/native-blueprint-import.verify.ts
npm run verify:clipmentor-blueprint
npm run verify:skills
npm run verify:server-tool-catalog
```
