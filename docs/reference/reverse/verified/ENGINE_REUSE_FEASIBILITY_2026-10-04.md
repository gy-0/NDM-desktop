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

## 认证 sheet 取消生命周期修复（研究适配器）

后续实现按 `NeatAuthWindow` 类型拦截 `beginSheet:completionHandler:`，保存原版
完成 block，暂不展示 sheet；其他 sheet 仍交给 AppKit，因此并未偷偷自动确认
未知交互。`cancel-auth` 按任务找到认证窗口，先移除保存的 block，再以
`NSModalResponseCancel` 调用原版回调。旧的直接调用 `handleAuthWindow:` 路径已移除。

完整重跑证据 `core-audit-2026-10-04/original-engine-reuse-auth-sheet-fixed.json`：
普通下载、暂停与进程重启续传、SHA、404 仍通过。认证阶段待处理回调为 1，
取消后为 0，完成计数为 1，任务进入 Error；整个运行的可见窗口采样为 0。
`authenticationStayedHidden` 已从诊断字段提升为必须为 true 的断言。
源码原件未变、独立副本已移到废纸篓、研究进程退出。

这修复了已复现的单任务认证取消缺口，不代表凭据提交、同时多任务认证、
未知 sheet 或正式产品集成已经验证。原失败证据保留，便于对照。

## 认证凭据、错误重试与两任务隔离

研究适配器新增 `submit-auth`：按任务定位原版认证控制器，检查输入控件类型，
填入测试用户名/密码，明确关闭 Remember，再调用已保存的原版 sheet OK 回调。
不改原版认证算法。报告只记录服务器是否匹配测试凭据，不保存 Authorization 头。
测试凭据为虚构值，命令邮箱和原版配置位于独立临时目录；这不是正式凭据传输方案。

`original-engine-reuse-auth-credentials.json` 完整运行验证：
两个任务同时处于认证等待；A 的错误密码产生新挑战，B 仍保持等待；取消 B 后，
A 仍可认证；给 A 正确凭据后，原版下载完成 32 MiB，SHA 与源文件一致。
B 保持 Error 且没有最终文件。四次认证完成回调均处理并释放，待处理数为 0，
整个运行可见窗口采样为 0。此前下载/重启续传/404 断言一并通过。

另保留 `original-engine-reuse-rapid-submit-failure.json`：首次快速连续提交时，
第二个认证任务没有出现，等待超时。两次提交间隔一秒的完整重跑通过。
这只说明较慢提交下可验证两个并发认证，不能证明桥接接收可靠，也不能将
一秒延时当作最终修复。接收确认、去重和重试仍需专门验证。HTTPS、代理认证、
正式产品集成和 Windows 复用也仍未完成。

## 连续提交漏任务的根因与确认机制

当前安装原版的 arm64 指令已直接核对：入口 `0x10003f068` 取时间，
`0x10003f074` 减去全局上次接收时间，`0x10003f078` 比较 `0x1f4`（500），
`0x10003f07c b.lt 0x100040140` 跳过处理；接受后在 `0x10003f084` 更新时间。
`FUN_100075818` 将 system_clock 计数转为毫秒，与既有逆向一致。
因此这是原版入口的全局 500 ms 抑制，不能靠 WebSocket 握手成功判断收单。

研究提交器现在序列化请求，从新任务记录被确认时起留出 550 ms，再发送下一项。
发送后必须观察到恰好一个新任务 ID；未出现则超时，多于一个则报关联歧义，
不会盲目重发不确定请求。测试环境只有该提交器一个生产者，因而记录差集
可以关联请求；正式多生产者集成不能沿用这个假设。

完整证据 `core-audit-2026-10-04/original-engine-reuse-intake-confirmation.json`
包含每次排队时间、确认耗时、原版任务 ID，以及连续六个提交对应六个不同记录。
此前认证、错误密码重试、并发任务隔离及下载 SHA 检查仍保留。
这里修正的是研究适配器的收单保证；正式持久队列、幂等与崩溃重试仍未完成。

## 阻止直接发行的正确性缺口：原版也会混合新旧资源

新增 `--identity-change` 故障夹具：第二次暂停停稳后，将 32 MiB 内容换成
同长度随机新版本，并改变强 ETag；随后原版重启并续传。服务器支持 If-Match
不匹配返回 412、If-Range 不匹配返回完整 200，没有故意忽略条件请求。

实测 `original-engine-reuse-identity-mixed.json` **失败**：原版记录 Complete，
但 3,166,148 个位置只匹配旧内容，30,258,184 个位置只匹配新内容，
其余位置是两个随机源字节碰巧相同；没有不匹配任一版本的字节。
实际 SHA `f63d5895e1b1aa92122980dea8c19102cca6d5d0f56d4b590359afc5803c9625`
与两版源文件均不同。重启后的四个 Range 请求均未携带 If-Range/If-Match，
继续写入已保存分段，服务器响应 ETag 已变为版本 2。

