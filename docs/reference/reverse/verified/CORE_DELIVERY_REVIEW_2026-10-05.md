# 核心下载阶段性交付核对

产品继续采用 Electron 界面和已经维护的 macOS Swift 引擎；Windows 普通
HTTP 下载继续由 aria2 配合我们的任务与响应校验层实现。原版用于解释具体
行为差异和定位瓶颈，没有把原版伪代码或版本特定地址混入产品。

## 已复现问题及验收依据

| 用户影响 | 修复与核对结果 | 证据 |
| --- | --- | --- |
| 同长度资源变化后续传出混合文件 | 保存强标识，检查探测及实际响应；变化发生在探测之后也拒绝混合 | [Windows 身份保护](WINDOWS_IDENTITY_GUARD_2026-10-04.md)、[实际 Windows/NTFS 验证](WINDOWS_NATIVE_PUBLICATION_2026-10-05.md) |
| POST 变成 GET，或恢复时重复提交 | 保留方法、正文和类型；提交前持久化防重放状态；缺少恢复认证时保留旧数据 | [POST 任务路径](WINDOWS_POST_TASK_2026-10-05.md)、Windows 原生 POST 报告 |
| 点击后等待 HEAD，再等第二次响应 | 普通 GET 直接开始；符合条件时首响应直接承载数据，保留身份、落盘和取消边界 | [首响应复用](MACOS_FIRST_RESPONSE_STARTUP_2026-10-05.md) |
| 已收到数据但界面速度仍为零 | 更早发布一次真实正文速率样本 | [启动速度反馈](MACOS_STARTUP_SPEED_FEEDBACK_2026-10-05.md) |
| 尾段不断拆分反而拖慢 | 依据剩余正文耗时与新连接成本决定是否拆分；保留父请求和大尾段收益 | [尾段成本复现与修复](MACOS_TAIL_PAYBACK_2026-10-05.md) |
| 断线后其他连接已完成，仍多等约 4.5 秒 | 空闲恢复机会可以唤醒失败后缀，保留已有字节及健康连接 | [原版机器码、运行对照及修复](MACOS_DISCONNECT_HANDOFF_2026-10-05.md) |
| 镜像内容不同却拼成一个文件，或 Windows 下载完不能交付 | 不同来源使用独立文件代次；修正 Windows fsync 打开模式；NTFS 五组场景通过 | [镜像来源隔离](WINDOWS_UNPINNED_MIRRORS_2026-10-05.md)、[NTFS 交付](WINDOWS_NATIVE_PUBLICATION_2026-10-05.md) |
| 首个 GET 收到 503 后直接失败 | 恢复最多三次服务重试，保留 Retry-After、暂停和 POST 不重发 | [回归复现和全绿 CI](MACOS_STARTUP_SERVICE_RETRY_2026-10-05.md) |
| 完成烟花开始前明显卡顿 | 减少大任务库通过 Electron contextBridge 的重复对象复制，保留烟花 | [3,748 项任务的打包版测量](MACOS_LARGE_LIBRARY_COMPLETION_2026-10-05.md) |

这些条目各有独立提交。关键修复包括 `c420073`、`66004b8`、`b6c9c1f`、
`2405f91`、`b58b610`、`e153ddf`、`50adea8`、`7a36707`、`2c5d185`、
`abb7329`，均已在 main 的历史中并推送。

## 独立运行及安装核对

- [同服务端原版对照](MACOS_ENGINE_COMPARISON_2026-10-05.md)、
  [持续大文件对照](MACOS_SUSTAINED_COMPARISON_2026-10-05.md)、
  [公开 HTTPS 对照](MACOS_PUBLIC_TLS_COMPARISON_2026-10-05.md)均核对最终文件。
  单次公网顺序测量不能证明整体快于原版。
- [活动 Host 崩溃恢复](MACOS_ACTIVE_HOST_CRASH_2026-10-05.md)验证 64 MiB、
  32 连接、已有检查点之后新增写入时的退出恢复；不等于所有掉电边界。
- CI `37245889005` 在 `2c5d185` 上四组检查全部通过；检查
  `git diff 2c5d185..6310dda -- src native extension` 无差异。
- [安装版 2026100504](DEPLOYMENT_2026100504.md)通过打包、签名、启动程序检查
  和实际 Host 恢复测试；3,748 项任务的指定字段更新前后完全一致，旧包保留。
- 原 Windows 安装包 SHA 为 `3474f9a78cf4a443eeba53d136d0d36d860cecdf955c39075f99287fc759c69e`；
  原 macOS 可执行文件 SHA 为 `08560144cab189f041389aa2458b0bcff7b8fac937347b7b95d57dcd4ddb4101`，
  此次重新计算均一致。原安装包保持未跟踪，没有提交二进制。

## 仍未关闭的边界

Mac 锁屏，实际启动和烟花视觉验收仍待解锁；浏览器扩展重载也未确认。
程序化启动和帧时间测试不替代这两项。

HTTPS 回环地址经 SOCKS、HLS 代理仍有明确限制；Windows POST 不支持自动
续传或正文保留的 307/308 自动重放。普通 POST 引擎支持不等于任意网页正文接管。
Windows 安装器/UI、其他文件系统和未选择的重解析点场景没有由五组 NTFS 测试证明。
原 Windows 动态对照使用 CrossOver，不能冒充原版 Windows 真机对照。

更广来源、证书、长期吞吐与公网故障覆盖仍有限。无强标识时维持单流以避免
无法证明身份的分段拼接，不能把“设定连接数”解释为每个站点都能得到同等并发。
上述限制继续保留在[当前审计状态](CORE_AUDIT_STATUS_2026-10-05.md)，不以全绿
测试或一次公网耗时将其抹去。本核对不把整个产品的验收标为完成。
