# 原版 Windows Neat 初步代码对照

输入由用户提供：仓库根目录 `原版NeatDM_setup.exe`，保留原文件且不提交安装包。安装包 SHA-256：`3474f9a78cf4a443eeba53d136d0d36d860cecdf955c39075f99287fc759c69e`。

用 innoextract 1.9 解开 Inno Setup 5.5.7，主程序为 32 位 x86 `NeatDM.exe`。主程序 SHA-256：`60b06db7dfeb6fffb1be82f8ad059d61bdb1b1a3889439b56eaac162e64c0f37`；manifest 标识版本 1.4.24.0。解包不执行 Windows 安装器。

Ghidra 12.1.3 独立工程导入、自动分析和按字符串引用导出完成，产物在 `/tmp/ndm-original-windows-20261004/`。原 Mac 签名修订脚本地址不适用于该二进制，未套用。

| 位置 | 直接证据 | 解释及限制 |
| --- | --- | --- |
| 导入表 | WS2_32 的 socket/connect/send/recv，Secur32 的 TLS 上下文及加解密接口 | 具备自己的网络传输实现路径。仍需调用链确认各函数用途；不能凭导入表声称完全了解引擎 |
| `0x004d69f0`，引用 `0x004d7b8f` | 构建 `Range: bytes=` 请求字段 | HTTP 请求构建候选函数，参数类型尚未全部人工修正 |
| `0x004d8730`，引用 `0x004d8974` | 206 分支解析 Content-Range 的起止和总长；比较保存长度与当前分段偏移；不匹配进入重新下载错误路径 | 与 macOS 原版的长度/偏移保护相符，是具体可对照的代码证据。尚未执行此 Windows 原版的故障夹具 |
| `0x004d8730`，引用 `0x004d8b66` | 200/206 条件下读取 Last-Modified 并存入对象 | 此处只证明读取/保存，不能当作同长度内容身份校验已经成立 |

字符串扫描未发现 ETag/If-Range/If-Match，不足以证明所有路径都没有这些保护。已有伪代码包含类型推导和栈变量恢复瑕疵；下一步需修正请求/响应对象与字符串函数签名，追踪已保存元数据的使用，并用机器指令或原版运行补证。

后续新增强标识与条件请求保护，原始 Windows 混合文件复现已被阻止，见 WINDOWS_IDENTITY_GUARD_2026-10-04.md。更广的响应校验边界仍需继续。不得以“原版也主要检查长度”合理化盲目续传。完整原版 Windows 动态执行、HTTPS、代理、认证及分段并发行为仍未验收。

## 原引擎直接复用：Windows 接收入口

新增可重跑 Ghidra 脚本 `scripts/reverse/reuse/windows/TraceWindowsReuse.java`，
以 readOnly/noanalysis 打开此前分析工程。引用报告保存在
`core-audit-2026-10-04/windows-reuse-string-xrefs.txt`；反编译全文保留在临时目录。

- `004e25c0` 创建 NeatWebSocketListener，设置端口 `0x2717`（10007）及
  `127.0.0.1`，有实际 bind/listen 调用链，超出仅字符串匹配的证据。
- `004e1400`/`004e0eb0` 处理 `neatextension.v1` 握手；接收路径为
  `004e0c20 -> 004e1990 -> 004e1c80`。
- `004e1c80` 分配并复制请求正文，将指针作为 WPARAM、长度作为 LPARAM，
  通过 `PostMessageW(hwnd, 0x40e, pointer, length)` 交给主窗口线程。
  指令扫描确认 `004e1f5c PUSH 0x40e`，不是由字符串猜测消息号。

这个消息携带进程内指针，不能直接从外部进程发送自己的地址。
需要进程内适配器或继续使用已存在的 WebSocket 接收层，并验证请求所有权、
主窗口消息处理、任务 ID 与暂停/恢复控制。Mac Objective-C 入口不适用于该 x86 EXE。
当前还没有可宣称完整引擎 API 的证据。

环境核查：`prlctl list -a` 将 Windows 11 与 Deepin 都列为 invalid，PATH 中
未发现 wine/wine64/qemu-system-x86_64/VBoxManage。未启动或修改无效虚拟机。
这阻碍当前 Windows 动态验证，但不妨碍继续静态追踪，也不影响 Mac 适配研究。

## Windows 暂停/恢复及状态通知的静态控制链

