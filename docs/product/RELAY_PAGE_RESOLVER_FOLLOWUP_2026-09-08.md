# Relay 零媒体时主动解析页面：后续方案

日期：2026-09-08。状态：**方案，尚未实现；下列验收均待执行。** 本轮只读追踪已有代码，没有新增 popup 入口。本报告不应被当成已完成能力或强制产品规格。

## 具体问题

popup 的媒体卡目前仅在 `mediaCount > 0` 时出现。用户在视频尚未开始播放、网络媒体尚未被探测或页面面板未出现时，没有直接请求 NDM 解析当前页面的入口。已有“显示下载选项”只是要求 content script 展开已有面板；找不到候选就没有可展示内容。

代码位置：`extension/NDMRelay/popup.html` 的隐藏 `media-card`；`popup.js` 的 `refreshState`、`show-panel`；`ct.js` 的 `showAllPanels`。

## 可以复用什么

现有 `site-adapters.js` 识别具体站点页面并规范 URL；`ct.js` 的 `downloadSitePage` 把该 URL 作为 `media-page` 交给桥接。Bilibili 分P与 Vimeo 访问 hash 已有身份保留修复，应继续复用，不能另写一个丢参数的 URL 清洗器。

原生 `native/Sources/NDMHost/main.swift` 的 `bridge.onDownloadMessage` 收到 `media-page` 后广播 `openMediaComposer`。`src/renderer/src/App.tsx` 处理该消息，随后打开现有 Composer；`Composer.tsx` 与 `lib/store.ts` 已有 `probeMedia`、格式选择、重试解析和返回浏览器的路径。

有两个需要明确保留的行为边界：

- App 会先分类 URL；确认非 HTML 的文件可能直接 `addFromUrl`，所以该消息并非无条件打开确认弹窗。
- Composer 对已知媒体页面解析失败会阻止误存网页，但未知网页仍可能回退到普通下载。因此首版不能把任意页面自动标为视频。

原生认证错误分类正由主线维护；本方案不重做该逻辑，也不默认触发读取浏览器会话。

## 当前没有任务级 ACK

**现有协议没有“NDM 已打开格式选择器”“已建立任务”或“下载完成”的逐请求确认，popup 也没有等待这些确认后关闭的机制。**

| 当前信号 | 实际含义 | 不能代表 |
| --- | --- | --- |
| popup 探测 WebSocket `onopen` | 本地桥接连接建立 | 页面已解析或任务已创建 |
| `relay:downloadResource` 返回 `sent` | 后台找到资源和 content port，并转交消息 | native 已收到、格式已可选或下载成功 |
| `relay:showMediaPanel` | 要求页面显示已有面板；popup 随即关闭 | 面板实际可见或 native 已接受任务 |
| `NDMRelayStatus` | 握手/运行状态 | 逐条页面请求回执 |

相关代码：`popup.js` 的 `probeBridge`、资源按钮反馈、`show-panel`；`bg.js` 的 runtime message listener；`native/Sources/NDMBridge/BrowserBridge.swift` 的状态响应与下载消息回调。不能把传输层连通包装成任务级 ACK。

## 建议的最小实现

1. 零媒体计数时，对适配器能识别的**具体媒体页面**显示“解析当前页”，由用户主动点击；不在后台自动解析。
2. 复用现有页面识别与 `downloadSitePage`，将带内容身份的页面 URL 作为 `media-page` 转交。后台检查 tab 与当前导航是否仍匹配，不能使用 popup 打开时的过期页面。
3. 等待后台对本次转交操作给出有限反馈，但不要将其命名为 native 任务确认。成功文案为“请求已发送，请在 NDM 中选择”；popup 保持打开，用户可以自行关闭。
4. 未连接、找不到 content port 或发送失败时保留按钮与明确错误，不关闭 popup，不显示“已下载”。解析失败和画质选择交给现有 Composer。

本轮不建议为这个入口单独新增任务级 ACK 协议。若后续确需自动关闭，应先实现带请求 ID 的 native 接受/拒绝回执、超时与重复请求语义，再决定关闭时机。

## 首版识别边界

仅覆盖当前适配器可明确识别内容的已知站点页面，例如 YouTube watch/shorts/live、Bilibili 普通视频页、Vimeo 视频页、TikTok 单视频及 Douyin 视频页；具体集合由现有识别器确定。这里的“可识别”不等于“已验证能下载”。

不自动处理主页、信息流中不明确的多个视频、搜索页、任意网页、浏览器内部页面或无法确认目标的短链接。X/Instagram 信息流有多个对象时，继续使用现有逐条内容入口；没有明确当前对象，不把第一条结果当成用户要下载的内容。短链接需要当前页面已解析到明确内容，或另行验证专门解析流程。

现有公开探测曾出现 Vimeo 匿名提取失败，因此显示该入口也不得宣传整个站点已兼容。入口负责可靠交接，成功范围必须由实际端到端测试证明。

## 预期改动文件

| 文件 | 预计工作 |
| --- | --- |
| `extension/NDMRelay/popup.html`、`popup.js` | 零媒体主动解析按钮、pending/错误反馈、保持 popup 打开 |
| `extension/NDMRelay/_locales/zh_CN/messages.json`、`en/messages.json` | 与实际交接阶段一致的中英文文案 |
| `extension/NDMRelay/bg.js` | 当前 tab/导航验证与明确的后台转交结果 |
| `extension/NDMRelay/ct.js` | 接入消息并复用 `downloadSitePage`，不另建提取器 |
| `extension/NDMRelay/site-adapters.js` | 优先复用已有识别能力；只有验证发现缺口才调整 |
| Relay 单元与浏览器测试 | 覆盖 popup、后台契约、导航与重复点击；不依赖真实视频网站网络 |

首版预计不需要修改原生下载引擎。若发现现有 Composer 无法满足边界，应另立具体修复，而不是静默扩大入口行为。

## 待执行验收

- [ ] 已知具体媒体页面计数为 0 时，用户可主动解析；未点击不产生探测或下载。
- [ ] 普通网页和内部页面不被自动当作视频；信息流没有明确目标时不选错第一条。
- [ ] Bilibili `p` 与 Vimeo 访问上下文完整传至现有媒体选择流程，敏感链接不新增到日志。
- [ ] popup 打开后页面导航，点击时使用当前页面或明确拒绝过期请求。
- [ ] 连续点击与多个入口不会创建重复请求；等待状态允许理解和恢复。
- [ ] 桥接未连接、content port 不存在、转交失败时不关闭 popup，不显示成功下载文案。
- [ ] “已发送”只描述后台已确认的转交阶段；不冒充 native 接受、格式选择成功或下载完成。
- [ ] 已知站点解析失败能在 Composer 重试或返回来源页，不悄悄把 HTML 保存为视频。
- [ ] Relay 契约测试、真实隔离浏览器 fixture 与必要的 Composer 回归通过；真实站点结果另行记录，不混进确定性 CI 单测。
