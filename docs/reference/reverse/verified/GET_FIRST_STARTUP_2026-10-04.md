# 普通 HTTP 下载取消前置 HEAD

普通 GET 现在直接发送 `Range: bytes=0-0`，从实际下载响应取得总长度、有效 URL、validator 与 Range 支持情况。明确指定 HEAD 的请求保持原行为；POST 仍使用真实方法且不重放正文。200 全文响应沿用受限流式接收、进度与所有权记录，避免重新下载一遍。

已有部分文件时，如果探测返回 200 全文，在响应头阶段拒绝，保留原数据，避免先下载整份全文才发现不能安全续传。206 身份变化、重定向、认证、容量不足、暂停、尾段回退及成品 SHA 校验继续保留。

## 原版依据与实现差异

`HRBEU_TRANSPORT_RUNTIME.md` 的原版运行轨迹记录首个 `Range: bytes=0-`，后续连接从各自偏移延伸至文件尾，内部按所有权边界截断。当前修改消除了独立 HEAD 往返，但仍先完成一字节 GET，再发有效数据 Range；尚未实现原版那种首个响应直接持续承载分段数据的调度方式。不能称作完全对齐。

## 隔离 release Host 测量

同一脚本、8 MiB 随机文件、每请求 64 KiB/30 ms 的本地服务器；每个结果校验 SHA。Chrome 使用独立 headless profile。未更换安装版或操作用户下载。

| 场景 | 修改前首次可见进度 | 修改后首次可见进度 | 修改前完成 | 修改后完成 |
| --- | ---: | ---: | ---: | ---: |
| 强 ETag，1 连接 | 161 ms | 166 ms | 4026 ms | 4085 ms |
| 强 ETag，8 连接 | 160 ms | 112 ms | 593 ms | 639 ms |
| 无 validator | 164 ms | 109 ms | 4007 ms | 4038 ms |
| 强 ETag，8 连接，HEAD 延迟 1.5 s | 1656 ms | 107 ms | 2082 ms | 632 ms |

Chrome 对同一慢 HEAD 路径只发一个 GET，本轮服务端首次写 body 36 ms，完成 3994 ms。NDM 服务端首次 body 35 ms **包含一字节探测**，不能拿它冒充客户端有效数据进度；上表使用 Host 报出的非零进度。每连接人为限速导致多连接加速，不能外推公网排名。

证据：`core-audit-2026-10-04/startup-throughput-before.json` 与 `startup-throughput-after.json`。复验命令：`node scripts/qa-startup-throughput-audit.mjs --expect-fixed`；断言没有 HEAD、慢 HEAD 场景有效进度小于 1 秒、输出 SHA 正确、隔离进程与状态清理成功。

## 回归覆盖的调整

原本 HEAD 不计入 Range 请求序号；现在一字节探测计入序号。短响应、429、416 与镜像故障明确移到实际数据请求，防止测试提前失败却没覆盖已写入字节保护。尾段暂停/注入故障的等待条件排除探测；文件完整性、健康连接不重启、部分字节保留等断言未取消。未知长度测试改用真正无 Content-Length 的 GET 全文响应，而非仅省略 HEAD 的长度。

`node scripts/qa-bootstrap-controls-audit.mjs --expect-streaming` 再次通过：CONTROL / 忽略 Range 的 GET / POST 分别 15064 / 15054 / 15118 ms（1 MiB，64 KiB/s），均有中途非零进度、SHA 正确，POST 未重放；记录 `bootstrap-get-first.json`。release Host 构建成功。针对其余受影响故障夹具的 71 项原生测试全部通过；随后完整 `npm run test:native` 通过：NDMEngine XCTest 717 项（28 跳过）、NDMCore XCTest 561 项、NDMBridge XCTest 32 项，全部零失败；另有 Swift Testing 套件通过。
