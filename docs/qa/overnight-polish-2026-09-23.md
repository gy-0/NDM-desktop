# NDM 夜间打磨记录

时间：2026-09-23 01:35–08:00，Asia/Singapore。当前 goal 在本任务持续执行，heartbeat `ndm` 每 30 分钟续跑；到 08:00 安全收尾并暂停 heartbeat。

## 工作约束

- 在 main 上工作，保留既有 package.json/package-lock.json 版本号修改，不提交这两项。
- 以 9644b29 的下载恢复改造为起点，不操作用户下载与浏览器会话。
- 每批实现后运行适用测试并使用隔离宿主/应用验收；通过后提交推送。
- Chrome Web Store 为正式分发计划；证书、公证、商店账号、支付和品牌决策属于外部事项，不伪造完成。

## 工作队列

1. 已完成：首次使用主按钮直接进入添加下载，普通链接表单聚焦链接与目录，高级导入/协议按需展开；保留已输入的高级内容。
2. 已完成基础诊断：关于与售后入口，提供可预览的最小脱敏诊断，不能包含任务网址、文件名、路径、Cookie 或登录数据。
3. 已完成：完成文件移动/删除后的打开与定位反馈，右键菜单错误提示。
4. 已完成：Relay 版本较旧/较新/混合/无法确认分别提示，断线后复位；正式商店入口待真实商店地址。
5. 后续：根据实际复现补下载可靠性、键盘/缩放/减少动态效果与打包验收，优先真实用户故障。

## 已验证批次

第一批：欢迎页主按钮进入真实下载表单；修复弹窗交接与草稿加载后焦点丢失；高级导入/协议按需展开，单文件表单限宽 760px。

验证：npm test 678 通过、8 跳过；typecheck/build 通过；Impeccable 检测无发现。隔离 Electron 实测欢迎页主按钮、输入焦点、高级设置收起后重命名保留、磁力链自动展开；一个真实 HTTP 下载交付 524288 字节，原样比对通过，任务总数为 1，测试资源已清理。截图保存在工作区外的审查目录“夜间打磨/01-first-download.png”。

上一轮 9644b29 证据见 download-recovery-2026-09-23.md。

## 继续点

用户明确要求绿色改蓝色。第二批已实施：三主题统一冷蓝操作色与完成状态色，减少卡片选中描边；主题说明同步。三主题对比度脚本通过，npm test 678 通过/8 跳过，typecheck/build 通过。隔离应用检查三主题、恢复弹窗、卡片选中与下载完成通知；宿主再次核对实际文件和旧片段通过。截图 02-blue-dark、03-blue-light、04-blue-workspace 已保存在外部夜间打磨目录。

第三批：设置 → 通用新增问题诊断，主进程白名单生成预览，用户主动保存。导出严格使用主进程预览内容；旧 token、过期预览被拒绝；引擎读取 4 秒超时后仍生成有限报告；取消/失败不丢预览。新增 5 项测试覆盖私密字段、恶意版本字段、真实文件与权限、保存失败/取消/过期和无响应。npm test 683 通过/8 跳过，typecheck/build 通过。实际 Electron 预览、取消、重试保存已完成，导出 541 字节，构建号已核实；05-support-diagnostics.png 为实际截图。

第一批 84f8b50、蓝色主题 cfa0df6 已推送。颜色检测仅报告既有 spring 曲线，未扩大为动效重写。下一步检查已完成文件移动/删除后的真实反馈与 Relay 版本兼容。

第四批：修复文件已移动时定位操作的假成功；原文件不存在而文件夹存在时，等待系统打开结果并明确说明只打开了原保存文件夹。打开失败区分文件丢失；右键菜单和传输通知接入统一反馈。新增 3 项真实临时文件与系统失败测试。npm test 686 通过/8 跳过，typecheck/build 通过；隔离 Electron 实测卡片打开/定位和右键打开反馈，截图 06-missing-file-open、07-missing-file-reveal。只使用合成文件，未操作用户任务；完成状态继续表示历史下载结果，不代表实时文件跟踪。第三批 cedd748 已推送。

第五批：Relay 按 Chrome 数值版本规则比较，省略的零等价；新扩展不再误报“扩展需要更新”，改为检查桌面端更新；无效元数据不能冒充已核验。规则来源：https://developer.chrome.com/docs/extensions/reference/manifest/version 。旧版本指引移除普遍要求开发者模式重新加载的文案，未虚构商店链接。npm test 689 通过/8 跳过，typecheck/build 通过。真实隔离宿主配合合成 WebSocket worker，CUA 实测旧版、较新版、匹配版本和断线状态。首次使用单段合成版本时被现有宿主格式校验拒绝，调整为实际发布格式 2.0.0 后通过；此批未修改宿主协议。第四批 722c0ca 已推送。

第六批：正式商店安装入口与开发测试安装分离。欢迎页、设置页共用 RelayInstallPanel；主进程返回构建时固定的商店配置，正式包未配置时说明入口待提供，绝不展示开发者模式步骤；开发构建仅在折叠区提供测试目录。配置的商店 URL 仅允许官方条目且不能携带重定向参数。发行配置与待办见 ../relay-store-distribution.md。

验证：新增 3 项测试，npm test 692 通过/8 跳过，typecheck/build 通过，Impeccable 无发现。CUA 实测开发引导展开与打开目录；重新编译 release NDMHost 并用已安装的同版本 Electron 43.4.0 打包到 /tmp/ndm-night-store-package。原网络下载进程主动终止后才切换本地运行时，未并行写包。实际打包应用的欢迎页、设置页均不出现开发安装入口，截图 08-packaged-relay-install.png；隔离宿主和测试数据均已清理。此包未做发行签名/公证，未替换 /Applications/NDM.app；商店真实安装与转交尚待有效条目。

可靠性复核：qa-deploy-resume 实际宿主暂停、退出、重启通过。有效前缀 262144 字节在重启后原位续传，6 MB 最终 SHA-256 一致；原本暂停的另一任务未发起请求，暂停 ACK 后写入已排空，fixture 数据清理通过。报告 /tmp/ndm-night-resume.log。第四批移动文件 fixture 的最终校验和清理也已完成。

