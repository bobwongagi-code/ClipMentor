# 剪辑前分析：现有转写 → 视觉观察 → 卖点候选

这一步只改 `clipMentorAnalysis`。不碰时间线、素材口播字幕、配音或导出，不自动审核自己。

开始观察与内容判断前读 [analysis-method.md](analysis-method.md)，执行“购买关注 → 待解问题 → 针对性观察 → 表达关系 → 逐组反证自审”。本文件负责工具与证据格式，不能只照字段填动作清单就算完成分析。

## Source breakdown contract

剪辑前先拆清原片表达，再写口播；不要求物理切成许多文件。按完整动作/比较/信息任务划分窗口，长短由内容决定。短动作必要时补看密集采样，单帧不当成连续观看。原话不清就留未知，不用观察补造台词。原片分段、讲解单元和最终剪切点可以不同，不机械一镜一句或套固定栅格。

使用同一份 `clipMentorAnalysis.source_breakdown` 承接下游，不另建只在主Agent桌面可读的重点表：

1. `segments` 是源片索引。记录源秒、可见动作证据ID、原片宣称证据ID、解释证据ID和未知，三类引用分开。先用现有观察/append工具建立真实证据和蓝图，再登记索引，不伪造帧或调用成功。空的原片宣称数组表示本窗口没有可引用原话，不表示没有讲话。
2. `points` 是写稿前选定的教学任务。每条有购买关注、值得学什么的审核问题、必要拍法条件、重要性和源片单元ID。`analysis.points` 是分析发现库；这里是从中选择并保留下来的教学基线，不能把最新短稿反过来当基线。不把每个观察动作都选成必讲点。
3. `units[].original_source_ranges` 是当前选定的完整原声播放源秒范围（可含必要口播上下文）；`original_segment_ids` 是其中教学证据的索引，不能用稀疏索引代替完整播放范围。未填正式范围的历史记录暂按索引推导；新登记应明确填写。不得另造 `original_playback_entry` 等播放权威字段，未知unit字段会报错并拒绝写入；状态、理由与历史候选放在蓝图的 `internal_review`。完整范围必须在素材内并覆盖原声索引。

4. `units` 分别登记原声展示和讲解使用的源片单元，以及每个重点的 `explain / merged / visual_only / omit` 处理。后3种须有理由，合并须指向同组真正解释的点；出现过不等于讲清。必讲点不能直接omit，作者不能自行降低primary/必讲级别绕过审核；证据不足保留待核，不编造解释。合法的基线内容纠正需要新的 `change_reason` 和重新审核。

通过现有 `revise_clipmentor_analysis` 保存：`action:"set_source_breakdown"`、当前 `expectedRevision`、既有actor/reason以及 `record`。首次登记不默认要求用户逐项确认。历史重点和段落ID不能从后续记录消失；修订后复读，用返回的具体问题ID继续处理。未登记就保存新的文案候选会被拒绝；历史旧稿仍可读取。缺覆盖可保存为待修候选，但不是制作通过。

下面是字段示例，证据和单元ID需来自本项目真实记录；不是Teashell素材事实或可以直接导入的成品：

```json
{
  "version": 1,
  "segments": [{
    "segment_id": "S-use", "source_range_seconds": [10, 12],
    "visible_evidence_ids": ["VIS-01"], "claim_evidence_ids": [],
    "interpretation_evidence_ids": ["WHY-01"], "unknowns": []
  }],
  "points": [{
    "point_id": "P-01", "segment_ids": ["S-use"],
    "buying_concern": "本项目已知的具体购买关注",
    "teaching_question": "这项拍法怎样把这个购买关注展示清楚？",
    "filming_conditions": ["本项目观察到且必须保留的对象和拍法条件"],
    "role": "primary", "importance": "must_explain"
  }],
  "units": [{
    "unit_id": "U-01", "original_segment_ids": ["S-use"], "original_source_ranges": [[10, 12]], "explanation_segment_ids": ["S-use"],
    "coverage": [{"point_id": "P-01", "treatment": "explain"}],
    "revisits": [{"from_segment_id": "S-use", "to_segment_id": "S-use", "reason": "回看已展示的做法，解释其与购买关注的关系"}]
  }]
}
```

`primary` 要讲清拍法与具体商品关注，`supporting` 提供上下文并用 `supports_point_id` 指向同组primary，`auxiliary` 可简短交代衔接。意义可由整组几句/短标共同承担，不机械每句重复全套公式。具体内容与事实仍须独立语义审核，`structurally_ready` 只证明登记/引用/范围可对照。

