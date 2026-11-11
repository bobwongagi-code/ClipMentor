# ClipMentor 状态转换与恢复边界

维护现有的事实源、所有者和提交边界，不把所有布尔值改成另一套状态框架。下表沿用原静态盘点的 SM 编号；一个协议可有多个子状态，104 条不代表 104 个缺陷，也不代表穷举了所有运行组合。

## 事实源与完成含义

- `ProductionTask` 及持久运行检查点是制作控制依据。派发时的内存快照不能覆盖执行所有者读到的新检查点。返修要同时保存目标阶段及失效的后续检查点。已登记的最新检查点不可读、正文与索引不符或协议身份错误时，不能退回旧检查点。等时间戳按索引中的发布先后排序，读取与历史压缩共用同一实现。
- 运行索引的排队写入不代表读取版本仍然有效。普通写入必须匹配 `expectedRevision` 并推进一次；set/merge 合入有效变化也推进版本，无变化重放不推进。竞争后仅由现有本地重读接续，不授予外部重试。
- Agent 冷恢复的未知工具结果必须与最后的结束事件按递增编号一起落盘，不能临时插在旧结束事件前。原日志不改写，回放只以最后一个有效结束事件终止。恢复提交同时绑定会话代次及该运行的持久事件尾序号；上下文、待取消审批和恢复后缀原子发布，争用只重读，不重新派发工具。
- 外部调用台账与 raw 文件是“已发出／已收到”的依据。源观察、独立审核及 ASR 的本地回读可接续已保存 raw，不重新发送；缺失、错配、损坏或结果未知仍不算成功。原失败、预算和审核原判不因此重置。
- 共享主体的本地准备许可绑定前后工程字节、生产者、原审核与共用主体。仅允许完成相同的部分提交；遇到后续编辑拒绝。当前任务的额度仍是唯一授权来源，许可不复制额度。片尾仍独立，正式审核仍必须通过。
- 生成任务初始化只恢复本地读取失败，不重跑失败的外部恢复阶段；不认识的账本协议/行或重复ID不能按空账本覆盖。执行结束关闭旧回调权限；清理在引用检查、持久删除及文件回收期间排他，同ID不能同时恢复/重用。过期定时器须同时匹配任务对象和当前timer句柄；提交失败先保留文件，后恢复记录，不能制造指向已删除结果的成功记录。
- 检查点等时间戳不能把导入到达顺序当任务进度；按经原索引/正文核验的 sequence 排序。并发压缩只可从当前已索引的无损归档取回同一记录，不能借较早检查点减少已用次数。网关诊断复用同一历史归档，不能耗尽进度保存槽；已确认的远端 lease 释放只清本地相同 token。
- 工程、运行索引、产物文件的提交边界不同。丢失确认时先回读权威索引；不能把已发布的产物当垃圾删除。通知和提交后的清理失败不撤销成功写入。
- 素材回执核对当前四槽的真实文件哈希，并在异步核验后重读工程版本；文件存在不等于登记内容仍有效。尚未制作的工程可用同名称、同类型、同哈希输入修复缺失或坏文件，保留资产 ID 和有效槽位；旧对象不覆盖、不删除。提交后回读不确定时保留新引用文件，后续可直接读取回执。
- 外部上传登记的队列、异步准备与后台确认共用原调用的工程／运行／取消边界。只按回执的精确资产 ID 操作；重放先核旧目标和当前 claim，命令实际生效后才确认。已提交但回包丢失时以同 claim 的终态确认恢复，不重传文件。后台确认不重放用户后来删除的资产。旧 relink 日志缺少原目标证据且当前目标不符时保留日志，不能猜测覆盖；已匹配的旧日志仍可确认。目标比较不包含收藏、目录或转录等未被此次登记覆盖的字段。
- 确认队列的所有者失效后，新调用可以接管；旧回调及其 finally 不能清掉新所有者。取消清理以实际是否开始命令为界：确定未编辑时，同 claim abort 确认后才删除私有日志；已编辑或上下文已变时保留证据，不能拿新工程判断旧写入是否发生。
- 视觉对照的原子发布结束私有清理权限：取消只清自己的工作目录，不删除共享 HTML/索引。不同文件路径可有同一内容身份，不能靠进程内去重假设没有其他读取者。缺索引的 HTML 不是有效缓存，按原哈希校验在本地重建，不重调模型。
- 局部预览准备先写本次私有临时目录，再不可覆盖地发布。相同名称不代表相同字节；并发晚到进程不能截断已发布文件。导出遇到既有文件同样比较真实字节。
- 导出结果的目标重选只更新目的地，不重写已渲染结果的时间线、帧率等身份；已提交状态不能被旧重选、注册或错误回退。本地阶段与租约在同一 IndexedDB 事务内校验并写入，与服务端共用转换判断。远端回执只可合并匹配目标的当前本地句柄；缓存读取失败不能退用旧句柄授权。
- 源材料工具按作用区分当前性：会写稿件/分析的操作核对完整快照，ASR只读核对原片事实，历史观察可读但失配标stale。subject与packet及历史绑定必须由同一冻结输入派生；A→B→A的最终相等不能证明中途没有混包。进度回调后、付费派发前再核对运行/信号；硬截止后的非协作返回不能生效。
- 复核回执与审片板图片的消费同时绑定项目、运行、取消信号和完整规范化工程快照。请求前已取消不提交；JSON 或异步回执哈希完成后上下文已变，不暴露旧 pass 或图片。内容等值的新对象可读；短 revision 仅作原 HTTP 版本绑定，不能替代完整快照等值。原服务端回执保留，不因此重新调用。
- 人审页面按实际看过的板提交：主工程、兄弟片尾、任务与要求一起确定 identity。该 identity 是 HTTP 版本绑定，不能替代内容审核。取消、页面代次或上下文变化后，晚到响应不可写入当前工程或替换当前板。

