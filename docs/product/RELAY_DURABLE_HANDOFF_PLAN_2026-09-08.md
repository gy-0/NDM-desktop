# Relay 跨 worker 重启交接方案

日期：2026-09-08。状态：**原生确认与去重、独立会话队列模块已实现并测试；worker 接入和端到端验收待完成**。详见 [原生实现与证据](RELAY_DURABLE_HANDOFF_NATIVE_2026-09-08.md)。下文保留方案与完整验收要求。当前已经验证的 socket 断线重连不能证明 service worker 被销毁后仍能保留请求。本方案不代表现有产品具有持久 ACK、请求幂等或浏览器重启恢复能力。

## 修复前的源码依据

以下为实现前的审计快照；部分缺口已由开头链接中的原生实现补齐。函数名称是主要定位依据。

| 文件 / 位置 | 当前行为与缺口 |
| --- | --- |
| `extension/NDMRelay/bg.js:237`，`V` 构造器 | `pendingRelayQueue` 是内存数组，worker 重建后为空。 |
| `extension/NDMRelay/bg.js:434`，`admitRelay`、`I` | `relayReservations` 是内存 Set；容量限制防止接收后被挤出，但不能跨 worker 生命周期恢复。`I.send` 在 WebSocket `send()` 返回后释放 reservation，尚无 Host ACK。 |
| `extension/NDMRelay/bg.js:579`，`fa` | 连接建立后清空内存待发送队列并重放请求。 |
| `extension/NDMRelay/bg.js:608`，`ea` | `NDMRelayStatus` 处理版本和协议状态，不是任务级接收凭证。 |
| `extension/NDMRelay/bg.js:652`，`relayWithCookies` | 捕获请求可能携带 Cookie、其他请求头和 POST 数据；不能原样转存普通磁盘配置。 |
| `native/Sources/NDMBridge/BrowserBridge.swift:248`，`receiveFrames` | Hello 返回版本状态；解析下载消息后调用 `onDownloadMessage`，没有针对该请求和连接的提交 ACK。 |
| `native/Sources/NDMHost/main.swift:310`，`bridge.onDownloadMessage` | 普通文件经 `manager.addFromBridge` 入库后启动；媒体页面仅广播 `openMediaComposer`，没有持久的待处理页面意图。 |
| `native/Sources/NDMEngine/DownloadManager.swift:554`，`addFromBridge` | Link Rescue 按业务条件复用失败任务；不是请求重放的幂等键机制。 |
| `native/Sources/NDMCore/Storage/DownloadStore.swift` | SQLite 任务存储可作为任务与 receipt 同事务提交的落点；当前尚无本方案的 receipt 表和 API。 |

## 建议的最小范围

第一批只实现普通文件的“跨 worker 重启会话 outbox + Host 持久 ACK/去重”。使用 `chrome.storage.session` 保留尚未完成交接的请求，不把完整请求写入 `storage.local` 或 `storage.sync`。即使移除 Cookie，URL 也可能包含签名令牌，因此不能把 URL 自动视为无敏感信息。