当前没有自动签发“删掉已选教学任务”的独立范围豁免入口。`omit`可记录为待审提案，不代表已有制作许可；证据不足保留未知，不能写空洞解说凑覆盖。先分析清楚再选择值得讲的任务，不把所有动作都登记成必讲项。

写稿的每句继续用现有 `point` 或 `point_ids` 对应这里的重点ID，`source_seconds` 对应讲解段落范围；不能为缩短而换成粗粒度旧ID遮掉细项。`request_clipmentor_copy_review`通过宿主从当前工程生成独立审核包，不手填一个更容易通过的任务。标准包含原声/讲解范围、逐句源窗、登记回看关系及当前画面执行方案，剔除作者理由、自评与旧批准。服务端绑定原片哈希，按登记范围取前后两侧采样供隔离复核者读取；采样不证明连续动作或实际排版已验收。只接受一次授权，结果版本不符不写入，没有自动重试或修稿循环。

实际制作位置确定后，用同一action补 `units[].placement`：`{timeline_id, original_frames:[起,止), explanation_frames:[起,止)}`，均为该时间线帧。Agent只登记输出阶段位置；片段ID、实际源秒和与段落的重叠关系由代码读取真实视频实例计算。不要手填“实际已使用范围”。回看需登记关系和理由，不要求固定口播回看词，是否讲得通交独立审核。

历史较多时不要反复全量读取：`read_clipmentor_analysis {view:"source_breakdown"}` 读取正式拆解与当前revision，`{view:"current_copy",unitId:"U-02"}` 只读该组现行候选、不夹带旧稿与转写。全量读取仍可用于需要历史证据的任务，但超长返回不能当作已成功读到后部字段。

**冻结审核输入的有限回读。** 先按单元用 `read_clipmentor_analysis {view:"copy_review",reviewPart:"result",unitId}` 读原判和门禁，再用 `reviewPart:"packet"` 核对冻结输入，不拿当前替换稿冒充已审稿。小包保持原对象返回；大包自动返回 `packet_page`，其中 `json_text` 是冻结JSON原文的一页，`offset/end_offset/total_chars` 用UTF-16字符定位。继续用同一单元、`packetOffset:next_offset`、`packetDigest:digest` 读取，直到 `next_offset:null`；默认每页6000字符，也可显式指定256–6000的 `packetLimit`。按offset顺序拼接可恢复完整冻结输入，包括原画面方案和共享证据，不能只看preview或最后一页就称完整自核。摘要改变则从0重新读同一已保存结果，不请求新审核。`is_last_page`只表示该页到达末尾，`read_complete:false`不是通过或失败结论；原判、current/stale绑定与制作门禁始终分别保留。本入口只读，不修稿、不签发批准、不调用模型。

**局部登记新稿不需要读整份历史蓝图。** 先用 `read_clipmentor_analysis {view:"current_copy",unitId:"实际单元ID",copyPart:"summary"}` 取当前指针/revision；再用同单元 `copyPart:"candidate"` 取口播、同文字幕、中文、重点及源范围。画面另用 `copyPart:"picture_plan"` 读取，避免和稿件一起堆大；默认all保留原行为。摘要不包含历史或画面大对象。不要把被限长的返回当完整记录来重建历史。

要登记新的文字版本，用 `revise_clipmentor_analysis {action:"set_copy_candidate",id:"实际单元ID",expectedRevision,actor,reason,record:{source_candidate_id:"刚读到的当前稿ID",candidate_id:"script_candidate_新ID",lines:[{id,point_ids,narration_ms,caption_lines,zh,source_seconds,labels?}],plan_id:"picture_plan_新ID",plan:{本次紧凑画面方案},line_guidance:"与新稿和方案一致的交接"}}`。提交该单元完整的有序句子，不发送旧候选、旧画面方案或历史。未改句子逐字保留；若本次只授权同步已有作者稿，就不得借登记重写。每句只用这些字段，字幕与口播同文，源范围合法且引用本单元已登记重点，不能丢掉explain任务。代码核对的是格式、引用、范围与同文，不证明中文忠实或教学讲透。

该操作原子保存新候选、新画面方案与两个current指针，源绑定及 `selected_narration` 由宿主建立；若提交重复的selected_narration，必须与lines一致。旧记录原样保留，新稿/方案固定candidate、pending、production_allowed=false；保存使旧审核过期，不继承声音适配或制作批准。每次写入仍记录actor/reason、校验revision和当前稿ID，冲突/失败不覆盖也不自动重试。随后分开回读candidate和picture_plan，核对新revision、原文、方案和制作门禁。只选旧句仍用select_copy_lines，只改画面仍用set_picture_plan，不为小改动重传整条blueprint。

