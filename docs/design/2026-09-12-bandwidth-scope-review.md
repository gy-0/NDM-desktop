# 下载限速范围审查

日期：2026-09-12。依据工作区源码与 aria2 官方手册；路径和行号对应初次审查时的实现。初次范围审查仅阅读源码，随后主任务修复合并媒体恢复，并补充真实下载验证，见下文。

## 本轮决定

macOS 当前 `bandwidthLimitBytesPerSecond` 的可靠含义是**每项普通 HTTP 文件的默认限速**，不是所有下载合计的总带宽。产品使用“默认文件限速”“临时文件限速”，明确“每项”及支持范围。任务自定义限速优先于默认值。

Windows 的限速机制与 macOS 不同，而且存在执行确认、重启和任务遗留限速问题。本构建不显示 Windows 临时限速入口；既有 Windows 设置保持现状。这是发布范围决定，不代表这些缺陷已经修复。

本轮不为“总带宽”这个名称重写所有协议。未来若要承诺总带宽，必须建立跨任务、跨引擎的共同配额，并完成本文后面的验收。

## 为什么原文案不成立

审查时，[Settings.tsx](../../src/renderer/src/components/Settings.tsx) 显示“全局带宽限速”和“控制全局最大下载速度”；任务详情显示“跟随全局”。临时入口又与所有任务的合计速度放在同一个传输面板里。这些呈现会让用户合理地理解为“设置 5 MB/s 后，整个应用合计最多下载 5 MB/s”。

macOS 普通 HTTP 路径的代码并不提供这个保证：每个任务各自拥有 5 MB/s 配额。三个没有自定义限速的任务，同时下载时理论上可以合计接近 15 MB/s；这是由独立 limiter 推导出的语义，不是本次测得的吞吐数值。带自定义限速的任务也不会被更低的默认值约束。

这里的“普通文件”指经 `DownloadEngine` 下载的 HTTP/HTTPS 文件，不能靠侧栏的“文档/视频”分类判断。一条直接下载 MP4 的 HTTP 链接也可以走普通文件引擎；经网页解析、HLS 或音视频合并路径处理的媒体则不能据扩展名承诺支持。

## macOS 源码证据

| 路径 | 当前实际行为 | 证据 |
| --- | --- | --- |
| 普通 HTTP/HTTPS 文件 | 每项默认上限；同一任务的分段共享配额，不同任务不共享。自定义单项值大于零时优先使用单项值。正在运行的普通文件能随设置更新。 | [Host 更新设置](../../native/Sources/NDMHost/main.swift) 约 826 行；[DownloadManager.updateSettings](../../native/Sources/NDMEngine/DownloadManager.swift) 91–100 行；[DownloadEngine 初始化](../../native/Sources/NDMEngine/DownloadEngine.swift) 136–144 行；[RangeStreamDownloader](../../native/Sources/NDMEngine/RangeStreamDownloader.swift) 约 345 行消费 limiter。 |
| HLS，含直播 | 没有读取这一限速值，也没有使用普通文件 limiter；不能承诺默认限速或临时恢复会控制其速度。 | [独立 HLS 创建路径](../../native/Sources/NDMEngine/DownloadManager.swift) 约 1014 行；[HLSEngine](../../native/Sources/NDMEngine/HLSEngine.swift) 约 631 行直接获取数据。 |
| FTP | 没有读取这一限速值，也没有使用普通文件 limiter。 | [独立 FTP 创建路径](../../native/Sources/NDMEngine/DownloadManager.swift) 约 1056 行；[FTPEngine](../../native/Sources/NDMEngine/FTPEngine.swift) 约 184 行直接接收并写入。 |
| 分离音视频合并 | 启动时创建两个独立 `DownloadEngine`，音轨与视频各得到一份启动时的默认限速；之后没有被全局设置更新遍历覆盖。 | [MKVMergeEngine](../../native/Sources/NDMEngine/MKVMergeEngine.swift) 75–92 行；[DownloadManager](../../native/Sources/NDMEngine/DownloadManager.swift) 24–28 行分别维护 `engines`、`hlsEngines`、`ftpEngines`、`mkvEngines`、`ytDlpEngines`，更新时仅遍历 `engines`。 |
| yt-dlp 媒体 | macOS 启动路径未传此限速，参数构造也没有 `--limit-rate`。 | [DownloadManager](../../native/Sources/NDMEngine/DownloadManager.swift) 约 424 行；[YtDlpTool 参数构造](../../native/Sources/NDMEngine/YtDlpTool.swift) 约 1330 行。 |

