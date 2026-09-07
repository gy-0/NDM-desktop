# 05 · SQLite 与任务模型

## 库文件

- 模板：`App/Contents/Resources/NeatDB.db`
- 运行时：`~/Library/Application Support/com.NeatDownloadManager/NeatDB.db`
- 访问类：`NeatDBHelper`

## Schema

```sql
CREATE TABLE auths (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target TEXT,
  protocol TEXT,
  user TEXT,
  pass TEXT
);

CREATE TABLE headers (
  id NUMERIC,      -- = downloads.id
  header TEXT      -- 完整头行，如 "Referer: https://..."
);

CREATE TABLE downloads (
  id INTEGER PRIMARY KEY,
  url TEXT,
  method TEXT,              -- GET | POST
  filename TEXT,
  ltype TEXT,               -- normal | media | hls
  filesize NUMERIC,
  category TEXT,            -- Video Audio Document Compressed Misc …
  status TEXT,              -- 见下
  bandwidthlimit NUMERIC,
  connections NUMERIC,
  lasttry NUMERIC,          -- 时间戳；样本见 -1 哨兵
  firsttry NUMERIC,
  useragent TEXT,
  resumable NUMERIC,        -- 0 / 1 / -1(未知)
  pageurl TEXT,
  pagetitle TEXT,
  hittitle TEXT,
  mimetype TEXT,
  errortext TEXT,
  urla TEXT,                -- 第二 URL（MKV 音轨等）
  postdata TEXT,
  folderpath TEXT
);
```

## 枚举值（运行时统计）

### method
- `GET`（绝大多数）
- `POST`

### ltype
| 值 | 含义 |
|----|------|
| `normal` | 普通文件 |
| `media` | 媒体捕获 |
| `hls` | HLS/TS |

### category（首字母大写）
- `Video`, `Audio`, `Document`, `Compressed`, `Misc`（及可能的 Application/Image 图标资源）

资源图标文件名：`video.png` `audio.png` `document.png` `compressed.png` `exe.png` `pdf.png` `misc.png` `complete.png` `incomplete.png`

### status（字符串，非纯枚举）
| 形态 | 例 |
|------|----|
| 完成 | `Complete` |
| 暂停 | `Paused ( 36% )` |
| 错误 | `Error ( 0% )` |
| 空/其他 | 少量空字符串 |

百分比写入 status 文本，便于主列表直接显示。

### resumable
- `1` 可续传  
- `0` 否  
- `-1` 未知/未探测（样本存在）

## headers 表

每个下载 id 可多行，存完整 `Name: value`。常见：

- `Origin:`
- `Referer:`
- `Cookie:`

与扩展协议字段对应。

## auths 表

站点/代理凭据；`pass` 可能经 `encryptString:` / AES 处理（与设置代理密码同类机制）。

## 与文件系统关联

- 任务 id → 目录名 `Application Support/.../<id>/`
- `LastDownloadID`（UserDefaults）追踪自增
- `folderpath` + `filename` → 最终文件

## 任务工作目录布局（冻结）

```
~/Library/Application Support/com.NeatDownloadManager/
├── NeatDB.db
└── <downloadId>/                 # 整数 id，与 downloads.id 一致
    ├── LogFile.txt               # 引擎 INFO/DEBUG（几乎总是有）
    ├── segments.bin              # 24*N 字节段表（进行中/暂停时）
    ├── seg.x0 … seg.xN           # 段数据，N = segmentId
    └── （完成后 seg.* 常被清理，可只剩 LogFile）
```

最终成品路径：

- 根：`DownloadDirectory`（偏好，默认 `~/Downloads/`）
- 若 `CategoryFolders` 开启：再拼 `Video` / `Compressed` / …（与 `category` 列对应）
- 文件名：`downloads.filename`

Schema 快照（可机读）：`reverse/fixtures/neatdb_schema.sql`

## NeatDBHelper 方法（selector）

- `insertDownload:`
- `loadDownloadRecords` / `loadRecords:category:sortOrder:activeWindows:`
- `deleteDownloadRecords:`
- `updateDownloadField:updateField:newValue:`
- `updateFileName:newName:`
- `updateLastTry:`
- `doUpdateURL:newUrl:`
- `getDownloadField:fieldName:`
- `getFolderPath:`
- `loadDownloadRequest:`
- 凭据：`loadSiteCredential:User:Pass:` / `saveSiteCredential:` / `loadAllCredentials` / `deleteCredential:` / `getAllCredentials` / `getSiteCredential:User:Pass:` / `setSiteCredential:User:Pass:`