下一批优先复核打包应用中的首次下载与错误恢复，以及异常退出后的进度一致性。当前仅 package.json/package-lock.json 为预存版本号改动，继续保留不提交。整体夜间目标保持 active，截止 08:00。

第七批：实际应用包下载验收发现并修复 Markdown 链接识别问题。此前 `[网址文字](实际地址)` 可被识别为拼接地址；现先识别内联目标，再扫描其余分享文本，忽略链接文字中的伪地址。保留目标的平衡括号、签名查询字节和转义括号，重复目标只保留一次。新增 3 项测试，npm test 695 通过/8 跳过，typecheck/build 通过。

真实包验收：qa-first-download-host 支持指定应用包并加强 HTTP 目标断言。重新打包后，CUA 输入文字地址与目标地址不同的合成 Markdown，点击下载；任务 URL、所有请求路径均准确，文件原样比对 524288 字节、任务数 1。日志 /tmp/ndm-night-markdown-ui.log，未向任何真实剪贴板地址提交请求。

故障恢复补充：以包内 release NDMHost 执行 qa-offset-host，32 路 Range、64 MB 本机合成文件，暂停后已写入 1277952 字节；SIGKILL 后重启恢复并完成，最终 SHA-256 与原样本一致，无遗留 partial。峰值磁盘分配为文件大小的 1.00049 倍。报告 /tmp/ndm-night-crash-resume.log；该测试是实际宿主故障恢复，不等同于操作系统强制退出整个 UI 的验收。

第六批 34141c7 已推送。下一步继续检查打包后的失败恢复、键盘操作与较小窗口的可用性，避免重复已通过的正常下载路径。

第八批：打包应用恢复流程键盘验收复现焦点丢失：点击恢复后按钮临时 disabled，进入 needsRedownload 说明时焦点落到页面背景。修复为请求结束后聚焦确认说明或错误反馈，避免直接聚焦“重新下载”造成连续回车误操作；打开来源网页返回 false 也会报告失败。

验证：npm test 695 通过/8 跳过，typecheck/build 通过，Impeccable 无发现；重新打包后 CUA 纯键盘选择 profile-b、请求恢复，AX 确認焦点在说明；回车不触发下载；Tab 依次进入稍后处理/重新下载，明确确认后同任务完成。包内宿主验证旧片段保留、最终 524288 字节一致、过期请求被拒绝，无重复任务，日志 /tmp/ndm-night-recovery-focus-ui.log。放大界面后操作仍可达；窗口边缘拖动未改变尺寸，因此没有声称验证了最小窗口尺寸。

恢复 fixture 增加独立应用包路径选择并修复应用已退出时清理等待。第七批 d8aef90 已推送；下一步继续审查低高度布局和错误反馈，不重复本批已验证的恢复协议。

第九批：修复 URL 探测实际网络层自动跟随跳转，绕开应用逐跳策略的问题。同源跳转显式保留 Cookie，跨源清除 Cookie 与 cookieUsed 元数据；先处理 3xx 再判断 MIME，跳转页 HTML/附件头不能当作目标文件，超出上限或目标不可达时保持 unknown。GET 降级返回无类型重定向时也继续解析。探测收到响应头即结束，统一清理超时并 abort，替换原来的异步 body guard。

证据：真实 Electron + 两个 loopback 服务器，修复前同源 Cookie、跨源元数据、跳转次数上限失败，修复后十项检查全通过；跨源真实 Cookie 在修复前也未泄露，不夸大为外传漏洞。忽略 Range 的 8 MB 响应被提前停止，挂起响应超时通过。原来的源码正则断言替换为这些实际网络检查，另增 3 项行为测试；npm test 697 通过/8 跳过，typecheck/build 通过。详见 url-probe-wire.md；日志 /tmp/ndm-night-probe-before.log、/tmp/ndm-night-probe-after.log。第八批 73dcae4 已推送。

下一批继续核查普通文件响应内容与完成交付。当前隔离打包产物停留在第八批，主进程第九批已完成真实 Electron 模块验收，但尚未重新打包；下次打包须包含此变更。

第十批：补齐探测到实际下载的会话衔接。登录后的文件可从原站跳到匿名 CDN；最后一跳 cookieUsed 清空是正确的，但下载仍要从原地址开始。成功分类新增 sourceCookie，明确绑定原始 URL；任务创建只对完全一致的 URL 使用它，拒绝换行 Header，保留浏览器资料元数据以便后续更新会话。

验证：新增分类与任务创建 2 项行为测试；npm test 699 通过/8 跳过，typecheck/build 通过。真实 Electron 网络 + 包内 release NDMHost 联调：匿名登录页 → 合成会话跳转 → 匿名 CDN → 实际文件交付，原站 Cookie、CDN 无 Cookie、最终字节一致三项全部通过。只使用本机合成 Cookie，未读取真实登录资料。脚本清理独立宿主、支持目录及偏好域；日志 /tmp/ndm-night-source-session-wire.log。第九批 0d2f752 已推送；最新源码构建已通过，但隔离应用包仍停留第八批。

第十一批：自动补充文件登录 Cookie 时保留原请求头，避免 Referer/自定义下载参数被整个覆盖；已有显式 Cookie 或 Authorization 时保持用户指定会话，不自动替换，不给它错误标注其他浏览器来源。使用新数组，不修改调用方输入。

真实复现：生产 addFromUrl 业务模块通过合成 IPC 连接真实 Electron 分类和隔离 NDMHost，修复前 creationHeadersPreserved=false，修复后为 true；原站使用原头与自动 Cookie，CDN 匿名，文件字节一致。日志 /tmp/ndm-night-headers-before.log、/tmp/ndm-night-headers-after.log；此项是业务模块与宿主联调，不冒充鼠标 GUI 操作。新增 1 项测试覆盖原头保留、显式 Cookie/Authorization 和输入不可变；npm test 700 通过/8 跳过，typecheck/build 通过。第十批 9548644 已推送。

