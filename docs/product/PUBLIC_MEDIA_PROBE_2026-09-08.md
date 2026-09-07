# 公开媒体页面提取探测

实际执行时间：2026-09-08 02:50:34–02:50:50（Asia/Singapore；UTC 2026-09-07 18:50:34–18:50:50）。这是一次真实网络提取探测，不是仅查支持列表；**没有下载媒体文件，也没有验证 NDM 浏览器入口、音视频合并或最终播放**。

## 工具与执行边界

- 可复用入口：`node scripts/qa-public-media-probe.mjs`。脚本只输出经过字段白名单处理的 JSON，可手动保存；没有加入 CI 单测。
- 工具：仓库 `native/Vendor/Tools/yt-dlp`，版本 **2026.07.04**；SHA-256：`ff7d4fc44b8fbf42da021c1bca950da0326cdb0cdb84992fdc7fb7ec215df435`。使用仓库内 Deno，未安装全局工具。
- 环境：darwin 27.0.0 arm64；继承当前系统/进程网络，未改变代理；代理环境变量不存在。未独立追踪系统代理、VPN 或出口，不能称为已确认直连。
- 每站一个固定公开测试 URL，共三站；每站进程总超时 45 秒，socket timeout 12 秒，网络/提取/分片/文件访问重试均为 0。本次均在超时前退出。
- `--ignore-config --no-plugin-dirs --no-cookies --no-cookies-from-browser --no-cache-dir --no-remote-components`；没有读取浏览器 cookies、用户配置或插件，没有登录、提供密码、DRM 解密或改变网络来重试。
- `--simulate --skip-download --no-check-formats --no-playlist --dump-single-json`：允许读取页面、API、格式清单与必要提取脚本，不下载媒体，也不检查格式对应媒体 URL 实际可下载性。
- 原始 JSON/诊断只在子进程与父进程内存中处理，不打印或落盘。输出不含签名媒体 URL、token、cookies、请求头、完整页面内容或原始 stderr。

## 实际结果