## 零调用验证入口

| 边界 | 主要回归入口 | 反例 |
| --- | --- | --- |
| 阶段回退、取消及旧派发快照 | `server/clipmentor/production-task.verify.ts`、`server/plugins/clipmentor-production.verify.ts` | 重启跳过返修；取消被等待状态吞掉；重复执行已完成阶段 |
| 共享主体分步提交、人审并发 | `server/plugins/clipmentor-production.verify.ts` | 工程已提交但检查点保存失败；晚反馈擦除共享标记；晚准备覆盖成片确认；真实内容漂移与仅选择变化 |
| 检查点读入与压缩 | `server/clipmentor/production-checkpoint.verify.ts` | 最新正文丢失/损坏不能退回较少次数；等时间戳保留最近发布；旧历史不可伪造 technical epoch |
| 生成任务生命周期与清理 | `server/plugins/generation-job-state.verify.ts`（生产入口含JSON/SQLite） | 坏账本不覆盖；旧回调/旧timer不污染新任务；删除与恢复互斥；持久化失败保留文件；合法legacy正控 |
| 运行索引多写方 | `server/plugins/project-store-agent-runtime.verify.ts`、`server/plugins/project-store-merge.verify.ts` | 旧快照不能删新证据；租约续期仍可见；同版本合入推进版本，重复与 retention 后重放不空增 |
| 产物 body/index 发布 | `src/persist/agentRuntimeStore.verify.ts` | 发布已生效但确认丢失；同步/异步 observer 抛错；清理失败 |
| 交接预算与绑定发布 | `server/clipmentor/handoff-publication.verify.ts` | 部分写入隐藏预算消耗；不同 payload 复用同一运行绑定 |
| raw 与 ASR 分块冷恢复 | `server/clipmentor/saved-model-response-recovery.verify.ts`、`server/plugins/clipmentor-funasr.verify.ts` | 真实子进程中断；只恢复已有块；错来源、损坏和缺结果不补调 |
| 源工具批量边界 | `src/clipmentor/source-context.verify.ts`（接现有生产回归） | 114 例，覆盖 JSON、真实 SHA、回调、命令写入与三种 ABA。等值克隆和只读无关改动放行。新增六例在修复前全部失败。 |
| 客户端回执/图片消费上下文 | `server/plugins/clipmentor-preview-review.verify.ts`、`server/clipmentor/storyboard.verify.ts` | 预取消零提交；JSON/真实 SHA 等待中切换；完整文档短 revision 碰撞；等值克隆及键顺序正控 |
| 截止与晚返回 | `server/clipmentor/external-call.verify.ts` | 登记后发前已到期；非协作 transport 晚返回；未知提交不能重发 |
| 视觉对照发布/取消 | `server/clipmentor/preview-visual-evidence.verify.ts` | 相同字节不同路径的晚取消不删赢家；HTML半提交不伪装缓存；完整提交零抽帧复用 |
| 并发文件发布与同名异字节 | `server/clipmentor/preview-edit.verify.ts`、`server/clipmentor/native-preview-edit.verify.ts`、`server/plugins/export-runtime.verify.ts` | 同尾/异尾并发编码；晚到进程 truncate；同长错文件 |
| 取消后的客户端应用 | `src/clipmentor/source-asr.verify.ts`、`src/clipmentor/production-gate.verify.ts`、`server/clipmentor/source-video.verify.ts` | 取消后完成 JSON/本地投影，不得应用或宣称当前 |
| 看过的板与实际提交 | `server/plugins/clipmentor-production.verify.ts`；前端 `tests/e2e/chimera.spec.ts`、`tests/integration/production-loop.spec.ts` | 主版本不变而片尾/要求改变；旧 409 刷新晚到；旧板 token 不能借用新缓存 |

