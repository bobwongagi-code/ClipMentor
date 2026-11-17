# ClipMentor 状态机接手说明

## 从哪里接手

后端仓库为 `bobwongagi-code/ClipMentor`。本文件所在的 `codex/clipmentor-state-handoff` 分支是接手基线。此次修改前的后端树为 `f24436c`，与已合并的 `4f58502` 内容一致。前端在独立的 `Chimera-Prototype-Mockup` 仓库，同名分支的配对提交为 `8690ffd6939a62cabd1d51be90d4967ec030175b`，包含已有的 ClipMentor 前端提交和本次网页修复。前端仓库需要已有访问权限。

从已克隆的对应仓库进入各自的接手工作树。若远端名有区别，使用 `git remote -v` 核对后替换。

```bash
# ClipMentor 后端检出
git fetch rootify codex/clipmentor-state-handoff
git worktree add --detach ../clipmentor-state-next FETCH_HEAD

# Chimera 前端检出
git fetch origin codex/clipmentor-state-handoff
git worktree add --detach ../clipmentor-web-next FETCH_HEAD
```

先读 [HANDOFF.MD](HANDOFF.MD) 最新几节和 [原状态机盘点](docs/clipmentor-state-machines.md) 的批次验收、网页状态及双版本派发部分。范围是已盘点的 ClipMentor 生产状态机。用实际入口重现可确认的缺陷并修复，沿用现有状态和存储。测试使用隔离工程、合成媒体和本地服务替身。保留真实工程、媒体、历史审核判断及外部调用计数。

## 已落地的行为

| 边界 | 已落地 | 从这里看 |
| --- | --- | --- |
| 原片观察、ASR、成片复核 | 有确切零派发证据才接续原操作。已派发或结果未知继续查现有回执。ASR 原始返回要匹配来源、配置、实际音频和片段。 | `headless-editor.ts`、`preview-review-cli.mts`、`server/plugins/clipmentor-funasr.ts` |
| 持久化回执 | 写入报错时，只按序号推进且整份内容精确匹配的存储回读确认。写前失败不派发。准备阶段取消或超时先查现行检查点。 | `production-task.ts`、`production-continuation.ts` |
| 双版与旧版单结尾 | 直接恢复、网页控制、子任务唤醒和冷启动核对当前父清单。父清单错误或被替换时保留原子任务。删除的子任务不重排队，有效兄弟任务仍可恢复。旧单结尾清单按实际绑定读取。 | `production-panel.ts`、`server/plugins/clipmentor-production.ts` 及同名 `.verify.ts` |
| 页面、代理与素材接续 | 版本指纹双向透传。旧轮询和旧草稿不影响当前稿件。重开读取保存的终审。上传断开时按四份素材哈希回读。 | 前端 `vite.config.ts`、`src/pages/ProductionPanel.tsx`、`src/pages/ClipMentorPage.tsx` |

## 下一步

1. 从实际制作 HTTP 继续查跨工程竞态。在持久化子任务前挂起控制请求，同时替换当前父任务、删除工程或切换会话，再恢复原请求。核对对象身份、实际写入、原回执和派发次数。现有回归覆盖请求进入前父清单已失效，也覆盖排队与取消相撞。父清单在控制请求途中变化的组合需要补直接证据。
2. 用配对前端补多标签页的组合验证。一个标签页保存新蓝图或终审，另一个保留旧审片板、预览或待返回操作。检查两版各自的确认、附件和下载对象。已有真实后端联调、页面重开、旧响应竞态和实际 Vite 代理的分项证据。
3. 与盘点逐条对照。遇到可复现问题先加失败对照，再修复并跑合法旧版正对照。以持久化数据、实际派发、当前页面状态和导出字节判断。记录仍未覆盖的部署或真实服务边界，避免把模拟工作流当成真实成片或远端可用性验收。

## 本地验证入口

交接前已复跑后端生产、外部调用、ASR、成片复核、源视频和 R2 套件，以及 Node 类型检查。前端应用与 Node 类型检查、17 项浏览器测试和 2 项浏览器联调均通过。联调包含真实本地 Vite 代理，以及实际制作处理器的端到端测试。两边使用合成数据和隔离存储，未发出真实外部服务调用。

后端工作树已安装仓库依赖后执行以下命令。生产套件含合成 MP4 的小规模渲染。用任务专用临时目录，加一次运行前后的缓存清点。进程退出后回收本轮产物，保留简要结果。

```bash
export TMPDIR="$(mktemp -d /tmp/clipmentor-state-verify.XXXXXX)"
npm run verify:clipmentor-production
npm run verify:clipmentor-external-calls
npm run verify:clipmentor-asr
npm run verify:clipmentor-preview-review
npm run verify:clipmentor-source-video
./node_modules/.bin/tsc -p tsconfig.node.json --noEmit
```

前端从其工作树运行。将后端路径设为配对检出的绝对路径。用已有 Chromium。联调的 Vite 端口是 5173，代理回归会先尝试独占 5199，端口已占用时先确认服务归属。

```bash
export TMPDIR="$(mktemp -d /tmp/clipmentor-web-verify.XXXXXX)"
export CLIPMENTOR_TEST_SOURCE_ROOT=/absolute/path/to/clipmentor-state-next
CI=1 ./node_modules/.bin/playwright test --workers=2 --output "$TMPDIR/e2e"
CI=1 ./node_modules/.bin/playwright test -c playwright.integration.config.ts --output "$TMPDIR/integration"
```

**可复制给接手 Agent**

> 从 ClipMentor 和 Chimera 前端的 `codex/clipmentor-state-handoff` 分支继续。先读本交接和对应 HANDOFF，复跑制作 HTTP 与浏览器联调，再查跨工程恢复竞态和两标签页验收。只修复能从实际入口证明的问题。保持真实工程、历史回执、额度和媒体完整，所有回归零外部服务调用。每轮验收后回收本轮临时文件和新生成缓存。全局审计仍未收口。