继续运行扩展后的 `TraceWindowsReuse.java`，已从字符串候选追到虚函数表及
机器指令。证据：`windows-original-control-xrefs.txt` 和
`windows-original-pause-control.asm.txt`（均在 core-audit-2026-10-04 下）。

- `NeatDownloadWindow::vftable` 位于 `00566240`，槽 `+0x80`（`005662c0`）
  指向 `004fbb50`。该函数先检查两个交互对象指针，再检查 `this+0x468` 引擎指针。
  引擎存在时禁用按钮、把文案设为 Resume，并调用引擎 vtable `+4`。
- `NeatDownloadEngine::vftable` 位于 `00561180`，`+4` 指向 `0040bef0`，
  后者转调 `+0x10` 的 `004c1290`，最终调用 `004be960(engine,3)`。
  `004be960` 写入 `engine+0x4e0` 状态字段。`004bed30` 的状态文字映射为
  1 Starting、2 Downloading、3 Paused、4 Error、5 Merging、6 Completed。
  这证明停止请求通过状态机传递，不能把函数返回或状态变成 3 当作磁盘已停稳。
- 引擎不存在时，`004fbb50` 调用窗口 vtable `+0x94`（`005662d4`）的
  `004f8c10`；后者分配 `0x5b8` 字节对象、调用构造路径 `004bce80`，
  保存到 `this+0x468`，应用请求/代理参数，然后 CreateThread 启动引擎。
- `004c2e90` 将通知字符串复制到堆对象，通过 `PostMessageW` 的 `0x40c`
  或 `0x40d` 发给保存的窗口句柄。它与此前收单消息 `0x40e` 一样携带
  进程内指针，必须进一步核对接收者与释放责任，不能当作跨进程公共接口。

这建立了 Windows 专用控制候选链，仍未动态验证对象生命周期、参数 ABI、
暂停写入停稳和恢复 SHA。也没有把这些版本特定地址写入正式产品。
当前本机无可用 Windows 虚拟机，限制维持；Mac 的成功实验不能替代 Windows 验收。

## Windows 接收者、缓冲区所有权与收单节流

再次只读运行 `TraceWindowsReuse.java`，新增 EXE SHA-256 校验，避免把本版本
地址用于其他程序。脚本正常完成，导出 36 个候选函数。新增证据为
`core-audit-2026-10-04/windows-original-receiver-xrefs.txt` 和
`core-audit-2026-10-04/windows-original-receiver.asm.txt`。

- 窗口过程在 `004e38d3` 减去 `0x40d`，索引 `004e3ac8` 跳转表。
  `0x40e` 对应 `004e398c`，调用对象虚表 `+0x6c`。
  NeatMainWindow 虚表 `00567108` 的该槽指向 `00509d70`，由此接上浏览器收单链。
- `00509d70` 先通过 `00402bc0` 复制传入的指针/长度，再在 `00509de5`
  调用 `0051e914` 释放原缓冲区。外部进程不能把自己的指针交给这条路径。
- 时间戳除以 10000 后，与全局上次接受时间作差；机器指令 `00509e1a`
  比较 `0x1f4`（500），小于该值跳过接收处理。通过门槛才更新上次时间。
  这为适配层串行提交、确认任务入库提供直接依据；尚未用 Windows 动态实验
  验证边界时序，不能仅凭 WebSocket 发送成功宣称任务创建成功。
- 同一处理函数解析 `__0NeatPostData9__` 标记；这里只确认解析路径，
  不代替实际 POST 请求正文、分段重放和最终哈希验证。

环境补充：虽然 PATH 中没有 Wine，发现 CrossOver 26.2.0 的内置 `bin/wine`
可运行。其 `CXBottle.pm` 明确支持 private scope 的绝对容器路径，以及
`CX_BOTTLE_PATH`。这提供隔离动态测试的候选环境；当前尚未创建容器或运行原版
EXE，也不能把兼容层测试视为真实 Windows 验收。

## CrossOver 原版 EXE 启动与桥接实测

后续运行 `scripts/reverse/reuse/windows/smoke.py`，独立创建 private
win10_64 容器，并实际运行上述 x86 原版 EXE 的私有副本。只修改
`004e269c` 的端口立即数（文件偏移 `0xe1a9c` 的 `mov eax,10007`），
改到当次独立 loopback 端口。源 EXE SHA 固定校验，源文件未变。

