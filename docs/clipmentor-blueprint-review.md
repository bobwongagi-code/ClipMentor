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

### 四格复验的写法对照

这轮先读匿名稿，按「达人一眼能看懂她怎么拍、这一拍交代了什么」选句。下面保留每份稿里值得学的部分，供同类问题校准。编号来自 JUDYDOLL 四格复验的匿名审稿。

| 稿件 | 值得保留的词 | 达人能学到什么 |
| --- | --- | --- |
| 第 1 组 1-C | `warna dalam palet dengan kodnya` | 「盘内颜色对回编号」把比较之后能得到的东西说实。单说方便比较时，编号在镜头里承担的作用会丢掉。 |
| 第 1 组 1-G | `dalam satu bingkai` | 「同一个画框」把动作说具体。两盘及各自编号要一起入画，买家才有直接对应的依据。 |
| 第 2 组 2-E | `berus dan sebahagian muka dalam satu bingkai` | 分部位示范时，刷头和脸部参照一起留在画面里，买家马上知道刷头在哪。几个部位可以由画面交代，口播把这种拍法讲透即可。 |
| 第 3 组 3-B、3-F | `warna solekan dan bentuk pipi` | 示范后用无遮挡侧角把颊面妆色和轮廓交代在一帧里。这里学的是怎样收尾，画面支持的是当时的局部妆面。 |

第 1 组的两份稿都还可以补强开场。用妆面和反应开场，是为了让人想接着知道她用了什么。要讲到这个作用，保留「同框、带编号、颜色对回编号」，压掉画面本身已经讲清的动作细节。Codex 的 1-D 已经写出对号结论，和 1-C 同为 23 词。它可以继续借 1-G 的办法，把「一并展示」说成达人能够照着拍的同框。

前轮把眼下静帧写成原片示范，把局部角度写成「完整妆面」，或把刷头位置写成「已扫过」，都扩大了证据。选稿时可以借用这些版本里讲清拍法的部分，保留原误句和出处供校准。两边中选的句子都还需要母语者实听和声画对位。样本整理方式见 [Skill 写稿入口](../src/agent/skills/clipmentor/references/planning.md#before-drafting-the-narration)。

#### 第 1 组复写要求

正式讲解由 Codex 写。四格复验里，Codex 有 12/12 段通过文字边界和估读下沿筛选，Gemini 有 9/12 段。Gemini 少的三段都是估读下沿超窗。静帧、「完整」和「已扫过」来自前轮稿，作为边界反例继续保留。

- **事实卡** 一眼效果写清两步。妆面和反应让人想知道她用了什么。双盘带编号同框，让买家能直接把盘内颜色对回编号。这组的钩子负责第一步，讲解结论负责第二步。
- **写作者复盘** 回看本组八份匿名稿，其中四份是 Codex。先写下 1-C、1-G 和 Codex 稿各自怎样交代好奇与对号，把漏掉的效果指出来。1-C 的对号结论和 1-G 的同框条件是本轮选中的学习片段。两稿的开场还可以把「想知道用了什么」说实。作者的复盘只记在写作记录里。
- **一轮盲选的完成条件** 用同一份事实卡和已选片段，让 Codex 给第 1 组两到三个表达有实际区别的候选。原文保留。先核对第三人称、买家称呼、结论、证据和预计声长，再请编辑匿名选稿。如果中选稿在「让人想接着知道用了什么」这点达到原对照稿的水平，且颜色对号的结论仍然齐全，该轮对比就结束。顺不顺口留给实听。
- **临时对照** 编辑读中文大意时指出某组仍抓不住她怎么拍，并明确要另一个模型给参考时，只对该组取一稿。对照稿和 Codex 稿用相同的事实边界核对。

Verification uses synthetic dependencies and temporary media:

```sh
node scripts/run-check.mjs server/clipmentor/blueprint-review-board-human-context.verify.ts
node scripts/run-check.mjs server/clipmentor/blueprint-review-board.verify.ts
node scripts/run-check.mjs src/clipmentor/native-blueprint-import.verify.ts
npm run verify:clipmentor-blueprint
npm run verify:skills
npm run verify:server-tool-catalog
```