第十二批：阻止已确认的 HTML 页面以 ZIP/PDF 等文件地址创建普通任务。媒体探测已找到格式仍可正常下载；媒体解析无结果或失败时，明确说明网站返回网页，用户可检查来源后重试。正常网页地址、显式保存为 HTML、以及未被匿名探测覆盖的自定义 Header 请求保留原能力。

真实本机复现前 htmlFileRejected=false、htmlCreatedNoTask=false，修复后两项为 true；认证 CDN 下载等原验收仍全通过。新增 2 项行为测试覆盖媒体探测失败与正常网页/显式认证/显式 HTML 保存；npm test 702 通过/8 跳过，typecheck/build 通过。日志 /tmp/ndm-night-html-before.log、/tmp/ndm-night-html-after.log。此批保护经过 addFromUrl 的创建路径，不宣称已完成全引擎内容识别。第十一批 3a36127 已推送。

第十三批：优化大量任务的排序和合集分组。文件名排序复用中文自然排序比较器并预计算排序值；合集一次建立可见成员索引，避免每组重复扫描全部任务。保持稳定排序、过滤后的展开成员、完整合集摘要和原数组不可变。

真实 Electron 运行生产纯函数，一万条合成任务、一千组，预热后 3 次中位数：文件名排序 380.74 → 16.38 ms，合集分组 59.54 → 2.49 ms。这是函数基准，不是整界面帧率。新增分组语义测试，npm test 703 通过/8 跳过，typecheck/build 通过。脚本 qa-library-performance.cjs 可重现；前后日志 /tmp/ndm-night-library-before.log、/tmp/ndm-night-library-after.log。

隔离宿主成功装载 10000 条合成任务并启动开发应用；CUA 因 Mac 锁屏无法读取界面，未宣称搜索/筛选 GUI 验收通过。任务数保持不变且 fixture 已清理，日志 /tmp/ndm-night-library-ui.log；解锁后可用 qa-library-host.mjs 继续检查搜索 09999 和完成/暂停各 5000 条。第十二批 b98a86c 已推送。隔离打包产物仍停留第八批，后续需要重建。

第十四批：重新打包时发现发行范围过宽，`out/**/*` 将无关 Expo/iOS 实验输出收入 app.asar（27316/7 个条目），归档 381424129 字节。收紧为 out/main、out/preload、out/renderer；未删除任何实验文件，未提交预存版本号变化。

重新使用本地 Electron 43.4.0 打包成功，归档降至 55853278 字节，减少约 85.4%。逐字节检查 61 个桌面构建文件与包内一致，无实验目录；包内 NDMHost 与当前 release 二进制一致。归档 SHA-256 89a11a5a0b2c7806b0dff3a9e696277f33dd5374a2d3699ae3ab1a06b2ad9677，宿主 SHA-256 5f57bcc6e71ff91c1e2c4439c4daa322a86c8de7ec46520bb9bf21a79a2b7669。日志 /tmp/ndm-night-package-integrity.log、/tmp/ndm-night-latest-package.log。第一次范围检查遇到 .DS_Store 和实验目录的 .gitignore 不在归档中，随后发现真实混入内容；最终检查明确仅覆盖三个桌面构建目录并断言实验目录不存在。

包内宿主联调 qa-download-management-host 全通过：导入预览零请求、镜像 404 回退、实际队列顺序 1/3/2、时段限速及退出恢复、导入服务重启不重复创建；3 个 2 MB 文件逐字节匹配。日志 /tmp/ndm-night-package-management.log。主进程服务来自当前源码，宿主来自打包产物，不冒充完整 GUI 验收。此后打包过滤变更未改变宿主字节。隔离包现在包含第九至十三批代码；仍未签名/公证、未替换 /Applications/NDM.app，锁屏下新增 GUI 验收待完成。第十三批 824a3d3 已推送。

第十五批：补充成品校验联调证据，无需修改已经正确的产品逻辑。qa-download-management-host 将实际包内宿主交付的 2 MB 文件传入生产 FileIntegrityService，以宿主列表解析任务路径。正确 SHA-256 匹配且不改变内容；随后只修改合成成品的一个字节，查询旧结果返回 fileChanged 并删除旧 digest/matches；重新校验得到 matches=false，同时保持被校验文件字节与所有任务状态不变。既有导入、排队、镜像、限速用例仍通过，fixture 清理完成。

报告 /tmp/ndm-night-integrity-host.log。这是校验服务与真实下载成品的联调，未通过完整 Electron IPC 或 GUI；文件改变后的失效发生于再次请求状态，不宣称后台持续监控文件。第十四批 f82e534 已推送。后续继续检查完成交付与错误恢复边界。

第十六批：审查批量暂停/继续/重试的失败处理，补充真实宿主部分重试验证。在 restartMany 同一请求中先放入不存在的任务，再放入有效的暂停任务；返回 ok=true、count=1，有效任务继续执行并交付完整 2 MB 文件，不创建重复记录，也未改动前一项校验不一致的合成成品。原导入/队列/限速/校验全部仍通过，fixture 清理完成。日志 /tmp/ndm-night-partial-retry.log；qa-download-management-host 现包含这项回归。

界面源码已有成功数与目标数比较、部分失败提示及逐项继续处理；此轮只证明宿主返回和文件结果，不把源码检查当作提示实际可见的 GUI 证据。锁屏下没有运行依赖 Playwright 的旧 UI 脚本。第十五批 be0b689 已推送。

第十七批：官网仍要求普通用户开启开发者模式装 Relay，与既定正式商店分发方向冲突。Relay 页改为 Chrome Web Store 计划及入口尚待提供，当前可先粘贴链接下载；同步下载/价格页说明。首页、价格页和 FAQ 移除 license.ts、商业化开关等内部实施文案，明确 Pro 未开售、价格与功能是草案；未更改既有价格、设备数、付费策略或真实下载目标，未虚构商店/购买链接。

