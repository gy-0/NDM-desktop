# 当前官方 Neat：HRBEU HTTPS 传输对照

2026-09-08。本次是重新运行当前 `/Applications/NeatDownloadManager.app` 的真实公开 HTTPS 下载，不以历史 loopback 实验代替。没有暂停、恢复、手动重试或修改下载引擎指令。

公开样本：<https://www.hrbeu.edu.cn/__local/C/A2/B4/FEE5A8AA184531BAF36583D61EB_FAD75A67_3C99ACE.mp4?e=.mp4>。

## 对象和隔离

- 当前官方 App：1.3 / build 24。主可执行文件 SHA-256：`08560144cab189f041389aa2458b0bcff7b8fac937347b7b95d57dcd4ddb4101`。实验前后相同。
- ARM64 `__TEXT,__text` SHA-256：`89c7b03d4913dd009d0905b0134930f961bee7b6423693b09e39aa052453da38`；与此前归档相同，也与本次重新签名副本的代码段逐一核对相同。
- 使用短期 `/Applications/NeatReferenceHRBEU.app` 副本，仅改 bundle identifier 为 `org.ndm.reference.hrbeu`、ad-hoc 签名。App 约 2.4 MiB；未改原包。
- 复用 `scripts/reverse/runtime/isolate.c`，仅将原版本机 IPC 10007 的 bind/connect 映射至空闲 42007，没有增加外部下载 connect 拦截或改写。
- `HOME`、`CFFIXED_USER_HOME`、`TMPDIR` 指向新建 `/tmp/neat-hrbeu-audit.wJMHPi`；`lsof` 确认原版 DB 打开于该目录下 `profile/Library/Application Support/org.ndm.reference.hrbeu/NeatDB.db`，桥接监听仅 42007。
- 启动参数：`-MaxConnections 32 -CompletionDialog 2 -AppAutoStart 2 -DownloadDirectory /tmp/neat-hrbeu-audit.wJMHPi/profile/Downloads`。原版目录参数按字符串拼接且本次末尾没有 `/`，输出成为隔离 profile 内的 `DownloadsFEE5A8AA184531BAF36583D61EB_FAD75A67_3C99ACE.mp4`。仍在自建目录，未进入真实用户 Downloads；复现时应给目录补尾斜杠。
- sandbox 禁止 `/Users/gaoyuan` 写入，以及真实 Neat/NDM 支持目录、Neat 偏好和用户 Downloads 读取；网络仅放行 TCP 443、DNS UDP 53、mDNSResponder 本地 IPC 和隔离桥接。它不是精确目标 IP 的全进程防火墙。

本次 DNS 返回 `198.18.30.81`，运行中 `lsof` 观察到 32 个目标 `198.18.30.81:443` 的已建立 socket，源地址 `198.19.0.1`，属于机器现有 fake-IP 网络路径。没有关闭系统代理、改 DNS 或变更全局网络配置，不能声称直连源站。

## 首轮隔离配置问题，不能算原版传输失败

最初 sandbox 仅给 DNS UDP 权限，缺少 `/private/var/run/mDNSResponder` 的 Unix IPC 许可。第一次任务在 HTTP 之前报 `No Internet Connection or DNS Failed`；独立 sandbox 内 `dscacheutil` 同样无法解析。补充必要的本地 DNS IPC 后，同一独立探针能解析上述 fake IP，才重新启动隔离 App 并提交正式对照任务（id 2）。

此外 macOS 当前 sandbox 规则不接受字面远程 IP，只接受 `*` 或 `localhost`；最早策略编译失败发生在 App 启动前。后续采用 TCP 443 边界，并记录实际 socket 目标。这些都是实验隔离设置问题，不是原版引擎失败或恢复能力的证据。

## 正式任务结果

| 项目 | 实测 |
| --- | --- |
| 参数连接上限 | 32 |
| 日志实际活跃连接 | 从 1、2 增至 32；lsof 独立观察到 32 个目标 HTTPS socket |
| 开始 / 完成日志时间 | 13:03:19 → 13:04:33（本机 SGT） |
| 最终段数 | `File completely Downloaded( 48 Segments )` |
| 206 响应日志条数 | 51 |
| 416 / 429 | 本次日志均 0 |
| 服务器中途关闭 | 3 次 `Server Closed Connection Suddenly`，socket 28、13、19 |
| 手动干预 | 无暂停、恢复或重试 |
| 最终长度 | 63,544,014 B |
| 最终文件 SHA-256 | `b9ea30651a7ff2cd7bf5e8734b44b5316b59d4897ea4df9063eeb4b957fcef8b` |
| 成功后的临时 seg.x 文件 | 0 |

约 74 秒仅是这一任务的日志窗口，不是严格速度 benchmark。未控制 CDN 缓存、系统代理、瞬时带宽、并行负载或新旧产品同时条件，不据此作性能优劣结论。

## 请求和恢复证据

原版首个请求为 `Range: bytes=0-`。后续子请求示例：`bytes=31999664-63544013`、`bytes=47813468-63544013`、`bytes=16490349-63544013`；它们请求到整个文件末尾，而不是每个内部段自己的 end。接收到内部段边界的数据后，原版自己结束该段；不能把 HTTP Content-Range 的 end 直接当作内部存储段的 end。

首段于 13:03:31 完成后又请求 `bytes=42998108-63544013`；全过程未暂停仍从 32 活跃连接发展为最终 48 段。这是本次真实 HTTPS 的持续接手证据，不是历史结果的复述，也不代表每个 socket 完成后必然立即补满。

13:04:25–26，socket 28、13、19 在 RECEIVING 状态报服务器突然关闭。后续日志保留重连/TLS 事件，13:04:33 可见这些 socket 的 `SslHandShake OK`；同秒整体完成。文件输出与完整 SHA 已读取验证。结论是原版在这次任务的三次连接中断后自行完成；本次没有触发 416 或 rollback 日志，不能声称实测证明了原版如何处理 416。

## 保留证据与清理

小型本次归档目录：`/tmp/neat-hrbeu-audit.wJMHPi/`。

- `result.json`：范围列表、状态统计、三次错误及后续恢复摘录、文件长度/SHA。
- `provenance.json`：官方与副本指纹、隔离条件和清理状态。
- `transport-evidence.txt`：仅摘取配置连接数、Range、响应状态、连接错误/重连、段完成与最终完成等行，未归档完整请求 headers 或任何用户凭证。
- `socket-snapshot.txt`：本次进程的连接目标快照。
- `isolation.sb`、`isolate.c`：实际实验隔离配置。

隔离 App 进程已停止，42007 已确认无监听。临时 `/Applications/NeatReferenceHRBEU.app` 已精确永久删除，未留下应用副本；原官方可执行文件再次计算哈希相同。自建 profile、生成视频、数据库及原始任务目录已精确清理，仅保留小型证据。没有读取、删除或修改用户 NDM 现有任务的约 43 MB 部分下载数据。
