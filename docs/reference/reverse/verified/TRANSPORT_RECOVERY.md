# 普通 HTTP 传输恢复：当前 Neat 样本核对

2026-09-08。只读核对当前 `/Applications/NeatDownloadManager.app`，没有启动、暂停或修改用户的 Neat 下载任务。可读函数名由分析者命名，伪代码不是原作者源码；以下结论来自控制流、虚表和当前 ARM64 指令交叉核对，不表示已移植原版全部稳定性。

## 样本身份

- 当前 universal executable SHA-256：`08560144cab189f041389aa2458b0bcff7b8fac937347b7b95d57dcd4ddb4101`。
- 旧 manifest 的 universal SHA 是 `82ac9da838a633a187029aef14cef45f5bd8a9b8914ad2d0ccea5205c47641a9`，已不能用于描述当前完整文件。
- 本轮重新用 `lipo -thin arm64` 提取的完整切片 SHA：`25031b78644cc3371ad81dd1e675550ae72e221d88f6c0ae167b434025cdc0c7`，与 verified manifest 完全相同。因此本报告 ARM64 地址仍有效；不据此解释 universal 差异原因或宣称 x86_64 也已核对。
- 当前切片临时路径 `/tmp/neat-retry-audit-arm64`。直接 r2 反汇编记录 `/tmp/neat-retry-current-disassembly.txt`、`/tmp/neat-retry-current-extra.txt`；这些临时文件不是持久归档。
- 辅助读取既有 `reverse/dumps/verified-2026-09-08/export` 和 `reverse/dumps/full_decompile/ghidra_c`；原有产物未修改。旧 Ghidra 输出仍有签名/不可达块警告，关键分支另以当前指令确认。

## 可确认的控制流

| 触发 | 地址与行为 |
| --- | --- |
| HTTP 连接突然关闭 | `0x10003b02c` 发出 `Server Closed Connection Suddenly`，调用统一错误入口 `0x100024ffc(engine,socket,error,0)`。它也先处理已完成/特殊未知长度的情况，不能把所有 EOF 都叫失败。 |
| Connect / DNS 失败 | `0x1000265dc` 的 `Can't Connect to Host`、`No Internet connection or DNS failed` 分支同样传最后参数 0。 |
| 下载阶段普通传输失败 | `0x100024ffc` 在 engine 状态 `+0x598 != 1` 且可恢复分支，参数 0 调 `0x1000532d0`。后者调用当前 socket 虚表 `+0x88(self,1,1)`；允许后续工作时设置等待标志 `+0x1f8`、延时 `+0x1e8 = 0x1194 = 4500`，启动 `+0x1f0` 计时。 |
| 延迟到期 | `0x100053510` 要求等待标志为真且 elapsed **大于** 4500，然后清标志并调用 `0x100052a30(socket,0)`，使其可重新分配。 |
| 下载阶段 timeout | 主循环 `0x1000286fc` 调 socket 虚表 `+0x30`；超时后向 `0x100024ffc` 传最后参数 **1**。非 starting 分支直接调用 `+0x88(self,1,0)`，不经过上述 4500 等待。 |
| 启动阶段失败 | `0x100024ffc` 的 engine 状态 `+0x598 == 1` 分支读取 `+0x698`，非零则减 1 并重试，零则进入任务 error。构造 `0x100021a04`、重新启动 `0x100027e20` 将它设为 3。是启动阶段的 3 次重试预算，不是所有下载 worker 共用的失败上限。 |
| 不可续传 | `0x100024ffc` 优先检查 engine `+0x18c == 2`，直接全局 error。`0x1000260d0` 当前指令字符串确认：0=`RESUMABILITY_UNKNOWN`，1=`RESUMABILITY_OK`，2=`RESUMABILITY_NOT_OK`。 |

普通下载中的上述断开→等待→重排链没有每 socket 或 engine 的重试次数扣减，也没有发现“成功收到字节重置次数”的逻辑。不能把启动的 3 次预算套在这条链上；也不能脱离可续传性、任务停止条件和可分配工作，把结论写成所有错误都无限重试。

## 关闭、分配与其它 worker

HTTP 虚表地址点 `0x1000c92d8`，`+0x88` 槽 `0x1000c9360` 指向 `0x10003bd14`。该函数先清理当前 socket，再判断启动状态或 manager 是否仍有可分配工作：没有则进入 socket state 7；立即重排参数为 0 时进入 state 0；等待参数为 1 时先停留 state 7，交给上述 timer。

清理函数 `0x100054554` 关闭当前 fd/TLS、清空当前收发缓冲，并以 `0x100064214(segment,0)` 解除该 worker 对分段的占用。后者根据完成量保留未完成段的可分配状态；不是把其它健康 worker 全部取消或把所有已有字节清零。特殊零字节段还有分段删除分支，因此不能承诺原版 segment ID 永远不变。

## 时间的准确含义

- HTTP 虚表 `+0x30` 槽 `0x1000c9308` 指向 `0x1000060ac`，返回计时 elapsed **大于 26000 ms**。
- `0x100005fc4` / `0x100006014` 在 send/recv 调用后重置 socket `+0x10` 的时间；不是只在成功收到有效下载字节后重置。设置连接状态 1/2 也会启动计时，关闭会清计时。
- 时间 helper `0x100075a7c` 使用 `std::chrono::system_clock::now()` 换算后的差值，并非本报告证明的单调时钟。
- 主下载循环 `0x1000286fc` 以 5000 ms 门槛扫描 socket 等待与超时。因此 4500 和 26000 是检查门槛，**不是精确 4.5 秒重连 / 26 秒报超时的实际时延保证**。OS 调度、循环阶段和其它处理还会影响实际请求时间。

## 当前 NDM patch 的对应与边界

`native/Sources/NDMEngine/DownloadEngine.swift` 的 `downloadSegmentWithRetries` 新增普通 byte-range 传输恢复：网络断开、connect/DNS/离线错误等待 4.5 秒；URLSession timeout 不额外等待；失败 worker 从最新 lease 与实际已写前缀重新构造 Range，健康 worker 继续运行。该循环没有套用 3 次 transport 上限。

这对应普通可续传 worker 的局部恢复原则，**不是二进制代码移植**：NDM 使用 URLSession、取消 token、共享 lease 和自己的安全存储。固定 4.5 秒 async 等待也不复刻 Neat 的 5 秒扫描相位。NDM 的 URLSession timeout 设置不等同于原版上述 26 秒计时器。

当前 patch 没有给初始探测/未知长度单流加同样的重试；HTTP 429/503 仍走已有独立、有界的 admission 策略；证书、认证、文件版本变化、416、文件 I/O 和主动取消不归入网络重试。原版 TLS/代理所有错误类别、实际 CDN 行为及长期离线运行仍需独立验证，不能从此静态分支推断。
