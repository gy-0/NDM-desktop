# 03 · 下载引擎规格

## 入口（ObjC → C++）

`NeatDownloadWindow` / MKV 变体：

- `BuildDownloadEngine`
- `initWithValues:appStatusMenu:request:tempOutputPath:finalOutputPath:rowIdx:doResume:`
- `initMKVWithValues:…`（音视频双引擎）
- `handleEngineNotify:` / `handleEngineNotifyDownload:`
- `handleEngineNotifyAudio:` / `handleEngineNotifyDownloadAudio:`
- `pauseResume:`, `cancelDownload`, `applyConnectionsCount:`, `applyBandwidth:`
- `updateRequest:`（Renew 过期链接）

`AppDelegate`：

- `buildDownloadWindow:resume:rowIndex:`
- `resumeDownload:`, `reDownload:`, `stopDownloads`
- `mRunningEngineThreadCount`, `mpWebSocketServer`

## 引擎状态（日志实证）

完整成功路径（高频）：

```
Unknown → Starting... → Downloading... → Merging... → Completed
```

分支：

```
Downloading... → Paused
Starting... / Starting... ( n ) → Error
Error → Starting...          # 重试
Completed → Starting...      # 重新下载
```

相关日志键：

- `DownloadEngine State Changed : X -> Y`
- `DownloadEngine is Starting...`
- `DownloadEngine Is Terminating , EngineState = …`
- `Failed to Create/Start DownloadEngine`
- `Resume Failed. DownloadEngine will Try a fresh Redownload silently ...`
- `Download Canceled By User.`
- `Error Occurred. DownloadEngine Finished Working but Situation is Undefined.`

详见 [11_APP_LIFECYCLE.md](./11_APP_LIFECYCLE.md)。

## 连接模型

1. 初始创建 **1** 个 socket，`Range: bytes=0-` 探测/下载  
2. 收到 `206` + `Content-Range: bytes a-b/total` 后知道总长  
3. **动态** 再开 socket（`New Socket(s) Created. MaxAllowedConnection = N And ActiveSockets = M`）  
4. 新分段：`SegmentManager Created a New Segment and now has K Segments`  
5. 后续 socket 使用有界 Range，例如 `Range = 9595188-18207336`  
6. `MaxAllowedConnection` 来自设置（运行时样本默认 **32**），可在下载中 `applyConnectionsCount`  
7. `Accept-Encoding: identity`（禁用压缩，保证 Range 字节对齐）

## HTTP 请求模板（日志还原）

```
GET {path} HTTP/1.1
Host: {host}
User-Agent: {browser UA or custom}
Accept: */*
Accept-Encoding: identity
Accept-Language: en-US,en;q=0.9
Accept-Charset: *
Origin: {origin}
Referer: {referer}
Cookie: {cookies}
Range: bytes={start}-{end?}
```

代理时存在：

- `HTTP_STATE_CONNECT_SENT` / `PARSING_CONNECT_HEADER`（HTTPS 隧道）
- `SendProxyConnect`
- `Proxy-Authorization: Basic|Digest|NTLM`
- `Authorization: Basic|Digest|NTLM`

## SSL

日志：`Initializing SslHandShake for Socket (n)` → `SslHandShake OK`  
自研 socket 栈上的 TLS，不是简单的 NSURLSession。

## 带宽限制

- 结构体 `NeatBandWidth`
- UI：`txtBandWidth` / `applyBandwidth:` / `chkBandWidthChanged:`
- 设置键：`BandWidthLimit`（0 = 不限）
- 下载中可改

## 暂停 / 续传

- UI status 字符串形态：`Paused ( 36% )`、`Error ( 0% )`、`Complete`
- 暂停后保留 `segments.bin` + `seg.xN`
- 续传加载：`Segments were loaded from segments.bin file.` / `TS Segments were loaded...`
- 失败时可能静默整文件重下（见上条 Resume Failed 日志）

## HLS 模式

