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

## 启动阶段专项核查

同一匹配 ARM64 样本，继续核对 `0x100024ffc`、`0x10003a468`、`0x100024d08`、`0x100028b54` 附近、`0x100054344`、`0x100024c88` 与 timer 指令。新增临时记录 `/tmp/neat-startup-status-branches.txt`、`/tmp/neat-startup-current-control.txt`。

**“初始值 3”不是任意启动错误统一重试 3 次。** 必须先看错误是否进入预算分支、预算是否已被明确清零、以及 resumability 是否允许继续。

| 启动失败位置 | 确定的行为 |
| --- | --- |
| 首轮预解析 origin / proxy DNS | `0x1000286fc` 创建 socket 后、进入轮询前调用 `0x100024aa8` / `0x100024bec`。失败直接 `0x100025760`，不是 `0x100024ffc`，因此不走 3 次预算。当前指令调用点 `0x100028b84` / `0x100028bbc` 可核对。 |
| worker 的 connect / DNS 失败 | `0x1000265dc` 调 `0x100024ffc(...,0)`；仍 starting、预算非零且未标不可续传时减 1，关闭并重新排队。重定向后 DNS 失败 `0x100033844` 也进入此入口。 |
| 无响应 / timeout | 进入统一错误入口后，starting 分支使用同一预算，不区分最后参数 0/1。原版超时检查本身约 26 秒门槛，不能把重试数乘固定秒数当精确总耗时。 |
| TLS 初始化、握手错误 | `0x100034f1c` 的 SSL Initialization Error/Failed、`0x100052e00` 的 SSL HandShake Error 进入 `0x100024ffc(...,0)`，可消耗 starting 预算。此事实不意味着应在 NDM 中忽略或绕过证书校验；原版 SecureTransport 内部错误类别未完整映射到 URLSession。 |
| 普通 HTTP 500、403 | response dispatcher `0x100039fb8` 的通用失败分支 `0x10003a468` 先调 `0x100024d08`；后者指令是 `strb wzr,[engine,+0x698]`。因此在随后进入错误入口前预算已清零，不执行普通 3 次重试。403 等 400–410 另可能走旧页面/LinkRescue 分支，取决于其它条件；不是“403 必然四次请求”。 |
| 401 / 407、416、redirect | dispatcher 有独立分支，不能由通用 500/403 分支或 transport 预算推导其最终尝试次数。416 的空文件/资源变化分支可直接全局 error。 |

预算从 3 开始，适用的失败每次先判断非零再减一；若每次都停留该分支，含初次尝试在内最多 **4 次尝试**。错误日志在递减前输出 `RemainedRetryCount=` 和 `and Engine is going to try again.`，所以日志上的数字是当时剩余预算，不是已经发生的次数。耗尽调用 `0x100025760` 保存错误文本、清零预算、设置 engine state 4；主循环离开状态小于 3 的运行阶段，后续统一结束处理。

### 启动重试时延与成功边界

预算重试调用 HTTP `+0x88(self,1,0)`：这是立即排队参数，不调用 `0x1000532d0` 的 4500 ms 延迟路径。`socket_set_state(0)` 还调用 `0x100024c88` 把 engine 扫描 timer `+0x590` 清零；`0x100075a2c` 随后的比较会允许下一轮扫描，不需要固定再等完整 5 秒。实际仍受事件循环、DNS/connect/TLS、OS 调度影响，不能宣称零毫秒重发或任意指数退避。

普通 HTTP 首 socket 的成功响应经 response dispatcher / `0x100032da0` 更新 HTTP 接收状态与可续传性；真正的 engine starting→downloading 在数据写出准备函数 **`0x100054344`**：打开/准备对应 segment 输出后，确认 engine 仍 starting，调用 `0x100022bb0(engine,2)`，随后刷新缓冲数据，并按是否还有可分配工作启动更多 socket。因此不能把“TCP 已连接”“TLS 已成功”“收到任何 HTTP 响应”当作已经转入 downloading，也不能直接把原版这条首 socket 流程视作 NDM 当前独立 HEAD probe。

### 下一步对齐测试应分层

1. 初始连接被拒绝或在成功响应前断开：验证允许的有限重试、耗尽后明确错误，不采用下载阶段无限重试策略。
2. 已进入可续传下载后中途断开：验证局部重试无 startup 次数上限、保存前缀、其它 worker 不取消（已有本轮 transport 修复方向）。
3. HTTP 500/403：作为“不因 transport 重试而重复请求”的负例；认证/资源变化仍走独立处理。
4. 无响应与临时 TLS 网络故障：分别验证取消可及时退出和错误类别，不把证书失败降级成网络重试。

上述是静态控制流证据和测试建议，未运行原版启动故障的完整联网夹具。尤其首次 DNS 直接失败与 worker 内 DNS 预算路径必须通过隔离运行进一步验证，不能先把两者合并成单一产品策略。

### 明确的红灯场景：响应头完整、首个 body 字节到达前断线

`0x10003b02c` 在完成响应头解析后计算缓冲区剩余 body 字节数；为 0 时仅清缓冲并返回，不调用虚表 `+0x98` 的写出路径，所以不会由 `0x100054344` 转 engine state 2。正常 200/206 响应也不会走通用错误状态的预算清零分支。因此**响应头有效，但首个 body 字节尚未到达即断开**，在可续传性未被标为 NOT_OK 的情况下仍适用 starting 的初次尝试加最多 3 次立即重排。

NDM 可为 GET/HEAD 的完整启动 probe 添加有限的临时传输重试来覆盖该故障；这是对首响应失败的安全适配，不是声称 Neat 也执行相同的 HEAD→Range 0–0 probe 封装。应保持认证循环独立、HTTP 状态不由传输规则重试、POST 不自动重放、证书/TLS 错误不笼统重试、首轮 DNS 失败不混同 worker 内 DNS 的预算路径。若已经有 body 被处理或可续传性已改变，则需要按实际 engine 状态另判断，不能只看“收到过 headers”。
