# 核心下载与原版 Neat 对照审计（2026-10-04）

目标：优先保证成品正确、启动及时、暂停/续传可靠，再追求多连接收益。此次使用当前 NDM-desktop 源码和隔离测试；不把本机测试称作 Windows 真机验收，也不把历史 Neat 记录称作本次重新运行了原版 GUI。

## 基线与版本

- 起始提交：`826fe1bcc08fdcacd7d189137f7dda8360f704ee`，工作区已有界面及引擎修改。
- `ca10e49` 保存界面、窗口、品牌字标、草稿等待和对应 QA。
- `1b8184a` 保存已有的响应完整性、暂停/删除、命名/落盘保护修改。这两组不是本次发现问题后临时制造的修复。
- 本轮新增观察脚本、证据、以及 bootstrap 流式下载修复分别提交；不替换正在使用的 App，也不触碰用户下载。
- 实际引擎：macOS 普通 HTTP 是 `native/Sources/NDMEngine/DownloadEngine.swift`（Swift + URLSession）；Windows 普通 HTTP 是 `src/main/windows/windowsEngine.ts`（aria2 RPC）。媒体、BT 等另有路径。不能将 macOS 的所有性能问题归因于 aria2。

## 先处理什么

| 顺序 | 场景与用户影响 | 当前证据 | 状态与下一动作 |
| --- | --- | --- | --- |
| 1 / P0 | Windows 暂停退出后，原 URL 的内容变了但大小相同；续传产出混合文件却显示完成 | 实际 Windows 编排代码 + 本机 aria2：8 MiB 成品含 2 MiB 旧数据、6 MiB 新数据；不等于任何版本。未改变资源的对照组正确 | **已加入强标识续传保护并通过原始复现**。持久化 ETag、有效 URL 哈希和长度，恢复时检查，aria2 实际请求附带 If-Range/If-Match 并禁止续传失败后覆盖重下；原始同长度换内容和检查后换内容均未发布混合成品。详见 WINDOWS_IDENTITY_GUARD_2026-10-04.md；不等于所有 HTTP/镜像边界已关闭 |
| 2 / P1 | 首次请求先等 HEAD；HEAD 慢时界面及真实下载一起等 | HEAD 人为延迟 1.5 s，NDM 首个服务端 body 约 1547 ms；真实 Chrome headless 下载只发 GET，约 34 ms | **已取消普通 GET 的前置 HEAD**。当前直接做一字节 Range GET，慢 HEAD 夹具首次可见进度由 1656 ms 降至 107 ms，成品 SHA 正确。仍未实现原版首个开放 Range 直接承载持续数据的调度；详见 GET_FIRST_STARTUP_2026-10-04.md |
| 3 / P1 | HEAD 不支持且忽略 Range、或 POST 的全文响应先在后台收完，进度长期 0，限速失效 | 同为 1 MiB、64 KiB/s：普通流约 15.10 s；GET fallback 0.379 s、POST 0.369 s；后二者中途没有任何非零进度 | **本轮修复并复验**：统一受限流式接收、从首块起报告进度、直接写入有所有权记录的文件；保留 POST 只提交一次和错误响应不发布的边界。复验数据见 `bootstrap-after.json` |
| 4 / P1 | Windows 接受带 method=POST/body 的 add 请求，却按 GET 下载并报完成 | 独立接口夹具：accepted=true、status=complete、服务器只收到 GET | **已阻止静默降级**：在创建任务和收据前拒绝非 GET 或带正文的请求；实测没有网络请求或任务残留。完整 Windows POST 支持仍未实现。此处验证的是引擎 API，并非声称 Windows 浏览器桥已经支持 POST |
| 5 / P2 | 选择 8 连接，但实际仍单连接 | 无强 validator 时 `acceptRanges` 保护主动禁用分段；同夹具约 4.01 s，等同单连接 | **有意的正确性取舍，不直接算缺陷**。需更清楚显示实际连接与原因；若扩展兼容性，必须先定义能够证明字节身份的安全方案 |
| 6 / P2 | 多连接的启动、爬升和尾段收益 | 强 ETag 的 8 MiB 文件：1 连接 4.03 s、8 连接 0.59 s；原始机器码确认最大未完成段选择及阈值 | 已证实这个场景有收益；仍欠 HTTPS/CDN、代理、高延迟与大文件持续吞吐对照，不能宣称达到原版的总体速度 |
| 7 | 断线、429/503、416、崩溃和发布失败 | 当前原生故障套件、独立进程崩溃恢复与文件校验 | 已有对应保护并通过本轮相应检查；不是零缺陷保证，也不能据此继承原版所有边界行为 |
| 8 | 认证、跨来源重定向、链接刷新与浏览器接管 | 原生认证/重定向/URLRenewal 测试；旧协议字段 3 的纠错记录 | 原生核心边界已有覆盖；真实浏览器全链路和 Windows 功能对齐仍需独立场景，不在这轮伪造验收 |

P0 代表发布阻断级数据正确性问题，并不是已证实原版 Neat 对同一场景一定安全。原版头解析中能看到总长度/偏移变化检查，但未证明其同长度换内容场景具备强 validator 保护。我们应达到自己的正确性标准，不照抄原版可能的弱点。

## 可复现的测量