最终重跑报告 `core-audit-2026-10-04/windows-original-crossover-smoke.json`
记录原版返回 HTTP 101、`neatextension.v1`，并通过随机请求 key 对应的
WebSocket accept 摘要校验。清理对该绝对路径容器执行 wineserver stop/wait，
两步退出码均为 0；没有停止其他容器或现有下载进程。

测试子进程被限制为 loopback IP 通信、不能写真实 home，容器里的真实 home
目录链接也改为私有目录（未操作其目标）。容器和报告留在打印出的临时目录。
两次启动/握手实验通过，第二次增加并验证了 stop 后的 wait。

这消除了“本机无法执行该 Windows EXE”的研究限制；仍是 CrossOver 兼容层
证据。没有提交下载任务，尚未验证实际传输、暂停/续传、POST、身份变更或
后台无窗口控制，也没有把正式产品改用原版引擎。

## Windows 原版实际传输与暂停/恢复（2026-10-05）

在独立 CrossOver 容器继续运行原版，没有替换下载函数。新增
`--transfer`、`--inspect-ui`、`--pause-resume` 夹具选项和 Win32 控件辅助程序。
基础 8 MiB 随机文件两次正确下载，第一次报告保存在
`core-audit-2026-10-04/windows-original-crossover-transfer.json`。
实际请求从 GET `bytes=0-` 开始，扩展到 8 个分段请求，无前置 HEAD。
这只是该普通 HTTP 夹具的路径，不能推广为所有协议/恢复场景都无 HEAD。

最终重跑命令：

```sh
python3 scripts/reverse/reuse/windows/smoke.py /tmp/ndm-original-windows-20261004/app/NeatDM.exe --transfer --pause-resume --inspect-ui
```

最终报告为 `core-audit-2026-10-04/windows-original-crossover-pause-resume.json`，
原版控件清单为 `windows-original-controls.txt`：

- 32 MiB 限速随机源。原版进程的 `NeatDownloadWindow` 中控件 1020 是任务 URL，
  1051 是 Pause/Resume 按钮。辅助程序只匹配原进程、完整测试 URL、唯一窗口，
  检查按钮文字和启用状态后发送 BM_CLICK。没有调用猜测的 C++ ABI。
- 暂停命令成功后，8 个 `seg.xN` 和 `segments.bin` 的 SHA 连续一秒不变。
  只读数据库记录任务 1 为 `Paused ( 28% )`；没有把点击成功当作写入已停稳。
- 恢复后的 8 个 GET 均从非零偏移继续，首个为 `1196032-33554431`。
  最终数据库同一任务为 `Complete`，33,554,432 字节文件 SHA 与随机源一致。
- 源 EXE 未变；独立容器 stop/wait 都返回 0。正式产品、安装版和现有下载未参与。

这证明了兼容层中的普通 HTTP 下载及同进程暂停/恢复闭环，仍不是原生 Windows
验收。进程重启续传、同长度资源变更、POST、认证/代理/TLS、无窗口适配及正式产品
接入仍待验证；原版自身的完成状态也必须配合文件哈希验证。

## 同长度资源变更：原版 Windows 也会产生混合文件

2026-10-05 在上述真实 EXE 的独立 CrossOver 容器中执行
`--transfer --pause-resume --identity-change`。先确认暂停分段稳定，再把每个源
字节 XOR 255、ETag 从 v1 改为 v2，长度保持 33,554,432 字节。
每条响应固定使用一个 body/ETag 版本，避免测试服务器在响应中途换内容。
服务器支持 If-Match/If-Range，但原版恢复请求未发送二者。

失败证据 `core-audit-2026-10-04/windows-original-identity-mixed.json`：
原版数据库任务 1 为 `Complete`，实际文件含 5,505,024 个旧版本字节和
28,049,408 个新版本字节，无其他字节。文件 SHA 既不等于旧源，也不等于新源。
夹具退出码为 1，明确保留该失败。由此不能把直接复用原版等同于继承完整的
内容身份保护，也不能仅以原版完成状态判定下载正确。

## 复用适配层的响应保护验证

新增 `--identity-guard`，使用现有研究版 IdentityGuard，检查实际 GET 响应的
强 ETag 后才转发正文，仍由原版负责分段、写盘和任务状态。没有修改原版下载函数。