**合并媒体：初次审查发现的缺口，现已修复。** 上表保留修复前证据。当时若在临时限速期间启动，两个子引擎会继承临时值；到期更新普通文件默认值，不会同步改变这些已启动的子引擎。仅修改产品文案不会消除这一行为，实际修复与验收见下一节。

因此本轮可以承诺“为每项普通 HTTP 文件设置临时默认限速并恢复原默认值”，不能承诺“所有下载都会在到期后恢复速度”，也不能承诺“其他下载不会受到任何影响”。合并媒体的继承与动态恢复已完成独立验收。

## 主任务补充：合并媒体恢复已修复

上述表格与缺口说明保留修复前的审查依据。随后为 `MKVMergeEngine` 增加运行期默认限速传递，Manager 设置更新同时通知两个子下载；单项显式 cap 保持优先。启动中和重叠设置更新都重新核对最新值，不重建下载。

修复前真实两路本地 HTTP 在 1 B/s 默认值下启动，恢复不限速后仍不前进；修复后约 0.36 秒内两轨都有进度，每轨仍只有一个原 Range，任务尝试时间不变。新增三项测试及相关回归共 21 项通过，另覆盖启动前变化、音视频分别自定义，以及三十个重叠更新。该修复消除了临时默认值在已运行 MKV 子下载中残留的问题；音视频仍使用各自配额，不能称为共享的总带宽。

## Windows 源码证据与暂缓原因

