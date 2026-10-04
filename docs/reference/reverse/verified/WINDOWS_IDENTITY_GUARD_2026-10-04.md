# Windows 同长度换内容：第一阶段修复与剩余边界

原版 Windows `0x004d8730` 证据证明续传长度/偏移比较，但不证明同长度内容身份保证。本产品增加自己的强版本保护，不照搬仅大小比较。

## 实现

- 使用 GET bytes=0-0 检查强 ETag、总长及最终资源 URL，拒绝弱/非法/重复 validator、异常范围和内容编码。保存 URL 哈希，避免将签名 URL 新增到身份记录。
- 实际 Electron 网络层使用与 aria2 配置一致的直接或代理路径，隔离非持久化网络会话，跨来源重定向只保留无凭据的明确白名单头，禁止 HTTPS 降级。会话按代理配置复用，不为每个文件永久创建新分区。
- 首字节写入前将身份持久化。写盘失败回滚内存身份，重试不能跳过持久化。恢复时校验旧身份；没有可靠身份的旧任务不能盲目续传。
- aria2 实际请求使用 If-Range、If-Match、identity 编码及 always-resume，覆盖重启恢复和原进程 unpause。缺少身份的普通单来源任务限制为单连接、单次尝试；调整连接数也不突破这个限制。

## 当前证据

- `node scripts/qa-windows-resume-identity-audit.mjs --expect-identity`：真实本机 aria2，重启后原文件续传 8 MiB SHA 正确；同大小换版本被拒绝；预检查后才换版本，由真实请求条件阻止完成。拒绝/失败后原文件字节一致。
- 增加 `--same-session`：同进程暂停/恢复的上述三种情况也通过。比较前等待底层 aria2 状态变成 paused。
- `node scripts/qa-windows-http-probe.mjs`：真实 Electron 网络请求验证跨来源剥离 Authorization、显式 HTTP 代理生效，以及响应身份解析。
- 736 项 JS 测试通过、8 跳过；typecheck/build 通过。测试包含元数据持久化失败后的重试。

## 不能外推的边界

- 这是 Windows 编排代码与 macOS 上 aria2/Electron 的隔离运行证据，未执行 Windows 真机。
- 此阶段依赖来源遵守 If-Range/If-Match。aria2 RPC 不暴露每个分段的响应 ETag；返回不匹配 ETag 却仍违规返回 206 的来源仍需要额外的逐响应验证。不能据此称 HTTP 完整性问题全部解决。
- 多镜像是否返回相同内容、跨 URL 的 ETag 作用域仍需单独方案与故障测试；本次不宣称镜像字节身份已保证。
- 没有强标识的旧任务需要重新下载。完整无 validator 恢复策略、原版动态调度、HTTPS/代理组合仍属后续工作。
- 同进程实验发现 forcePause 确认是接受请求，并非底层写入已完全停稳；现已等待 tellStatus 确认 paused/complete/error/removed 后再反馈，使用最终字节数；5 秒取消期限避免无限等待。回归覆盖完成/失败与暂停竞态、确认失败不误报暂停。740 项测试、typecheck/build 与不额外等待的同进程 aria2 QA 通过。

## 新补充：不遵守条件请求的 206 已实际复现

`node scripts/qa-windows-resume-identity-audit.mjs --noncompliant` 使用同一隔离 Windows 编排 + macOS aria2。恢复前的一字节探测仍回答旧 ETag，随后服务器更换同长度正文，无视 If-Range/If-Match，返回新 ETag 的 206。最终任务错误地显示 complete：8 MiB 中包含 2 MiB 旧字节和 6 MiB 新字节，既不等于旧文件也不等于新文件。证据为 `core-audit-2026-10-04/windows-noncompliant-206-before.json`。报告 `completed` 只表示观察流程结束，不表示完整性通过。

这将原先列出的限制升级为已复现的未修复问题。仅再次探测或继续添加请求条件都不能代替检查每个实际数据响应；下一步必须在接收实际响应头时验证身份，验证前不得把正文交给 aria2 的文件写入。此项尚未修复，不得把第一阶段保护描述为已覆盖所有同长度内容变更。
