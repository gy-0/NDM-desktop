# 15 · Rapidmg 1.3.1 一键安装逆向规格

> 2026-08-06。对象：`/Applications/Rapidmg.app`（`com.branchseer.rapidmg`，MAS 应用，本机为 macked.app 破解重签名副本）。
> 方法：静态（strings / __objc_methname / Ghidra 12.1.2 全量反编译 4257 函数）+ 动态（log stream + 真实 dmg 端到端）。
> 目的：为 NDM「下载安装包后一键安装」功能提供行为规格。**注意：Rapidmg 是闭源商业应用，本规格只描述行为，移植到 NDM 必须 clean-room 重写，禁止复制字节码。**

## 0. 一句话

Rapidmg = **不挂载、直接读镜像**的一键安装器：用内嵌 7-Zip（UDIF+HFS/HFSX+APFS 处理器）把 dmg 里的 `.app` 直接解压进 `/Applications`；ZIP 同理。挂载（DiskImageMounter）只是用户显式「Mount」动作的兜底。

## 1. 二进制事实

| 项 | 值 |
|----|----|
| Bundle ID / 版本 | `com.branchseer.rapidmg` / 1.3.1 (14) |
| 语言/UI | Swift 5.9（SwiftUI+AppKit），916KB，arm64-only，未加密 |
| 签名 | 原始 MAS 签名已被 macked.app 替换（`Authority=https://macked.app`，TeamIdentifier 空） |
| Entitlements | `app-sandbox`、`files.bookmarks.app-scope`、`files.user-selected.read-write`、`network.client` |
| 内嵌 Framework | **`7zz.dylib`（5.3MB，7-Zip SDK）**、macked.app.dylib（破解注入） |
| 链接框架 | IOKit、LocalAuthentication、Security、StoreKit、WebKit、SwiftUI |
| 源码文件（路径泄露） | `DecompressUI.swift`、`DefaultHandlerUI.swift`、`promptURLBookmark.swift`、`PurchaseUI.swift`、`SettingsUI.swift`、`WelcomeUI.swift` 等（`/Users/runner/work/1/s/Rapidmg/`） |

## 2. 挂载机制（核心发现）

**字符串里完全没有 `hdiutil` / `diskutil` / `DADiskMount` / `mountVolume`。** 7zz.dylib 导出符号确认编译进了：

```
NArchive::NDmg::CHandler    ← UDIF 镜像直接读取
NArchive::NHfs::CHandler    ← HFS / HFSX
NArchive::NApfs::CHandler   ← APFS
NArchive::NSquashfs::CHandler
```

反编译确认主流程只调 `NSWorkspace openURLs:withAppBundleIdentifier:`（com.apple.DiskImageMounter）一次 —— 那是**「Mount the disk image」按钮**（EULA 弹窗内 / RDNoAppAction=3 兜底），不是常规安装路径。

## 3. 主流程（Ghidra 反编译还原）

```
application:openURLs: (AppDelegate.openedFromFiles=true)
 └→ FUN_1000099dc: 逐 URL 派发
     └→ EULA 检测（见 §4）
         └→ FUN_100016468 总管:
             1. SZArchive 打开（ZIP/DMG/文件夹统一归档视图）
             2. itemPathAtIndex: 枚举条目 → FUN_10001aacc 过滤垃圾（见 §5）→ 找 .app
             3. RDNoDetectApps==false（默认自动检测）且发现 .app:
                → 目标 = bookmark「RDURLBookMarkData_<path>」（默认 /Applications，security-scoped）
                → startAccessingSecurityScopedResource
                → 多 app 弹「Install Selected App」选择
                → FUN_1000181cc/FUN_100017a8c 安装（见 §6）
                → stopAccessingSecurityScopedResource
             4. 无 .app → RDNoAppAction 五选一（见 §7）
             5. NSUserNotificationCenter 发通知
             6. RDSuccessiveExtractionCount：连续 3 次没装成 → 重置 -1 → 弹「设为默认处理器」提醒（macOS 14+）
```

## 4. EULA 检测

- 用 `NSURLResourceKey.resourceForkXMLData` 直接读 dmg 资源 fork XML（UDIF 的 SLAs 存这里，`propertyListWithData:` 解析）
- 有 EULA → NSAlert sheet：`"«localizedName» has a license agreement. Do you accept it?"`，按钮 [View Agreement] / [**Mount the disk image**]（openURLs+DiskImageMounter）/ [Accept]
- 弹窗标题用 `NSURLLocalizedNameKey` 资源值，取不到退回 `lastPathComponent`

## 5. 条目过滤器（FUN_10001aacc，内联 Swift 小字符串解码）

跳过以下名字的条目（后缀/前缀/全等匹配，HFS+/APFS 特殊文件）：

```
.fseventsd        /.fseventsd
.Trashes          /.Trash
.journal          .journal_info_block   /.journal_info_block
.DS_Store
[HFS+ Private Data]      [HFS+ Private Directory Data]（strings 明文）
```