需要已登记的动作窗口、帧ID或采样状态时，使用`read_clipmentor_analysis {view:"evidence",evidenceIds:["实际已有证据ID"]}`（每批1–8项）。返回这些既有记录、其直接关联帧记录与观察元数据，不重新抽帧、不返回图片，也不构成新观察。读不到的引用会列出缺失，不把“当前稿没带出帧索引”说成原片缺证据；仍不能把采样或历史描述当作本轮连续观看。

画面承载方案用局部操作保存，不能为它重传整条含历史的blueprint：`revise_clipmentor_analysis {action:"set_picture_plan",id:"U-02",expectedRevision,actor,reason,record:{plan_id:"picture_plan_自定新ID",script_candidate_id:"当前current_script_candidate值",plan:{作者自己的画面承载方案},line_guidance:"指向同一当前稿、正式原声范围及新画面方案的交接说明"}}`。同一ID不可覆盖，旧方案保留；代码绑定源素材与当前稿，只存candidate/pending，生产false，旧批准失效。`current_copy`窄读取同时返回`picture_plan_id`和`picture_plan`，保存后据此回读。这里的方案仍需核对画面作用与实际声长，不是已执行的时间线，也不填placement来凑通过。

`read_clipmentor_analysis` 返回 `breakdown_check` 和 `breakdown_timeline_check`。计划变更使既有制作审核摘要过期；还原旧内容也不会恢复旧批准。正常剪辑期间允许存在尚未搭完的画面，但内置/离线Agent的制作入口在提交导出前会核实际范围。不匹配、没有placement、来源变化均不放行。当前只自动核同帧时钟下的直接视频实例；嵌套、复杂文字驱动裁切、静帧/合成布局或帧时钟不明需保留待核，不为过检查强行改成顺播视频。这不是连续视听检查，也没有接管手动UI导出按钮。

先读 `read_clipmentor_analysis` 和源素材。原片转写不必逐字核清才继续：能读清的保留为机器候选，听不清的留未知，相关结论不采用未知信息。用户提供的文字另存为用户来源，不能反填为机器听清或人工逐字审核通过。局部未知不阻塞全片视觉观察；写出它具体限制哪条结论，不要求同事补技术表。

用 `observe_clipmentor_source` 按原片时间抽帧。现在每张图单独返回，保留原片比例、最长边不超过1280、不放大，图片序号与时间/帧ID在note中对应，不再用低分辨率横向格子观察细节。

先用 `seconds:[...]` 覆盖全片、建立信息段落；再由你选择短动作或不确定区间，用 `sequence:{startSeconds,endSeconds,count}` 在窗口内等距取2–8帧。两个参数互斥，边界必须在素材内。短动作先选覆盖起势、接触/指向与收势的短窗口，再按需要缩小；整段均匀抽样不能替代短动作补看。单帧包装或细节可用 `seconds:[一个时间]` 清晰回看；遇到特效/遮挡时看前后帧，不立刻判图片坏了。每批最多8帧是容量而不是全片上限，必要时分批。相邻静帧只能支持这些采样时刻，不能声称连续观看、听审或精确动作次数。

返回的 `observation` 区分提取成功/失败、源哈希、帧ID和时间；`images_returned` 仅表示图片已返回，不证明主模型实际看见或理解。当前入口直接向主Agent返回图片，不调用隐藏的视觉模型。若当前运行时无法看到图片，明确报告不可见，不按文字线索编造动作。`failed` 记录保留，不自动重试，不写成“原片没做”。需要已授权的补抽时重新读revision，说明原因。

看图后先建立产品是什么、原片在向谁表达什么购买理由，再逐项对应可见做法。解释链是“购买理由/顾虑 → 原片用什么具体拍法 → 观众因此更容易看懂或感受到什么 → 值得借鉴的必要条件”。只写举起、涂抹、并排、表情等动作名称不算完成；不同动作共同完成一个信息任务时合成一组，不把每个动作机械立成卖点。不要给原片未表达的功效、数字或购买承诺背书，也不把表达优势当成已经验证的爆单因果。

证据边界用于保证忠实，不是对商品做质检。原片通过台词、指向、演示或比较表达了什么，可以作为“达人想让观众理解的卖点”分析；不要求每个提及对象都实际测试才允许解释其表达作用。“不能证明功效”放在相关未知项，不能取代蓝图的主题。局部不知道产品真实效果，不应抹掉画面已经传达的购买理由；比较身份不清时保留未知，不擅自命名使用前后。

用 `revise_clipmentor_analysis action=append` 将动作和解释分开保存为候选。观察期间先登记帧；整理后一次保存一份收敛的卖点/蓝图，不把多轮草稿累计成相互重复的正式蓝图。已有同一信息任务就以稳定ID修订，不另追加替代单元；保留审计即可。最终蓝图按源顺序，每组承担清楚且不重复的信息作用，核心卖点以解释深度体现权重；包装、过渡与普通收尾不抢重点。

