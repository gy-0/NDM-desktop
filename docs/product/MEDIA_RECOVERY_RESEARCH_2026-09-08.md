# 媒体解析失败后的恢复路径

研究日期：2026-09-08。范围：重新查阅 yt-dlp 官方文档、固定版本提取器源码，并只读当前 NDM 的会话入口。本轮没有请求视频网站媒体、读取 cookies、登录、改变网站状态或运行下载；没有扩大已验证站点范围。

## 证据边界

已读 `PUBLIC_MEDIA_PROBE_2026-09-08.md` 与 `RELAY_COMPATIBILITY_RESEARCH_2026-09-08.md`。已有记录只证明旧工具的 YouTube/Bilibili 各一个匿名样本元数据提取成功；Vimeo 旧工具在 macOS OAuth 阶段失败，2026.08.19 候选沿用产品 CA 后返回登录要求。候选 YouTube 未恢复成功。不同时间、参数和工具的结果不能拼成一次产品端到端验证。

下列 Wiki 内容是本次访问到的动态文档；源码链接固定到 **2026.08.19**，不代表 NDM 已升级到该版本。官方仓库里的用户 issue 只能证明有人报告现象，不作为整站根因或成功率证据。

## 三站实际要求

| 站点 | 官方依据 | 对恢复交互的含义 |
| --- | --- | --- |
| YouTube | 官方说明账号内容可需要 cookies；浏览器中的账号 cookies 会轮换；OAuth 登录已不可用。文档同时把请求频率限制单列为一种错误。[Extractors](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies) | 先匿名，只有明确需要账号时才让用户选择会话；过期会话可以重新授权，但限流不能一律归为未登录，也不能靠自动循环重试。 |
| YouTube 运行依赖 | EJS 文档要求受支持的 JS runtime；官方打包可执行文件已经附带 EJS 脚本。PO Token 是另一项条件，客户端、格式与账号状态影响要求，并非有 cookies 就一定能获取所有格式。[EJS](https://github.com/yt-dlp/yt-dlp/wiki/EJS)、[PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide) | 缺 runtime、脚本不匹配、客户端限制都应作为工具诊断，不能要求用户反复登录。当前产品显式客户端配置需要独立回归，不可用上游默认客户端成功替代验收。 |
| Vimeo | 固定源码的默认 web API 客户端要求认证；嵌入隐私错误另要求嵌入页面地址，视频密码又是独立参数。[Vimeo 源码](https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/yt_dlp/extractor/vimeo.py) | 区分账号会话、视频访问密码、嵌入来源上下文。不能把某条 API 需认证外推为所有 Vimeo 公共视频都必须登录。既有样本失败仍未解决。 |
| Bilibili | 固定源码分别处理普通视频、会员格式缺失、只可预览、地区限制、需登录字幕与私有列表；其中只可预览可以是警告而非提取失败。[Bilibili 源码](https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/yt_dlp/extractor/bilibili.py) | 能列出格式不代表是完整正片或最高画质；会员权限与会话存在是不同条件。字幕失败也不应错误否定已经取得的视频轨。 |

通用 cookies 文档支持直接从指定浏览器提取，也支持 Netscape 格式文件。导出整份浏览器 cookie 文件会包含超出当前网站的数据，因此产品不应为了便捷偷偷导出或默认读取全部账号；本轮没有进行此操作。[官方 FAQ](https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp)

## 当前代码已经做到什么

- `native/Sources/NDMHost/main.swift` 的 `probeMedia` 仅在请求显式包含受支持的 `cookieBrowser` 时走浏览器会话预检。当前白名单含 Chrome、Firefox、Safari、Edge、Brave、Chromium。
- `native/Sources/NDMEngine/YtDlpTool.swift` 已区分 `browserDataUnavailable` 与 `browserSessionRequired`，支持浏览器或文件形式的 cookie source。
- `src/renderer/src/components/Composer.tsx` 有 Chrome 会话重试、打开来源页面和普通解析重试。读取浏览器失败的文案没有假称授权成功。

这些是源码可见能力；本轮没有验证某个浏览器实际读取得到正确账号、macOS 权限通过或带账号下载成功。

## 最值得修复的三个缺口

### 1. 地区/会员权限与登录需求被合并

`YtDlpTool.accessIssue(in:)` 的 sessionMarkers 包含 `geo-restricted`、地区不可用、会员专享等；Composer 随后统一显示“需要刚刚访问过的浏览器会话”，主动作是 Chrome 重试。对于地区限制，这条因果提示不成立；会员格式缺失也不等于用户只需登录。

建议先细分 `regionRestricted`、`entitlementRequired` 与真正的 `browserSessionRequired`。前两者保留“在浏览器中查看访问条件”，只有用户确认该账号可观看时再显式提供会话重试。限流、DRM、工具依赖失败不得进入登录提示。验收用脱敏诊断 fixture 覆盖每类，检查文字、按钮及不自动读取 cookies；不需要在真实受限页面试错。

### 2. 会话入口固定 Chrome，读取失败后缺少原地重试

Composer 的 `retryWithChrome` 固定 Chrome；Host 虽支持多个浏览器，但 UI 没有对应选择。用户在 Firefox 登录而 Chrome 未登录时，会反复提交错误会话。`browserDataUnavailable` 当前只有打开页面动作，用户排除读取问题后也没有明确原地重试按钮。

建议复用 Host 白名单提供简短浏览器选择，保持逐次明确授权；读取失败后保留已选浏览器与重试动作。不要直接暴露任意文件系统 profile 路径，也不要擅自迁移到另一个账号。验收使用模拟 Host 返回失败→成功，确认选择随 probe 与后续下载一致，失败不静默退回匿名。真实多账号/profile 支持另列待验，不能仅凭浏览器名称就宣称已覆盖。

### 3. “成功但受限”的媒体结果没有明显表达

当前 `YtDlpTool.probe` 从 JSON 构造 title/duration/formats/subtitles/缓存路径；未见把上游只可预览或权限相关 warning 作为结构化结果送到 Composer 的字段。因此 Bilibili 的预览格式可能仍以普通成功结果呈现。这是静态代码判断，未用会员页面实测，不断言当前具体视频已出现误导。

建议增加白名单化的受限结果字段（例如 preview-only），不把原始 stderr 展示给用户，也不凭短时长猜预览。明确上游预览信号时显示“当前仅提供预览”，保留已经可用的格式；获取完整版本需要用户自身访问权限。验收使用固定上游结构/警告 fixture，检查普通短视频不被误标、预览内容不被宣传成完整正片。

## 后续验收门槛

先完成上述确定性错误交互，再由用户授权具体账号与自有视频做小样本端到端验证。每个样本记录工具版本、页面类型、会话浏览器、格式选择、最终音画与时长；不保存 cookies、签名 URL 或原始敏感诊断。Vimeo 嵌入来源/密码和 YouTube 客户端依赖作为独立场景，不与“登录后成功”混为一个开关。

本报告是后续建议，未改产品代码，也没有证明升级 yt-dlp 即可修复当前 Vimeo 样本。

## 本轮交付跟进

会话数据不可用及普通解析异常现均有原地“重试解析”。真实 Electron IPC 验证失败→重试，链接、自定义文件名及显式 Chrome 来源保留，成功清除错误且不自动创建下载。日志 `/tmp/ndm-composer-retry-green.log`。浏览器选择仍固定 Chrome；地区/会员权限与预览结果的细分仍待实现，本次未扩大实际网站兼容范围。

Relay 1.4.7 修复旧连接探测覆盖新成功状态，保留备用端口重试；102 项契约检查与 17 项隔离 Chrome fixture 通过。设置中的扩展路径使用已有复制反馈组件，真实 Electron 验证复制失败可重试、路径完整且布局无溢出。用户 Chrome 是否实际重载新版仍需单独确认，随包版本不等于已运行版本。

## 地区与会员错误分类交付跟进

新增 `regionRestricted` 与 `entitlementRequired`，Host 显式传给界面。原有登录与浏览器数据不可用分类保留；`requiresCookies` 不再把新类别当成需要会话。多行工具诊断优先保留具体限制原因，而非最后一行泛化 cookies 建议。私有视频、年龄验证等其他既有登录分类未在此批重定义。

界面显示来源访问条件，地区限制无 Chrome 重试动作；会员权限只有用户明确选择才走现有会话重试。普通 probe、显式会话 probe、提交和 store 的 HTML fallback 均处理新类别。

`scripts/qa-media-access-host.mjs` 使用真实独立 Host RPC 和临时 yt-dlp 错误 fixture。installed12 将地区/会员样本误归登录，新 debug Host 四类正确，未创建任务。`scripts/qa-media-access-ui.mjs` 在真实 Electron 中注入结构化错误，验证地区无登录动作、会员显式会话请求、保留输入和不下载 HTML；旧 installed12 缺少对应地区状态，新界面通过。两种测试分别证明原生协议和 UI 行为，不代表实际站点兼容或账号授权成功。日志 `/tmp/ndm-media-access-debug-green.log`、`/tmp/ndm-access-ui-green.log`。

此批已安装为 build 2026090813。285 项 UI/脚本检查与完整原生 927 项 XCTest（7 环境跳过）、11 项 Swift Testing 均通过。正式包实际 Host 与 Electron fixture 通过；安装内容与正式包哈希一致，启动健康后清理旧包。仍未验证新的真实视频网站/账号访问能力。

## 显式浏览器会话交付跟进

Composer 现可在 macOS 选择 Chrome、Firefox、Safari、Edge、Brave、Chromium，Windows 不显示 Safari。受支持的既有偏好只用于初始选择；本次选择不修改全局偏好，改变选项本身不解析或读取会话。普通匿名重试保持匿名；明确使用浏览器会话后，后续重试和创建下载使用当前明确选择。请求期间锁定选择，避免旧响应冒充新浏览器结果。未支持的既有偏好要求重新选择，不静默改为 Chrome。

原生 probeMedia/addMedia 共用严格解析：缺省可匿名，显式非法类型或名称明确失败。续传遇到已保存但损坏的媒体选项停止，不再默认匿名继续；没有保存选项的旧任务仍保留兼容默认值。有效浏览器与 cookie 文件配置均保留。

`qa-media-session-browser.mjs` 的真实隔离 Electron 通过两条模拟 IPC 链：匿名→Firefox 失败→Firefox 成功→创建 Firefox 下载；匿名→Firefox 失败→选 Safari 不触发请求→明确重试成功→创建 Safari 下载。全局偏好不变。`qa-media-access-host.mjs` 增加真实 Host 的八个非法会话请求，旧 installed13 静默匿名行为红灯，新 debug Host 全部拒绝，且不调用工具或创建任务。原有四类访问错误验证仍通过。这里证明参数传递和错误处理，不证明实际浏览器 cookies 读取、账号权限或新网站兼容。

## 后续核验：固定 2026.07.04 的番剧预览信号

核验日期：2026-09-08。本轮仅运行仓库工具的本地 `--version`，确认 `native/Vendor/Tools/yt-dlp` 返回 **2026.07.04**；未请求媒体、登录或读取浏览器会话。以下纠正“直接从现有 JSON 读取预览字段即可”的潜在误解。

固定版 `BiliBiliBangumiIE` 在原始 API `play_info` 中检查 `play_check.play_detail` 为 `PLAY_PREVIEW`，或 `play_video_type` 为 `preview`；命中时输出警告前缀 **“Only preview format is available,”**。随后返回的结果字典不携带上述两个字段，也没有 `is_preview`。这是番剧单集提取器的明确行为，不能推广为所有 Bilibili 普通视频或国际站均有同样信号。[固定版上游源码，第982–1027行](https://github.com/yt-dlp/yt-dlp/blob/2026.07.04/yt_dlp/extractor/bilibili.py#L982)

当前 `native/Sources/NDMEngine/YtDlpTool.swift` 的 `probe` 参数带 `--no-warnings`，因此该信号首先被工具抑制；`runStreaming` 成功时又优先返回 stdout，stderr 不进入成功结果。仅为 JSON parser 添加布尔字段不会修复这个问题。原始 API 中的字段不等于 yt-dlp 输出字段，时长短也不构成预览证据。

最小后续实现建议（**尚未实施**）：

1. 仅在 probe 路径允许警告，分别处理 stdout JSON 与 stderr；不要用混合输出全文搜索，否则标题里的同一句话可能被误判。
2. JSON 解析成功后，结合明确的 Bilibili 番剧提取器身份与该 stderr 警告前缀，生成 `availabilityNotice: "previewOnly"`。普通的会员画质缺失、字幕需登录提示不能充当预览信号。
3. `YtDlpProbe`、预检缓存与 Host RPC 只传结构化枚举，不传原始诊断；成功结果保持可选择格式，不改成登录错误。UI 显示“当前仅提供预览”，不承诺使用会话后就能取得完整版。
4. 没有信号时不显示预览提示，也不据此宣称已确认完整正片。该方案不要求升级 Vendor、补取站点 API 或猜测时长。

待执行验收：临时 yt-dlp fixture 分别返回成功 JSON＋精确 stderr 警告、普通短视频、仅缺少会员画质、字幕登录提示、标题包含同句文字、非 Bilibili 提取器。只有第一种出现预览标记。另覆盖 stderr 分块、末尾无换行及缓存后再次打开；验证其他警告不会以原文出现在 RPC/UI。真实授权番剧的最终下载与时长验收另列，本轮没有这项证据。

## 实现审查补充

固定版的番剧预览 `report_warning` 调用没有传入 `video_id`；公共方法仅在显式传入时添加 ID。因此真实警告前缀为 `WARNING: [BiliBiliBangumi] Only preview format is available,`，不能要求中间出现视频 ID。首次拟定的带 ID 样本与匹配器已被源码复核否定，不能把互相符合的模拟样本和实现当作上游兼容证据。[公共警告方法](https://github.com/yt-dlp/yt-dlp/blob/2026.07.04/yt_dlp/extractor/common.py)

首轮原生样本测试曾调用生产解析缓存方法，可能触发其既有过期清理；没有证据确认是否删除了旧条目。后续测试改为每次调用显式临时缓存目录，独立 Host 样本使用临时 HOME 与 CFFIXED_USER_HOME 并检查缓存确实落入该目录。不继续扫描或清理用户缓存。

实现现已接通 `YtDlpProbe.availabilityNotice`、Host RPC、前端白名单解析及 Composer 普通/会话重试两条成功路径。只接受明确的番剧提取器与真实 stderr 预览前缀，界面显示“当前仅提供预览”，保留格式和下载；换链接、重试和关闭清除旧提示。没有扩展到其他站点或 Windows 工具解析器，不宣称预览以外的内容必然完整。
