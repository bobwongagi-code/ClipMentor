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
| 源工具批量边界 | `src/clipmentor/source-context.verify.ts`（接现有生产回归） | 108例：JSON/真实SHA/回调/最终写入/三种ABA；合法克隆与只读无关改动放行 |
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
| SM10 | Author self-check freshness | 保留现有 | `server/clipmentor/production-author-self-check.ts` |
| SM11 | Author self-check format repair | 保留现有 | `server/clipmentor/production-author-self-check.ts` |
| SM12 | Author self-check receipt recovery | 保留现有 | `server/clipmentor/production-author-self-check.ts` |
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
| SM28 | Analysis mutation/CAS | 保留现有 | `src/agent/tools/clipmentor-analysis-tools.ts` |
| SM29 | Current candidate/picture-plan pair | 保留现有 | `src/agent/tools/clipmentor-analysis-tools.ts` |
| SM30 | Point-review freshness | 保留现有 | `src/clipmentor/analysis.ts` |
| SM31 | Production copy-approval freshness | 保留现有 | `src/clipmentor/production-gate.ts` |
| SM32 | Readiness routing projection | 保留现有 | `server/clipmentor/production-readiness.ts` |
| SM33 | Audio reuse eligibility projection | 保留现有 | `server/clipmentor/audio-reuse.ts` |
| SM34 | Speech-anchor file cache and certification | 保留现有 | `server/clipmentor/word-anchors.ts` |
| SM35 | Frozen handoff-policy lifecycle | 本轮修补 | `server/clipmentor/handoff.ts` |
| SM36 | Handoff budget/deadline reservation | 保留现有 | `server/clipmentor/handoff.ts` |
| SM37 | Creator-document authoring and evidence binding | 保留现有 | `server/clipmentor/creator-storyboard-document.ts` |
| SM38 | Governed external call journal | 保留现有 | `server/clipmentor/external-call.ts` |
| SM39 | Deadline versus late response | 本轮修补 | `server/clipmentor/external-call.ts` |
| SM40 | Endpoint capability TTL | 保留现有 | `server/clipmentor/external-call.ts` |
| SM41 | Gateway bounded recovery | 保留现有 | `server/clipmentor/production-recovery.ts` |
| SM42 | Source-video observation operation | 本轮修补 | `server/clipmentor/source-video.ts` |
| SM43 | Source-video derived recovery | 保留现有 | `server/clipmentor/source-video.ts` |
| SM44 | Independent copy-review operation | 本轮修补 | `server/clipmentor/copy-review.ts` |
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
| SM63 | Uploaded-asset finalize commit | 保留现有 | `src/agent/tools/upload-finalize.ts` |
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
