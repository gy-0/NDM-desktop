# 原版扩展与前置接管证据

审查日期：2026-09-12。范围：只读本地原始归档、当前源码、官方 API 文档；运行过纯 Node VM，不由本审查 agent 操作浏览器。真实 Chrome 的下载项数量、网络时序及 UI 表现以专属 QA 记录为准。

## 原版归档的身份与限制

采用提供的本地原始归档 `reverse/extension/chrome_store/`（不作为本仓库运行依赖），其 `manifest.json` 标注 NeatDownloadManager Extension、作者 Javad Motallebi、版本 **1.9.92**、Manifest V3。`_metadata/verified_contents.json` 的 item_id 是 `cpcifbdmkopohnnofedkjghjiclmhdah`，版本同为 1.9.92。

| 文件 | SHA-256 |
| --- | --- |
| `reverse/extension/chrome_store/bg.js` | `5f9fdc13f71fc3674331af11c8dd1750fcebaf103e02accd9ef927f6c75fb173` |
| `reverse/extension/chrome_store/ct.js` | `28a139aa7e0c53bec3e3951898dc04f7d2da9d1434709ac256434191ca9ab792` |

按元数据的 4096 字节分块计算 SHA-256 tree hash，bg.js、ct.js 均与元数据一致。这只证实本地源码与本地归档元数据一致；没有验证 Google 签名，也没有证明这就是当前商店版本。`neat_extension_clean` 和 BetterNDM 是改写或社区参考；`docs/reference/reverse/specs/` 是历史说明，不能代替原始代码。

## Chrome 1.9.92 的实际顺序

1. 原版 `bg.js:12-13` 注册 `downloads.onCreated → V.X`、`webRequest.onBeforeRequest → V.T`、`onHeadersReceived → V.V`。HTTP 请求监听仅申请 requestBody/responseHeaders，没有 blocking。
2. `bg.js:35` 的 `V.T` 记录 URL、tab/frame 和 POST body。HTTP 分支不取消或重定向请求。
3. `bg.js:27-33` 的 `V.V` 在响应头到达后分类。`:32` 先将匹配 URL 写入 `this.u`，`:33` 再异步取 cookie；`:20` 的 `V.J` 收到 cookie 后调用发送函数。
4. `bg.js:15` 的 `V.X` 在 **DownloadItem 已创建** 后匹配 URL，立即 `chrome.downloads.cancel(a.id)` 和 `erase({id:a.id})`。它没有等待 native ACK。
5. `bg.js:16-18` 发送旧 CRLF 协议；`:19` 处理 waiting/nowaiting/配置消息，没有逐请求 correlated durable ACK。
6. 原版 `ct.js:16` 的 document click listener 对应 `:27` 的 `M.la`，只隐藏媒体面板，没有一般 anchor 的前置接管。

纯 Node VM 将原始 bg.js 放入模拟 Chrome API、故意不回调 cookies.getAll：`onBeforeRequest` 和 `onHeadersReceived` 都返回 undefined；随后 onCreated 仍先 cancel/erase 模拟 item 41。这验证代码顺序，**不证明真实 Chrome 会否短暂显示气泡、提示音或下载记录**。

### “几乎所有下载都接管、没有弹出下载列表”的体验

用户描述的可见体验可以成立。原版在 onCreated 回调里立即发出 cancel 与 erase，不等 cookie 查询或 native 接收结果；因此最终历史列表可以没有该项。是否来得及绘制下载气泡或底部栏还涉及当时 Chrome 版本和 UI 调度，不能由 VM 判断。**用户没有看到 UI，与内部已经发生 onCreated 是不同的观察，不应把源码结论表述成用户记错。** 同样，今天重新加载原版进行 UI QA，也不能直接复原用户当时的 Chrome UI 时序。

对完整 `chrome_store` 归档扫描确认：没有 `setUiOptions`、`setShelfEnabled`、`declarativeNetRequest`、`webRequestBlocking` 调用；manifest 的权限只有 webRequest、webNavigation、cookies、contextMenus、storage、downloads，没有 downloads.ui、downloads.shelf、DNR 或 blocking 权限。`bg.js:12-13` 仅注册非 blocking 的 request/header 监听；`:35` 的 HTTP onBeforeRequest 只记录请求。没有找到第二条一般 HTTP 请求阶段取消路径。`:35` 的 FTP 特例直接发送链接，但也没有 cancel/redirect 返回值。

