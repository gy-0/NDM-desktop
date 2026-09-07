# Relay 连接中断时保留下载意图

Relay 1.4.8 修复 worker 发送时的连接状态竞态。旧代码只检查缓存的连接标志；WebSocket 已经关闭而 close 回调尚未处理时，发送可能静默丢弃。旧 socket 的迟到事件也可能覆盖替换后的新连接状态。

发送前现在检查当前 socket 的 OPEN 状态，关闭或同步发送失败则保留原请求并重连。旧 socket 的 open/close/error/message 均以当前 socket 身份过滤。重连仍先发送版本握手，再提交队列；测试验证本次请求仅提交一次。

兼容旧桥接的 `waiting` 分支会通过 HEAD 补充元数据。此预检过去遇到非成功响应、网络异常或等待期间断线会丢掉请求；现在最多等待 5 秒，失败仍转交原信息给 Host，发送时重新检查连接。当前 NDM Host 不发送 `waiting`，因此该 HEAD 分支是兼容修复，不能称为当前所有下载的前置步骤。

108 项 Relay 检查、20 项隔离 Chrome fixture 全部通过。新增 VM 六项覆盖旧事件、关闭/抛错、HEAD 跨连接、失败及不响应 abort 的超时；新增真实 Chrome 三项在旧代码均失败、新代码均通过。浏览器使用独立临时环境及模拟网络，不读用户 profile。日志 `/tmp/ndm-relay-recovery-check.log`、`/tmp/ndm-relay-recovery-browser.log`。

这些改变不新增 Host 的逐请求 ACK，也不将 WebSocket.send 成功等同于任务创建或下载完成。popup 的回执仍是扩展内转交阶段。队列仍沿用既有有界内存机制；worker 被系统彻底终止时的持久恢复不在本次保证内。用户已安装的 unpacked 扩展仍需单独验证重载，随 App 打包不是浏览器实际运行版本证明。

## 真实原生交接

`scripts/qa-relay-worker-handoff.mjs` 执行完整 worker，Chrome API 为 stub，但 WebSocket、独立 Host 和本地 HTTP 服务器均真实运行。先关闭连接并延迟其状态回调，再请求下载固定 65,536 B 文件。旧代码未完成交接；新代码建立第二个连接，仅提交一次并创建唯一完成任务，文件 SHA-256 与服务器原始字节一致。测试不操作用户浏览器、任务或默认端口。

正式签名包复验通过，Host SHA `9a23bbe1bfcc247118aa442fd0df26080fe6ce11737de34657419fbf905a9f40`，worker SHA `ecf6024bea7889506bc0c8b6e2432949d420abf0c056b4d62ba27607cc399ff9`。输出 SHA `4b640d85ab3ba30fd02c9fc9db4a8928f416322ad27022ea58a65aaee68a4df2` 与源一致。worker 引入的三个策略脚本也与包内逐字节核对一致。自身输出和任务库清理完成。日志 `/tmp/ndm-relay-recovery-packaged-handoff.log`。
