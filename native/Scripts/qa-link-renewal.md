# HTTP 链接更新与已下载进度保护：真实引擎回归

此夹具直接启动仓库内编译的 `NDMHost`，通过 Host TCP JSON 协议调用真实下载引擎。HTTP 服务只监听 `127.0.0.1`，使用系统分配端口；Host、Relay Bridge 使用独立空闲端口，并关闭 Legacy Bridge。夹具用 macOS `lsof` 确认监听者确为其启动的子进程后才连接；若并行测试抢占端口，重新选端口启动，避免误连其他 Host。每次运行在 `/tmp/ndm-link-renewal-*` 创建独立数据库、设置命名空间和下载目录，不启动 Electron、不安装应用、不读取真实下载或凭据。

## 运行

```sh
npm run build:native
node native/Scripts/qa-link-renewal.mjs --host native/.build/release/NDMHost --expect protected
```

脚本退出码为 0 代表所有断言通过。启动时将给定二进制固定复制到本次临时目录，所有重启均用同一副本，避免并行构建改变受测对象。控制台输出每个场景的复用字节和最终哈希，末行给出完整 `report.json` 路径。报告记录二进制 SHA-256、每次 HTTP 请求的 Range/If-Range、响应体写入字节、数据库请求上下文、分段范围、已保存字节哈希、重启结果和取消清理结果。各场景目录还保留分步 checkpoint 及 Host 日志。

`--expect baseline` 用于未修复二进制。基线采用提交 `3f0c464cb02c16ea818d7ed8e1d77b03bcbcb330` 的源码，在生产修改前使用独立 Swift scratch path 构建。复现基线应在该提交的独立干净 worktree 编译，然后把其二进制路径传给当前夹具；不要重置正在工作的分支。

```sh
swift build --package-path /path/to/baseline-worktree/native --scratch-path /tmp/ndm-renewal-baseline-build --product NDMHost
node native/Scripts/qa-link-renewal.mjs --host /tmp/ndm-renewal-baseline-build/debug/NDMHost --expect baseline
```

## 测量方式

两个确定性合成对象各为 8,388,608 字节。对象 A 的 SHA-256 为 `e15b8b7720908ed20d5beb98d1e43bc669373cbec9711c414fe780a1644bce8e`；对象 B 为 `be5b8520b0d2ea5f3e6552a1eef466a2c373eb38003c06fdd585465dffc86fe3`。两者故意返回相同 ETag，位于不同 URI，并使用相同来源页。这里的 ETag 仅可验证各自 URI 内的版本，不能证明两个 URI 指向同一对象。

每个场景真实下载对象 A，至少保存 1 MiB 后暂停。夹具读取真实 offset manifest 的 durable prefixes，再逐范围读取 `.partial` 内容并与对象 A 对应区间核对哈希。预分配文件长度不计为已完成字节。之后让旧 token 返回 HTTP 403，尝试更新 URL，重启 Host，再恢复原 URL 的服务。

共有四个主场景：v2 offset／legacy 分段格式，分别更新到「对象 A 的新 token URL」和「对象 B 的新 URL」。每种存储格式另有一次真实部分下载，在拒绝更新及重启后删除任务，验证其拥有的 partial／workdir 被清理，无关文件保持原样。

legacy 场景是明确的兼容夹具转换：先由真实 v2 引擎下载字节并暂停，再停止 Host，把 manifest 中已落盘的前缀复制为 `seg.xN`，按 `SegmentFileFormat.swift` 文档序列化 24 字节小端 `segments.bin`，保留引擎原写入的 `representation.json`。原始 v2 manifest 和 partial 归档在场景目录，没有伪造历史身份。它验证实际引擎的旧格式读取路径，但不声称这些文件由历史版本应用原生创建。

网络计数是本地 HTTP 服务成功写到响应流的正文数据字节，和客户端保存字节独立测量。它不是网卡层流量抓包。报告排除 HEAD 的零正文，并把单字节探测与数据请求分别计算；续传复用通过「实际发出的数据 Range 与 durable prefixes 不相交」及最终完整文件哈希共同证明。`repeatedSavedDataBytes` 统计重复获取已保存字节，`repeatedOriginDataOffsets` 统计服务端此前发送过的偏移再次发送：暂停时的在途字节可能尚未落盘，因此后者可以大于前者，不能把「已保存字节重复为 0」说成所有网络重复均为 0。

## 已观察的基线

2026-09-12 的基线运行中，每个场景暂停时保留 1,179,648 字节。

| 存储格式 | 更新后实际结果 | 字节结果 |
| --- | --- | --- |
| v2 offset | `renew` 返回成功，原 URL 被新 URL 覆盖；随后真实恢复报 `#diag:downloadRecordChanged`，重启仍为新 URL | partial 和 ownership manifest 的哈希保持不变。夹具显式写回原 URL 后，只续传缺失的 7,208,960 字节，已有数据重复下载 0 字节 |
| legacy | `renew` 返回成功，同一任务 ID 随后完成 | 新 URL 完整重下 8,388,608 字节；原有 1,179,648 字节复用 0，相关偏移被重复下载。新 URL 指向 B 时，原任务最终文件为完整对象 B |