原版从 native 接收的 `ShowPanelChrome=0/1` 不控制 Chrome 下载气泡：`bg.js:19` 将其转换成消息 13；`ct.js:26-27` 的 case 13 / `M.$` 只修改网页内媒体面板的 display。

### 原版下载分类的覆盖面

`chrome_store/bg.js:1-2` 的监听类型为 object、xmlhttprequest、media、other、main_frame、sub_frame、image；`:27` 仅处理 HTTP(S) GET/POST，`:28` 接受 200/206 且 Content-Length 不为零。`:28-30` 先用 MIME 映射，再用响应 filename 与 URL 后缀确定类型。main_frame 媒体、部分 other 媒体、frame/other 的 attachment 或强制下载 MIME，以及非网页/资源/媒体的未知二进制后缀，都可命中。它不是只收 zip 的小白名单，普通归档、安装包、签名 query 链接及 POST 导出因此覆盖很广。

下列结果来自直接执行原始 bg.js 的独立 Node VM；所有命中项均先记录 URL，再在模拟 onCreated 中 cancel/erase。没有运行原 App 或真实 Chrome：

| 模拟响应/下载 | 原版自动接管 |
| --- | --- |
| main_frame GET zip，含 query 的 zip | 是 |
| main_frame POST 无后缀 endpoint，attachment filename=export.zip | 是 |
| sub_frame zip、type=other zip | 是 |
| xmlhttprequest zip | 否；不能把普通 XHR 文件请求等同浏览器下载 |
| 无后缀 URL + application/octet-stream，没有 attachment | 否 |
| 无后缀 URL + attachment | 是 |
| PDF inline / PDF attachment | 否 / 是 |
| TXT attachment | 否；原版有 txt/js/dict 等显式排除 |
| 没有被请求监听记录，仅 onCreated.filename 为 file.zip | 否 |
| 未被请求监听记录的 blob: / data: 下载项 | 否 |

`:29-30` 还有 manif/favicon/pem.msg/wasm/json/dict 及网页、资源、流片段等排除。`:15` 的 onCreated 只比较单个 `this.u` 与 item.url/finalUrl，不重新根据 filename/MIME 分类；不匹配时也会清空 `this.u`。因此“普通下载覆盖很广”有代码支持，而“任意来源、并发场景下的所有 DownloadItem 都会接管”没有。右键菜单是另一条显式路径（`:20` 的 V.W），不能补足一般 blob 下载的字节转交。

另有 `reverse/extension/appex/` 的 Safari 参考：manifest 1.8.0、MV2，`bg.js:30` 响应头路径及 `:36` FTP 路径返回 `{redirectUrl:"javascript:"}`。这是另一平台/版本的静态实现，不能据此声称 Chrome MV3 1.9.92 在创建下载项前拦截。

`reverse/extension/bg.js` 与 appex/bg.js 字节完全相同，旁边 manifest 也是 1.8.0/MV2；它不是另一份已验证的旧 Chrome 商店版本。该 1.8.0 manifest 同样没有 webRequestBlocking，`:12-13` 没有 blocking extraInfoSpec，故即使看到 redirectUrl 返回值，也不能据此证明它在 Chrome MV2 中实际阻止了请求。当前只找到一份有商店归档元数据的 Chrome 样本：1.9.92。

只读扫描 `reverse/dumps/all_strings.txt:1560,1594-1595,2056` 以及当前 `/Applications/NeatDownloadManager.app/Contents/MacOS/NeatDownloadManager` 的相关字符串，找到 Google Chrome、ShowPanelChrome 和 neatextension.v1，未找到 setUiOptions/setShelfEnabled/downloads.ui/downloads.shelf/chrome://downloads、下载 bubble/shelf、AppleScript/System Events UI 操控的相关字面量。当前 app metadata 为 1.3/build 24，但可执行文件 SHA-256 `08560144cab189f041389aa2458b0bcff7b8fac937347b7b95d57dcd4ddb4101` 与 2026-09-08 reverse manifest 的 `82ac9da838a633a187029aef14cef45f5bd8a9b8914ad2d0ccea5205c47641a9` 不同；不把旧反编译当成当前二进制的完全证明。有限字符串扫描没有提供额外 Chrome UI 操控证据，也不能证明所有 native 机制绝不存在。