首次 website 生产构建真实失败：next/font/google 拉取三个字体族发生 TLS 断连，重试后仍失败。改为 next/font/local，复用已安装 @fontsource 的相同字体族与字重，6 个 Latin WOFF2 文件；保留 3 份 SIL 许可并通过 public/licenses 提供。重新 npm run build --prefix website 通过。Noto Serif SC 仍由浏览器加载外部样式，不宣称字体完全离线。

实际本机 Next 生产服务器验收：5 个路由 HTTP 200，开发者模式/license.ts/商业化开关文案全部消失；Relay 待发布说明和两项草案价格保留；6 个本地字体资源及 3 份许可均可获取。日志 /tmp/ndm-night-website-build.log（失败）、/tmp/ndm-night-website-local-font-build.log（通过）、/tmp/ndm-night-website-http.log。未部署到线上；Mac 锁屏下未验收视觉排版。第十六批 2e91b7c 已推送。

第十八批（界面验收待补）：Composer 的 handleChooseFolder 原先直接 await 原生选择器，调用拒绝会产生未处理异常而没有界面反馈。补充 catch，保留原目录及输入，并用现有错误区域提示选择器未能打开；反馈仍受表单 session 和选择序号保护，旧操作不得污染新表单。取消选择器仍保持安静。

这项缺口来自源码，不冒充现场已复现的操作系统故障。npm test 703 通过/8 跳过，typecheck/build 通过，Impeccable detect 无发现；日志 /tmp/ndm-night-folder-{tests,types,build}.log。Mac 锁屏，原生选择器失败及跨表单延迟结果的 GUI 验收尚待完成，本批不能记为完整验收完成；下次隔离应用包也需包含此变更。第十七批 3c205c9 已推送。

第十九批调查：新增 qa-file-delivery-host 隔离复现，目录预存 same-name.bin，随后并发创建两个同名但内容不同的普通 HTTP 下载。原文件逐字节保留，两项任务均返回 #diag:fileAlreadyExists，没有自动编号成功。最初按“两项均完成且互不覆盖”验收失败，日志 /tmp/ndm-night-file-delivery.log；现状安全性脚本明确报告 safetyPassed=true、completed=0、collisionErrors=2、autoNumberingSatisfied=false，日志 /tmp/ndm-night-file-delivery-safety.log。两次 fixture 均清理完成，不能将“不覆盖”说成“自动处理冲突已完成”。

后续要解决新下载遇到同名文件的体验，但不得直接放宽引擎独占发布保护。需覆盖服务器给出的最终文件名、并发新任务、暂停/恢复、已完成任务明确重下与原片段所有权。DownloadManager 当前 makeURLTask/createURL 分别处理推导与明确名称，DownloadEngine 探测后还会解析最终名称；不能只在创建入口扫一次文件存在就认为并发冲突已解决。第十八批 18f0d8c 已推送。

第二十批：修复 macOS 普通 HTTP 下载及镜像下载的新任务同名冲突。HTTP 探测解析最终名称后，通过管理器 actor 串行检查磁盘和其他未完成任务的目标，并持久保存编号后的名称；保留最终独占发布，外部程序中途占用目标仍拒绝覆盖。已有 offset/旧 segments 记录及明确 replacement 请求不进入自动改名流程。FTP、HLS、辅助引擎未扩大本批行为范围。

实际 release NDMHost 验收通过：已有文件 → 两项分别生成 (2)/(3)；无已有文件的并发任务目标不同；Content-Disposition 最终名冲突同样编号；编号后的单连接下载保留 343744 字节，经宿主退出/重启，断点记录及 partial 字节不变，HTTP 从准确的 durable prefix 发起请求，最终内容一致；明确重新下载仍覆盖自身编号成品而保留原同名文件；镜像 404 回退后编号成功；模拟其他程序在请求正文时占用目标，任务报冲突且外部文件原样保留。日志 /tmp/ndm-night-file-delivery-complete.log，fixture 清理完成。

验证：npm run build:native 通过；npm run test:native 的 XCTest 共 1265 项、28 跳过、0 失败，另 Swift Testing 11 项通过。随后在旧分段碰撞用例注入自动命名回调，断言该回调绝不能运行，单独重跑通过。日志 /tmp/ndm-night-collision-native-tests.log、/tmp/ndm-night-collision-legacy-test.log。重新构建隔离包，61 个桌面资源与 out 逐字节一致，宿主与已验收 release 完全一致（SHA-256 71be235919b108f8d9c7d4beb28590991f7737368798ecec51fb34e7ba6f56c8）。未签名/公证、未替换正式安装。第十九批 7e5a802 已推送。

新发现留待下一批：刚重启、尚未恢复的普通暂停任务 list.completedBytes 为 0，磁盘实际片段仍在；根因线索是 manager.progress 无活跃 engine 时返回 nil，Host 的 taskJSON 对未完成任务回退 0。本批已用断点记录和准确 Range 证明没有数据丢失，不能把显示问题混称为续传失败。最初按列表字节等于暂停值的断言因此失败，随后改用更强的磁盘/网络证据；显示修复仍待实现。

第二十一批：恢复 offset 断点任务重启后的进度展示。无活跃引擎时，管理器读取经任务身份、目录、文件 inode 和范围边界检查的已提交 durablePrefix；不按预分配文件长度计算，不修改任务状态，不启动下载。缺失/截短/被其他文件替换的片段不沿用旧值。已有非 offset 旧格式进度展示未在本批扩展。

新增 2 项 OffsetDownloadStorage 测试覆盖未提交字节、预分配、重复只读、缺失、截短及外来 inode。完整 npm run test:native：XCTest 共 1267 项、28 跳过、0 失败，另 Swift Testing 11 项通过。真实 release 宿主退出重启，列表 completedBytes 从修复前 0 变为磁盘已提交的 343744 字节，fileSize 正确、状态仍暂停；读取期间无 HTTP 请求，断点和 partial 内容未变，继续后 Range 精确起于 durable prefix，最终文件一致。日志 /tmp/ndm-night-persisted-progress-native-tests.log、/tmp/ndm-night-persisted-progress-wire.log。