- `node scripts/qa-windows-resume-identity-audit.mjs`：未变化控制组 + 同长度换版本；临时目录、独立 aria2、loopback，保留合成文件用于复查。
- `node scripts/qa-windows-resume-identity-audit.mjs --post-only`：引擎 API 方法保持情况。
- `node scripts/qa-bootstrap-controls-audit.mjs --expect-streaming`：当前 release Host；普通流、忽略 Range 全文、POST；请求数、进度样本、时长、SHA。
- `node scripts/qa-startup-throughput-audit.mjs`：当前 release Host 对照真实 Chrome headless 下载；强标识单/多连接、无 validator、慢 HEAD。每请求 64 KiB/30 ms，为有意构造的每连接吞吐限制，不是公网速度排名。
- `node scripts/qa-offset-storage-crash.mjs`：独立测试进程强制中断后恢复，4 MiB 最终 SHA 一致，分配空间 4,202,496 B。脚本旧输出的 “not yet integrated” 是历史说明；此实验仅证明存储后端，不冒充完整 App 崩溃恢复。

浏览器 benchmark 不继承用户 Chrome profile；不登录站点、不干扰已有下载。所有 HTTP 数据都是随机/固定合成文件，输出按 SHA 校验，时长使用客户端发起到完成；“首个服务端 body”是服务器写出时刻，不能冒充客户端首字节落盘或 UI 出现时刻。NDM 同时记录了 `firstVisibleProgressMS`，两者分别保留。

## reverse 本身是否可靠

当前 `/Applications/NeatDownloadManager.app` 为 1.3/build 24。universal SHA-256 为 `08560144cab189f041389aa2458b0bcff7b8fac937347b7b95d57dcd4ddb4101`；本次新提取 ARM64 为 `25031b78644cc3371ad81dd1e675550ae72e221d88f6c0ae167b434025cdc0c7`，与旧 reverse 切片一致。旧 `manifest.json` 的 universal hash 与此不同，不能照抄旧 manifest；本次逐架构比对确认允许复用 ARM64 地址。

1. 旧 Ghidra 12.1.2 全量导出确有 2147 个 C 文件。重新扫描发现 251 个含跳转表恢复警告、41 个含类型推导不收敛警告、109 个含移除不可达块警告。类别可以重叠，**不是错误率**。`ok=2147` 不是语义正确率，也不是恢复出原工程。
2. 旧 `ENGINE_FUN_MAP.md` 有按体积猜角色的条目；未验证的 “疑核心循环” 不能作为重写依据。应依调用关系、字符串、寄存器传参和运行轨迹确定职责。
3. 已有更强的 2026-09-08 资料：手工修订签名的 Ghidra、独立 Hopper 输出、机器指令核对和原版隔离运行记录。已知旧导出曾丢失返回值到下一次调用的参数关系，必须优先阅读 `verified/`，而不是仅用原始 `ghidra_c/`。
4. 本次在 `/tmp/ndm-reference-audit-20261004/project` 的独立工程副本重跑 Ghidra 12.1.3 + `RefineEngine.java`，32 个目标导出成功。未改原 App、旧 Ghidra 工程或其代码。
5. 本次用 Unicorn 2.1.4 重新执行当前切片的 272 组分段选择输入、1088 条选择断言和 requeue 场景；通过。对象内存是合成输入，网络/清理调用有测试 hook，**这是原始函数机器码验证，不是原版端到端测速**。

本地重分析产物：`/tmp/ndm-reference-audit-20261004/`（新切片、Ghidra 副本、32 个修订伪代码/汇编、radare2 指令、日志）。仓库只收报告和验证结果，不把反编译伪代码混入产品源码。

结论：已有 reverse 有价值，但完整性不足以支持逐字照搬；关键调度点具有较强证据，其余部分需按功能补齐。无需先将整个 App 再反编译一遍才能改进产品。下一步最有价值的是原版首次请求到首块写盘的控制流、动态加连接的实际时机，以及相同 HTTPS 故障场景的双方运行轨迹。

## 验证记录

- 保存原有修改前：JavaScript 732 项通过、8 项跳过；typecheck、前端 build、完整原生测试命令通过。
- `3a76354` 提交流式修复。隔离 release Host 实测三种路径全部通过限速、非零中途进度、单次请求和最终 SHA 断言；详见 `core-audit-2026-10-04/bootstrap-after.json`。
- 流式修复后：72 项针对性原生测试全部通过，覆盖 bootstrap、暂停与所有权清理、进度配额、分段及 offset 存储、认证、重定向和 HLS；release Host 重新构建成功。
- 观察脚本的 `passed` 只代表该脚本的断言通过，不代表产品没有缺陷；Windows 观察报告保留了已复现的问题。bootstrap 的 `--expect-streaming` 额外断言中途进度及限速，不能省略后声称修复已验收。

## 本轮边界

- 普通 GET 的 HEAD 启动等待已移除；一字节探测与有效数据请求仍分开，不能宣称已实现原版首流调度。
- 没有替换 aria2、没有将原版专有伪代码直接复制进产品、没有宣称三平台已有同一套保障。
- Windows 不遵守条件请求的来源及多镜像边界、完整 Windows POST 支持和首次 Range 响应持续承载数据仍是明确未关闭项，不能因构建和其他测试通过就将其标为完成。
- 不以最大连接数或一次局域网速度证明总体更快。引擎选型应先统一正确性/恢复契约，再比较实际站点性能；目前没有证据支持“换掉 aria2 就能解决 Mac 上的慢”。
