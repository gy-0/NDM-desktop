# Relay 视频入口与提取兼容性研究

研究日期：2026-09-08。本文实际查阅 yt-dlp 官方 README、支持列表、提取器源码与 Wiki，以及浏览器官方扩展文档和下载器入口说明。它是设计与测试方案；本轮没有运行 NDM 的站点下载测试，也没有验证打包版本所带 yt-dlp 与当前上游版本一致。

## 结论

推荐 **工具栏始终可用，播放器旁提供情境入口，浮动入口按需出现且可关闭**。三个入口打开同一份媒体选择结果，不分别发起任务。用户应该看到“这是什么、能下什么、将保存到哪里”，而非网络请求清单。页面媒体探测与 yt-dlp 页面提取相互补充，不能把前者没发现资源等同于后者不支持。

yt-dlp 的官方支持列表明确说明：列出的是内置提取器，网站变化会让提取器失效，是否可用要实际尝试；未列出也可能通过通用或嵌入提取器工作。因此不能直接把该列表转换为 NDM 的“支持数千网站”宣传。[支持列表](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md)

## 入口参考与设计取舍

| 入口 | 官方参考与价值 | NDM 推荐行为与代价 |
| --- | --- | --- |
| 工具栏按钮及 popup | Chrome 官方提供 action/popup；Video DownloadHelper 有专门的找回工具栏图标教程，说明未固定图标会影响发现性。[Chrome UI](https://developer.chrome.com/docs/extensions/develop/ui)、[DownloadHelper](https://help.downloadhelper.net/article/20-lost-icon) | 始终作为兜底：显示当前页标题、已发现的媒体、解析当前页；首次引导固定图标。无结果时显示“解析此页面”，不能只有空列表。缺点是离播放器较远 |
| 播放器旁按钮 | IDM 官方展示观看视频时出现 Download This Video 面板。[IDM 官方说明](https://www.internetdownloadmanager.com/welcome.html) | 对已识别且可见的主要播放器，在外边缘或不覆盖控件的位置放短标签“用 NDM 下载”；键盘聚焦也能发现。多播放器分别关联自己的候选，不能把第一条网络视频绑定所有按钮。需要适配缩放、iframe、全屏和单页导航 |
| 可关闭浮动入口 | 这是本研究的设计建议，不是浏览器官方推荐模式 | 当播放器按钮无法可靠定位、但当前页存在可用媒体时，用一个可收起的小入口打开同一选择器；避开字幕、页面导航与播放器控制。按站点关闭；不要全页永驻大悬浮球，不应与已显示的播放器按钮重复抢注意 |
| 右键菜单 | Chrome、Firefox 都有扩展菜单机制。[MDN UI](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/user_interface) | 给链接/视频提供“用 NDM 下载”，作为熟练用户的快捷入口；`blob:` 或不能直接下载的对象回到页面解析，不将临时 URL 当普通文件提交 |

浏览器扩展本身可以被用户隐藏，所以“始终可用”指能力保留，不保证按钮始终可见。工具栏也不应该成为 NDM 主窗口常驻的快捷键帮助入口。

## 能实现这些入口的边界

Chrome content script 可操作页面 DOM，但默认处在隔离执行环境，不能假设直接读取播放器的 JavaScript 内部变量。跨域 iframe 要单独处理权限与 frame 身份；顶层页面拿不到内嵌资源时仍能提供工具栏解析。[Content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)

`activeTab` 是用户调用扩展后得到的临时页面权限，不足以实现未点击前全站自动出现的播放器按钮。建议将“主动点击解析”作为最低权限路径；需要自动发现的站点再申请相应站点权限，并解释用途。不能声称靠 `activeTab` 已解决自动全站探测。[activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)

三个入口只向后台发送页面身份、候选身份和用户动作；后台校验来源、tab/frame 与当前导航版本，再交给本地 App。页面发来的消息与 URL 都按不可信数据处理；不要允许页面指定任意本地命令。发出请求后 popup 关闭也不应丢失状态。[Chrome 消息传递](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)

## 站点证据矩阵

“上游有提取器”与“NDM 已兼容”是两列。下表后者均标为**本轮未实测**，不推翻项目此前某个样本的成功，也不将此前成功推广到所有资源。官方 master/Wiki 随时变化，发布前须记录实际打包版本并复测。

| 站点 | 当前上游证据 | 认证、格式与直播边界 | NDM 状态 |
| --- | --- | --- | --- |
| YouTube | 有视频、播放列表、短链接和直播嵌入等提取器 | 官方 Wiki 提醒部分格式涉及 PO Token；受限内容可能要有效登录会话。当前 EJS 文档还有 JS runtime/组件要求，不能只打包一个可执行文件就假定完整能力。README 将从直播起点下载标为实验性。[提取说明](https://github.com/yt-dlp/yt-dlp/wiki/Extractors)、[PO Token](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide)、[EJS](https://github.com/yt-dlp/yt-dlp/wiki/EJS) | 本轮未实测；先验证公开、无账号、单视频，再单列音视频合并和直播 |
| Bilibili | 有普通视频、番剧/合集及 BiliLive 等提取器 | 当前源码识别 SESSDATA；缺失清晰度可能提示会员资格，DASH 可含分离音视频，接口还存在暂时拒绝分支。不能承诺访客获得最高画质。[上游源码](https://raw.githubusercontent.com/yt-dlp/yt-dlp/master/yt_dlp/extractor/bilibili.py) | 本轮未实测；普通公开视频与会员/课程/直播分开验收 |
| Vimeo | 有普通视频、review、event 等提取器 | 源码分别处理登录与视频密码。公开视频、密码保护、私有链接及事件不是一个支持等级，不能把“能播放”视为“无条件能提取”。[上游源码](https://raw.githubusercontent.com/yt-dlp/yt-dlp/master/yt_dlp/extractor/vimeo.py) | 本轮未实测；先作者明确允许下载的公开视频 |
| TikTok | 有视频、用户与 live；当前列表把 effect、sound、tag 标为 broken | 源码存在登录跳转处理；单视频成功不代表标签页、合集或直播可用。[支持列表](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md)、[上游源码](https://raw.githubusercontent.com/yt-dlp/yt-dlp/master/yt_dlp/extractor/tiktok.py) | 本轮未实测；优先短链接→单视频，暂不宣传整站批量兼容 |
| Douyin／抖音 | 列有 Douyin 提取器 | 同文件中当前 Douyin 分支仍会报需要新鲜 cookies，且明确不一定是登录 cookies；不能把此错误统一翻译为“请登录”或无限重试。[上游源码](https://raw.githubusercontent.com/yt-dlp/yt-dlp/master/yt_dlp/extractor/tiktok.py) | 本轮未实测；页面探测与页面提取分别记录，不从 TikTok 成功推断抖音成功 |
| Twitch | 有 clips、stream、VOD 等提取器 | 源码区分缺少订阅权限与登录；README 的从直播起点下载是实验性。离线频道、持续直播和固定 VOD 必须区分结束条件。[上游源码](https://raw.githubusercontent.com/yt-dlp/yt-dlp/master/yt_dlp/extractor/twitch.py)、[README](https://github.com/yt-dlp/yt-dlp/blob/master/README.md) | 本轮未实测；优先自己的短 clip/VOD，直播另建停止、断线、封装验收 |

DRM 是独立内容属性，不应给整站一概打标签。yt-dlp 的公共提取器基类有明确的 DRM 错误报告路径；NDM 应将其显示为不支持该受保护内容，而不是持续重试或增加连接。普通 HLS 分片及音视频分离也不应仅因形式复杂就误标 DRM。[公共提取器源码](https://raw.githubusercontent.com/yt-dlp/yt-dlp/master/yt_dlp/extractor/common.py)

直播不具备普通文件那样固定总字节数。UI 应显示“录制中”和已保存时长/数据量，用户停止后再展示整理/完成，不能伪造总百分比。NDM 是否已经满足这些条件，需要产品测试确认；这是建议，不是本轮结论。[直播媒体概念](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Audio_and_video_delivery/Live_streaming_web_audio_and_video)

## 公开测试素材与发布证据

先使用公开的教学/测试页验证通用路径，再使用作者允许的站点资源做提取器端到端测试。本轮只核对网页来源，没有下载媒体、登录账号或发布上传内容。

| 候选 | 用途 | 本轮确认到的边界 |
| --- | --- | --- |
| [MDN video 示例](https://interactive-examples.mdn.mozilla.net/pages/tabbed/video.html) 与 [元素文档](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/video) | 小型 video 元素、双 source、页面按钮定位与直接媒体路径 | 官方示例包含 flower 媒体；适合交互验证，不代表任何视频网站兼容 |
| [Xiph 测试媒体](https://media.xiph.org/) | 可控的格式与文件下载样本 | 官方提供测试素材；选择具体样本时记录该文件许可，不能默认目录内所有文件同一许可 |
| [Big Buck Bunny 许可案例](https://wiki.creativecommons.org/wiki/Case_Studies/Blender_Foundation) | 选定 CC 许可素材后，在本地生成 HLS/DASH 固定与滚动清单 | CC 官方案例确认 Blender 项目采用署名许可；保留具体素材来源与署名。站点镜像是否来自作者仍须核实 |
| 自己或合作测试者在六站发布的短片 | 真正验证页面 URL→选择格式→下载→播放 | 本轮未创建账号或上传；公开可观看不自动等于已明确授权再分发，测试录屏也不含 cookies/令牌 |

每条宣称兼容的证据应记录：NDM/Relay/yt-dlp 版本、测试日期、浏览器版本、页面类型、是否登录、入口是否出现、解析是否成功、所选清晰度、音视频轨、输出播放与时长检查、停止/重试结果。URL 日志去掉会话令牌；只存必要诊断数据。

建议支持标签分为“公开点播已验证”“需账号的样本已验证”“直播实验性”“尚未验证”。不要用网络请求被捕获或 `--list-formats` 成功替代完整文件的音画验证。

## 最先实现的三项

1. **统一媒体选择与去重模型。** 工具栏、播放器旁和浮动按钮共用当前页面的候选；区分页面 URL 与实际资源、完整媒体与音/视频轨、已探测与待解析。最小验收：同一媒体通过两个入口点击不产生两个任务；页面切换不提交上一条视频；只有音轨不能标成完整视频。
2. **工具栏兜底 + 克制的播放器入口。** 先完成通用 video 与经过验证的少数播放器，按钮不遮字幕与控制条；可关闭站点内入口、可键盘操作。最小验收包含全屏、iframe、长页面滚动、单页切换、多个视频；无法定位时保留工具栏解析，不能静默失效。Chrome 官方 DOM/权限模型支持这个实现方向，具体站点仍需适配与测试。
3. **提取失败分类与小型站点回归矩阵。** 将需登录、权限不足、临时拒绝、DRM、媒体离线、上游解析失效分开；提供相应下一步，停止无意义重试。先用公开测试媒体跑通端到端，再逐站加入授权短片。YouTube 的 runtime/组件准备以及 FFmpeg 音视频合并应作为打包验收，而不是要求普通用户安装命令行环境。[yt-dlp README](https://github.com/yt-dlp/yt-dlp/blob/master/README.md)

这些建议优先让用户稳定取得眼前这一段媒体，再扩大覆盖范围。支持范围由版本化的真实结果更新，不被本报告或旧文档固定。