| 站点与本次页面 | 退出/耗时 | 本次观察 | 可以与不能得出的结论 |
| --- | --- | --- | --- |
| [YouTube：Big Buck Bunny](https://www.youtube.com/watch?v=YE7VzlLtp-4) | 0；4.499 秒 | 提取到 597 秒时长；27 个格式条目，其中 18 个视频格式、6 个仅音频格式；视频最大高度 1080；非直播 | 该 URL 在该环境的匿名元数据/格式提取成功；不代表媒体 URL 下载、合并、其他视频或更高画质成功 |
| [Vimeo：The New Vimeo Player](https://vimeo.com/76979871) | 1；4.072 秒 | 提取失败，无成功 JSON；未超时；诊断未匹配当前白名单类别 | 原因尚未确定。不能推断整站失效、需要登录、被 DRM 限制或只是网络问题；本轮没有再次请求，也未用账号/绕过手段补测 |
| [Bilibili：BV13x41117TL](https://www.bilibili.com/video/BV13x41117TL) | 0；6.119 秒 | 提取到 554.117 秒时长；11 个格式条目，其中 8 个视频格式、3 个仅音频格式；视频最大高度 1080 | 该 URL 的匿名元数据/格式提取成功；并不说明游客能实际下载每个列出的格式，也不说明番剧、会员、合集或直播兼容 |

格式条目不等于用户可选清晰度数量：可能包含不同编码、独立音轨或辅助格式。脚本在视频计数和高度统计中排除了无视频轨及 mhtml；最终候选仍需播放器可用性/合并验证。以上结果未出现已匹配的警告类别，不代表原始诊断完全没有警告。

## 与真实产品参数的差异

本轮另读取 `native/Sources/NDMEngine/YtDlpTool.swift` 的 `probe`、`pluginArguments`、`javascriptRuntimeArguments`、`trustStoreArguments`、`siteExtractorArguments` 和进程环境设置。**该脚本测试的是仓库工具的隔离匿名基线，不是对产品完整调用的复刻。** 差异可能影响成功与失败，不能把本次 Vimeo 失败直接归因于 NDM。

| 项目 | 本次脚本 | 产品当前源码路径 |
| --- | --- | --- |
| 插件 | 全部禁用 | 先禁用默认目录，但若 App Resources 存在 `yt-dlp-plugins`，会重新启用该随包目录；本轮未验证安装包是否有插件，因此不覆盖它们 |
| JS runtime | 禁用默认选择后显式使用仓库 Deno | 显式传入工具定位器找到的 Deno；打包工具位置不同 |
| 远程组件 | 明确 `--no-remote-components` | 当前读取到的原生源码没有显式启用 `--remote-components`；不能声称产品依赖远程组件，也不能把未覆盖的插件能力当成不存在。没有修改本机配置来补齐 |
| YouTube 客户端 | yt-dlp 该版本默认 | 产品显式传 `youtube:player_client=tv,android,web`，故本次 YouTube 的 27 个格式不代表产品会返回同样数量 |
| 信任链 | 工具默认信任链及继承环境 | 产品可能通过 `SSL_CERT_FILE` 与 `no-certifi` 接入 macOS 证书桥；本轮不覆盖该桥 |
| 用户配置与认证 | 忽略配置，明确禁止 cookie 文件及浏览器 cookies；未传 netrc | 产品可按 cookieSource 传会话；本轮读取到的 probe 参数没有显式 `--ignore-config`，所以它也不是本次隔离配置条件 |
| 超时/重试 | 45 秒总超时、12 秒 socket、各类重试 0 | probe 总超时 90 秒、socket 20 秒，读取到的参数没有显式重试 0 |
| 返回与后处理 | 仅白名单格式统计，不保存 info JSON、不下载或媒体 URL 验证 | 产品还经过质量分层、缩略图/字幕提取、info JSON 缓存，以及后续下载合并路径；均未覆盖 |

当前二进制已有的内置 EJS 能力并不因禁用用户插件自动消失；但本次没有单独审计其组件版本或逐项执行路径。关于 JS 与远程组件的行为以 [yt-dlp README](https://github.com/yt-dlp/yt-dlp/blob/master/README.md) 和 [EJS 说明](https://github.com/yt-dlp/yt-dlp/wiki/EJS) 为参考，不能只凭一个失败推断缺少解题能力。

## 样本依据

三个 URL 都选自本轮实际读取的 yt-dlp 官方提取器测试代码，选择普通视频条目而非账号、付费或密码测试。仅查询公开元数据，不以测试列表作为媒体再分发许可。

- YouTube 上游测试将该 Blender 视频标记为 `availability: public`、`age_limit: 0`。[官方测试](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/youtube/_video.py)
- Vimeo 上游测试为 Vimeo 自己的播放器介绍，普通字幕视频条目。[官方测试](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/vimeo.py)
- Bilibili 为上游普通视频提取器的首个测试条目，不是番剧、课程或登录收藏列表。[官方测试](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/bilibili.py)

上游 master 用于确定测试来源，实际执行的是上述固定二进制版本，二者不能混为同一版本。

## 下一步

本轮证明我们随仓库附带的工具能在两个具体公开页面上完成匿名提取，同时暴露一个 Vimeo 样本失败。下一步应在明确的小范围复现中扩展安全错误分类，先定位 Vimeo 的失败原因；不通过增加重试或默认读取用户 cookies 掩盖问题。另为成功样本增加经过授权的完整下载、音画与时长检查，才可以称该场景端到端可用。

## 后续：Vimeo 单次定位复现

2026-09-08 03:06:43（Asia/Singapore；UTC 2026-09-07 19:06:43）结束了一次仅针对原 Vimeo URL 的复现，耗时 5.208 秒，退出码仍为 1。没有扩大站点、下载媒体、登录、读 cookies、降低 TLS 验证或升级工具；原始失败记录保留在上表。

参数与原探测相同；唯一工具路径表达差别是从仓库 cwd 传相对 Deno 路径。复现把 stderr 在内存中筛选，再遮蔽 URL 和敏感字段。保留的明确诊断前缀是 **`Failed to fetch macos OAuth`**：可将失败定位到旧版 Vimeo 客户端申请 OAuth 的阶段，而非无结果或超时。当前遮蔽器把 `token` 一词后面的诊断一并去掉了，因此本地 HTTP 状态没有保留；下文的 HTTP 401 来自上游问题证据，不能写成这次本地已经记录了 401。原始 stderr 没有落盘，也没有为补取状态再次访问该视频。

上游版本化源码确认 `2026.07.04` 默认 Vimeo 客户端是 `macos`，该诊断来自申请客户端 OAuth 的调用。[2026.07.04 源码](https://github.com/yt-dlp/yt-dlp/blob/2026.07.04/yt_dlp/extractor/vimeo.py)

官方仓库存在同阶段错误的 [问题 #17401](https://github.com/yt-dlp/yt-dlp/issues/17401)；另一条使用相同视频 URL 的 [问题 #17271](https://github.com/yt-dlp/yt-dlp/issues/17271) 被归为重复报告。更强的维护者证据是 **2026.08.19 正式发行记录明确移除了 Vimeo 的 `ios` 和 `macos` 客户端**，对应 PR #17290。[正式发行说明](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19)、[上游变更](https://github.com/yt-dlp/yt-dlp/pull/17290)

据此，当前最有依据的判断是：**仓库旧工具的 Vimeo 匿名客户端路径遇到了上游已知兼容性问题**。它比“视频下架”“缺 JS runtime”“需用户登录”更符合现有证据；但尚未用另一版本或真实产品参数做 A/B，因此不是所有其他因素已被排除的证明。

| 候选原因 | 本次证据边界 |
| --- | --- |
| 视频下架 | 没有得到该结论；失败发生在客户端认证阶段，不是成功读取视频后的下架判断 |
| 当前网络 | 未超时且进入明确 OAuth 错误；不支持笼统称网络断开，但未单独排除出口或服务器策略 |
| 工具版本 | 旧版默认客户端、错误阶段与上游后续移除该客户端吻合，是优先排查方向 |
| 产品配置 | 产品对 Vimeo 没有本轮读取到的专属客户端覆盖；插件、缓存、会话和信任桥仍可能不同。不能声称已复现整个 App，也不应让用户换登录解决这个匿名客户端错误 |

最小后续方案（本次未实施）：先在现有工具发布流程中准备**固定版本、校验哈希的隔离候选**，同 URL、无账号、同网络与参数对照；验证后再决定升级随包工具或回移上游适配。不要一边更新工具一边改用户认证。产品错误分类可新增“媒体解析服务兼容性问题”，避免将此类客户端 OAuth 失败一律展示成“请登录”；是否添加要经过真实错误样本测试。仅移除旧客户端并不能保证匿名提取恢复，所以不把上游发行记录当成已修复结果。

## 后续：2026.08.19 隔离候选对照

2026-09-08 03:16:12–03:16:15（Asia/Singapore）对同样三个页面各做一次新版本探测，未重试，未改变认证、代理或 TLS 验证。本次确认**不能直接宣布升级已修复 Vimeo，也不能说三站没有回退**。

### 来源与完整性

- [官方 latest](https://github.com/yt-dlp/yt-dlp/releases/latest) 本次解析到固定发行 **2026.08.19**；实际下载使用固定 tag URL，未使用浮动下载目标。
- 仅写入独立目录 `/tmp/ndm-media-candidate.Y0C94d`，未覆盖仓库 Vendor 或系统工具。
- [macOS onedir ZIP](https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp_macos.zip) 对照同发行 [官方 SHA2-256SUMS](https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/SHA2-256SUMS) 验证通过：`07e54b0865303c864006925913bce2604f8ee8cc6f18699bac9c309f9328a6d8`。这是官方 HTTPS 校验和匹配，未另验证发布者签名。
- 解包 launcher SHA-256：`4f54eb67e4e96c7c3ffa49dd5deb81bc348bbb495080889b47d157d5c6d74443`；实际 `--version` 返回 `2026.08.19`。
- 首次 10 秒本地版本预检未完成，未发起任何站点请求。单独本地启动随后成功，未修改 quarantine 或关闭任何系统验证；本次不能精确归因该启动延迟。
- 使用脚本的临时副本，仅切换候选 binary 路径，并在诊断类别中添加 OAuth/HTTP 401 匹配。参数、旧仓库 Deno、匿名配置隔离、45 秒/站和重试 0 均与首次基线相同。结果为 `/tmp/ndm-media-candidate.Y0C94d/results-warm.json`，只含脱敏统计。
- 检查后仓库旧 launcher 哈希仍为 `ff7d4fc44b8fbf42da021c1bca950da0326cdb0cdb84992fdc7fb7ec215df435`，未被替换。

### 对照结果

| 同一页面 | 2026.07.04 已知结果 | 2026.08.19 本次结果 | 结论 |
| --- | --- | --- | --- |
| YouTube BBB | 匿名提取成功，27 格式 | exit 1，0.386 秒，明确匹配 TLS certificate 错误 | 新条件下失败；无法验收无回退。没有跳过证书校验；产品证书桥仍是未覆盖变量 |
| Vimeo 76979871 | exit 1；另一次诊断定位旧 macos OAuth 阶段 | exit 1，1.369 秒，无 JSON，当前诊断类别未匹配 | 失败仍在，原因未确定；不能说新版恢复匿名支持，也不能假定仍是原 OAuth 原因 |
| Bilibili BV13x41117TL | 11 格式、8 视频/3 仅音频、最大高度 1080 | exit 0，1.403 秒；同样 11/8/3/1080，时长 554.117 秒 | 这个样本的元数据/格式统计没有观察到回退；不代表媒体可下载或整站成功 |

新版结果保留于此，不用旧版成功覆盖新版失败。版本测试相隔约半小时，服务器状态和网络路径不是严格实验室常量，且产品还有自己的证书桥与参数；因此这是一轮受限对照，不足以单独给所有失败下根因定论。YouTube 的 TLS 失败也可能涉及新版打包运行时或证书信任链差异，尚未逐项确认，不能直接归为提取算法回退。

### 仓库 pin 与具体建议

只读检查 `scripts/prepare-media-tools.sh`：默认 `YTDLP_VERSION=2026.07.04`，可由同名环境变量覆盖；用固定版本拼出官方 ZIP 与校验和 URL，解包前核验 SHA-256，最后复制进目标 Vendor 目录。当前是固定版本加下载时校验官方清单，ZIP hash 没有在脚本中硬编码。`npm run fetch:mac-tools` 调用此脚本；普通 `npm run package` 先检查工具，不自动升级 yt-dlp。Windows 获取脚本也独立 pin 在 2026.07.04，不能只改一处就宣称跨平台同步。

**建议当前生产 pin 暂保留 2026.07.04；下一轮验证候选固定为 2026.08.19 与上述 ZIP hash。** 这是针对本次证据的升级门槛决定，不表示旧版 Vimeo 已可用。先用产品相同的证书信任桥和经过脱敏的明确错误分类对候选复测，再决定更新，不能为了升级通过而关闭 TLS 验证。即使修复候选的匿名提取，仍要经过 NDM 原生 probe、浏览器入口与完整媒体输出检查后才能宣称产品修复。本次未修改产品脚本、native 源码或全局工具。

## 后续：沿用产品 CA 的两站最小验证

2026-09-08 03:20:24–03:20:40（Asia/Singapore），固定同一 2026.08.19 候选，仅增加产品已有的 `--compat-options no-certifi` 和 `SSL_CERT_FILE=/Users/gaoyuan/Library/Caches/dev.ndm.open/Trust/macos-system-ca.pem`。使用现有公开 CA 文件，未访问私钥、修改系统信任、降低 TLS 验证或读取用户 cookies。YouTube/Vimeo 原样本各一次；其余匿名参数、socket 12 秒、总超时 45 秒、重试 0 保持不变，没有媒体下载。

| 样本 | 实际结果 | 解释范围 |
| --- | --- | --- |
| YouTube BBB | exit 1，14.311 秒；诊断匹配 `network-timeout`、`unavailable`，未匹配 TLS 证书错误 | 先前证书错误在本轮未复现，但提取仍未成功；不能称已经完全修复 TLS 或恢复下载。`unavailable` 是文本分类，不据此判断视频下架 |
| Vimeo 76979871 | exit 1，1.265 秒；诊断明确匹配 `login-required` | 新版当前匿名路径要求登录，未用账号补测；升级并没有在该条件下恢复匿名样本 |

安全结果保留于 `/tmp/ndm-media-candidate.Y0C94d/results-product-ca.json`；临时脚本为同目录 `probe-product-ca.mjs`。未覆盖 Vendor，未再重试。

只读 CA 对比也确认：旧包 certifi 118 张证书、新包 121 张，共同 117 张；现存产品 CA 文件 148 张。产品源码已有 `no-certifi` 与 `SSL_CERT_FILE` 配套传递，探测早先没有覆盖这条路径。当前测试仍未完整复刻产品的专用 YouTube 客户端、随包插件等差异。

**本轮继续不建议以“修复 Vimeo”为理由升级生产工具。** 没有足够证据验收新候选的 YouTube 与 Vimeo 匿名路径，Bilibili 只有单样本元数据保持成功。下一批需要先定义 Vimeo 公开页面的可接受产品行为与明确认证边界，再决定引入新版本；不能将登录要求包装成下载器自身已经支持匿名下载。