研究脚本以非零退出及 passed:false 保留失败，不把“原版 Complete”视作完整性通过。
原版安装未修改，研究进程退出，副本已移到废纸篓。

这证明直接复用本身不能解决资源变更混合问题。后续集成必须在每次响应/续传
边界加入身份验证，并在冲突时阻止旧分段参与新文件；单次恢复前 HEAD 检查
仍存在检查后变化的时间窗口。保护尚未实现，原版后端不能据此发布。

## 同长度替换保护：本地 HTTP 研究适配层

新增 `identity_guard.py`，固定转发到夹具的 loopback origin。首次成功响应保存
强 ETag，后续每一个成功响应都在读取/转发正文之前检查；弱、缺失或变化的 ETag
返回 412。原版仍负责分段和磁盘写入，适配层未替换下载调度。
不依赖上游遵守 If-Range，也不依赖恢复前 HEAD，因此覆盖已复现的响应身份变化。

`original-engine-reuse-identity-guard.json` 验证：更换同长度资源并重启原版后，
冲突响应被阻止，任务进入 Error，没有最终文件，所有旧分段大小/SHA 保持不变。
这是 fail-closed 保护；自动重新下载新版本尚未实现。
正常回归另见 `original-engine-reuse-identity-guard-normal.json`。

范围严格限定本地 HTTP、强 ETag、单个固定 origin。TLS、重定向、认证导致的表示
变化、无验证器降级、代理自身重启持久化和正式引擎接入未验收。不能把这个研究
代理直接当作可交付网络后端，原先 Windows aria2 的独立漏洞也不能据此宣布已修复。

## HTTPS 上游的增量验证

研究 guard 新增经过证书和主机名校验的 HTTPSConnection；禁止传入关闭
hostname checking 或 CERT_REQUIRED 的 SSLContext。独立生成的一天有效测试证书
仅载入 guard 的私有上下文，没有修改系统证书信任。

`original-engine-reuse-tls-conflict.json` 覆盖：默认信任上下文拒绝自签名测试证书，
返回空 502 且不写资源 pin；信任测试证书后下载可运行，同长度资源变更则在正文
转发前被拦截，原分段逐字节不变。完整正常回归证据为
`original-engine-reuse-tls-normal.json`。

边界：验证的是适配层到上游的 TLS。原版到适配层仍为 loopback HTTP；
没有声称原版原生 TLS 已验证，也未覆盖公网证书链、重定向、客户端证书或正式
产品的 URL/凭据映射。这个边界应在后续架构决策中保留，不能混淆两条 TLS 路径。

## POST 方法与正文：原版 Mac 运行证据

`--post-audit` 通过原版 WebSocket 协议发送 `1:POST` 和
`__0NeatPostData9__:` 正文分隔符。48 字节测试正文包含重复参数及百分号编码中文，
服务端只接受逐字节一致的正文，GET 返回 405、错误正文返回 400。

`core-audit-2026-10-04/original-engine-reuse-post.json` 验证原版发送四个 POST：
Range 起点分别为 0、16785408、8400896、25178112，正文 SHA 均为
`16d9d093b1d5de5182d361ec52b5bee9a5a1fe816a935623f20690dc4472e69e`。
最终 32 MiB 文件 SHA 与源文件一致，说明该场景没有降成 GET 或丢失正文。
下载、重启续传、认证与六任务接收测试也在同次完整运行通过。

原版会为分段重复发送 POST。测试接口是可重复读取的导出夹具，不能把这个结果
推广成任意有副作用 POST 都适合并发重放。正式策略、二进制正文、重定向及
身份保护适配层的 POST 转发仍未实现/验收，CLI 显式禁止 POST audit 与当前
GET-only guard 混用。此处也不是 Windows 实测，Windows POST 仍需独立完成。

## 正式接口接入前的数据缺口：真实字节进度

已核对 `src/main/engine.ts`：界面通过 EngineClient.request 与 snapshot 事件使用后端，
Mac 接 Swift host，Windows 接 WindowsDownloadEngine。正式 Task 模型需要
fileSize、completedBytes、bytesPerSecond、segments 等字段；研究适配器此前只有百分比，
不能直接充当完整后端。

