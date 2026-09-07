# 12 · 模块边界冻结（重写用）

本文件把宿主拆成可独立实现的模块。重写时保持这些边界即可，无需再打开二进制。

## 模块图

```
                    ┌─────────────────────┐
                    │  BetterNDM / Safari │
                    │  (out of host repo) │
                    └──────────┬──────────┘
                               │ WS text protocol
                               ▼
┌──────────────────────────────────────────────────────────┐
│ Bridge                                                   │
│  NeatWebSocketServer · NeatWebSocket · Listener · kqueue │
│  bind 127.0.0.1:10007  path /download  proto v1          │
│  parse download message → DownloadRequest DTO            │
└────────────────────────────┬─────────────────────────────┘
                             │ handleBrowserDownloadRequest:
                             ▼
┌──────────────────────────────────────────────────────────┐
│ App / UI (AppKit)                                        │
│  AppDelegate · Main list · Wait/URL/Settings/… windows   │
│  orchestrates DB + Engine lifecycle                      │
└───────────────┬───────────────────────────┬──────────────┘
                │                           │
                ▼                           ▼
┌───────────────────────────┐   ┌──────────────────────────┐
│ Persistence               │   │ Engine (C++ / ObjC++)    │
│  NeatDBHelper + SQLite    │   │  NeatDownloadEngine      │
│  downloads/auths/headers  │   │  SegmentManager          │
│  task dir <id>/           │   │  SocketHttp/Ftp/Hls      │
│  segments.bin · seg.xN    │   │  Auth · Proxy · BandWidth│
│  LogFile.txt              │   │  merge → final file      │
└───────────────────────────┘   └──────────────────────────┘
```

## 跨模块 DTO

### DownloadRequest（引擎输入）

来源：扩展协议 / 手动 URL / DB resume。

| 字段 | 来源 |
|------|------|
| downloadID | DB id / LastDownloadID+1 |
| url (+ alternate urla) | protocol `2` / `urla` |
| method | `1` |
| headers | Origin, Referer, Cookie, X-*, … |
| postData | `__0NeatPostData9__` |
| userAgent | `9` or settings |
| maxConnections | settings MaxConnections / per-task |
| bandwidthLimit | settings / per-task |
| requestType | `6` normal\|media\|hls |
| fileName | `3` or URL basename |
| pageTitle / topPageUrl / referer / mime / size | `4` `5` `7` `8` |
| tempOutputPath | `Application Support/.../<id>/` |
| finalOutputPath | DownloadDirectory [+ category folder] |
| doResume | bool |

### ProgressInfo（引擎 → UI）

日志/方法名：`onDownloadWindowProgress:progressInfo:`

至少包含：downloaded bytes、total、bandwidth、percent、segment 可视化数据、status 文案。

### Notify（引擎 → UI）

`onDownloadWindowNotify:senderWindow:extraInfo:` — 完成/错误/认证需要等事件。

## 实现顺序建议（重写时）

1. Persistence（schema + task dir）  
2. Engine HTTP single then multi-Range + segments.bin  
3. App list + progress window  
4. Bridge server + BetterNDM 联调  
5. Proxy/Auth/HLS/MKV  

## 明确不在宿主内

- Chrome 扩展 UI/捕获逻辑 → **BetterNDM**  
- 原版闭源算法的逐指令复刻 → 行为等价即可；未知项见 `10_GAPS.md`
