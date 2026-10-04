# 原版引擎直接复用：方向澄清与可行性边界

用户于 2026-10-04 明确：优先直接复用原版 Neat 的成熟下载引擎，在其上构建自己的界面与扩展功能；不是默认继续重写引擎，也不是把调好 aria2 视为完成。对外品牌与宣传不与 Neat 关联。原版二进制的嵌入、修改、再分发许可需要独立确认，品牌更名不提供这些许可。

此前产品现状必须如实区分：macOS 是 Swift/URLSession 独立实现；Windows 普通 HTTP 是 aria2 编排。现阶段并非原版引擎加新 UI。已有正确性修复保留，但不能据此声称完成了直接复用目标。

## 当前核对的证据

- `/Applications/NeatDownloadManager.app/Contents/MacOS/NeatDownloadManager` 是主可执行文件；已检查包内 MacOS/PlugIns，未发现独立下载引擎动态库。不能直接当 dylib 链接。
- 本轮 `otool -ov` 在当前原版中确认保留 Objective-C 方法名 `BuildDownloadEngine`、`pauseResume:`、`applyConnectionsCount:`、`applyBandwidth:`、`handleEngineNotify:`、`resumeDownload:`。这些是内部方法，不是已经验证过 ABI 和生命周期的公共 SDK。
- 既有 `RUNTIME.md` 记录原版隔离副本通过 WebSocket 协议接收真实任务并完成下载、哈希校验。暂停/恢复场景当时使用原版按钮；尚未证明浏览器协议可完整管理所有任务。
- 用户提供的 Windows 安装器解包后仅有 `NeatDM.exe`；当前材料没有独立 engine DLL 或完整外部控制 API。
- `reverse` 是带不确定类型、控制流与依赖的逆向产物，不是可直接编译交付的原项目源码。不能把反编译文本的数量当作已经分离出引擎。

## 优先验证的直接复用路线

先保留原版进程及其实际下载逻辑，建立我们控制的适配层；在独立副本、独立数据目录和端口下验证。避免一开始搬走函数而丢失线程、对象、回调、数据库和平台依赖。首个可行性门槛必须同时证明：

1. 新任务由适配层启动，网络字节确由原版接收，最终文件 SHA 正确。
2. 适配层能读到真实任务身份、字节进度和状态；不能靠窗口标题猜测。
3. 不依赖人工点击即可暂停并确认写入停稳，再恢复并验证 SHA。
4. 适配层退出/重启、引擎退出/重启后能关联并恢复任务，不覆盖用户任务库。
5. 原版窗口是否能可靠保持隐藏，且不影响确认流程、错误处理和退出；不能仅靠强行隐藏所有弹窗。
6. Windows 需单独验证，不把 Mac Objective-C 入口泛化到 Windows。

如这条路成立，再评估长期维护的内部接口/进程边界，以及有授权的引擎抽取或源码集成。下方动态验证已证明单个 Mac 普通 HTTP 场景的任务控制闭环；发行集成、完整异常处理与 Windows 路线仍未闭环，不能承诺已经能够把原版内核嵌入发行版。

## 本轮处置

开始编写但未接入的独立 HTTP 引擎草稿已移至 `/tmp/ndm-owned-http-unintegrated-20261004.ts`，未提交，未运行下载测试，未部署。工作树不含该实验实现。优先继续直接复用可行性调查。

## 本轮动态验证：Mac 直接复用控制闭环已跑通

运行 `python3 scripts/reverse/reuse/run.py`。最终版本完整重跑通过，证据 `core-audit-2026-10-04/original-engine-reuse-macos.json`。适配器源码及隔离说明位于 `scripts/reverse/reuse/`。

