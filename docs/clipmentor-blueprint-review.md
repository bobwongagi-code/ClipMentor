# Internal blueprint review boards

Use the saved blueprint as the source of truth. The human view places source speech, planner Chinese translations, narration, caption cards, labels and bound delivery pictures together. The planner view retains technical diagnostics. Neither is the Storyboard sent to creators.

```sh
npm run board:clipmentor-blueprint -- /path/to/candidate.json --view human --bindings /path/to/new-contact-project.json --bindings /path/to/existing-partner-project.json --out /path/to/internal-board
```

A saved project ID can replace the candidate path. The read-only `render_clipmentor_review_board` tool uses the same implementation and the original product artifact reader. Generation reads local full-resolution media and writes an offline HTML artifact; it does not call a model or edit a project.

Missing optional Chinese remains visible as missing. When several copies supply Chinese, they must agree; an older copy without the field cannot hide a later conflict. Original label positions are validated before presentation. Registered delivery pictures and evidence cannot be replaced by older external bindings. Geometry stays associated with its supplying project and line, including when independent projects reuse section IDs.

Source speech is model transcription unless separately heard and verified. `original_claim.meaning_zh` and `labels_zh` are planner translations for internal reading and are excluded from the independent reviewer projection. The board does not judge semantic coverage, audio alignment or final-film quality. Provided review history is not overwritten by a candidate's unreviewed flag, and the board does not certify a production approval.

Achievement openings may report results, ask an observational question or use a supported comparison. No sample sentence is pre-approved: historical “same product, but why this video…” wording is not an evidence-free default. Writing and review criteria remain in [planning](../src/agent/skills/clipmentor/references/planning.md) and the existing delivery review. This feature does not restore spent calls, restamp old reviews or start production.

## 讲解打磨的经验与教训

JUDYDOLL 从 `v3-6a7f9450` 打磨到离线第二稿，最重要的变化，是先定**达人下一条要改哪个拍摄决定，以及这个决定给买家多了什么判断依据**。原稿的问题在事实与教学之间，润色或缩短本身解决不了。

| 本轮暴露的问题 | 下次写稿前怎么处理 |
| --- | --- |
| 双盘组把用于策划比较的手背试色写进了口播。 | 把允许写进口播的证据与策划备选分开。双盘组只需说明两盘与各自编号同框，让买家把盘内颜色直接对回编号。用原片 8.3 至 9.7 秒支持这层关系。 |
| 删掉不实断言后，讲解退到了「买家可以自己判断」。 | 先写要下的教学结论，再动正文。把「可以看清」说具体。双盘组说清能对回哪个信息，鼻侧组说清补上脸画面后，买家知道棕痕实际落在脸上哪里。 |
| 鼻侧组把前后画面写成了连续近景，还从色痕可见推到显眼程度。 | 涉及动作和剪辑顺序时回看连续帧。约 36 秒发生画面跳变，因此用移开后的 36.1 至 36.6 秒说明色痕的位置。它支持后接一个上脸参照的做法，棕痕的显眼程度和色号归属仍缺依据。 |
| 有了结论之后，第二句仍在重述第一句。 | 让每一句有自己的任务。本例先交代拍法，再讲它带来的具体判断依据。前文和画面已指清对象时，用简短的回指即可。 |

起草时，逐组给作者带时窗的观察、本组要教的决定、结论的证据边界，以及应留在策划或审核区的信息。先用马来语写，再回译中文。原片买家与拆解读者分别用 `pembeli` 和 `kreator` 理清。需要比较写法时，在一轮里给两种有实际取舍的表达，各写一句理由。范例只提供语气或推理方法，事实来自本片。

交稿前单读实际口播，试答「达人下一条会改哪个决定」「哪一句说明为什么」。然后逐句回到原片时窗核查。正反对照放在同一案例里，保留关键改句和改动理由即可。像两句上限、产品名和用词选择这样的本项目取舍，可以作为范例信息。

第三稿把连接词换成 `Jadi`，试用 `match`，A 版两组仍按同一节拍讲「她做了什么，这样买家就能怎样」。逐词换口语词解决不了这个问题。先跟着原片找一句同行真会说的话，安排哪里停、哪个词需要重读、哪些对象画面已经交代。随后单读口播，核拍法的价值有没有被省掉。项目词表保留整句语境和听审状态，接入作者的写法见 [Skill 写稿入口](../src/agent/skills/clipmentor/references/planning.md#before-drafting-the-narration)。

编辑认可的是第二稿两组 A，可作为独立审核候选。独立审核、母语实际听审、声画承载及在新项目上能否改善首稿仍待验证。本节是供复盘和校准的案例记录。

Verification uses synthetic dependencies and temporary media:

```sh
node scripts/run-check.mjs server/clipmentor/blueprint-review-board-human-context.verify.ts
node scripts/run-check.mjs server/clipmentor/blueprint-review-board.verify.ts
node scripts/run-check.mjs src/clipmentor/native-blueprint-import.verify.ts
npm run verify:clipmentor-blueprint
npm run verify:skills
npm run verify:server-tool-catalog
```
