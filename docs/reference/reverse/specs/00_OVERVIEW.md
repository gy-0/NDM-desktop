# 00 · 总览

## 产品身份

| 项 | 值 |
|----|-----|
| 名称 | Neat Download Manager |
| Bundle ID | `com.NeatDownloadManager` |
| 版本 | 1.3 (CFBundleVersion 24) |
| 最低系统 | macOS 10.10（appex 10.14） |
| 架构 | x86_64 + arm64 |
| 形态 | `LSUIElement=true`（菜单栏 Agent，默认无 Dock 图标） |
| 版权 | © 2021 Javad Motallebi |
| 官网 | https://www.neatdownloadmanager.com/ |
| 扩展商店 | Chrome Web Store ID `cpcifbdmkopohnnofedkjghjiclmhdah` |

## 技术栈

```
┌──────────────────────────────────────────────────────────┐
│ UI: AppKit + NIB (Objective-C)                           │
│   AppDelegate · *Window · ProgressBar · StatusItemView   │
├──────────────────────────────────────────────────────────┤
│ Engine: C++ / Objective-C++ (自研，非 URLSession)         │
│   NeatDownloadEngine · SegmentManager · Socket* · Auth*  │
│   I/O: kqueue · 自研 TLS 握手日志 "SslHandShake"          │
├──────────────────────────────────────────────────────────┤
│ Storage: SQLite3 + 每任务目录 + segments.bin              │
├──────────────────────────────────────────────────────────┤
│ Bridge: NeatWebSocketServer @ 127.0.0.1:10007            │
│   subprotocol: neatextension.v1  path: /download         │
├──────────────────────────────────────────────────────────┤
│ Extension: Safari Web Extension appex + Chrome MV2/3 JS  │
└──────────────────────────────────────────────────────────┘
```

系统依赖：`libsqlite3`、`Foundation`、`AppKit`、`Security`、`IOKit`、`CoreServices`、`libc++`。

## 数据位置

| 路径 | 用途 |
|------|------|
| `~/Library/Application Support/com.NeatDownloadManager/` | 主数据 |
| `…/NeatDB.db` | 任务库 |
| `…/<downloadId>/` | 每任务工作区 |
| `…/<id>/segments.bin` | 分段元数据 |
| `…/<id>/seg.xN` | 分段数据文件 |
| `…/<id>/LogFile.txt` | 引擎详细日志（极有价值） |
| `~/Library/Preferences/com.NeatDownloadManager.plist` | 设置 |
| 下载成品 | `DownloadDirectory` 配置路径（默认 `~/Downloads/`） |

## 运行时主流程

```
启动 AppDelegate
  ├─ 单实例检查 ("already running")
  ├─ 加载 DB / 设置
  ├─ buildWebSocketServer (10007)
  ├─ 创建 Status Item
  └─ 可选恢复未完成任务

扩展捕获链接
  → ws://127.0.0.1:10007/download  (neatextension.v1)
  → AppDelegate handleBrowserDownloadRequest:
  → insertDownload + buildDownloadWindow
  → BuildDownloadEngine / start

引擎
  → 探测 Range 支持
  → 动态创建 Segment + 多 Socket
  → 写入 seg.x* + 更新 segments.bin
  → 合并到最终文件
  → 更新 DB status = Complete / Error / Paused (n%)
```

## 原版内部版本字符串

日志：`AppVersion = MacVersion1324`（= 1.3.24 源码树）
