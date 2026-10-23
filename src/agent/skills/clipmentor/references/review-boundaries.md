# Review roles, unresolved items and release boundaries

Use this reference for review ownership, escalation or delivery-status questions. It clarifies the existing [production checkpoints](planning.md#production-review-checkpoints), not another checklist or a new approval service.

## Ownership and authorization

“Author” means the built-in product Agent; “independent reviewer” means a fresh context receiving the frozen current subject; “operator” means the human who supplies business decisions and final acceptance. Historical “lead/main reviewer” labels describe their actual recorded actor, not an interchangeable human/Agent role.

| Stage | Author and independent reviewer | Continue automatically within the task | Escalate only when |
| --- | --- | --- | --- |
| Blueprint | Author understands the product, selects tasks and maps material; independent review checks planned L1/L2 and necessary conditions | Repair a specific omission/organization error within the authorized repair budget; preserve the selected-task accounting | Required business facts/material are unavailable, a choice changes the agreed scope, or the budget is exhausted |
| Localized copy | Author writes; independent reviewer applies the four questions, deletion loss and evidence boundaries | Revise the identified gap, retain valid content and save a pending candidate | A material language/factual uncertainty cannot be resolved from authorized evidence; do not invent meaning or require a human for every edit |
| Execution and preview | Executor implements the settled version and checks saved instances; independent preview review stays within its authorized scope | Fix confirmed execution deviations and consolidate remaining issues for one final operator review | A content/picture conflict needs replanning, an action needs new authorization, or a required acceptance cannot be performed |

Independent calls require an explicit applicable task budget. Keep stable operation IDs; failed/unknown attempts consume that budget; no automatic retry. Existing saved results, local reads and deterministic checks need no new model call. Self-review cannot satisfy independent approval. An approved business input is not an independent quality verdict. Never fabricate an operator sign-off.

## Resolve uncertain items instead of accumulating labels

Use the current review/brief record. Each unresolved item names **unit/point/line ID → exact missing evidence or decision → owner → permitted resolution method → stage it must be resolved before → blocking scope**. The owner is normally the author for existing material, the reviewer for a contradictory/incomplete judgment, and the operator only for missing business facts/permissions. “Later” alone is not a deadline; specify before synthesis, before editing or before final delivery.

| Finding | Next action and closure |
| --- | --- |
| Missing current teaching/factual evidence, ambiguous critical language, unsupported number/condition | Keep pending; author first uses existing authorized evidence. A new observation/native review/call needs its applicable authorization. Close with a linked evidence item and fresh affected review, not “handled” |
| A clear required revision | Return the concrete relationship/condition to the author within the repair budget; reviewer does not rewrite. Changed content invalidates the old receipt |
| Optional wording improvement | Record suggestion and adopted/retained reason; do not label an already clear accurate sentence uncertain solely for style |
| Future audio/listening/preview work not yet due | Mark not checked with its owner and checkpoint. It is not a current text defect, but must not be advertised as final acceptance |

A critical unknown blocks its checkpoint. The current conservative production receipt covers all selected copy units: a failed/stale receipt blocks all gated production, while preparation may continue. This is not permission to synthesize an apparently unaffected line. After a bounded repair fails, return one consolidated blocker instead of opening an unlimited loop.

## Source presence and delivered meaning are different

For each retained point distinguish source support from what narration, same-word captions, independent labels or visible composition actually teach. Source evidence IDs alone do not establish coverage; the reviewer must cite the real delivered words or the bound visible relationship. A core number/condition cannot vanish into a generic adjective. A prominent supported label/picture may carry it without the voice repeating it: do not require source presence, narration and prominent visuals to all be true. A visual-only task still requires source-bound evidence, a group role and sufficient visual review; an unquoted spoken claim cannot borrow that exception. Existing per-point judgments and visual_check carry these answers, not another boolean checklist.

## Copy approval, representative measurement, remaining synthesis

1. **Text/plan first.** Establish the whole-group teaching argument, necessary filming conditions, current copy/picture binding and independent four-question/L1/L2 result before new synthesis. Estimated speech time is a planning risk indicator, not proof of fit.
2. **Reuse or measure the risk.** First look for exact-text audio with the approved voice/settings and measured duration. If new synthesis is authorized and timing risk remains, synthesize one or two representative reviewed lines from that same authorized batch first; failed attempts count. Reuse those files in the final video. This is not an extra throwaway test or a mandatory additional paid call; without authorization, stop at the measured-evidence gap.
3. **Complete only what remains.** Once a meaningful group picture allocation can carry the measured speech, synthesize the remaining authorized lines. With a one/two-line task the representative sample may already be the complete batch. A text/picture change reopens the applicable review; no forcing new words into old audio slots or accelerating/slowing/looping/empty holds to hide deficits.

Material mapping provides verified usable ranges, not immutable sentence-sized cut windows. If the group still does not fit, return its actual teaching/capacity conflict to planning; don't repeatedly compress isolated sentences. Continuous viewing/listening is a later separate acceptance.

## Malay quality and human involvement

Entity, scope, stage, numbers, units, negation and conditions must agree across Malay, Chinese meaning, evidence and captions; a material discrepancy blocks release. The author and independent reviewer can perform these checks; they do not inherently require a human. Correct Chinese prose cannot repair unclear Malay meaning.

Native naturalness feedback and anonymous A/B comparisons are optional evidence unless the task makes them a prerequisite. A native reviewer must be arranged by the operator, with actual language background, scope and result recorded. If the model cannot decide a material language issue, retain that specific uncertainty; do not pretend to have native approval. Optional small style improvements do not force another review round. Text review, actual audio listening and continuous picture review retain separate statuses.

## Independent inputs are fixed, not an author-controlled mode

Authors may work collaboratively with feedback/history. The production reviewer still uses the host policy `independent_current_subject_v1`: current versioned copy/captions/picture plan, selected teaching tasks, source evidence and source-bound operator facts. No author self-review/reasons, old verdicts, expected answers, previous drafts or “known issues” leading to the desired result. Neutral business facts belong in source-bound context, not an answer sheet. The saved inspection/ledger records this policy. Supplying a new request `mode` or `context` is rejected, not a way to weaken isolation.

The execution-plan input is a declared-field projection, not a field-name blacklist. It carries current source ranges, phases/context bindings, composition/constraints, visual-only source bindings and viewer-stage cues. Unknown metadata containers and author history/self-evaluation are excluded at both handoffs. Known structural fields must also have their declared object/row-array shape; malformed containers stop review before any model call, rather than being silently dropped. Existing composition may be text or a canvas/detail object; author check/self-assessment fields are excluded. Operational strings are still untrusted content to assess; this is not a claim that free text cannot contain misleading instructions. Extending the operational format requires updating the projection and its preservation/isolation regressions together.

A retained registered unit cannot leave the review scope merely by losing its current-copy pointer. Drafts may remain incomplete and readable, but independent review and production must wait; no placeholder upgrade or renamed candidate key may leave new copy disconnected from the active pointer. Any narration duplicated in a picture plan must mirror the current copy; a different manuscript uses atomic copy registration, not a picture-plan update. Conflicting imported drafts remain readable and repairable but cannot enter review/production. Visual-only points within a reviewed group remain supported and do not require invented narration.

Historical anonymous blind experiments preserve their frozen inputs and verdicts. They are not production review modes or proof the current project passed. Compare actual accessible evidence before attributing different outputs to model ability.

## What the existing checks establish

| Entry | Can establish | Cannot establish / next owner |
| --- | --- | --- |
| `verify:clipmentor-blueprint` | Structural/typed regressions, point accounting, pointer binding, saved-review and dispatcher gates, valid positive controls | New real teaching/fluency quality; semantic reviewer must judge it |
| Current `production_gate` | Current source/content binding and complete declared point/line/group judgments; no old/self approval | Truth of reasons, measured picture capacity or final viewing quality |
| `verify_export` with actual manifest / transition checks | Deterministic scene/audio facts and consolidated review candidates | Whether a transition feels abrupt; continuous evidence is still needed |
| `diff:delivery-check -- before.json after.json` | Read-only changes to current units, selected tasks, review state, assets and timeline; unchanged records omitted | Resolve revision names automatically, approve content, or infer an unavailable earlier snapshot |

Structure errors return to the author/tool owner. Semantic failures return to independent review/planning within the authorized budget; missing external facts/permission alone go to the operator. A passing mock is not a real Agent test. These local checks introduce no paid calls. More review output costs tokens; report actual cost/latency when an authorized run supplies them, not a claimed zero cost.

## Pending preview to final delivery

Keep status in the existing delivery record, with its artifact/version/hash, checks, blockers, owner and next checkpoint. A pending preview becomes final only when applicable teaching, measured capacity, continuous viewing/listening and technical checks have evidence, critical unknowns are resolved, and the operator's actual acceptance is recorded for that version. A user-accepted exception records its scope; it does not turn an unperformed test into a pass. Later substantive changes reopen affected acceptance. The production gate's plan-ready result never sets complete-film acceptance.

Deliver one preview and consolidated remaining intervals, not every structural flag for the user to decide. Missing evidence permits a clearly limited pending preview, not silent publication. Do not invent a sign-off date or promote historical “looks good” into complete acceptance. No second delivery-status registry is required.