因此，v2 的已确认缺口是原请求来源被覆盖、任务无法正常恢复；本次并未观察 v2 丢掉 partial。legacy 则真实复现了静默丢弃旧分段并从头下载。仅凭任务 ID 不变或 JSON 状态，无法区分这两种行为。

基线原生二进制 SHA-256：`932a31453bcd5ae87cad22b1039c83ad21abc77b4adea6537c4efcbbf88d3848`。

## 最终 release 实测

2026-09-12，修复后的最终 release 二进制 SHA-256 为 `3789123dc36faaceeaebeafa36bce2a2faeb94391bc9e8fcc878d49a95a51f69`。四个恢复场景及两条取消清理场景全部通过，进程退出码 0。本地完整报告为 `/tmp/ndm-link-renewal-SpgrZ2/report.json`；对应基线报告为 `/tmp/ndm-link-renewal-O2vciz/report.json`。这些临时目录不是运行依赖，重新执行命令即可生成新证据。

| 存储／候选 | 真实保留并复用的字节 | 续传响应正文 | 重复获取已保存字节 | 服务端已发送偏移重传 |
| --- | ---: | ---: | ---: | ---: |
| v2／同对象新 token | 1,179,648 | 7,208,960 | 0 | 0 |
| v2／不同对象同大小、ETag | 1,114,112 | 7,274,496 | 0 | 65,536 |
| legacy／同对象新 token | 1,179,648 | 7,208,960 | 0 | 0 |
| legacy／不同对象同大小、ETag | 1,179,648 | 7,208,960 | 0 | 0 |

四场景的候选 `renew` 均返回明确的拒绝原因，没有向候选 URL 发出请求；SQLite 原 URL、请求头、方法、请求体、状态和错误信息保持，partial 及恢复元数据哈希跨重启不变。原 URL 再次可用后，仅补齐 durable ranges 的缺口，最终均得到对象 A 的完整 SHA-256。第二行的 65,536 字节是暂停前服务端已写出、客户端尚未落盘的区间，再次请求该区间是恢复所需，不是丢弃了已保存的进度。

取消场景中，v2 保留 1,048,576 字节、legacy 保留 1,114,112 字节直到显式删除任务。拒绝更新及重启没有改变其内容；删除后其拥有的 partial／workdir 被清理，无关 sentinel 文件保持不变。

本节仅报告该独立 HTTP／NDMHost 夹具的结果，不代表整个 native 测试套件或 UI 验收结果。

## 修复后的保证与边界

- 有已保存内容或恢复元数据时，无法确认身份的新 URL 在修改原任务前被拒绝；请求 URL、请求头、状态和原错误信息不被替换。拒绝时不向候选 URL 发起 HTTP 请求。
- 尚无恢复内容时可更新同源 URL；跨源更新要求新任务，避免携带原请求凭据访问另一来源。正在下载或已完成的任务不接受手动原地更新。
- 原请求上下文、partial 和 ownership metadata 跨 Host 重启保持。原 URL 再次可用且同一 URI 内的强校验器保持一致时，可真实续传缺失区间，继续发送 `If-Range`，最终文件必须与对象 A 哈希一致。
- 取消／删除任务仍能按原有所有权记录清理保留的下载数据，不影响无关文件。
- 新 URL 指向同文件也可能被拒绝。这是保守的进度保护；本改动没有实现 S3 version ID 等跨 URI 安全复用契约，也不保证任意网站的过期授权链接能续传。
- 来源页、文件名、大小或不同 URI 上相同的 ETag 不构成对象身份。Link Rescue 只有唯一且请求上下文完全相同的候选可接回；改变 URL／会话头或候选不唯一时走新任务路径。此脚本直接验证手动 `renew` 及引擎恢复；自动 Link Rescue 的匹配和持久回执另由原生测试验证。

暂停时的精确字节数可能随调度变化。断言使用当前运行实际落盘的字节数，而不是把基线的 1,179,648 字节写死。

## 本轮构建与回归检查

2026-09-12 最终 `npm run test:native` 退出码 0：NDMEngine 504 项（8 项按条件跳过）、NDMCore 552 项、NDMBridge 22 项，0 失败。跳过项涉及独立进程崩溃 harness、未准备的媒体工具、公开网络及本地语言模型，未把这些条件测试记作通过。JS 测试 430/430、Relay 142/142、typecheck、Electron build、native release build 均通过。

首轮全量测试曾因本机仅余约 291 MiB 空间导致 32 路 tail-resume 用例报 ENOSPC；清理本任务可重建的重复构建缓存后，可用空间恢复至约 1.1 GiB，最终全量重跑该用例通过。原 PR 曾有启动／认证重试的远程 CI 失败，本轮相关本地测试通过，但没有据此宣称远程 CI 已修复。