- 变更对照 `windows-original-identity-guard.json`：首个恢复响应的 v2 与已保存
  v1 冲突，保护层返回 412；原版记录 `Error ( 16% )`，没有最终文件，8 个分段
  及 `segments.bin` 与暂停时哈希一致。脚本成功退出。
- 未变更对照 `windows-original-identity-guard-normal.json`：无拦截，恢复请求从
  非零偏移继续，原版 `Complete`，32 MiB 文件 SHA 与源一致。脚本成功退出。
- 三次运行均校验源 EXE 未变，停止并等待独立容器；9 个现有辅助单元测试通过。

这些是兼容层下的 HTTP 研究验证。固定 origin 的 Python guard 还不是正式产品
网络层，没有修复当前 aria2 后端的全部响应校验问题；未覆盖 Windows HTTPS、
POST、重定向、Cookie 变体或进程重启。正式引擎接入仍未完成。

## Windows POST 方法、正文与类型的动态验证

2026-10-05 运行 `--transfer --pause-resume --post-audit`。按 Relay 的实际线格式
发送 `1:POST`、显式 Content-Type 和 `__0NeatPostData9__:` 后的 48 字节正文。
本地测试端点只允许可重复读取的导出请求，收到错误方法、正文或 Content-Type
会返回 400，避免把“下载了一个错误页面”当作成功。

最终报告 `core-audit-2026-10-04/windows-original-post-resume.json` 记录：

- 初始 8 个分段请求与恢复后的 8 个请求全部为 POST，正文长度和 SHA 都正确，
  Content-Type 均保留为 `application/x-www-form-urlencoded; charset=UTF-8`。
- 暂停后分段哈希稳定，数据库同一任务的 method 始终为 POST，最终为 Complete。
  恢复请求均从非零偏移开始，32 MiB 文件 SHA 与源一致。
- 未先发 HEAD；源 EXE 未变，隔离容器 stop/wait 成功。9 个辅助单元测试通过。

这验证了原版的 POST 能力，也证实它会为分段和恢复重复发送 POST。不能把该
行为直接用于任意有副作用的接口。二进制正文、重定向、进程重启后的 POST、
保护层转发 POST 仍未验证；当前 CLI 显式拒绝 POST 与 GET-only guard 混用。

当前产品 `src/main/windows/windowsEngine.ts` 的 `withCreationReceipt` 仍拒绝
非 GET 或非空正文，解决了静默降级，但并未实现 POST 下载。本轮没有放宽该
检查，也没有声称当前发行版已支持 POST；直接复用的正式接入仍需完成。

## 原版引擎进程重启后恢复已有任务

2026-10-05 新增 `--restart-engine`，在暂停、分段停稳后停止并等待独立 Wine
容器，再启动新原版进程。没有再次发送 WebSocket 下载请求。辅助程序在原版
主列表中要求恰好一条记录且文件名匹配，读取工具栏 Resume 的真实命令 ID
（本次为 1003），选择记录并执行 Resume。跨进程标准控件的数据缓冲区在目标
进程分配、同步调用后释放，不把辅助程序自己的指针当作原进程地址。

三组真实运行均通过，JSON 与对应 `-control.txt` 保存在 core-audit-2026-10-04：

- `windows-original-restart-get.json`：GET 原任务 ID 1 恢复，8 个分段从非零偏移
  继续，原版 Complete，32 MiB 文件 SHA 与源一致。
- `windows-original-restart-identity.json`：暂停期间替换同长度资源，原版进程
  重启后仍被运行中的保护层拒绝，任务 Error，无最终文件，全部旧分段哈希不变。
- `windows-original-restart-post.json`：退出后保存的任务仍为 POST，新进程从
  同一 ID 恢复。初始和恢复的 16 个请求均保留正文及 Content-Type，最终 SHA 正确。

检查包含新旧启动进程 PID 不同、退出/重新加载前分段哈希不变、同一数据库任务
身份、最终状态及字节校验；三个独立容器最后均 stop/wait 成功，源 EXE 未变。
9 个辅助单元测试、Python 编译及差异格式检查通过。

这里停止的是已经暂停的测试引擎，未模拟写入中断电。保护服务和 HTTP 夹具保持
运行，未证明整个控制服务重启恢复。辅助程序的一行列表限制只适用于隔离实验，
正式接入仍需要以任务 ID 定位多任务、无窗口运行、错误/认证及设置适配；兼容层
验证不替代原生 Windows 验收。