qa-library-host 新增 --headless，用 10000 条合成记录验证实际宿主，无需桌面解锁。新宿主 3 次完整列表请求为 531/491/516 ms，上一批包内宿主为 503/383/362 ms；这不是界面帧率，额外断点验证存在读取成本。将 Host 的 activeOnly 过滤提前到进度读取前，避免高频活跃轮询扫描暂停/完成任务的断点；未声称完整列表因此加速。日志 /tmp/ndm-night-persisted-progress-library.log 和 ...-library-before.log。所有 fixture 已清理。第二十批 ea9810f 已推送。

最终 npm run build:native 通过（SwiftPM 等待完整测试释放锁后构建，未重启测试）；包含 Host 过滤调整的 release 再跑全套文件交付 fixture 通过，日志 /tmp/ndm-night-persisted-progress-final-host.log。当前隔离应用包仍停留第二十批，后续打包需纳入本批；GUI 暂停进度外观仍未在锁屏下验证。

第二十二批（GUI 验收待补）：通过 GitHub API 确认 gy-0/NDM-desktop 为公开仓库且 Issues 已启用。在问题诊断面板加入“报告问题（GitHub）”，固定指向仓库的新问题模板，不在 URL 中预填私人下载或诊断信息；打开失败显示手动访问地址，防止重复打开。公开反馈属性在按钮旁说明，诊断仍由用户自己决定是否保存和附上。

新增 .github/ISSUE_TEMPLATE/bug_report.md，收集问题、复现步骤、预期/实际、应用版本、系统和可选诊断。未发送任何问题或消息，也未自动上传文件。npm test 703 通过/8 跳过，最终 typecheck/build 通过，Impeccable detect 无发现。日志 /tmp/ndm-night-support-entry-{tests,types,build}.log。Mac 锁屏，实际点击外部浏览器、返回焦点与失败提示 GUI 验收待补，不能将代码接入当作已完成实机点击。第二十一批 22e9b47 已推送。

第二十三批：减少大任务库完整快照的重复数据库读取。Host 已取得权威任务列表后，将该任务行传入管理器读取进度，不再为每项重复查询任务和 recoveryGeneration；实时引擎进度优先级、辅助任务展示及 offset 所有权验证保持不变。

真实 release 宿主的 10000 条合成任务对照：同一 fixture 顺序运行优化前宿主 600/480/508 ms，优化后 208/207/169 ms，中位数 508 → 207 ms（约减少 59%）。这是完整列表请求耗时，不是 GUI 帧率；任务数未变，fixture 清理完成。日志 /tmp/ndm-night-library-snapshot-control-{before,after}.log。文件交付全套联调通过，重启前 durable prefix 与重启后列表均为 359192 字节，读取不发起 HTTP，续传范围和最终内容正确；日志 /tmp/ndm-night-library-snapshot-delivery.log。

最新提交 2d48c8c 的 CI 35771978945：Windows 成功；Ubuntu 的单测、类型、Relay、构建成功，渲染器验收在旧 Relay 文案断言超时。下载 report.json 确认此前 35 项通过、无 rendererErrors；失败截图实际已显示新文案，脚本仍期待“从当前应用的扩展目录重新加载旧版”。同步该断言为浏览器更新文案，node --check 通过，未本机运行旧 Playwright 操作脚本；修改后的 CI 仍待推送验证。

重新打包隔离产物，61 个桌面资源与构建输出逐字节一致，包内宿主与本批 release 相同，SHA-256 117ac9c7eac879fa21137a332adfdaa23902a4ac7fd42d982929deb325b24502。未签名/公证、未替换正式应用；macOS 锁屏后的 GUI 待验项仍未冒充完成。

本批最终 build:native 通过；完整 test:native 通过（XCTest 1267 项、28 跳过、0 失败，另 Swift Testing 11 项）。日志 /tmp/ndm-night-library-snapshot-{build,native-tests}.log。旧 CI 的 macOS 作业仍运行，先保留其完成机会，避免连续推送再次自动取消原生检查。

第二十四批：GitHub API 实时查询仓库 Releases 列表为空，下载页却声称可获取安装包。修正文案为“公开安装包尚未发布”，原 Releases 地址保留，按钮改为“查看发布状态”；不捏造下载资产，不提供关闭系统安全检查的安装指导。移除普通用户不需要的 Electron/Swift/aria2/FFmpeg 实施细节，保留 Windows Relay 与独立音视频合并限制，签名和兼容性标注待正式发行验证。

website 生产构建通过；隔离 Next 生产服务器实际 GET /download 返回 200，新发布状态三处文案可见于响应，旧获取安装包标题及内部引擎文案消失，Releases 链接未变。日志 /tmp/ndm-night-download-page-build.log；服务器验证后退出。未部署网站，锁屏下无新视觉验收。第二十三批已本地提交 b2e2806，暂缓推送以保留上一轮仍在进行的 macOS CI，下一轮需一起推送。

第二十五批：补充独立、只读的 macOS 对外发行检查 scripts/verify-macos-distribution.mjs，避免将本地 Apple Development/ad-hoc 安装签名视作商业发行完成。要求 App 与 NDMHost 的 Developer ID、相同 Team、Hardened Runtime、安全时间戳与完整性验证，并要求 Gatekeeper 明确接受已公证 Developer ID、已附加公证票据有效；没有忽略失败的选项，不进行签名/上传/发布或系统设置修改。docs/MACOS_SIGNING.md 记录命令、Apple 来源及不能替代实机发行验收的边界。

3 项回归纳入 npm test，覆盖系统命令失败、开发/临时签名、缺失强化运行时/时间戳、关闭 Gatekeeper、非公证接受和宿主团队不一致。完整 npm test 706 通过/8 跳过。真实当前隔离 App 的检查退出 1，正确列出尚缺 Developer ID/runtime/timestamp、完整性/公证门槛；不把 fixture 模拟全部通过当作实际发行包通过。日志 /tmp/ndm-night-distribution-{tests,gate}.log。再次确认 Mac 仍锁屏，GUI 验收未恢复。

