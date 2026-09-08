# Neat 对照审计：仍未完善的下载行为

本轮只分析和复现，不修改引擎或替换用户 App。基线为 Git `bd73bf5` / 安装构建 `2026090829`。当前官方 Neat 主程序 SHA-256 重新核对仍为 `08560144cab189f041389aa2458b0bcff7b8fac937347b7b95d57dcd4ddb4101`，其匹配 ARM64 指令依据见 [TRANSPORT_RECOVERY](TRANSPORT_RECOVERY.md)。分析者命名的伪代码不是原始源码；以下明确区分 NDM 实测、原版静态证据及未验证推论。

## P1：局部分段短暂 503 会终止整个任务

NDM `DownloadEngine.swift:1155` 在第四次拒绝后抛出 HTTP 错误，`:983` 取消整个 Range round。隔离安装版 Host 实测：8 个分段中 6 个已完成，1 个健康连接持续传输，另 1 个连续四次返回 503 / Retry-After 1。约 3.23 秒时任务变为 error，健康连接仅发送 253,952 / 1,048,576 字节便被关闭。服务器设置为第五次请求即可成功，但引擎没有再尝试。

原版状态 dispatcher `0x10003a32c/334/33c` 排除 401/407/416 后，503（429 同分支，未实测）进入 `0x10003a468`，经 `0x10003a664` 调统一错误入口。原版普通可续传 downloading 错误入口 `0x100024ffc` 不消耗 startup 预算，延迟重排当前 socket；通用 HTTP 错误先清 startup 预算，不等于已进入 downloading 时同样存在三次上限。原版该特定 503 夹具未重跑，不能声称本轮直接看到了原版完成它。

修复方向：区分启动失败、可续传传输中的临时拒绝与终止性 HTTP 错误；保持健康连接和已写前缀，尊重 Retry-After，不把有限拒绝次数直接升级为全局失败。2 连接时降为 1 的 admission 会延迟重试，所以不能把此夹具的时序泛化到任意连接数。

证据：[admission.json](engine-gap-audit-2026-09-08/admission.json)，复现 `node scripts/qa-admission-audit.mjs`。

## P1：成功 POST 下载重复提交请求

`probeRemote` 对 body-bearing 请求使用真实 POST 探测；`probeData` 在 `:599` 用 `session.data` 接收完整响应，`:708` 丢弃 body；之后单流路径再次发送 POST。

隔离 release Host 实测同一 12 字节合成表单确实提交两次，每次返回 1 MiB，最终留下 1 MiB 正确文件。此前“失败 POST 不自动重放”的测试没有覆盖成功 probe 后的二次请求。一次性下载令牌或动态生成文件可能因此失效/重复生成；这些业务后果是推论，本轮只实测了重复提交。

修复方向：首次真实请求同时建立元数据和保存下载内容，不能把有副作用的请求当可丢弃探测。没有完整验证原版所有 POST 行为，不把推论包装为原版兼容承诺。

## P1：忽略 Range 的服务器导致完整下载两遍

隔离 GET 夹具：HEAD 返回 405，Range 0–0 被服务器忽略并返回 200 全文。NDM 收完 1 MiB 并丢弃，再发无 Range GET 收取相同 1 MiB；实际传输 2 MiB，成品 1 MiB。

这是上述 probe 与下载分离的另一个用户可见后果。`session.data` 还需要聚合完整 body，意味着大文件探测存在高内存风险；本轮没有做大文件内存峰值测量。原版已验证首请求 `Range: bytes=0-` 并将接收数据送入 segment 写出链 `0x100054344 → 0x100053f50`，是更合适的参考方向。

两个 probe 案例证据：[probe.json](engine-gap-audit-2026-09-08/probe.json)，复现 `node scripts/qa-probe-audit.mjs`。

## P2：真正下载首字节之前，错误地进入无限传输重试策略

NDM `:247/:282` 在元数据 probe 成功后就设置 downloading。真实 Range 使用 `:1139–1175` 的无次数上限 transport 重试，与是否实际写过文件字节无关。Neat `0x100054344` 在写出准备时才切换 engine 状态；只有响应头而无 body 时仍在 starting，适用相应有限启动预算。我们之前补的 StartupRetry 仅覆盖元数据请求，没有覆盖这一边界。

安装版 Host 单连接实测：HEAD 成功一次，真实 Range 连续五次返回有效 206 头后零 body 断开；18.764 秒后仍为 downloading、完成字节 0。随后已暂停该隔离任务并清理。它证明没有采用初次加三次预算；无限持续是源码推论，不是有限观察窗口直接证明。证据：[starting-state.json](engine-gap-audit-2026-09-08/starting-state.json)，复现 `NDM_QA_HOST_PATH=/Applications/NDM.app/Contents/Resources/bin/NDMHost node scripts/qa-starting-state-audit.mjs`。

修复应围绕首个真实数据流的启动成功边界；不能简单给 32 个 worker 各套三次重试，也不能破坏已有前缀的持续恢复能力。

## P2：503 被直接当作连接上限证据，降并发后本轮不恢复

`DownloadEngine.swift:1152` 每次 429 或 503 都把 `serverConnectionLimit` 减一。上述真实夹具可见上限从 8 降到 4；源码没有下载过程中恢复该 ceiling 的路径。503 可以是暂时服务不可用，不能仅凭这个状态码确定服务器少允许一个连接。

这是我们自己的保守策略，不是已复现的 Neat 策略。应分别处理速率限制、并发拒绝和临时服务故障，并验证恢复策略；本轮没有实测服务器恢复后长期吞吐下降的幅度。

## 需要继续确认，不能直接算缺陷

- URLSession 60 秒 request timeout 与 Neat socket >26 秒、约 5 秒扫描的计时不同；计时起止语义也不同，不应简单把 60 改成 26。
- HEAD 成功但不带长度时，当前直接返回并走单流，没有继续用 Range 获取完整信息。源码确认的兼容性缺口，尚未另跑夹具。
- 没有强 validator 时单流是完整性取舍，不应为了显示 32 连接而直接删除保护。
- NDM 请求到内部段末尾，Neat 请求到文件末尾并限制本地写入。差异已证实，尚不能据此认定哪种在所有服务器上更好。

优先顺序：局部 503 恢复 → 首次请求的 probe/下载合并与 POST 单次提交 → 首字节启动边界 → admission 恢复策略 → timeout 与其余协议矩阵。隔离夹具只操作自建任务、目录及端口，均清理自建下载数据。诊断脚本成功表示复现了当前缺陷，不表示产品已经修好。

## 后续修复

[构建 2026090830 的修复与验证](../../../product/ENGINE_GAP_FIXES_2026-09-08.md)记录这五项问题的实现、夹具复验和仍然存在的边界。本文保留构建 29 的原始审计证据，不作为新版本仍有相同缺陷的断言。
