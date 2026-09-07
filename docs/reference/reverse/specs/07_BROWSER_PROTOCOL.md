# 07 · 浏览器扩展与 WebSocket 协议

## 策略（已定）

| 部分 | 怎么处理 |
|------|----------|
| **Chrome / Chromium 扩展** | **不再逆向原版。** 采用社区已做好的 [BetterNDM](https://github.com/) 分支（本仓库副本：`reverse/extension/BetterNDM/`，MIT）。协议与原版兼容，UI 更好。 |
| **宿主 WebSocket 服务端** | 仍以 **Mac 主程序** 二进制为准（端口、子协议、文本字段）。 |
| **Safari appex** | 仅在需要 Safari 时再对照；Chrome 路径直接复用 BetterNDM。 |
| 历史材料 | `appex/`、`neat_extension_clean/` 仅作考古，**实现时不要当主线**。 |

BetterNDM 已验证仍使用同一桥：

- `ws://127.0.0.1:10007/download`
- subprotocol `neatextension.v1`
- 字段 `1:`…`8:` / Cookie / Origin / Referer 等与原版一致

## 组件

| 组件 | 位置 | 角色 |
|------|------|------|
| **BetterNDM（主线）** | `reverse/extension/BetterNDM/` | Chrome 扩展实现参考 + 将来可直接打包 |
| Safari appex | 原版 `.app` 内 | 可选 |
| 宿主服务 | `NeatWebSocketServer` | 必须逆向/复刻的是 **服务端** |

## WebSocket 端点

```
URL:          ws://127.0.0.1:10007/download
Subprotocol:  neatextension.v1
```

字符串证据：`neatextension.v1`、`Starting WebSocketServer...`、`Waiting for new URL from Browser Extension .....`

## 宿主 → 扩展（文本帧）

| 消息 | 含义 |
|------|------|
| `waiting` | 宿主正在等待用户确认/新建任务窗口打开 |
| `nowaiting` | 结束等待 |
| `ShowPanelChrome=0` / `=1` | 是否显示页面媒体面板（Chrome；另有 Fox/Edge 同源逻辑） |
| 含 `Version` 的帧 | 版本交换（扩展侧忽略部分） |

## 扩展 → 宿主（文本协议）

**格式：类 HTTP 头，行结束 `\r\n`，键为数字编号或标准头名。**

最小示例：

```
1:GET\r\n
2:https://example.com/file.zip\r\n
6:normal\r\n
4:Page Title\r\n
Origin: https://example.com\r\n
Referer: https://example.com/page\r\n
5:https://example.com/page\r\n
Cookie: a=b; c=d\r\n
7:12345678\r\n
8:application/zip\r\n
```

### 字段字典

| 键 | 含义 |
|----|------|
| `1` | HTTP 方法 GET/POST |
| `2` | 下载 URL（必填） |
| `3` | 建议文件名 |
| `4` | 页面标题 (pageTitle / hittitle) |
| `5` | 顶层页面 URL / referer 辅助 |
| `6` | 类型：`normal` \| `media` \| `hls`；新版 BetterNDM 另加 `media-page`，表示 X/YouTube 等规范页面地址，宿主进入 yt-dlp 解析与清晰度选择 |
| `7` | 文件大小（字节） |
| `8` | Content-Type |
| `9` | User-Agent |
| `10` | 请求 Content-Type（POST） |
| `11` | Content-Disposition |
| `Origin:` | 标准头 |
| `Referer:` | 标准头 |
| `Cookie:` | Cookie 串 |
| `Content-Type:` / `Content-Disposition:` | 亦可标准头形式 |
| `X-*:` | 自定义请求头透传 |
| `__0NeatPostData9__:` | POST body（特殊键，可无 `\r\n` 终止体） |

大小限制：消息长度 **≤ 118784** 字节（约 116 KiB），超限丢弃。

## 宿主服务端处理规格（重写必读）

实现 `NeatWebSocketServer` 等价物时：

1. **Listen** `127.0.0.1:10007`（仅本机）  
2. **HTTP Upgrade** 到 WebSocket；接受 `Sec-WebSocket-Protocol: neatextension.v1`（二进制含 `Sec-WebSocket-Accept` / `Sec-WebSocket-Key` 字符串）  
3. **路径** `/download`（扩展 URL 固定）  
4. 收 **文本帧** → 按行 `\r\n` 解析字段字典（上表）  
5. 映射到 `DownloadRequest`：  
   - url ← `2`  
   - method ← `1`  
   - headers ← Origin/Referer/Cookie/X-* / 10 / 11  
   - postData ← `__0NeatPostData9__`  
   - ltype ← `6`  
   - filename/size/mime/title/page ← `3`/`7`/`8`/`4`/`5`  
6. 调用 `AppDelegate handleBrowserDownloadRequest:` 等价路径  
7. 若需用户确认 URL：向扩展发 `waiting`，确认或取消后 `nowaiting`  
8. 设置变更时推送 `ShowPanelChrome=0|1`（及 Fox/Edge）

参考实现（解析器，非网络层）：`reverse/tools/protocol_message.py`  
常量与 round-trip 测试：`reverse/tools/test_re_specs.py`

## 扩展内部 Port 协议（bg ↔ ct）

`chrome.runtime.connect({ name: "neat" })` 数组消息：

| opcode | 方向 | 含义 |
|--------|------|------|
| 1 | bg→ct | ADD_MEDIA 添加可下载项到浮动面板 |
| 2 | ct→bg | READY / 更新 URL 与标题 |
| 3 | bg→ct | SET_TAB_ID |
| 4 | ct→bg | KEY_EVENT（Delete 键取消捕获） |
| 5 | bg→ct | UPDATE_VISIBILITY |
| 6 | ct→bg | DOWNLOAD 用户点击面板项 |
| 7 | bg→ct | YouTube formats 解析辅助 |
| 9 | bg→ct | adaptive 分轨入队 |
| 11 | bg→ct | INIT / SPA URL 变更 |
| 13 | bg→ct | SET_VISIBILITY 媒体面板开关 |
| 15 | bg→ct | CONNECTION_ERROR（NDM 未运行） |
| 17 | bg→ct | 用户点击工具栏图标，恢复当前标签页最近的媒体入口 |
| 19 | bg→ct | ADD_RESOURCE，将检测到的 PDF/Office/压缩包/电子书/安装包加入显式资源架；不自动下载 |

## bg.js 能力摘要

1. `webRequest.onBeforeRequest` / headers / completed  
2. 资源类型过滤：object, xmlhttprequest, media, other, main_frame, sub_frame, image  
3. MIME / 扩展名表决定是否捕获  
4. 取消浏览器原生 `chrome.downloads` 并改送 NDM  
5. 右键菜单：`Download by NeatDownloadManager`  
6. HLS m3u8 解析（`HlsParser`）  
7. 站点特化：当前 X 视频帖操作栏、YouTube watch 操作栏、B 站视频工具栏；Vimeo/Instagram/TikTok/抖音采用规范页面 URL + 保守内联入口；另有 YouTube itag、Vimeo progressive、Facebook video embed
8. Cookie 通过 `chrome.cookies.getAll` 汇总  
9. 非媒体资源发现与自动下载拦截分离：资源先通过 opcode `19` 展示，只有用户明确点击后才走 opcode `6`

## ct.js 能力摘要

1. 通用网页使用可找回的媒体浮标和资源架；X/YouTube/B 站等高频站点优先使用融入原页面操作栏的 NDM 按钮
2. 视频/音频元素旁挂载  
3. 与 bg 的 neat port 通信  
4. MutationObserver 处理动态 DOM（Facebook 等）  

## Safari

- `NSExtensionPointIdentifier = com.apple.Safari.web-extension`
- Principal: `SafariWebExtensionHandler`
- 资源同套 bg/ct/manifest

## 宿主处理入口

`AppDelegate`：

- `handleBrowserDownloadRequest:`
- `handleNewUrl:`
- `onWebSocketServerEnded`
- `buildWebSocketServer`