新 suite 由既有 verify 入口显式导入并 await；不以“文件存在”代替执行。上述是本地假 provider、临时 profile、合成媒体与真实 HTTP/store 夹具，不是付费模型或真实成片质量验收。Node 25 本地结果不等于 Node 24 部署验证。

## 成本与范围

仅存储竞争最多重读/合并三次，不增加外部重试、预算、模型选路、源窗或审批。raw 回读不抽帧、不重新提交。产物权威回读在异常路径发生；正常路径保留原写入。临时编码每次一份，发布后回收本次临时文件；比较既有产物会额外读字节。人审版本变化保留独立 HTML 快照，尚不宣称历史目录有全局容量上限。页面轮询增加兄弟工程身份读取，未据本地夹具时长宣称生产性能提升。

本机执行所有权/串行化不等于多实例分布式锁。休眠原型、演示与只读 UI 小状态保留，不为其新增制作状态或框架。当前工程、历史原判、失败计数和人工接受状态不属于修复对象。

## 2026-11-11 · 后续修复的审计基线

后端以 ClipMentor `main` 的 `e0402a9` 为基线。审计使用同树的 `3caea2a` 工作区。前端以单独的 Chimera 本地提交 `568b284` 为基线；其跟踪分支 `origin/main` 为 `9868b3e`，本地多三笔提交。前端结论限定在所读版本。

每个状态边界先定位当前事实源、提交点和恢复入口。随后按实际故障安排批次。审计区分本地已复现、代码路径确认、已有回归、待验证和休眠路径。104 个旧编号是逐项对账的起点。新发现挂在已有编号上，真正缺失的入口才补编号。已有正反回归的路径保留作合并验收。

本轮通过七个现有验证入口：`src/clipmentor/source-asr.verify.ts`、`src/clipmentor/source-context.verify.ts`、`server/clipmentor/handoff.verify.ts`、`server/clipmentor/external-call.verify.ts`、`server/clipmentor/production-task.verify.ts`、`server/clipmentor/headless-receipt.verify.ts`、`server/plugins/generation-job-state.verify.ts`（JSON 与 SQLite 两种账本）。独立探针使用保存的测试夹具、假回执、时钟切换和私有临时 profile，证实原测试没有覆盖的提交边界。测试未调用外部模型或渲染器，临时输入和输出均已回收。

### 已复现的问题

| 问题 | 入口 | 观察到的结果 |
| --- | --- | --- |
| SM36 截止后仍可登记派发额度 | `server/clipmentor/handoff.ts` 的 `assertRunHandoff` 和 `reserveHandoff` | 预检在截止前 1 ms 通过，进入持久提交时钟已到期，`toolCalls` 仍增加 1。探针发出零外部请求，实际 provider 派发需要独立回归。 |
| SM38/39 取消后仍返回已消费结果 | `server/clipmentor/external-call.ts` 的 `consume` 路径 | raw 已保存，暂停消费函数后取消，再释放消费函数。外层仍返回成功。旧 raw 仍应可读。 |
| SM40 旧回执把过期能力判断重新激活 | `server/clipmentor/external-fetch.ts`、`external-call.ts` | 推进时钟超过 TTL，只读回放旧 404。随后同入口的新有效请求仍被拦在能力预检。 |
| SM86 独立审核结果未应用却报告通过 | `src/clipmentor/request-copy-review.ts` | 使用保存的通过夹具和新回执 ID，编辑命令未写入。工具仍返回 `ok: true` 和 `production_gate.allowed: true`，工程中仍为旧回执。 |
| SM87 ASR 初始化未应用却报告成功 | `src/clipmentor/transcribe-source.ts` | 假回执成功，命令未写入。工具返回修订 1，工程没有分析。 |
| SM32/33 音频文件丢失仍算可复用 | `server/clipmentor/audio-reuse.ts`、`production-readiness.ts` | 对不存在的本地音频，元数据匹配就返回 `reusable`，实测旁白匹配也接受该资产。headless 工具直接把这个结果报告给执行 Agent。 |
| SM59 下载恢复登记失败后卡在运行中 | `server/plugins/generation-job-lifecycle.ts` 的 `resumeGenerationJobDownload` | 恢复开始前的持久化失败，内存已变为 `running`，实际下载未开始。磁盘恢复可写后，再次恢复被拒绝。 |
| SM67 Storyboard 封面元数据存活、文件丢失 | `server/clipmentor/production-panel-delivery.ts` | 原片字节和文档登记有效，封面引用存在但磁盘无文件。封面准备直接抛错，未返回作者可处理的状态，也未尝试本地恢复。 |