第二十六批：找到锁屏下可用的 CUA 内置浏览器，实际打开本机 Next 生产页面。下载页主按钮呈近白底近白字，DOM computed style 确认背景 rgb(240,240,242)、文字 rgb(245,245,247)。根因为通用 .ndm-site a 的优先级压过 .ndm-button；将通用链接选择器改为 .ndm-site :where(a)，保留既有 token/布局，按钮恢复 rgb(23,24,28) 深色文字。下载页与首页实际截图确认可读，未只凭构建宣称视觉通过。

同次导航发现价格页仍写“当前版本可免费下载”，FAQ 仍暗示已有安装包；统一为公开包未发布、Pro 未开售，保留既有价格/授权草案与 Releases 目标，首页按钮也准确写成查看发布状态。Relay 页面移除遗留内部引擎及仓库文档说明。生产构建通过，重新启动隔离服务器后 CUA 逐页看到新版价格/FAQ/首页，下载和首页主按钮截图保存为 夜间打磨/09-website-download.png、10-website-home-buttons.png。此证据仅限网站，不替代被锁屏阻止的原生桌面验收。

CI 35771978945 最终 Native(macOS) 与 Windows 成功，Ubuntu 仅旧 Relay UI 文案断言失败。等待其结束后，b2e2806/ac34849/9f5363e 已一并推送 main。新 CI 35773600775 正在验证修正后的断言，避免再次频繁推送取消它。本批网页变更待随后一并推送；原有版本号 WIP 保留。

第二十七批：CI 35773600775 暴露两处验收脚本问题。Windows 的 macOS 分发测试用 endsWith('/NDMHost') 匹配假宿主，在 Windows 路径分隔符下未注入错误团队，断言因此失败；改用 node:path basename。Ubuntu 渲染器已通过 36 项、无 rendererErrors，最后空任务页仍找旧 placeholder；失败截图确认新版 Composer 已打开，改用稳定的 textbox 名称“下载链接”，同样修复 qa-share-command 遗留定位。

该 CI 截图也包含模拟环境缺失 composerDraftLoad/relayDistribution 导致的无关错误；fixture 补充 revision=0/draft=null 和 unavailable/url=null，贴合当前正式包无商店配置状态。未把模拟环境报错当作真实引擎故障。npm test 706 通过/8 跳过，两个脚本 node --check 通过；日志 /tmp/ndm-night-ci-followup-tests.log。实际跨平台和渲染器运行结果仍待下一轮 CI，当前 macOS 作业尚在运行，不提前宣称全绿。

第二十八批：官网首页在 1280 宽实际将“视频”拆行，原 88px 标题列宽 498px。保留已有 ndm-display 字号和布局，将标题精简为“文件与视频 / 一处下载”，明确两行，不新增视觉系统。生产构建通过；CUA 内置浏览器在 320/390/1280 宽分别看到完整两行，document.scrollWidth 等于 viewport，主按钮在最窄屏自然换行。截图 11-website-home-390.png、12-website-home-320.png、13-website-home-desktop.png 已保存；临时 viewport 覆盖已 reset。

第一次恢复默认尺寸后的截图仍显示上一窄屏合成画面，随后重新读取 AX 并截图确认真正的 1280 桌面布局，没有用那张过渡画面作为验收证据。日志 /tmp/ndm-night-website-heading-build.log。仅首页可读性调整，未部署线上。

第二十九批：通用设置的“关于 NDM”新增主动“检查更新”。通过主进程固定 GitHub latest release API 查询公开正式版，不携带浏览器凭据、下载数据或鉴权，不自动下载/执行更新。404 明确为未查到正式版，不冒充最新版；数值版本比较区分新/同/旧，未知格式不臆测；网络/限流/异常数据分别提示，操作可以重试。固定仓库生成发行说明 URL，不采用响应中的任意 URL。8 秒超时覆盖正文读取，256 KiB 限制，多窗口同时检查合并同一请求。

5 项新测试覆盖版本关系、固定请求、凭据省略、并发、失败重试、超限取消、异常 JSON 与正文卡住；完整 npm test 711 通过/8 跳过，typecheck/build 通过，Impeccable 无发现。真实 Electron net.fetch 调用返回 unpublished，与当前仓库无正式 Release 一致；日志 /tmp/ndm-night-update-wire-final.log。最初隔离脚本误用文件路径 require Electron 导致未启动检查，已停掉这两个独立 QA 进程并修正后重新验证，不将首次失败算作产品故障。

CUA 实际点击生产 AppUpdatePanel 组件的隔离浏览器 fixture：初始不自动检查；等待期间按钮禁用；未发布不出现发行说明；网络失败及再次重试有明确反馈；模拟新版显示发行说明；Return 打开失败后显示手动地址；打开说明期间两项操作互斥，结束恢复。截图 14-update-network-retry.png、15-update-release-open-failure.png。此为实际组件加模拟 IPC，真实网络另用 Electron 验证；Mac 锁屏，完整原生设置窗口到 IPC 的点击链仍待解锁补验。CI workspace 脚本新增设置内未发布→失败→新版的回归，但本机未执行 Playwright。

已重新打包，61 个桌面文件与当前 out、包内宿主与 release 均逐字节一致；未签名/公证或替换正式应用。日志 /tmp/ndm-night-update-{final-tests,final-types,final-build,package}.log。前一轮 CI 35774895756 的 Windows、Ubuntu（含修正后的完整渲染器验收）均成功，macOS 仍运行。本批先提交，随后等待当前 CI 结束再推送。

第三十批进行中：真实隔离宿主复现长文件名问题。显式长英文 .pdf 因旧 sanitize 截断扩展名，最终选用服务器 .bin 名；170 个文件夹 emoji 的 .zip 触发 File name too long。初始复现日志 /tmp/ndm-night-filename-boundary.log，fixture 已清理。文件系统实测支持 180 个汉字文件名，但 170 个非 BMP emoji 名称失败，因此不将“字符数”误作文件系统长度。