aria2 的 `max-overall-download-limit` 限制该 aria2 实例合计下载速度；`max-download-limit` 限制单个下载。这两个选项的含义不同。[aria2 官方手册](https://aria2.github.io/manual/en/html/aria2c.html#cmdoption-max-overall-download-limit)

| 路径或边界 | 当前行为 | 风险与证据 |
| --- | --- | --- |
| 更新默认限速 | 调用 aria2 `changeGlobalOption`，修改 `max-overall-download-limit`。 | [windowsEngine.updateSettings](../../src/main/windows/windowsEngine.ts) 987–991 行。这一部分是真正的 aria2 实例总限速，但不包括独立 yt-dlp 进程。 |
| 执行确认 | `changeGlobalOption` 失败被 `catch(() => undefined)` 吞掉，设置仍持久化，随后返回 `ok: true`。 | [windowsEngine](../../src/main/windows/windowsEngine.ts) 987–1003 行。控制器的严格 `ok` 检查无法弥补适配器伪成功；UI 读回 JS 设置不等于 aria2 已执行。 |
| 临时期间新建任务 | `taskOptions` 把 `task.bandwidthLimit || settings.bandwidthLimitBytesPerSecond` 写为任务的 `max-download-limit`。 | [windowsEngine.taskOptions](../../src/main/windows/windowsEngine.ts) 398–406 行。到期只恢复 overall，未同步清除这些任务继承的单项 cap，可能继续残留临时上限。 |
| 应用与 aria2 重启 | 先加载持久 JS settings，然后启动 aria2；启动参数和连接成功路径没有重灌持久化 overall 值。 | [start](../../src/main/windows/windowsEngine.ts) 175–190 行；[spawnAria2](../../src/main/windows/windowsEngine.ts) 345–362 行。无外部配置介入的新实例可能仍是 aria2 默认不限速，而 `getSettings` 却报告非零值。 |
| yt-dlp 媒体 | 仅在新进程启动时读取设置，转为固定 `--limit-rate`。运行中的进程不接受此设置的后续更新。 | [windowsEngine](../../src/main/windows/windowsEngine.ts) 546–557 行；[mediaFormats](../../src/main/windows/mediaFormats.ts) 约 294 行。到期改 JS/aria2 设置不等于该媒体进程已经恢复。 |

只隐藏 Windows 按钮还不能构成执行边界。当前主进程仅在 macOS 创建临时限速控制器，Windows 不处理新增的私有临时操作。既有普通设置继续按原逻辑工作，不在本轮顺带声称已经可靠恢复。

## 本轮产品与控制器契约

| 位置 | 建议表达或行为 |
| --- | --- |
| macOS 设置标题 | 默认文件限速 |
| macOS 设置常驻说明 | 每项普通 HTTP 文件的默认上限；任务自定义限速优先。 |
| 支持范围说明 | 不保证控制 HLS、FTP 或网页媒体下载。分离音视频合并的两个 HTTP 子下载继承默认值并动态恢复，但各自使用配额。 |
| 传输面板入口 | 临时文件限速… |
| 临时表单 | 每项普通文件；选择速度和 15 / 30 / 60 分钟。提交前即可看到作用范围。 |
| 应用后状态 | 每项文件 5 MB/s；14:30 恢复原默认值。不要写成“总速度 5 MB/s”。 |
| 当前设置被手动修改 | 手动修改结束临时计划，包括用户手动写入相同值。 |
| 未收到引擎明确确认 | 显示确认中或失败；保留可恢复记录，允许重试。不能把未确认写入显示为已生效。 |
| 到期或“现在恢复” | 主进程读取并核对当前默认值后恢复；离线时保留恢复意图，重连再处理。不能为未受控媒体显示已经恢复的速度承诺。 |
| 传输合计速度 | 保留为观测值，与“每项文件上限”明确区分；超过单项上限本身并不等于限速失效。 |

现有 [TemporaryBandwidthController](../../src/main/temporaryBandwidth.ts) 负责“设置值的生命周期”，不负责跨引擎限流。它的 23 项独立测试覆盖持久化、严格确认、串行写入、重启、断线、休眠时间跳跃、手动接管与观察到的外部变更；这些测试不证明真实 HTTP 吞吐，更不证明 HLS/FTP/外部媒体进程的执行。

当前原生协议没有设置版本号或比较交换。控制器可以保护已经观察到的外部改值，也可以串行化应用内的手动操作；它无法消除独立进程在最后一次读取与写入之间的竞争，或从未观察到的同值往返变更。持久存储完全不可写时，已验证的放弃/收窄在内存里仍成立并持续重试；若在落盘成功前强制退出，不能保证这些尚未持久化的观察能跨进程保存。

## 后续架构及验收

若继续保留“默认每项”语义，下一步需补齐 Windows 的动态更新、继承及确认规则，再判断是否适合增加总配额。合并媒体的动态恢复已经修复。

若未来提供真正的“应用总带宽”，需要由 Manager 持有共享配额，普通 HTTP、HLS、FTP 和分离音视频共同消费。单项限制作为另一层上限，必须同时满足总配额与单项配额。两个音视频流不能把同一用户任务的配额翻倍。yt-dlp 等外部下载进程需要可控制的网络/调度边界；仅启动时追加 `--limit-rate` 不能满足动态总配额或到期恢复。

上线前至少完成以下可观察验收，使用独立 support 目录、端口和本地数据源，不能操作用户真实下载：

1. **普通文件默认语义**：两个并行 HTTP 文件，各自符合设置；单项自定义值优先；设置变更与到期恢复对已运行、新建、暂停后继续的普通文件一致。
2. **真实总配额语义（仅在实现后）**：HTTP、HLS、FTP、音视频混合并发，在预先规定的统计窗口及突发容限内测量合计接收字节；不能用 UI 设置回显替代吞吐证据。限制调整不丢片段、不破坏续传、完成文件可播放。
3. **合并媒体**：临时期间启动音视频任务，到期时两个子引擎都更新；验证两条流共享用户任务配额，并保留暂停/保存行为。
4. **外部媒体进程**：已运行进程可以动态应用和撤销；如果暂不支持，能力信息和 UI 必须明确排除，且不得隐式继承一个无法按时撤销的临时设置。
5. **Windows 执行确认**：注入 aria2 RPC 失败时不返回成功、不发布已生效状态；通过 aria2 `getGlobalOption` / `getOption` 对账，而非只读 JS settings。
6. **Windows 生命周期**：恢复持久化设置后、新 aria2 进程标记 live 前重灌并确认；临时期间创建的任务到期不遗留继承 cap；显式单项 cap 保持不变。
7. **时间与所有权**：窗口关闭主进程仍可恢复；断线、休眠唤醒、跨重启、系统时间变化后按期限对账；手动同值/异值写入、观察到外部变更、磁盘读写失败与确认丢失不得复活旧恢复权。
8. **跨平台产品证明**：分别验证入口可用性、错误文案、实际恢复时间及不支持类型。只有经过对应系统真实下载验证的能力才能展示给该平台用户。

本次审查完成的是范围判断、代码证据和验收定义。Windows 修复、跨引擎共享配额及真实混合总量吞吐验证仍未实施。合并媒体动态恢复已由主任务补充修复，见上文验收。