### 已确认的代码路径

- SM17/68 的终审核对视频哈希。随后 `production-panel.ts` 的视频读取和下载检查渲染 ID、路径及尺寸。文件被同尺寸的其他字节替换后，下载缺少与终审哈希的比对。使用同尺寸替换和 HTTP Range 做回归，保留正常播放和下载性能。
- SM80/83 的浏览器动作仅在 409 恢复分支检查当前审片板。一般响应、后续状态读取和最终下载之间缺少同样的动作身份检查。在原动作等待时切换渲染或卸载面板，延迟返回可清掉新反馈或尝试下载旧片。浏览器实测留给该批次。

### 批次验收方式

每批以当前基线上的具名故障和涉及的状态边界为范围。沿生产入口重现反例，修复后复跑反例及同入口的合法流程。发生重启、并发或确认丢失时，分别检查用户状态、实际存储和外部提交计数。回归用原有夹具和假服务；只让现有事实源决定是否成功、是否接续。已通过的相邻边界加入批次验收，代码按实际失败调整。

批次独立可合并，复查跨批交界后再结束整个计划。遇到新故障先登记入口、影响、证据和所属批次；只有会使已排批次失效的前置依赖才调整顺序。生产进度、原判、额度和可回读产物在恢复测试前后逐项核对。验证输出使用本轮私有临时目录，进程退出后回收，只留小体积复现证据。

### 修复顺序

| 批次 | 入口与处理 | 验收 |
| --- | --- | --- |
| 1 · 派发授权 | SM01–27、35–36、91–95。先收紧截止与提交之间的现有授权检查，覆盖 API、Codex 和工具入口。 | 跨截止窗口、旧所有者、并发恢复均不得发出未经授权的提交。有效任务可以派发，已发出的请求沿原计数和回执处理。沿 `handoff.verify.ts`、`handoff-publication.verify.ts`、`production-task.verify.ts` 和运行存储回归验证。 |
| 2 · 回执应用 | SM28–31、38–56、86–90。ASR 和独立审核沿用分析工具已有的命令后读回，区分已收到、已写入及写入未确认。检查消费边界的取消信号；只用新取得的响应更新能力时效。各 provider 用原 operation ID 核对恢复行为。 | 命令未写入、写入后换工程或抛错均不给成功。消费期间取消仍可回读原始响应。旧 404 回读不会延长失效的能力结论。有效结果正常应用。沿 `source-context.verify.ts`、`source-asr.verify.ts`、`external-call.verify.ts` 和 `saved-model-response-recovery.verify.ts` 验证。 |
| 3 · 工程与媒体 | SM32–34、37、57–63、66–68、96、98。修下载恢复的持久化边界，校验实际音频和 Storyboard 封面，恢复已有匹配字节，绑定下载到验收过的视频。 | 缺失、同名错字节、重启及提交后确认丢失的用例均覆盖。下载准备保存失败后仍可接续原作业。有效旧工程可继续；未核实音频不触发重配。正确的文件可播放、可下载。复用现有生成任务、音频、Storyboard、导出、上传与 headless 回归。 |
| 4 · 人审与双版本 | SM64–65、69–85。沿实际页面验证蓝图、修改意见、确认、双版预览和下载；动作回执绑定当时版本。 | 延迟旧回复不影响当前反馈与下载；两版各自确认，单版的旧回执不能更新另一版。运行前端 `chimera.spec.ts` 和接真实后端测试服务的 `production-loop.spec.ts`。 |
| 5 · 组合验收 | 合入各批后的准确提交；SM97 及跨批次入口纳入会话切换与重开回归，SM99–104 核对产品入口和作用范围。 | 在一次固定输入的本地联调中完成上传、审稿、确认、取消／恢复、两版交付。关掉一项关键保护，原反例应能失败。记录实际覆盖与剩余风险。 |