单帧可见姿态的 `visible_action.source_range_seconds` 可以是 `[t,t]`，表示一个时刻，不虚构持续时间；多帧动作仍按实际采样范围。重点段落和蓝图时长区间须有正长度。通过工具传回的图像载荷不要整段打印成base64文字，按运行时图像规则查看并保留序号/时间对应；解析工具包装格式的问题不等于原片内容未知。

保存前按分析方法逐组核“购买关注、可见做法、理解作用、必要条件”，并自查具体引用哪一刻的证据。一个大时间范围、有效ID或开头单帧，不代表其他语义也看到了。对未充分观察的内容不要先降为普通承接。解释要贴合本品当前购买关注，但不要求证明独有性能；未知只限制对应断言。逐组保留实质问题和处理结果，不复制泛泛的通过结论。这是语义自查，不是程序自动发现所有遗漏。

完整字段示例（ID由本次实际观察替换，不复制示例事实）：

```json
{
  "action": "append",
  "expectedRevision": 2,
  "actor": {"operator":"user","executor":"built-in Agent","instruction":"当前用户授权做剪辑前分析","identity":"local_declared_not_authenticated"},
  "reason":"将观察和解释分开保存为待审候选",
  "records": {
    "product": {"name":"按已知资料填写，未知就注明待核","category":"按实际资料填写"},
    "evidence": [
      {"evidence_id":"VIS-01","kind":"visible_action","text":"只填写真正看到的动作或关系","status":"agent_observed_candidate","source_range_seconds":[10,12],"supporting_evidence_ids":["返回的帧ID"],"source_ids":[],"observation_id":"返回的observation_id","observation_method":"main_agent_direct_image_read_not_independently_verified","call_status":"unknown"},
      {"evidence_id":"WHY-01","kind":"expression_analysis_not_verified_causal_effect","text":"解释上面的具体做法怎样表达购买理由，不宣称已证实功效或转化因果","status":"inferred_not_verified_causal_effect","source_range_seconds":[10,12],"supporting_evidence_ids":["VIS-01"],"source_ids":[]}
    ],
    "points":[{"point_id":"P-01","unit_id":"U-01","source_range_seconds":[10,12],"buying_reason_or_function":"产品购买理由与视觉表达的关系","filming_conditions":["保留必要对象、阶段、镜头和比较条件"],"evidence_ids":["VIS-01","WHY-01"],"uncertainties":["具体未知及其限制；无则空数组"],"required":true,"explanation_priority":"由本片内容决定","status":"candidate","review_status":"pending","provenance":"本次主Agent看图后的候选，未独立审核"}],
    "blueprint":[{"unit_id":"U-01","point_ids":["P-01"],"intent_zh":"这组要帮助达人理解什么","line_guidance":"拍法条件与观察口吻结合，先不写最终口播"}]
  }
}
```

原片台词候选用 `original_claim`、`status:candidate_unverified_speech`，必须有 `source_ids` 指向已有转写。不要把不清的整句修成确定原话。
用户补充用 `operator_supplied`、`status:operator_provided_not_independently_verified`，`provenance` 交代真实来源。补充文字可以使用 `transcripts`，字段为 `source_id/provider/origin/status/words`；`status` 固定 `operator_provided_segment_text_not_independently_listened`，每段文字整体用其源时间区间记录在 `words`，这是段落定位，不是逐字时间戳。

主审补入的协作稿也须通过 `revise_clipmentor_analysis` 写回对应工程，保留稳定ID和旧稿审计，标明“主审补入”、保持candidate/pending；写回不等于确认。最终复读核对实际蓝图与交付文档一致，不能只在文件中修稿而让后续工具继续读取旧蓝图。独立测试工程不可用协作答案回填。

新增帧必须由观察工具生成，不能用append伪造。新增记录ID不能与旧记录冲突，修改旧记录仍用revise；顺序写入使用最近成功结果的revision，冲突或结果不明时重读，结束时统一复读。按原片顺序组织段落，以时长、解释深度、素材丰富度体现重点，不把钩子移到重点后。普通收尾只短带其促单作用，不虚构套餐数量、价格或购买入口。

本轮输出：产品定位/购买理由 → 实际画面与时间ID → 值得借鉴的拍法条件 → 解释候选 → 未知项。保存成功、结构检查和待审核状态均不等于“分析质量已通过”或成片通过。保留模型初稿再做主Agent复核，不能将人工补入反记为自主发现。
