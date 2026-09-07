# 01 · 原版源码树推断

二进制中 `__FILE__` 路径痕迹：

```
/Users/kia/Desktop/NeatForMac-1.3.24/
├── NeatBase/
│   ├── NeatCriticalSection.cpp
│   ├── NeatEvent.cpp
│   ├── NeatFileUnix.cpp
│   ├── NeatPunyCode.cpp
│   ├── NeatSocket.cpp
│   ├── NeatThread.cpp
│   └── NeatTime.cpp
├── NeatEngine/
│   └── NeatDownloadEngine.mm          # 核心引擎（ObjC++）
└── NeatMKV/
    └── NeatClusters.cpp               # MKV cluster 处理
```

## 逻辑模块（由类名/符号补全）

```
NeatForMac-1.3.24/
├── NeatBase/          # 线程、同步、文件、socket、时间、punycode
├── NeatEngine/        # DownloadEngine、Segment、HTTP/FTP/HLS socket、Auth、Proxy、Bandwidth、KQueue
├── NeatMKV/           # MKV mux、WebM reader、clusters
├── NeatWebSocket/     # Server / Socket / Listener（符号 NeatWebSocket*）
├── NeatApp/           # AppDelegate + 全部 *Window + DBHelper + NsUtils
└── Extension/         # Safari appex + bg.js/ct.js
```

## 语言分工

| 部分 | 语言 |
|------|------|
| UI / DB / 设置 / 窗口编排 | Objective-C |
| 下载引擎核心 | C++（经 `.mm` 与 ObjC 互操作） |
| 浏览器扩展 | JavaScript（Closure Compiler 压缩风格） |

## C++ 侧主要类型（符号/类型编码）

| 类型 | 角色 |
|------|------|
| `NeatDownloadEngine` | 单任务引擎状态机 + 线程 |
| `NeatDownloadRequest` | 请求描述（URL 拆解字段见下） |
| `NeatUrl` | Scheme/Host/Path/Query/User/Pass/FileName… |
| `NeatSegment` / `NeatSegmentManager` | 分段与合并 |
| `NeatEngineSocket` | 引擎连接 |
| `NeatSocketHttp` | HTTP(S) |
| `NeatSocketFtp` / `NeatSocketFtpData` | FTP |
| `NeatSocketHlsMaster` | HLS |
| `NeatAuth` / Basic / Digest / NTLM | 认证 |
| `NeatBandWidth` | 限速 |
| `NeatKQueue` / `NeatKqSocket` | kqueue I/O |
| `NeatWebSocketServer` | 扩展桥 |
| `NeatFile` / `NeatFileUnix` | 文件 |
| `NeatCriticalSection` / `NeatEvent` / `NeatThread` | 同步 |
| `ProxyInfo` | 代理配置结构 |
| `NeatMKV` / `NeatMKVMuxer` / `NeatWebmReader` / `NeatClusters` | 媒体合流 |

### `NeatDownloadRequest` 字段（类型编码中出现的名字）

- `downloadID` (int64)
- `BandWidthLimit` (int64)
- `MaxAllowedConnection` (uint8)
- `FileName` (wstring)
- `Method`, `PostData`, `PageTitle`, `TopPageUrl`, `Referer`, `UserAgent`, `HitTitle`, `MimeType`
- `FullRedownload` (bool)
- `FileSize` (int64)
- `RequestType` (string) — 对应 DB `ltype`: normal / media / hls
- `IsSpecialRequest` (bool)
- `RequestHeaders` (vector\<string\>)
- 内嵌 `NeatUrl` 两份（主 URL + 可能的 alternate / audio URL）

### `NeatUrl` 字段名

`Scheme`, `QueryString`, `Path`, `AbsolutePath`, `AbsoluteHostPath`, `Host`, `OriginalHost`, `Fragment`, `User`, `Pass`, `FileName`, `mNonUnicodeRawUrl`