当前原版 `handleEngineNotifyDownload:` 的运行时签名为 `v24@0:8@16`，通知内容为
`累计字节@每秒速率@剩余时间@分段起点*已完成字节@...`。原版逆向
`handleEngineNotifyDownload___0x10000E0BC.c` 也明确把第 0 项用于下载量、
第 1 项用于速率、第 2 项用于剩余时间，然后将分段数组交给 segmentsProgress。
研究适配器现在在调用原方法的同时采集、校验并输出数值结构，不解析界面文本。
无效通知清空观察值；这些数据仍是最后一次通知，暂停/错误时必须结合状态使用。

完整 TLS 上游回归 `core-audit-2026-10-04/original-engine-reuse-progress.json`
验证分段完成字节之和等于总完成字节，总字节与独立百分比一致，并继续执行
下载哈希、重启续传、认证和连续提交检查。

未声称正式切换：还需请求与原任务 ID 的持久映射、总大小与文件路径元数据、
错误/认证事件规范化、删除及文件所有权、设置和媒体任务路由，以及正式进程
启动/退出管理。应适配已有 EngineClient 合同，不能通过伪造 Task 字段掩盖缺口。

## 提交回执与确认丢失恢复

新增 `receipts.py`：先保存 pending 请求指纹和提交前的 ID 集，再发送；确认后
持久化原任务 ID。写入采用文件 fsync、原子替换和目录 fsync。相同 key 的确认
请求返回同一 ID，不再次发送；key 改绑不同内容被拒绝。存在未解决 pending 时
禁止继续提交，避免后续同 URL 任务被误认为先前请求的结果。

恢复只处理单生产者、相同原版 profile 中唯一新增且 URL/method 匹配的 GET。
没有匹配、多条匹配、或未核对正文的 POST 都保持 uncertain，不盲目重试。
原版列表的内存 NSDictionary 没有 URL/method；初次试验因此安全拒绝恢复。
随后改用隔离 NeatDB.db 的只读 SQLite 查询获取保存的请求元数据，不修改原库。

`original-engine-reuse-receipts.json` 记录完整运行：故意在原版已接受后、保存确认
前丢失确认；新 Python 进程读取回执及隔离数据库完成恢复；重放 key 返回同一 ID，
任务记录只增加一条。六项单元检查还覆盖只读数据库恢复、零/多条匹配、旧记录、
POST 歧义、key 改绑和 pending 阻止后续提交。

范围：证明回执恢复，不是完整产品进程生命周期；未验证断电耐久、多生产者锁、
profile 迁移或 POST 不确定结果恢复。现有正式 EngineClient 尚未切到原版后端。

## 保护状态重新加载

身份 pin 存储新增 schema version 和 origin（含 HTTP/HTTPS 及端口）绑定。
原子替换前 fsync 文件，替换后 fsync 目录；损坏、旧格式或 origin 不匹配均拒绝，
不能回退为空 pin 而把变化后的资源当成首次下载。

`--restart-guard` 在暂停停稳、原进程退出后关闭并重新构造 guard server，
沿用同一监听端口，从磁盘载入 pin，再启动原版恢复任务。
`original-engine-reuse-guard-reload-conflict.json` 验证变更后仍阻止正文、旧分段不变；
`original-engine-reuse-guard-reload-normal.json` 验证未变更内容可正常续传并通过 SHA。
九项 helper 测试包含损坏格式、弱 ETag、错误 origin、HTTP/HTTPS 变更拒绝及回执恢复。

这是 server 对象重建和磁盘状态加载测试，Python driver 仍运行，不能称为完整
适配进程重启或断电验证。正式产品接入及 Windows 原版动态控制仍未完成。

## 暂停确认语义

此前研究控制接口调用 pauseResume: 后就返回 ok，即使 workingAfter 仍为 true；
夹具另行等待停稳，所以夹具通过不代表接口可直接用于正式 UI。
现在适配器延迟回复，在主队列后续 tick 观察 isWorking=false 才返回
accepted=true、settled=true、workingAfter=false；以单调时钟设置 10 秒上限，
超时返回错误，不阻塞原版主线程。认证或等待交互时返回 interaction-required，
避免原版只是显示交互窗口却被适配器误认为暂停成功。

`original-engine-reuse-pause-settlement.json` 验证两次暂停的回复本身已停稳，
随后分段文件连续一秒大小/SHA 不变。认证期间的暂停明确拒绝，认证状态保持，
仍可走显式取消/提交凭据路径。TLS、保护层重建、续传、SHA 和回执恢复同次回归。
初次新增严格断言发现 Objective-C 对逻辑非结果装箱会写成 JSON 数字 1；已改为
明确 @YES/@NO，最终完整重跑通过，避免正式客户端布尔解析歧义。

resume 的回复仍只代表已接受，不代表收到首字节；并发 RPC、等待态取消及正式
产品状态机接入尚未完成，不把这个局部接口修复当作后端整体完成。