- 使用原版 1.3/build 24 的独立副本，主程序源哈希固定校验；副本引擎 `__TEXT,__text` 与原版一致。注入的是自行编写的进程适配器，仅映射原桥端口并调用已核对签名的 Objective-C 入口，没有换成我们的下载代码。
- 原版 WebSocket 接收任务后，首个网络请求为 `bytes=0-`，随后由原版建立 4 个连接。
- 从 `NeatDownloadWindow` 的 `getDownloadId`、`isWorking`、`percentCompleted` 读取任务 ID、工作状态和进度。`getDownloadId` 返回对象，而非整数 ABI，已按真实运行时签名处理。
- `pauseResume:` 调用返回只表示命令已接受；随后等待 `isWorking == false` 并验证四个 `seg.xN` 文件连续一秒大小和 SHA 不变，确认写入已停稳。
- 首次原进程恢复后继续前进；再次暂停，退出进程并重新启动。新进程从同一隔离库读到 1 条原任务记录、没有旧引擎对象，分段文件与退出前逐字节一致。
- 适配器按任务 ID 找到记录行号，再调用 `AppDelegate.resumeDownload:`，由原版自行重建请求和引擎。不能把任务 ID 当成该方法的行号参数。
- 完成状态为原版记录的 `Complete`，最终 33,554,432 字节，SHA-256 `dc73d22f67cea7ee10d7ec1380bb97230d6966b6f587aca685fc1bc07438a5b4`，与本地随机源文件一致。12 个实际请求涵盖初始、同进程恢复和重启恢复；两次恢复均从已保存的非零偏移继续。
- 研究进程已退出、测试 App 副本已移到废纸篓、原版源文件哈希不变。用户 NDM 安装和任务库没有用于此实验。

这将门槛 1–4 在单个普通 HTTP loopback 场景下从“未验证”推进为“已验证”。并未完成门槛 5–6，也未证明 HTTPS/代理/认证、错误交互、原版窗口隐藏、所有任务生命周期和产品集成。首次探索脚本曾在最终文件刚出现时提前校验；原版仍在合并，修正为等待记录 `Complete` 后，完整脚本重跑通过。因此不得以“文件出现”代替完成通知。

## 后台运行与 HTTP 404 的增量验证

`python3 scripts/reverse/reuse/run.py --headless` 为研究副本增加了窗口展示拦截，
仅阻止 AppKit 将窗口排到屏幕上，不自动确认弹窗、不改变下载决定。
完整运行仍检查 32 MiB 下载、暂停停稳、进程重启续传及最终 SHA。
快照每 200 ms 记录可见窗口数和被拦截的展示请求；重启前后分别检查。
随后提交本地 HTTP 404，要求原版记录进入 Error，且状态通道继续返回新快照。
证据文件：`core-audit-2026-10-04/original-engine-reuse-headless-macos.json`。

该验证只覆盖普通 HTTP 与 404，无可见窗口是 AppKit 仪表采样证据，
不是屏幕录像，不能排除未覆盖的展示路径。认证、模态交互、权限提示仍未验证；
因此门槛 5 有具体进展，但尚不能宣布可靠的通用后台引擎已经完成。

## 401 认证：确认存在 sheet 缺口，取消控制已验证

本地服务器返回 `401 + WWW-Authenticate: Basic`。首次严格要求窗口保持隐藏
时失败，原始记录保留在 `core-audit-2026-10-04/original-engine-reuse-auth-hidden-failure.json`。
原版创建认证 sheet，绕过普通 `orderWindow:relativeTo:` 拦截；仪表检测到可见窗口。
这推翻了把普通 HTTP 后台验证推广到认证场景的假设。

补充诊断运行保留 `authenticationStayedHidden: false`，不把它吞掉或宣布通过。
`original-engine-reuse-auth-macos.json` 证明控制通道仍可读到任务 3 的
`isAuthenticating == true`。显式发送 `cancel-auth` 后，通过运行时核对
`v24@0:8q16` 签名调用 `handleAuthWindow:0`，任务退出认证状态并产生 Error 记录。
历史逆向 `handleAuthWindow___0x100011110.c` 的零值分支支持该取消语义；
`handleEngineNotify___0x10000E998.c` 中的 `beginSheet:completionHandler:`
解释了普通窗口拦截为何不足。适配器在实际副本上再次核对 ABI 才调用。

本轮没有输入、保存任何凭据，也没有验证凭据提交后成功下载。
下一步必须正确接管认证 sheet 的完成回调和生命周期，再验证凭据重试。
直接调用通知处理方法仅证明任务控制路径，不证明 sheet 已正确结束。
当前仍不可作为正式后台后端。研究进程已停止，副本已移到废纸篓，原版哈希未变。
