# ClipMentor 状态机接手说明

## 从哪里接手

后端仓库为 `bobwongagi-code/ClipMentor`，前端在独立的 `Chimera-Prototype-Mockup` 仓库。2026-11-18 核对的合并基线是后端 `50e6860`、前端 `7c9c1dc`。两边的 `codex/clipmentor-state-handoff` 已合入各自的 `main`。前端仓库需要已有访问权限。

从已克隆的对应仓库进入各自的接手工作树。若远端名有区别，使用 `git remote -v` 核对后替换。

```bash
# ClipMentor 后端检出
git fetch rootify main
git worktree add --detach ../clipmentor-state-next rootify/main

# Chimera 前端检出
git fetch origin main
git worktree add --detach ../clipmentor-web-next origin/main
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

父清单在控制提交途中变化、父子会话轮换、阶段保存失败以及实际处理器下的双标签页旧动作，均已有合入的回归。详见[盘点与组合证据](docs/clipmentor-state-machines.md)。继续从最新已合并版本复核，遇到可复现问题先加失败对照，再跑合法旧版正对照。

待补的验证包括通用远程 project-store 的跨工程条件、Node 24 环境和多实例部署。现有本地回归可查持久化数据、派发次数、页面状态和导出字节。真实服务与成片质量仍需各自的直接证据。

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

> 从 ClipMentor 和 Chimera 前端各自最新的 `main` 开始。先读 HANDOFF 和盘点中的最新验收，复跑制作 HTTP 与浏览器联调。保留真实工程、历史回执、额度和媒体。每轮用本地替身测试并回收本轮临时文件与生成缓存。