批次 1–3 沿 ClipMentor 后端提交，批次 4 在实际前端检出验证后与后端版本一起记录。预计涉及超过八个文件，改动按现有入口拆开。沿用当前事实源和测试入口，无需新依赖、服务、审批或额外付费调用。旧记录信息不足时保留原回执并标明未知，合法兼容有单独正控。单进程所有权结论限定在现有部署形态。

- 批次 1 用同一冻结截止时间检查持久化前和实际派发前。取消或超时后仍可回读已发出的请求。测试对比动作前后额度与 provider 提交次数。
- 批次 2 的命令读回确认编辑稿；工程保存仍由各自调用者确认。有效审稿原判和 ASR 原文不因写入失败改变。
- 批次 3 验证下载与读取使用已核准的媒体身份，并测量连续轮询与 HTTP Range 的磁盘读取量。产物恢复得到不同字节时，沿现有版本和门禁核对，不覆盖旧的批准绑定。
- 批次 4 使用当前项目、任务和预览的身份。过时回复仍可在服务端形成原动作的真实结果，页面只更新与当前动作对应的状态。

### 执行结果

| 批次 | 落点与验证证据 |
| --- | --- |
| 1 | API、Codex 和工具派发共用冻结截止。时钟在预检后、额度写入前跨线时不扣新额度；写入后、派发前跨线或取消时不发送，已登记额度保留。 |
| 2 | 审稿、转写命令从工程读回确认应用。取消后的已保存 raw 仍可恢复，旧回执不延长能力 TTL。预览复核冷启动区分尚未占有派发权和结果未知。R2 只有确定对象或分片已不存在时才按同一字节恢复，内容不符仍拒绝。28 组台账回归通过。独立本地接收器在 9 组故障验收中实收 10 次请求，符合预期，已确认的多余提交为 0。 |
| 3 | 生成任务写入失败时保留可接续状态及原文件。Storyboard 封面和语音校验实际文件；配音用已保存的相同字节补齐，不补调。导出入口验证缺音频时发出零导出请求，恢复相同文件后可派发。已验收成片校验字节后从同一打开句柄提供整段和 Range，缓存最近 32 个文件身份；同大小换文件被拒绝。无复核回执的旧待审预览只允许按原有画幅约束播放，仍无确认或下载资格。 |
| 4 | 反馈与确认在提交时核对实际看过的板，版本变化不覆盖当前反馈。输出清单绑定两版各自的子任务。旧成片的迟到响应不清掉新确认，也不触发旧文件下载。前端 13 个浏览器用例通过。 |
| 5 | 合成视频与三张图片走实际上传 HTTP、项目存储、人审版、反馈、确认、取消和接续，两版成片经各自的页面确认并下载。两份测试 MP4 的字节不同，下载逐版比对。模型、配音和成片审核使用本地替身，验证覆盖产品状态转换与交付，不作为真实媒体质量或远端服务可用性的证据。 |

### 补充收口

- SM42/44 原片观察和独立审核保留同一个操作 ID。只有受跨进程锁保护、身份完全匹配且标明零派发的备料记录才可接续。制作端接回原额度和回执入口。结果未知保留原登记，现有的原始返回回读照常使用。缺少所有权标记的旧备料记录保持阻断。审核备料的中断目录在该操作接续时清理，进入外部派发前删除本地抽帧副本。
- SM40 Fun-ASR 能力范围按账户、入口、模型及固定协议隔离。HTTP 405 和 501 在原有效期内可共享到不同源片、片段和语言。普通 400、404、415 保留各自的请求结果。输入和原始返回的哈希绑定沿用原协议。命中入口能力时，新片段标为未提交，已保存结果仍先回读。
- 本地子进程回归分别在备料、派发后和收到原始结果后中断。核对同任务接续、并发拒绝、错身份和旧标记拒绝、原始判定和次数保持，以及收到结果后零补发。源片观察经过实际制作宿主与 HTTP 路由复核。

## 原盘点逐项归属

“本轮修补”表示该协议至少一个已复现断点修复；“保留现有”表示检查后沿用原机制，不声称新写代码。“低风险保留”“演示保留”“休眠保留”明确不扩展。每行来源是维护入口；动态覆盖以以上具名测试为准，不能从整表推出 104 项均做了动态穷举。