Chrome 官方说明：session 存储位于内存、默认不暴露给 content scripts，适合 service worker 使用；但浏览器重启、扩展禁用/重载/更新会清空它。因此本阶段保证边界是同一次浏览器/扩展会话内的 worker 重建，不是磁盘持久化，也不是浏览器崩溃或重启前尚未交接请求的恢复承诺。初始化应等待存储恢复后再处理新请求，防止恢复结果覆盖新接收请求。[官方 storage 文档](https://developer.chrome.com/docs/extensions/reference/api/storage)；[官方 service worker 生命周期文档](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)。

不得通过把队列挂在全局变量、延长定时器、持续保活 WebSocket 来宣称解决持久性。session API 不存在或写入失败时，要明确降级/拒绝语义，不应静默改写到磁盘存储。

## 三种状态必须分开

1. **扩展已接收**：每个明确用户操作生成独立随机 `requestId`；等待 session outbox 写入成功后才返回 `accepted`。仅放入内存 Set 不算接收完成。限制队列条数与总字节，写入/删除串行化；凭证仅存在受限会话存储，设置合理到期策略。具体上限、TTL 在实现时确定并测试，过期需可见反馈，不能静默丢弃后仍显示成功。
2. **Host 已持久接收**：新 Hello/Status 协商类似 `durableHandoff:1` 能力，下载消息带 `requestId`。`BrowserBridge` 为该连接提供 reply closure；Host 在任务及 receipt 同事务成功提交后返回 `{requestId,status:"accepted",taskId}`。收到 frame、成功解析、广播 UI 或启动网络请求都不是该 ACK 的条件。已持久化但等待用户选择目的地的任务可以 ACK；ACK 不代表下载已经完成。
3. **下载完成**：仍由任务生命周期报告。不能把 outbox 成功删除或 ACK 文案描述为“已下载”。

扩展收到匹配 ACK 后才删除 outbox。ACK 超时、连接断开或 worker 重建时，仍以同一个 requestId 重发；删除 outbox 失败也可以重放而不重复创建任务。ACK 应只包含必要标识及有限状态，不包含原始 URL、headers、Cookie 或 POST 内容。

## 原子 receipt 与重复请求

在 `DownloadStore` 增加独立 receipt 表，以 `requestId` 建唯一约束，关联提交后的 taskId；将普通任务创建或明确的 Link Rescue 变更与 receipt 插入置于同一 SQLite 事务。必须设计存储 API，使 `DownloadManager.addFromBridge` 不在事务外分开提交关键修改。

- 先写 receipt 再建任务：崩溃可能出现“已接收”但没有任务。
- 先提交任务再写 receipt：崩溃后重放可能重复建任务。
- 同一 requestId 重发：查到 receipt 后返回相同结果，不再次入库或重复触发开始/聚焦副作用。
- 同 URL 的新用户操作：生成新 requestId，不能仅用 URL 去重吞掉用户明确操作。

receipt 的保留/清理必须覆盖可重放期限。删除任务后不能简单丢掉 receipt，否则迟到的重试会重建任务；需保留终态或明确拒绝重放。该策略、ID 格式长度校验、并发同 ID 行为均为实现待办。

旧 Host 没有该能力时只能保留当前尽力交接语义；不能因收不到不存在的 ACK 就持续自动重发并产生重复任务。协议能力应显式协商，不能凭版本字符串猜测。

## 普通文件与媒体页面边界

普通文件已有持久任务实体，适合第一批实现原子 receipt。媒体页面目前只在 Host 广播 `openMediaComposer`，若 Electron 未连接或接收后退出，页面意图依然会丢失。不能对此发送“任务已持久接收”的 ACK。

媒体页面的后续可靠方案需要独立的持久待处理意图及 Composer 消费/完成协议，明确用户取消、重复打开和 Host/Electron 重启的结果；不是把页面 URL 当普通文件自动下载。该功能不纳入第一批普通文件 ACK 保证。若第一批仍接受媒体页，要保留明确的旧语义并避免误报。

## 实施涉及文件

- `extension/NDMRelay/bg.js`：session outbox 初始化、串行 admission、稳定 requestId、ACK 匹配与重发、容量/过期处理。
- `native/Sources/NDMCore/Bridge/BridgeProtocol.swift`：协议字段和严格解析边界。
- `native/Sources/NDMBridge/BrowserBridge.swift`：能力协商、连接限定回执发送。
- `native/Sources/NDMHost/main.swift`：普通文件交接结果返回；媒体页面分支保持明确区别。
- `native/Sources/NDMEngine/DownloadManager.swift`、`native/Sources/NDMCore/Storage/DownloadStore.swift`：原子任务/receipt 提交和幂等重放。
- Relay 合约/浏览器测试、native 存储/桥接测试、`scripts/qa-relay-worker-handoff.mjs`：增加以下故障注入。现有脚本不是这些新增保证的证明。

## 完整验收清单（逐项范围以实施证据为准）

- session 写入前失败：返回未接收，不取消浏览器原下载；明确写入失败与队列满。
- session 写入后销毁 VM，以共享 session 存储重建完整 worker；真实 Host 最终只有一个任务。
- Host 提交后故意丢 ACK，随后重启 Host 和 worker；重复请求仍指向同 taskId。
- Host SQLite 提交失败或提交前杀进程：没有成功 ACK，重试能正常完成。
- 并发重复 requestId 只创建一次；不同 ID 的相同 URL 不误合并。
- ACK 后 session 删除失败：恢复重放不会再次建任务；未知/伪造/超大 ACK 不移除其他请求。
- Host receipt 保留期间任务被删除：迟到重放不能重新下载。
- 初始化恢复与新 admission 并发：不覆盖或丢失任一已接收请求。
- Cookie、Authorization、签名 URL、POST 的 synthetic fixture：只出现于允许的会话状态，不进入日志、sync 或普通磁盘配置。
- 旧 Host、不支持 session 的浏览器、存储配额错误、过期、队列满、媒体页分别测试真实降级语义。
- 扩展更新/浏览器重启清空 session 的边界不被包装成可恢复保证。
- 扩展当前真实 Host 脚本：在隔离支持目录与端口执行重放、ACK 丢失及 SHA 检查；另用隔离 Chrome 验证真实 service worker 停止/唤醒。VM + Chrome API stub 的绿灯不能代替该浏览器生命周期验证。

本方案最初为只读设计；当前实施状态见开头链接。未操作日常浏览器、用户 Cookie 或真实下载任务。