## 当前 Relay 与可复用的 native ACK

当前 `extension/NDMRelay/bg.js` 的 `S(a,b):183` 是媒体内容 fetch helper；后置下载响应分类入口是 `W.W`，不是 S。`W.W` 在响应头后调用 `browserHandoffs.begin()`；`W.Y` 是 onCreated handler。`browser-handoff.js:97-112` 将新 DownloadItem 绑定给 intent 并暂停；`:34-55` 等 accepted 后取消/擦除，失败则按所有权恢复浏览器。它比原版的立即 cancel 安全，但依然有已经创建的 DownloadItem。

当前覆盖不能表述成已与原版全面相同：`media-policy.js:273-279` 的后置自动接管明确要求 main_frame，原版可命中的 sub_frame/other zip 不在这一自动路径。`resource-policy.js:157-160` 允许将这些请求列为资源候选，再由用户选择，属于另一种行为。本轮 `click-catcher.js:8-37` 新增的零 DownloadItem 路径也仅限顶层、可信无修饰主键、自身 target、同源 HTTP(S)、可保留请求语义的 anchor；显式 download 属性或无 query 的有限 archive 后缀进入判断。POST 表单、blob/data、脚本生成的下载及任意 iframe 下载并未因此获得通用前置接管。扩大自动覆盖与消除可见 Chrome UI 是两个需要分别验收的目标。

native 已支持前置普通文件接管所需的持久 ACK 协议。ACK 本身无需增加字段；后续真实 QA 发现的跨源重定向安全能力是另一个必要条件，见下文：

- `native/Sources/NDMCore/Bridge/BridgeProtocol.swift:127-178`：请求 `NDMRelayDownload:{"requestId":"…","payload":"旧 CRLF payload"}`；回执 `NDMRelayReceipt:{"requestId":"…","status":"accepted|rejected|deleted",…}`。requestId 为 16–128 字节的字母数字、连字符或下划线，包体上限 118784 字节。
- `native/Sources/NDMBridge/BrowserBridge.swift:250-261`：握手状态声明 `durableHandoff:1`；`:350-358` 回执仅回复原连接，单次 reply。
- `native/Sources/NDMHost/main.swift:356-386`：只有普通文件完成 durable commit 才 accepted；已有相同请求返回 accepted，已删除任务返回 deleted。accepted 代表接收并持久化，不代表下载完成。
- `native/Sources/NDMEngine/DownloadManager.swift:656-666`：计算原始解析 payload 的稳定 SHA-256，先查已有 receipt。
- `native/Sources/NDMCore/Storage/DownloadStore.swift:225-255`：任务与 receipt 在同一 SQLite transaction 提交；`:285-294` 拒绝同 requestId 不同 payload，并保留已删除任务的 tombstone 语义。

前置路径应在可信点击默认动作发生前 preventDefault，先持久化原 ID 和完整 payload，再发送；已尝试发送且 ACK 丢失必须保持 pending 并重发完全相同的 envelope。只有明确未发送或确定拒绝后，才可恢复浏览器；ACK 不明时恢复浏览器会产生两个下载拥有者。新 `click-handoff.js` 将这一路径与后置 DownloadItem 状态分开。

## 官方 API 支持的边界