剩下的是「候选 .app」（`*.app` 后缀 / `.app/` 前缀命中）。

## 6. 安装（拷贝）语义

两种变体（DMG 路径 FUN_1000181cc、ZIP 路径 FUN_100017a8c），逻辑一致：

1. 目标 `destFolder + appName` 不存在：
   - `createDirectoryAtURL:withIntermediateDirectories:`（建 /Applications 或 ~/Applications）
   - 记会话时间戳（`store:`）
   - 主队列异步 → `SZArchive extractItemsAtIndexes:removingPathPrefix:toFolder:onErrorMessage:error:`（**removingPathPrefix = 公共目录前缀剥离**，只提取选中的条目）
   - 成功后 `setAttributes:ofItemAtPath:` 把 **NSFileModificationDate 改为现在**（刚装好的语义）
2. 目标已存在 → 冲突对话框 `"«name» already exists. Do you want to replace it?"`（附：替换会覆盖现有内容）
   - 替换 → `removeItemAtURL:error:` → 走 1
   - 不替换 → 跳过

## 7. 无 app / 处理完后的动作（枚举 0-4）

设置项 `RDNoAppAction`（无 app 时）与 `RDActionAfterExpand`（解压/安装后），同一枚举：

| 值 | 行为 | API |
|----|------|-----|
| 0 | Leave the disk image alone（不动） | — |
| 1 | Move the disk image to Trash | `FileManager.trashItemAtURL:resultingItemURL:error:` |
| 2 | Delete the disk image | `removeItemAtURL:error:` |
| 3 | Mount the disk image | `NSWorkspace openURLs:withAppBundleIdentifier:` DiskImageMounter |
| 4 | Expand into the same folder as the disk image | 解压到 dmg 同目录 |

本机实测（用户设置 RDActionAfterExpand=1）：17KB 测试 dmg → 1 秒内完成「安装到 /Applications + 原 dmg 进 ~/.Trash + 卷不残留」。**全程无挂载。**

## 8. 其它设置键（UserDefaults）

| Key | 类型 | 含义 |
|-----|------|------|
| `RDHideDefaultHandlerBar` | bool | 隐藏「非默认处理器」提醒条 |
| `RDNoDetectApps` | bool | 关闭自动检测 app（默认开） |
| `RDNoAppAction` | int | 无 app 动作（§7 枚举） |
| `RDActionAfterExpand` | int | 完成后动作（§7 枚举） |
| `RDSuccessiveExtractionCount` | int | 连续未安装计数（=3 → 提醒设默认，重置 -1） |
| `RDURLBookMarkData_<path>` | data | 目标目录 security-scoped bookmark |
| `NSOSPLastRootDirectory` | data | 上次开放面板目录 |

## 9. 对 NDM 移植的映射

| Rapidmg 能力 | NDM 移植方案 |
|--------------|-------------|
| 7-Zip 直接读 DMG | **改用 `hdiutil attach -nobrowse -readonly -plist`**（NDM 非沙盒、系统自带、可离线造 fixture 测试）；保留「不挂载残留」的收尾（detach 一定执行）；**attach 遇瞬态失败自动重试 3 次**（对应原版 `attachHandleBusy`） |
| EULA 检测 + 自己的接受框 | 原样移植。`hdiutil imageinfo -plist` 的 `Properties.Software License Agreement` 检测；检测到 → 弹「包含许可协议。你接受它吗？[查看协议][接受]」（查看协议=交给 DiskImageMounter 展示原文，与 Rapidmg 的 MountButtonTarget 一致）；接受后 **`hdiutil convert -format UDTO` 转裸镜像再挂载**（SLA 存在 UDIF 元数据里、不在卷内容里，转换即剥离，社区验证 15 年的自动化方案），装完删临时镜像 |
| 条目过滤器（§5） | 原样移植为纯函数（NDMCore） |
| 冲突替换确认 | 原样移植（NDMDialog） |
| 多 app 选择 | 原样移植（「安装所选应用」选择） |
| 无 app 五动作 | 原样移植（默认 Leave） |
| 安装后 mtime 打戳 | 原样移植（刚装好的语义） |
| 通知 | 复用 NDM 完成窗口（已是通知面） |
| 默认处理器抢占 | **不做**（NDM 不做 dmg 默认处理器，只做完成页一键按钮） |
| 沙盒 bookmark / Grant Access | **不需要**（NDM 未沙盒，/Applications 对 admin 用户 775 可写，实测） |

## 10. 验证记录

- 静态：strings 3108 行；__objc_methname 562 选择子；Ghidra 4257/4257 函数反编译
- 动态：`open -a Rapidmg <UDZO 测试 dmg>` → .app 落 /Applications、原 dmg 进 ~/.Trash、无挂载残留、进程 1s 内退出（RDActionAfterExpand=1）
- 本机 `/Applications` = `drwxrwxr-x root admin` → 管理员无需密码可写（一键安装无授权弹窗的前提）