新增仅用于新下载的 sanitizeNewDownload/newDownload 解析路径，保留末尾扩展名、按完整 grapheme 截到 UTF-16 预算，预留编号空间，并去掉截断后扩展名前的空白。旧 sanitize 和默认 resolve 保留，HTTP 仅无 offset/legacy 记录且无 replacement 时使用新规则。创建和新 Relay 任务先按新规则命名；既有任务与恢复工作区不迁移。

首轮 release 验收已成功交付长英文、emoji 与长 Content-Disposition 文件，精确内容一致；旧宿主建立的 100 个 emoji 名称断点也能由新宿主保持原名续传，已提交字节和重启列表均为 359608，准确 Range，明确重下仍保持自身目标。初轮日志 /tmp/ndm-night-filename-delivery.log、/tmp/ndm-night-filename-legacy-resume.log。复查编号边界后进一步将新名称预算设为 172 UTF-16，为最高编号保留 8 个字符，当前最终构建/完整测试与加强后的长英文名重启验收尚在进行，不能把初轮结果当最终通过。

第三十批补充进展：172 UTF-16 预算版本的真实长英文名编号→暂停→重启→续传通过，358984 字节与列表一致；NDM_QA_PREVIOUS_HOST=/tmp/ndm-night-progress-baseline-host 的旧宿主升级模式通过，旧长 emoji 名称未变，262144 字节与列表一致。该模式已纳入 qa-file-delivery-host，测试后清理独立资料。日志 /tmp/ndm-night-filename-final-{delivery,legacy}.log。

最后代码复查发现合成的 GitHub 仓库 ZIP 名也必须在旧 ensureExtension 截断前应用新名称规则，已补修并新增定向回归。最终 12 项 DownloadFilenameTests 和 release 重建正在等待完整原生测试结束，随后需再跑宿主联调并重建隔离包。当前不得提交本批或宣称最终验收完成。第二十九批 e40a160 已推送；此前 31d0cc4 的 CI 35774895756 三个平台全部成功。

第三十批最终验收完成：完整原生测试通过（680 Engine + 558 Core + 32 Bridge，共 1270 XCTest，28 跳过、0 失败；另 11 Swift Testing）。末尾合成 ZIP 修复随后单独运行全部 12 个 DownloadFilenameTests 通过，release 重建通过；完整测试覆盖修复前的 172 UTF-16 版本，最终两行调整由定向测试和最新宿主联调覆盖，没有混称同一次完整测试。

最新 release 的全部文件交付场景通过：长英文/emoji/服务器名称并发、同名保护、镜像、外部竞争、明确重下、长编号名暂停重启；343744 字节断点与列表一致。旧宿主创建任务再由新宿主恢复的升级模式也通过，359608 字节一致，旧长 emoji 文件名保留，最终内容逐字节正确，两套 fixture 均清理。日志 /tmp/ndm-night-filename-verified-{delivery,legacy}.log、/tmp/ndm-night-filename-final-{native-tests,unit}.log、/tmp/ndm-night-filename-archive-final-build.log。

最终隔离打包完成，61 个桌面资源逐字节匹配 out，包内宿主与 release 相同，SHA-256 207ae9bcfb1e96f916bc15abcf0fb8c178b12228e8962b55d88b240b20756408。日志 /tmp/ndm-night-filename-verified-package.log。未替换 /Applications/NDM.app，未签名/公证或发布。

补充界面证据：通过 CUA 内置浏览器运行完整已构建 React 界面，使用 CI 合成任务及模拟 IPC。新建下载中选择文件夹失败，错误可见，链接与 /qa/Downloads 原位置保留；设置的报告问题按钮通过 Return 激活失败后显示手动地址，焦点仍在按钮；完整设置的更新面板可见且显示未发布状态。截图 夜间打磨/16-renderer-folder-failure.png、17-renderer-support-failure.png、18-renderer-update-settings.png。这是实际渲染器的交互/布局证据，原生文件夹对话框、外部浏览器及完整原生 IPC 点击链仍待 Mac 解锁后补验。

第三十一批：设置读取失败不能当作空状态。完整渲染器 fixture 中发现周期限速未读成功仍显示关闭、开放空规则编辑保存；等待队列失败同时显示没有任务。周期限速现在首次成功读取前禁用编辑/保存，显示未知状态并提供重新读取；读取错误与保存/校验错误分离，后台恢复仅清除读取错误，保留未保存草稿及保存失败提示。缺失/不完整基础状态返回可理解提示，不暴露 undefined 属性错误。队列读取失败不再宣称为空。

CUA 实际操作完整生产渲染器、模拟服务失败/恢复：初始不能保存或添加；服务恢复后自动解除禁用、清除读取错误；添加并命名“工作时段”，保存失败保留草稿；后台再次断线再恢复，只消除连接错误，保存失败提示仍在。截图 夜间打磨/19-settings-save-failure.png。fixture 服务 127.0.0.1:39130，由 /tmp/ndm-night-settings-state.json 提供合成服务响应；不连接真实引擎、不修改用户限速。

npm test 711 通过/8 跳过，typecheck/build 通过，Impeccable 无发现；日志 /tmp/ndm-night-settings-read-{tests,types,build}.log。qa-workspace 添加对应 CI 交互回归与正确的限速/队列 mock，node --check 通过，本机未执行 Playwright。隔离应用重新打包，61 资源与当前构建逐字节一致、宿主与第三十批 release 一致；未替换正式应用。日志 /tmp/ndm-night-settings-read-package.log。

e40a160 的 CI 35776310287 三个平台全部成功，第三十批 0483cf7 已推送 main，CI 35777606018 正在进行。第三十一批先本地提交，待该轮 CI 完成后推送，避免取消原生检查。原版本号 WIP 保留。此次原生锁屏限制未改变，完整原生设置点击链仍待补验。