- onCreated 在下载开始时提供 DownloadItem；erase 只是擦除历史，不能把已创建变成未创建。隐藏整个 profile 的下载 UI 也不能证明某次点击没有创建下载项。[Chrome downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads#event-onCreated)
- 当前 Chrome 有 `setUiOptions({enabled:false})`（Chrome 105+，需 downloads.ui），作用于该 profile 的所有窗口；旧 `setShelfEnabled` 需 downloads.shelf，自 Chrome 117 起弃用。它们能影响可见 UI，既不是逐下载取消接口，也不阻止 DownloadItem 创建；本轮没有调用或新增这些权限。[Chrome download UI API](https://developer.chrome.com/docs/extensions/reference/api/downloads#method-setUiOptions)
- 普通 MV3 扩展没有 webRequestBlocking；本地原版注册也未请求 blocking。监听响应头本身不能阻止默认下载。[Chrome webRequest API](https://developer.chrome.com/docs/extensions/reference/api/webRequest)
- 现代 MV3 的 declarativeNetRequest 可按规则在请求前或响应头阶段 block/redirect；它不是一个可逐次等待 native durable ACK 的通用下载接管回调，原版 1.9.92 也未使用它。[Chrome declarativeNetRequest API](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)
- 旧源码保留 FTP 分支不代表现代 Chrome 能执行旧 FTP 流程：Chrome 88 已禁用 FTP 支持。[Chrome 88 removals](https://developer.chrome.com/blog/chrome-88-deps-rems?hl=en)
- content script fetch 受页面来源/CORS 约束；worker 应再次校验 content 消息中的 URL、tab、frame、document 与当前页面。[Chrome network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)、[Chrome messaging security](https://developer.chrome.com/docs/extensions/develop/concepts/messaging#security-considerations)
- HEAD 采用 `mode:'same-origin', credentials:'same-origin', redirect:'error'` 可以在遇到重定向时失败；manual redirect 是 opaque-redirect，不能普遍读取 Location 后自行决定。先跟随再检查 response.url 已经太迟。HEAD 的结果不能保证之后 native GET 的重定向或内容相同。[Fetch Standard](https://fetch.spec.whatwg.org/)
- Referrer-Policy 可由响应头、meta、anchor 属性和 rel=noreferrer 影响。用于 Referer 的 URL 必须去掉 username、password、fragment；不能用字符串中 `#` 与 `?` 的位置猜测。[Referrer Policy](https://w3c.github.io/webappsec-referrer-policy/#strip-url)
- `HTMLElement.click()` 是合成事件，不是新的可信用户点击；异步 fallback 不能声称与原始 trusted click 的页面事件处理完全等价。[HTML click algorithm](https://html.spec.whatwg.org/multipage/interaction.html#dom-click)

验收需分列：明确 download 属性链接的 **浏览器预检 HEAD 为零**、普通 archive 的浏览器 HEAD，以及 native 引擎自身的 HEAD/GET。普通 302、405、HTML 或 query-only 链接退回原有路径时，应报告实际 DownloadItem/owner，不算作前置零下载项成功。当前设计仅覆盖窄范围同源普通 GET 链接，不承诺所有网站、一次性 URL、登录跳转或特殊 referrer 策略都能前置接管。

## 真实 QA 发现后的必要安全门槛

专属 QA 在 `privacy-first/cross-origin-download-redirect.json` 中实测：同源 a[download] 跳转到另一源时，旧 Host 的 HEAD 和 GET 把原站 host-only Cookie 及含虚构 query token 的完整 Referer 发给了跨源 sink。`privacy-before-complete/cross-origin-download-redirect.json` 的基线走浏览器重定向再后置接管，sink 没有 Cookie，Referer 为 origin-only。它是前置接管新增的确定隐私回归，不能用“初始 URL 同源”这一限定排除。

当前 Relay 的 `bg.js` 已将前置路径与恢复发送同时要求 `durableHandoff === 1 && safeFileRedirects === 1`。缺少能力的 Host 保持浏览器原有路径；不能在测试中伪造该能力来声称修复。新 Host 的同一 fixture 真实验证已经完成：跨源 HEAD/GET 无源站 Cookie、Authorization 或 Referer；range 与最终 URL 请求安全由原生任务测试覆盖。完整分层结果见 [最终验收](README.md)。预先 HEAD 成功不能保证之后 GET 不跨源，因此不能代替这个门槛。

本审查最终执行的三个 click Node 测试文件共 **33/33 通过**；已复核策略改动后的 pending 去重优先、source userinfo 拒绝、多个/移除 meta 的 sticky 限制、重复 HTTP Referrer-Policy、片段清理及旧 Host capability 关闭路径。此处的源码/模拟结果与 [最终真实验收](README.md) 分别记录。
