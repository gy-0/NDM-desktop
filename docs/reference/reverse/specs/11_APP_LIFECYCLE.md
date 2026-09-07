# 11 · AppDelegate 生命周期与任务编排

来源：`02_OBJC_CLASSES.md` AppDelegate + 日志 + ivar。

## 启动

```
applicationWillFinishLaunching:
applicationDidFinishLaunching:
  → duplicateInstanceOccured?  （单实例）
  → doInitialization
  → setAppDirectories          （nsAppSupportPath / nsAppOutputPath）
  → loadDownloadRecords
  → buildWebSocketServer       （mpWebSocketServer）
  → Status Item + menu
  → receiveWakeNote:           （系统唤醒，可能恢复网络）
```

### 关键 ivar

| ivar | 含义 |
|------|------|
| `nsAppSupportPath` | Application Support 根 |
| `nsAppOutputPath` | 默认下载输出 |
| `db` | `NeatDBHelper` |
| `downloadRecords` | 当前列表缓存 |
| `downloadWindows` | id → 进度窗 |
| `waitingWindows` | 扩展等待确认窗 |
| `alertWindows` | 错误/完成等 |
| `mpWebSocketServer` | C++ WS 服务 |
| `mRunningEngineThreadCount` | 活跃引擎线程数 |
| `noSleepAssertionID` | 下载时防止休眠 |
| `currentStatus` / `currentCategory` / `currentSortOrder` | 列表过滤 |
| `outlineTopItems` / `outlineSubItems` / `allOutlineNodes` | 分类树 |

## 扩展推送下载

```
WS 收到文本协议
  → handleBrowserDownloadRequest:
  → 可能 addToWaitingWindows: / NeatWaitWindow
  → 用户确认
  → insertDownload (DB)
  → buildDownloadWindow:resume:rowIndex:
       resume=NO
  → BuildDownloadEngine
```

## 手动 URL

```
handleNewUrl: / onUrlWindow:
  → 同样 insert + buildDownloadWindow
```

## 进度与完成

```
引擎回调
  → onDownloadWindowProgress:progressInfo:
  → onDownloadWindowNotify:senderWindow:extraInfo:
  → onDownloadWindowDone:
       更新 DB status / filesize / folderpath
       刷新 table
       可选 Complete 对话框
```

## 用户操作

| 方法 | 行为 |
|------|------|
| `resumeDownload:` | `buildDownloadWindow:resume:YES` |
| `reDownload:` | 可能 FullRedownload |
| `stopDownloads` | 暂停选中 |
| `deleteDownloads` | 删记录（及可选文件） |
| `doUpdateURL:newUrl:` | Renew 链接 |
| `doUpdateLastTry:rowIndex:` | 更新 lasttry |
| `showPropertiesWindow:` | 属性 |
| `toolBtnAction:` | 工具栏分发 |

## 设置 / 浏览器 / 关于

```
onSettingWindowDone
onBrowsersWindowDone
onAboutWindowDone
onQuitWindowDone
onAlertWindowDone:
onWebSocketServerEnded
```

## 退出

```
windowShouldClose: → 可能 NeatQuitWindow（Hide vs Quit）
applicationWillTerminate:
  → stopDownloads
  → 关闭 WS
  → isAppTerminating = YES
```

## 引擎状态机（日志实证，n≈80 份 LogFile）

```
Unknown → Starting... → Downloading... → Merging... → Completed
                         ↘ Paused
              ↘ Error
Error → Starting...          （重试）
Completed → Starting...      （重新下载）
Downloading... → Starting... （少见，重配）
```

带计数的 Starting：`Starting... ( 4 )` 表示重试/阶段编号。

**Merging...** 是静态字符串里先前未单独强调的关键阶段：全部分段收齐后合并 `seg.x*` → 最终文件。