第三十二批：默认目录选择器失败反馈。CUA 在完整渲染器按 Return 激活设置“选取”，注入选择器拒绝后无任何界面反馈，控制台出现 Synthetic picker failure；chooseFolder 在保存 try/catch 外被 await。现在整个选择过程受保护，选择期间禁用按钮并显示正在选择，同步 pending 防重复；拒绝显示原目录未更改；取消不保存。设置关闭会使未返回的选择结果失效，避免迟到结果触发目录修改；失败/取消后仅在焦点落回 body 时恢复原按钮，不抢走用户已移动的焦点。

实际 CUA 验收：拒绝后提示可见、/qa/Downloads 保留、焦点回到选取按钮，截图 夜间打磨/20-default-folder-failure.png。第二个隔离 fixture 验证取消选择无错误/无 updateSettings；再注入 10 秒后返回 /qa/Other，等待期间按钮禁用，提前返回应用，结果返回后重新打开仍为 /qa/Downloads，按钮已恢复可用，服务调用日志无 updateSettings。临时 39131 页面/服务器已关闭；这些是模拟原生选择器响应的真实渲染器交互，原生系统对话框仍待解锁验收。

npm test 711 通过/8 跳过，typecheck/build 通过，Impeccable 无发现；日志 /tmp/ndm-night-default-folder-{tests,types,build}.log。CI workspace 增加拒绝/键盘焦点/取消/迟到结果回归，node --check 通过，实际 CI 待推送运行。重新打包 61 项资源与构建一致、宿主与 release 一致；日志 /tmp/ndm-night-default-folder-package.log。未替换正式应用。

第三十批 0483cf7 的 CI 35777606018 已三平台全部成功；第三十一批 481b046 与本批将在当前安全点一起推送。原有 package 版本号修改仍未纳入提交。

第三十三批：补浏览器连接重建后的真实宿主恢复验收。扩展 qa-recovery-host 的两个独立 Relay worker fixture：两资料故意报告相同 sourceID；选定 profile-b 后断开其 WebSocket、重新握手，使用旧 token 的恢复请求必须失败，不向 profile-a 或新连接发 prepare、不改变过期任务地址或旧片段。重新读取取得新 token 后，明确重下恢复原任务；最终文件 524288 字节逐字节一致，所有媒体请求 Cookie/Referer/User-Agent 均来自 profile-b，无跨资料回退。

用当前隔离 App 内 NDMHost 执行新增场景通过，包括既有并发防重、断线重放、旧片段保留与过期恢复请求拒绝；所有 fixture 资料/宿主/本地 HTTP 已清理。日志 /tmp/ndm-night-reconnect-recovery-final.log，SHA-256 d2190707699db01c81eac25a0cefea6e272830c79cf081e46a9071b0a3d4ba19。这是实际宿主和模拟扩展连接，不冒充已在真实 Chrome 配置中重启扩展或验证商店安装。产品逻辑无需改动，补充可重复的联调保障。

复查第三十二批新增 CI 断言时发现 SettingRow 为无障碍保留空 status 节点，取消选择后不会删除节点；将等待 detached 改为等待文本为空，与实际行为一致。node --check 两脚本通过，未本机运行 Playwright。793d676 的 CI 35778865588 尚在运行，等待其结束后推送后续提交。

第三十四批进行中：HTTP 407 代理认证曾被统一为网站重新登录。真实旧包宿主对本地 HTTP 服务的 401/407 均输出 signInRequired、openPage 和来源网站登录提示，日志 /tmp/ndm-night-proxy-diagnostic-baseline.log。保留现有序列化格式，407 单独显示代理认证标题/说明/列表摘要，primaryAction 为 retry，browserRescueURL 不再返回来源网页；401 仍保留来源登录恢复。

已补核心回归与 scripts/qa-http-diagnostics-host.mjs。新调试宿主通过真实 401/407 响应分类，日志 /tmp/ndm-night-proxy-diagnostic-debug.log；该 fixture 是本地 HTTP 返回认证挑战，不是外部代理账号登录验收，未读取凭据或用户下载。CUA 将真实宿主的诊断结果接入完整渲染器合成任务，列表和详情显示代理指引、继续下载，无网页恢复主操作；截图 夜间打磨/21-proxy-authentication-guidance.png，临时 39131 页面/服务器已关闭。

最终完整 test:native 与 build:native 在同一执行会话 96407 顺序运行，当前仍活跃，日志 /tmp/ndm-night-proxy-diagnostic-{tests,build}.log。测试后需用 release 运行诊断 fixture、重新打包核对，再提交本批；不得以当前调试宿主结果冒充最终 release 完成。原 package 版本号 WIP 保留。

CI 35778865588：Windows 通过，Linux 仅新目录选择验收等待空 status 节点 detached 超时；日志 /tmp/ndm-night-settings-ci-linux.log 明确节点为空 sr-only。0c27de7 已将断言修为等待文本为空，尚未推送；macOS 作业仍运行，保留其完成机会。

第三十四批最终完成验证：完整 test:native 通过，680 Engine + 560 Core + 32 Bridge = 1272 XCTest，28 跳过、0 失败，另 11 Swift Testing；release 构建通过（41.69 秒）。最新 release 再跑真实 HTTP 401/407 fixture 通过：401 保留 openPage，407 为 retry、代理认证标题和设置指引；日志 /tmp/ndm-night-proxy-diagnostic-release.log，fixture 清理完成。

重新打包后 61 项桌面资源与 out 逐字节一致，包内宿主与 release 相同，SHA-256 6d70d7a4d79823efa5a39ca918effdc5839a7009423754b3b500ad2f8d9865ae；日志 /tmp/ndm-night-proxy-diagnostic-package.log。未安装到 /Applications、未签名/公证。此批只有 Swift 诊断和独立宿主验收脚本变更，不重新运行无关 UI 构建测试。

CI 35778865588 的 artifact 已下载至 /tmp/ndm-night-ci-renderer-35778865588。report.json 确认前 35 项交互通过、rendererErrors 为空，唯一失败为目录取消后空 status 节点的 detached 断言；0c27de7 已修正。macOS CI 仍在运行，本批先提交，后续等待完成再与该修正一并推送。
