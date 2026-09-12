# 浏览器交接：先保证能下载，再减少视觉干扰

## 本轮修复的真实问题

用户提供的 YouTube 链接在其 Chrome 中已登录且正常播放。旧版应用却把网页分类器的 `sessionNote` 当成媒体解析失败，在调用媒体引擎前返回；“重试解析”重复同一路径。对同一 URL 直接调用已安装引擎的 `probeMedia`，无需登录信息便成功返回视频标题和 4 档清晰度。这证明截图中的登录提示来自错误的前置判断。

已知视频网站与明确的 Relay 视频交接现在直接进入媒体解析。文件类型探测仍服务普通文件；HTML 本身不再被用来推断视频需要登录。

## 会话属于发起交接的标签页

- Relay 从发起标签页的 cookie store、frame partition 读取与目标 URL 匹配的 Cookie，保留 HttpOnly、host-only、domain、path、secure 和 expiry。普通文件优先使用实际网络请求捕获的 Cookie、Authorization、Referer 等上下文。
- 媒体交接采用作用域明确的 cookie jar，避免将一个 Cookie 请求头套用到所有媒体 CDN。扩展协议字段 13/14/15 分别携带浏览器、编码后的 cookie jar、随机会话标识。
- Composer、格式解析、保存位置检查和创建请求绑定同一个会话标识；同 URL 的另一个 profile、匿名访问、迟到的响应不能借用之前的账户。手动修改 URL 或显式选择其他浏览器会解除旧绑定。
- 匿名 cookie jar 是有效的空会话。原生引擎重启或缓存过期后，可向持有该标识的原扩展 profile 请求刷新；不会猜测默认 Chrome profile。扩展的 session storage 只保留有界路由元数据，不保留 Cookie 值。
- 已审阅的加密批量草稿只持久化随机标识和浏览器选择，恢复时继续先检查创建回执，避免重复下载。Cookie、请求认证头不进入草稿。
- yt-dlp 调用使用权限受限的临时 jar，结束后删除。预解析 JSON 按独立文件存储，并移除 Cookie/认证头，避免跨会话覆盖与间接留存。

Chrome 的 Cookie API 默认只处理未分区 Cookie，需要单独查询发起 frame 的分区；这一点直接影响嵌入播放器与不同 profile 的登录状态。[Chrome Cookie API](https://developer.chrome.com/docs/extensions/reference/api/cookies)

YouTube 公开内容不应被应用强制要求登录；账号访问限制和解析器遇到的服务端限制应由真实解析结果区分。[yt-dlp 的 YouTube 说明](https://github.com/yt-dlp/yt-dlp/wiki/Extractors)

## 减少页面与工具栏的干扰

Relay 默认入口改为单层 32px 磨砂按钮；展开面板透出视频底色，去掉内层推荐卡片、双层描边和冗余说明。点击页面或播放器可收起，保留键盘与减少动态效果支持。

已有 YouTube、Bilibili、X、Vimeo、Instagram、TikTok、抖音适配，本轮优先修正适配准确性：YouTube Shorts 使用活跃侧轨；Instagram 使用站点颜色的图标入口；X/Instagram 取当前文章自身链接；Vimeo/TikTok/抖音切页后不再递交旧视频。

主应用把筛选与排序集中在搜索旁的“显示选项”，移除常驻“操作”和标题旁的独立筛选按钮；快速操作仍能从应用菜单或 ⌘K 打开。空闲传输只显示小图标，活动时展示数量与速度。标题和列表起点保持稳定。

## 验证边界

专项脚本分别覆盖真实 Chrome 扩展交接、真实原生引擎认证媒体下载、Composer 会话切换与草稿重放、三主题七窗口宽度。隔离网站 DOM 场景不等于七站逐一实网验收。原生会话解析与刷新本轮以 macOS 验证；Windows 尚无同等的 Relay cookie jar 实网验收。

测试入口：

- `scripts/qa-relay-session-wire.mjs`
- `scripts/qa-relay-media-session-host.mjs`
- `scripts/qa-composer-relay-session.mjs`
- `scripts/qa-library-toolbar.mjs`

完整测试与安装后真实 YouTube 下载的结果见本轮发布记录。