| ID | 协议 / 子状态 | 处置 | 维护入口 |
| --- | --- | --- | --- |
| SM01 | Production lifecycle | 本轮修补 | `server/clipmentor/production-task.ts` |
| SM02 | Checkpoint skip and repair invalidation | 本轮修补 | `server/clipmentor/production-task.ts` |
| SM03 | Effect reservation and replay | 保留现有 | `server/clipmentor/production-task.ts` |
| SM04 | Repair-mode selection | 保留现有 | `server/clipmentor/production-task.ts` |
| SM05 | Repair convergence allowance | 保留现有 | `server/clipmentor/production-task.ts` |
| SM06 | Historical technical-epoch recognition | 保留现有 | `server/clipmentor/production-task.ts` |
| SM07 | Blocked-task reconciliation | 保留现有 | `server/clipmentor/production-worker.ts` |
| SM08 | One author execution per epoch | 保留现有 | `server/clipmentor/production-worker.ts` |
| SM09 | Recovered source evidence application | 保留现有 | `server/clipmentor/production-source-evidence.ts` |
| SM10 | Author self-check freshness | 明确绑定到其他请求的回执拒绝复用 | `server/clipmentor/production-author-self-check.ts` |
| SM11 | Author self-check format repair | 续接已计费的格式重试，未解决项继续阻断 | `server/clipmentor/production-author-self-check.ts` |
| SM12 | Author self-check receipt recovery | 原槽位恢复，核对连续事件和唯一完成终态 | `server/clipmentor/production-author-self-check.ts` |
| SM13 | Human blueprint approval binding | 保留现有 | `server/clipmentor/production-task.ts` |
| SM14 | Pending versus dispatched blueprint feedback | 保留现有 | `server/clipmentor/production-task.ts` |
| SM15 | Feedback summary freshness | 保留现有 | `server/clipmentor/production-feedback.ts` |
| SM16 | One-shot preview feedback | 本轮修补 | `server/clipmentor/production-task.ts` |
| SM17 | Final acceptance and download entitlement | 本轮修补 | `server/clipmentor/production-task.ts` |
| SM18 | Two-output fanout publication | 保留现有 | `server/clipmentor/production-continuation.ts` |
| SM19 | Shared-body producer/follower release | 本轮修补 | `server/clipmentor/production-continuation.ts` |
| SM20 | Untouched follower rebase | 本轮修补 | `server/clipmentor/production-continuation.ts` |
| SM21 | Process execution ownership and cancellation | 本轮修补 | `server/clipmentor/production-task.ts` |
| SM22 | Dispatch, restart and sibling wakeup | 本轮修补 | `server/plugins/clipmentor-production.ts` |
| SM23 | Per-project control exclusion | 保留现有 | `server/clipmentor/production-panel.ts` |
| SM24 | Interrupted checkpoint arbitration | 本轮修补 | `server/clipmentor/production-task.ts` |
| SM25 | History compaction publication | 本轮修补 | `server/clipmentor/production-task-history.ts` |
| SM26 | Narrow canvas-reflow repair exception | 保留现有 | `server/clipmentor/production-worker.ts` |
| SM27 | Provider/settings preflight cache | 低风险保留 | `server/clipmentor/production-panel.ts` |
| SM28 | Analysis mutation/CAS | 已补调用期间的工程／运行／取消与实际写入校验 | `src/agent/tools/clipmentor-analysis-tools.ts` |
| SM29 | Current candidate/picture-plan pair | 保留现有 | `src/agent/tools/clipmentor-analysis-tools.ts` |
| SM30 | Point-review freshness | 确认及退回绑定同一次读取的版本和要点摘要，覆盖撤销后复用数字版本 | `src/agent/tools/clipmentor-analysis-tools.ts`、`src/clipmentor/analysis.ts` |
| SM31 | Production copy-approval freshness | 已补回执和分页读取期间的时效校验 | `src/agent/tools/clipmentor-analysis-tools.ts`、`src/clipmentor/production-gate.ts` |
| SM32 | Readiness routing projection | 保留现有 | `server/clipmentor/production-readiness.ts` |
| SM33 | Audio reuse eligibility projection | 保留现有 | `server/clipmentor/audio-reuse.ts` |
| SM34 | Speech-anchor file cache and certification | 保留现有 | `server/clipmentor/word-anchors.ts` |
| SM35 | Frozen handoff-policy lifecycle | 本轮修补 | `server/clipmentor/handoff.ts` |
| SM36 | Handoff budget/deadline reservation | 保留现有 | `server/clipmentor/handoff.ts` |
| SM37 | Creator-document authoring and evidence binding | 保留现有 | `server/clipmentor/creator-storyboard-document.ts` |
| SM38 | Governed external call journal | 保留现有 | `server/clipmentor/external-call.ts` |
| SM39 | Deadline versus late response | 本轮修补 | `server/clipmentor/external-call.ts` |
| SM40 | Endpoint capability TTL | Fun-ASR 按端点协议复用确定的能力错误，原始结果身份保留 | `server/clipmentor/external-fetch.ts`、`server/plugins/clipmentor-funasr.ts` |
| SM41 | Gateway bounded recovery | 保留现有 | `server/clipmentor/production-recovery.ts` |
| SM42 | Source-video observation operation | 匹配的新备料记录可接续，未知提交只回读 | `server/clipmentor/source-video.ts` |
| SM43 | Source-video derived recovery | 保留现有 | `server/clipmentor/source-video.ts` |
| SM44 | Independent copy-review operation | 锁内接续同请求与审核要求；保留原始判定 | `server/clipmentor/copy-review.ts` |
| SM45 | Copy-review contract/scope reinterpretation | 保留现有 | `server/clipmentor/copy-review.ts` |
| SM46 | Preview subprocess request recovery | 保留现有 | `server/plugins/clipmentor-preview-review.ts` |
| SM47 | Preview effective approval projection | 保留现有 | `server/plugins/clipmentor-preview-review.ts` |
| SM48 | Deferred visual comparison | 本轮修补 | `server/clipmentor/preview-visual-evidence.ts` |
| SM49 | Shared visual-evidence job | 本轮修补 | `server/clipmentor/preview-visual-evidence.ts` |
| SM50 | ASR operation/chunk aggregate | 本轮修补 | `server/plugins/clipmentor-funasr.ts` |
| SM51 | ASR saved-result readability/recovery | 本轮修补 | `server/plugins/clipmentor-funasr.ts` |
| SM52 | R2 multipart transfer | 保留现有 | `server/clipmentor/video-media.ts` |
| SM53 | R2 verified-object reuse | 保留现有 | `server/clipmentor/video-media.ts` |
| SM54 | R2 credential single-flight | 保留现有 | `server/clipmentor/video-media.ts` |
| SM55 | Observation excerpt publication | 保留现有 | `server/clipmentor/observation-material.ts` |
| SM56 | Governed MiniMax raw-to-asset pipeline | 保留现有 | `server/plugins/voice-providers.ts` |
| SM57 | Bound local preview-edit permit | 本轮修补 | `server/clipmentor/preview-edit.ts` |
| SM58 | Material-intake commit/cleanup | 本轮修补 | `server/clipmentor/material-intake.ts` |
| SM59 | Export/generation job lifecycle | 本轮修补 | `server/plugins/generation-job-lifecycle.ts`、`server/plugins/generation-job-store.ts` |
| SM60 | Export temporary-to-managed publication | 本轮修补 | `server/plugins/export-runtime.ts` |
| SM61 | Export delivery claim/reconciliation | 本轮修补 | `server/plugins/project-store-export-recovery.ts`、`src/export/serverExportRecovery.ts` |
| SM62 | Agent upload staging ownership | 保留现有 | `server/plugins/upload-route-write.ts` |
| SM63 | Uploaded-asset finalize commit | 已补调用失效、目标冲突、确认丢失与重载的批次回归 | `src/agent/tools/upload-finalize.ts`、`upload-tools.verify-lifecycle.ts` |
| SM64 | Per-project board generation exclusion | 保留现有 | `server/clipmentor/blueprint-review-board-api.ts` |
| SM65 | Panel board cache/confirmation prerequisite | 本轮修补 | `server/clipmentor/production-panel.ts` |
| SM66 | Creator PDF generation single-flight | 保留现有 | `server/clipmentor/creator-storyboard.ts` |
| SM67 | Storyboard cover registration freshness | 保留现有 | `server/clipmentor/production-panel-delivery.ts` |
| SM68 | Attachment delivery availability | 保留现有 | `server/clipmentor/production-deliverables.ts` |
| SM69 | Offline board candidate freshness | 保留现有 | `server/clipmentor/blueprint-review-board-page.ts` |
| SM70 | Lazy storyboard image queue | 低风险保留 | `server/clipmentor/storyboard-page.ts` |
| SM71 | Whole-board stale-snapshot stop | 保留现有 | `server/clipmentor/storyboard-page.ts` |
| SM72 | Image zoom interaction | 低风险保留 | `server/clipmentor/blueprint-review-board-page.ts` |
| SM73 | Per-slot material validation generation | 保留现有 | `Chimera-Prototype-Mockup/src/pages/ClipMentorPage.tsx` |
| SM74 | Aggregate upload admission | 保留现有 | `Chimera-Prototype-Mockup/src/pages/ClipMentorPage.tsx` |
| SM75 | Saved-intake bootstrap | 保留现有 | `Chimera-Prototype-Mockup/src/pages/ClipMentorPage.tsx` |
| SM76 | Business page-state projection | 保留现有 | `Chimera-Prototype-Mockup/src/pages/productionPanelState.ts` |
| SM77 | Monotonic task hydration | 保留现有 | `Chimera-Prototype-Mockup/src/pages/ProductionPanel.tsx` |
| SM78 | Status polling/reconnection | 本轮修补 | `Chimera-Prototype-Mockup/src/pages/ProductionPanel.tsx` |
| SM79 | Revision-bound board loading | 本轮修补 | `Chimera-Prototype-Mockup/src/pages/ProductionPanel.tsx` |
| SM80 | UI mutation and safe board-reload repost | 本轮修补 | `Chimera-Prototype-Mockup/src/pages/ProductionPanel.tsx` |
| SM81 | Feedback editing/eligibility | 本轮修补 | `Chimera-Prototype-Mockup/src/pages/ProductionPanel.tsx` |
| SM82 | Per-render human acknowledgment | 保留现有 | `Chimera-Prototype-Mockup/src/pages/ProductionPanel.tsx` |
| SM83 | Accept-and-download UI effect | 保留现有 | `Chimera-Prototype-Mockup/src/pages/ProductionPanel.tsx` |
| SM84 | Shared-blueprint/two-output presentation | 保留现有 | `Chimera-Prototype-Mockup/src/pages/ProductionPanel.tsx` |
| SM85 | Progress-step projection | 保留现有 | `Chimera-Prototype-Mockup/src/pages/productionPanelState.ts` |
| SM86 | Copy result received versus applied | 本轮修补 | `src/clipmentor/request-copy-review.ts` |
| SM87 | ASR one-shot initialization | 本轮修补 | `src/clipmentor/transcribe-source.ts` |
| SM88 | Observation/saved-ASR read currentness | 本轮修补 | `src/clipmentor/request-source-video.ts`、`src/clipmentor/read-source-asr.ts` |
| SM89 | Preview client effective-gate projection | 本轮修补 | `src/clipmentor/request-preview-review.ts` |
| SM90 | Storyboard/artifact snapshot readers | 本轮修补 | `src/clipmentor/read-storyboard.ts` |
| SM91 | Agent-run lifecycle/terminal settlement | 保留现有 | `server/agent-runs/store-types.ts` |
| SM92 | Tool claim/result settlement | 保留现有 | `server/agent-runs/store-tools.ts` |
| SM93 | Cold Agent-run/event recovery | 本轮修补 | `server/agent-runs/store-recovery.ts`、`src/persist/agentRuntimeStore.ts` |
| SM94 | Project edit ownership lease | 保留现有 | `server/external-agent/project-edit-ownership.ts` |
| SM95 | Agent-run ownership lease | 本轮修补 | `server/plugins/project-store-agent-runtime.ts` |
| SM96 | Headless draft/commit transaction | 保留现有 | `server/clipmentor/headless-editor.ts` |
| SM97 | Agent session generation | 保留现有 | `src/persist/agentSessionGeneration.ts` |
| SM98 | Artifact body/index publication | 本轮修补 | `src/persist/agentRuntimeStore.ts` |
| SM99 | Development profile bootstrap | 低风险保留 | `scripts/dev-profile.mjs` |
| SM100 | Reachable explicit demo flow | 演示保留 | `Chimera-Prototype-Mockup/src/pages/ClipMentorPage.tsx` |
| SM101 | Dormant prototype project processing | 休眠保留 | `Chimera-Prototype-Mockup/src/stores/projectStore.ts` |
| SM102 | Dormant prototype adjustment history | 休眠保留 | `Chimera-Prototype-Mockup/src/stores/projectStore.ts` |
| SM103 | Dormant prototype auth | 休眠保留 | `Chimera-Prototype-Mockup/src/stores/authStore.ts` |
| SM104 | Dormant prototype upload/processing navigation | 休眠保留 | `Chimera-Prototype-Mockup/src/pages/UploadPage.tsx` |
