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