- `hlsMode` / `hlsSegmentsCount` / `addTSSegments:shouldDraw:`
- `NeatSocketHlsMaster`
- 下载全部 TS 后合并为单一 `.ts`（官网描述）
- 日志：`TS-Mode Sockets Created`、`TS-Segments`、`took a partial TS-Segment`
- DB `ltype = hls`，filesize 有时为异常/占位值（样本出现负数）

## MKV 双轨模式

- `NeatDownloadWindowMKV`
- `mpDownloaderEngine` + `mpDownloaderEngineAudio`
- 两套 progress / connections table / segments bar
- `totalMKVSize`, `videoDownloadedBytes`, `audioDownloadedBytes`
- 扩展侧把 adaptiveFormats 的 video+audio 配对后发 `urla`（第二 URL）
- 引擎侧 `NeatMKVMuxer` / `NeatWebmReader` / `NeatClusters`

## 文件落盘

| 路径 | 含义 |
|------|------|
| `Application Support/.../<id>/seg.x{N}` | 第 N 段原始数据 |
| `.../segments.bin` | 段表 |
| `.../LogFile.txt` | 调试日志 |
| `folderpath/filename`（DB） | 最终合并输出 |

合并：`Internal Error. Failed on Merging segments` 等错误字符串。

## 线程模型

- `NeatThread` / `Failed to create thread`
- `mRunningEngineThreadCount`
- 同步：`NeatCriticalSection`（pthread mutex）、`NeatEvent`（cond）
- I/O 多路复用：`NeatKQueue`

## 动态分段算法（行为级，非源码级）

已观察行为（任务 3996 的长下载尾部进一步闭环）：

1. 先单连接拉头部与前半  
2. 当可 Range 且文件够大时，把**剩余未完成区间**切给新连接  
3. `MaxAllowedConnection = 32` 后，原版会尽量复用刚空闲的 socket，而不是把“32”当作总段数上限  
4. 下载进入后段时，日志仍会在 `Segment Completed` 之后创建第 **33 / 34 / 35** 个临时段，并从仍很长的未完成区间内部发出新 Range  
5. 新 socket 抢尾失败、服务端拒绝或边界追上时，临时段会 **rollback + merge**（`Segment Rolled Back To Socket` / `Merged To Segment`）  
6. 完成段若有错误可忽略（`Segment is Completed but some error occurred.We ignore the error`）

因此原版的“32 连接”语义是：在剩余数据足够时，**尽量维持接近 32 个活跃下载者**；不是开局静态切 32 段后让并发数一路自然掉到 1。任务 3996 的脱敏证据见 `reverse/fixtures/segments/3996_dynamic_tail_excerpt.txt`。

反编译现已把普通 HTTP 模式的两个调度常量钉死：

- `FUN_10005e1e0` 用 `0x3A000`（237,568 B）估算可维持的段数；另一模式为 `0x88000`（557,056 B）
- `FUN_10005e2b4` 只从剩余量大于 `0x32000`（204,800 B）的父段中选择最大者继续拆分；另一模式为 `0x80000`（524,288 B）
- 实际边界公式为 `segmentStart + completedInSegment + (remaining / 2)`，与任务 4125 的 9,595,188 起点一致

Swift 重构以这些第一方常量和公式作为行为底座，并额外计算 TCP/TLS 建连回本时间，避免在现代 HTTPS 场景的最后几秒机械开满连接。

## 规范样例：任务 4125（HTTPS，fixture 冻结）

证据：

- `reverse/fixtures/segments/4125_segments.bin`
- `reverse/fixtures/segments/4125_log_excerpt.txt`

| 步 | 日志 | 含义 |
|----|------|------|
| 1 | MaxAllowedConnection=32, ActiveSockets=1 | 首连接 |
| 2 | Range = 0- ；206 Content-Range 0-18207336/18207337 | 总长 18207337 |
| 3 | ActiveSockets=2；Range = 9595188-18207336 | 后半切开 |
| 4 | ActiveSockets → 32 | 动态加满上限 |

暂停后 `segments.bin`：

| segId | start–end (含) | next |
|------:|---------------:|------|
| 0 | 0 – 9595187 | 1 |
| 1 | 9595188 – 18207336 | END |

与 socket Range 一致；由 `tools/test_re_specs.py` 固化断言。
