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

第三十五批：周期限速保存/重新读取后的键盘焦点。此前实际渲染器保存失败时按钮被禁用导致焦点落到页面根部。现在仅对用户主动保存/读取记录发起控件；操作结束且焦点仍在 body 时，回到仍可用的发起按钮。放弃编辑后原按钮消失，则聚焦有明确名称的操作结果区域，并显示“已重新读取周期限速规则”。后台轮询不设恢复标记；用户已转移焦点时不强行移动。

CUA 完整渲染器按 Return 保存失败后焦点留在保存按钮；添加规则后按 Return 放弃编辑并重新读取，成功提示可见，焦点在“周期限速操作结果”。截图 夜间打磨/22-schedule-keyboard-feedback.png 已人工查看，焦点框可见。使用模拟服务，不修改真实限速。CI workspace 对保存失败与重新读取结果加入焦点断言，node --check 通过；本机未执行 Playwright。

npm test 711 通过/8 跳过，typecheck/build 通过，最终文案变更重新 build 通过，Impeccable 无发现。日志 /tmp/ndm-night-schedule-focus-{tests,types,final-build}.log。隔离包重新构建，61 桌面文件及宿主逐字节匹配，宿主沿用第三十四批 release；日志 /tmp/ndm-night-schedule-focus-package.log。第三十三、三十四批尚待随 CI 结束后推送。

第三十六批：源文件变化后的原任务重下。旧包真实 HTTP 验收确认 ETag/内容变化时会保护旧片段，但重复“继续下载”仍失败。新增宿主能力标记，仅普通 HTTP/S GET、downloadRecordChanged 且无辅助资源/待选目录的失败任务可用；界面明确显示重新下载并先确认，默认焦点在稍后处理。宿主在任务锁内校验确认、原 URL、恢复代次、队列和运行状态，开启新的恢复目录，保留原任务及旧片段/receipt；过时确认不能重放。旧宿主或不支持的任务不展示该能力。

新增两项原生测试覆盖明确确认、同任务代次切换、数据库重新打开、旧片段/请求元信息保留及非法类型/重放拒绝；前端测试覆盖能力标记和主操作。npm test 713 通过/8 跳过，typecheck/build 通过；完整原生 682 Engine + 560 Core + 32 Bridge = 1274 XCTest（28 跳过、0 失败），另 11 Swift Testing 通过，release 构建通过。日志 /tmp/ndm-night-changed-resource-final-{tests,types,build}.log、/tmp/ndm-night-changed-resource-native-{tests,build}.log。Impeccable 无发现，两 QA 脚本语法检查通过。

扩展 qa-deploy-resume 的 changed-resource 模式：真实宿主下载旧文件前缀、重启后收到变更 ETag、再次继续仍失败、未确认重下拒绝，确认后同 ID 完整下载新的 6 MB 内容，哈希正确，旧片段和 receipt 不变，过时确认拒绝，无重复任务。debug 和 release 均通过；release SHA-256 49a5cafe617f8c9ec8bb34c18513d290d3f26a661407ba5a1033b9bd500993ff。默认未变化模式也通过，从 262144 偏移续传且原本暂停的另一任务保持暂停。日志 /tmp/ndm-night-changed-resource-{debug,release}.log、/tmp/ndm-night-unchanged-resource-release.log。

新增窄 HTTP fixture 将当前完整渲染器的 list/恢复请求连接到隔离真实 Host，其他 Electron 功能仍使用模拟响应。CUA 实际点击重新下载、确认，最终列表显示完成/打开文件，最近完成出现该文件，另一任务仍暂停；截图 夜间打磨/23-changed-resource-confirmation.png、24-changed-resource-completed.png。初版 fixture 未模拟事件通知，虽后端成功但 UI 未更新；为 fixture 加入真实 list 轮询后重新全程验证通过，browserConfirmations=1，日志 /tmp/ndm-night-changed-resource-ui-final.log。此证据不冒充锁屏下原生 Electron IPC/系统对话框验收。

重新打包 61 项桌面文件及包内宿主均与当前构建逐字节一致，日志 /tmp/ndm-night-changed-resource-package.log；未替换正式应用、未签名公证。此前 a199468 CI 35780186878 已 Windows/Linux/macOS 全部成功。本批保留原 package 版本号 WIP，后续提交并推送。

第三十七批：统一批量重试与单项恢复规则。失败视图此前将所有错误任务放入 restartMany，即使单项操作需要登录/重新获取来源/明确重下，批量仍会普通重试。共享 needsInteractiveRecovery 判定单项确认和批量排除；页面仅对可直接重试的数量展示批量按钮，其余项目显示逐项恢复说明。yt-dlp 可自动重新解析来源的 renew 仍可直接重试，需登录的 openPage 保留交互。

CUA 完整渲染器使用三条隔离合成错误任务：网络故障、源文件变化、来源需登录。失败视图显示“重试这 1 项”及另 2 项逐项恢复说明；点击后只有 network-retry 变成下载中，服务调用日志只有 restart/taskID=301。其余两项保留，批量按钮消失；源文件变化行仍打开确认框，默认焦点稍后处理。截图 夜间打磨/25-batch-recovery-guidance.png 已检查，日志 /tmp/ndm-night-batch-recovery-ui.log。此轮模拟服务检验界面路由，真实宿主确认机制由第三十六批验收覆盖。

npm test 714 通过/8 跳过，typecheck/build 通过，Impeccable 无发现；日志 /tmp/ndm-night-batch-recovery-{tests,types,build}.log。qa-workspace 加入相同混合任务及仅一项 RPC/取消不触发恢复的回归，语法检查通过，待 CI 执行。隔离打包 61 项桌面资源及宿主均与构建一致，日志 /tmp/ndm-night-batch-recovery-package.log。a2c7752 CI 35781668145 仍活跃，本批先本地提交，待其完成后推送，避免取消正在运行的原生验收。package 版本号 WIP 保留。

第三十八批：扩展接管的并发回执及重启持久性。扩展 qa-relay-durable-handoff.mjs，两个真实 WebSocket 同时提交同一个新 requestId，验证两份 accepted 回执指向同一任务、只新增一条记录，完成文件 SHA 正确；随后删除该任务并重启 Host，对两个已删除 requestId 重放均返回 deleted，任务没有复活。既有丢失 ACK 后重试、重启复用原回执、同 ID 不同内容拒绝、同 URL 新 ID 可独立下载等场景全部通过。

使用当前隔离 App 内 release NDMHost（SHA-256 49a5cafe617f8c9ec8bb34c18513d290d3f26a661407ba5a1033b9bd500993ff），日志 /tmp/ndm-night-relay-durable-final.log。另运行完整 bg.js VM + 真实 WebSocket/Host 的 --durable --overflow 验收：浏览器下载 pause/cancel/erase 顺序正确；离线队列保留最早的已接收项，21 项接收、1 项明确拒绝，连接恢复后接受项全部完成，重试拒绝项后总计 23 项，各文件哈希一致。日志 /tmp/ndm-night-relay-worker-final.log，worker SHA c6f71c7368d71575e6dc587cc6cfd1a687fef6d198abccdd531fc2e2c6b3eef6。

所有服务器/子进程和自有任务目录已清理。Chrome API 仍为隔离 stub；本批不冒充真实浏览器休眠/商店安装验收。产品逻辑无需改动，只补可重复的真实宿主协议覆盖；脚本语法和 diff 检查通过。CI 35781668145 Windows/Linux 成功，macOS 仍运行，第三十七、三十八批暂本地提交待其完成后推送。

第三十九批：完成文件列表内字幕等附带文件的交付反馈。该区域原本直接 void openFile/revealFile，忽略返回的文件不存在/原目录已打开状态，拒绝也无可见反馈。改为复用 runFileDeliveryAction，显示具体文件名及下一步说明，使用同步 pending 防重复、请求期间禁用操作、卸载后忽略迟到结果；仅焦点落到 body 时恢复发起按钮，提示通过 status/aria-describedby 关联。

CUA 完整渲染器注入两条交付文件和延迟原生响应：Return 打开字幕后暂时禁用，文件不存在提示出现，焦点回到同一打开按钮；定位返回 parent-opened 后明确提示文件不在原位置、已打开原保存文件夹。初版误加与相邻校验面板相同的 key，截图暴露重复区域；删除冗余 key（外层已按任务重挂载）后重建并重新验收，最终只有一个完成文件区域。最终截图 夜间打磨/26-sidecar-file-feedback.png 已检查。本轮验证渲染器和模拟原生响应，不修改真实文件。

npm test 714 通过/8 跳过，typecheck/build 通过；最终 key 修正后再次 typecheck/build 通过，Impeccable 无发现。日志 /tmp/ndm-night-artifact-feedback-{tests,types,build}.log、/tmp/ndm-night-artifact-feedback-final-{types,build}.log。CI workspace 新增缺失文件/定位到原目录/拒绝异常/键盘焦点及单一区域断言，使用原生 summary 选择器，语法通过，待远端运行。

最终隔离打包 61 项资源和宿主逐字节一致，日志 /tmp/ndm-night-artifact-feedback-final-package.log；未替换正式应用。CI 35781668145 Windows/Linux 已成功，macOS 尚活跃，待完成后推送本批及前两批；package 版本号 WIP 保留。

第四十批：多选工具栏继续操作也遵守交互恢复规则。除第三十七批失败视图批量重试外，多选“继续所选”是独立的 resume 路径；现在它的可用数量排除需交互恢复项，且 store 在一次最新 list 响应后再按相同规则筛选，防止显示快照过时导致误发恢复。全部视图多选时也显示需要逐项恢复的数量；暂停行为不变。

新增权威快照回归：显示仍为 paused，但实际任务分别已变为需登录、需确认重下、普通暂停、yt-dlp 可自动重新读取；最终只向后两项发 resume。CUA 三条混合错误任务全选后，点击继续所选仅向 taskID=301 发一个 resume，另两项保留恢复/重新下载入口，工具栏不再显示继续按钮。截图 夜间打磨/27-selection-recovery-guidance.png 已检查，调用日志 /tmp/ndm-night-selection-recovery-ui.log；隔离模拟服务，未操作真实任务。CI workspace 同时扩展多选路径断言，语法检查通过。

npm test 715 通过/8 跳过，typecheck/build 通过；日志 /tmp/ndm-night-selection-recovery-{tests,types,build}.log。Impeccable 无发现，重新打包 61 项文件及宿主与构建逐字节一致，日志 /tmp/ndm-night-selection-recovery-package.log。CI 35781668145 macOS 测试步骤仍运行，前两平台已成功；继续保留该次检查，完成后推送待发提交。package 版本号 WIP 不变。

第四十一批：当前隔离发行包的强制退出/恢复与写盘验收。先改 qa-offset-host 的运行隔离：HOME/CFFIXED_USER_HOME/TMPDIR 均指向本轮 mkdtemp，自有下载/支持/偏好目录在宿主停止后清理，只保留报告，不读取真实用户偏好。

使用当前包内 Host（SHA-256 49a5cafe617f8c9ec8bb34c18513d290d3f26a661407ba5a1033b9bd500993ff）实际运行 64 MB、32 路 HTTP 测试：32 个初始 Range，峰值并发 32；暂停时已持久化 1245184 字节，等待后已保存前缀及文件哈希完全不变；继续过程中 SIGKILL，重新启动同一隔离 Host 后恢复完成，最终 SHA-256 一致，无残留 partial、只有一个最终载荷，峰值分配量约为载荷 1.00049 倍。日志 /tmp/ndm-night-offset-crash-final.log。

独立 8 MB/4 路 speculative-tail 测试：观察到真实动态分段后立即 SIGKILL；读取持久化 journal 确认子分段来源；重启后本地服务对该子分段返回 416，引擎记录 Segment Rolled Back To Socket 并保留父段已有前缀继续，最终文件 SHA 一致，初始父段请求没有被重开。日志 /tmp/ndm-night-tail-crash-final.log。两次 fixture 结束后目录均只剩 report.json，子进程/服务已退出。产品逻辑无需修改；脚本语法及 diff 检查通过。

a2c7752 的 CI 35781668145 三平台已全部成功；第三十七至四十批 b7d7669/fc22d4a/507811d/ac65cd9 已推送 main，当前 CI 35782822661 运行中。本批先本地提交以保留当前 CI 完成机会。原 package 版本号 WIP 未改。

第四十二批进行中：已用当前包复现普通 ZIP 下载收到 HTML 后被错误标记完成。直接 HTML 响应落盘 document.zip.html；HEAD 宣称 application/zip、GET 改为 text/html 的响应直接以 changed-after-head.zip 完成。两文件内容均确认为登录网页。基线日志 /tmp/ndm-night-html-response-cases-baseline.log，合成 HTTP 与独立支持/HOME，未访问用户账号。

实现中：macOS 原生下载器对已知二进制/文档/媒体文件扩展名检查 HTML/XHTML 响应类型，在探测结果和真正传输响应两处阻止，明确 .html/.txt/无扩展端点不建立此限制；新增 unexpectedWebPage 持久化诊断，不伪装成 HTTP 错误或确定的登录失败。渲染器说明未取得所需文件，有来源时提示按需登录重新获取，无来源时说明回原网页。范围是明确 HTML MIME 与已知文件意图冲突，不宣称对伪报为二进制的任意网页做内容识别，也尚未覆盖 Windows aria2 引擎。

调试 Host 三场景已通过：上述两种 ZIP 响应进入 error、没有输出文件，明确 .html 请求完整保存成功；日志 /tmp/ndm-night-html-guard-debug.log。新增两项 HTTPFileResponsePolicyTests 通过；npm test 716 通过/8 跳过，typecheck/build 通过。CUA 真实宿主诊断接入合成完整渲染器，列表/恢复框解释网页响应，无来源时不虚构打开来源动作，默认焦点稍后处理。截图 夜间打磨/28-unexpected-webpage-guidance.png 已检查。

完整 test:native -> build:native 正在会话 74670 顺序执行，日志 /tmp/ndm-night-html-guard-native-{tests,build}.log。本批尚未提交/重新打包，必须等待全量测试后用 release 重跑 scripts/qa-html-file-response-host.mjs，再复验普通下载恢复并核对隔离包。当前调试成功不得当成最终发行构建验证。

第四十二批最终验证完成：完整原生 684 Engine + 560 Core + 32 Bridge = 1276 XCTest（28 跳过、0 失败），另 11 Swift Testing 通过；release 构建通过（44.04 秒）。追加 302 -> /login 的 HTML 响应场景后，release 的三种 ZIP 请求均返回 unexpectedWebPage 且不发布文件，显式 .html 完整保存；输出目录仅 saved-page.html。日志 /tmp/ndm-night-html-guard-release.log。普通 6 MB 文件重启续传仍从 262144 偏移开始、哈希一致、另一暂停任务未被唤醒，日志 /tmp/ndm-night-html-guard-resume.log。宿主 SHA-256 9140a5f891de86ecc360845b5d95314397e804bcbd5ba2bb12c459e7cccbc14f。

最终重新打包 61 项桌面文件与构建一致，包内宿主与 release 逐字节一致，日志 /tmp/ndm-night-html-guard-package.log。未替换正式应用、未签名公证。脚本/差异检查通过，保留用户版本号修改。本批先提交，待活跃 CI 完成再与第四十一批一并推送。

CI 35782822661 Windows/Linux 成功，macOS 仍运行。已下载 /tmp/ndm-night-ci-renderer-35782822661/report.json 核对 42 项真实 CI 界面测试全部通过，包含完成附带文件缺失/焦点、批量和多选恢复等新增检查，rendererErrors=[]；这比仅检查作业状态提供更具体的覆盖证据。

第四十三批：将真实宿主验收纳入 macOS CI。native 作业在 release NDMHost 构建后，运行网页误响应拦截、源文件变化后原任务确认重下、扩展持久回执去重三个隔离 fixture；增加与桌面作业一致的 Node 22 环境。这些验收直接校验下载输出、旧片段/receipt 以及请求去重，不仅检查函数返回值。沿用 20 分钟作业限制，fixture 不需要浏览器资料或外部站点。

命令验证使用当前 release（SHA-256 9140a5f891de86ecc360845b5d95314397e804bcbd5ba2bb12c459e7cccbc14f）：HTML 四场景见第四十二批最终报告；改动后的原任务确认重下再次通过，日志 /tmp/ndm-night-ci-host-recovery.log；并发/断线/重启/删除回执九项协议断言通过，日志 /tmp/ndm-night-ci-host-durable.log。js-yaml 成功解析更新后的工作流且三个命令节点齐全；最初尝试 yaml 包不可用，改用仓库已有 js-yaml，无新增依赖。diff 检查通过。

此前 ac65cd9 的 CI 35782822661 三平台已全部成功；第四十一、四十二批已推送 main，当前 c179d07 CI 35784030014 正在运行。本批工作流先本地提交，待该轮结束后推送；新 CI 步骤的远端执行仍待确认，不将本地命令通过当成远端通过。原版本号 WIP 不变。

第四十四批：单条添加同样使用持久创建意图与回执。隔离完整渲染器模拟“宿主创建成功、回复丢失”：旧版显示添加失败，再次点击后任务数从 8→9→10，确认重复创建风险。普通文件与当前媒体单项现在在发送请求前保存带 creationKey 的准确请求，复用现有加密清单存储；回执存在则接受原任务，回执暂不可读则保留待确认项，确认操作不重发创建。已接收但没有任务对象时也不会重新建任务。整批媒体仍沿用原路径（其原生协议不支持单项 creationKey），浏览器页面媒体沿用其已有独立回执路径。

CUA 当前最终构建验收：丢失回复但回执可读时自动关闭添加框且总数仅 9；回执连续两次不可读，点击确认仍为 9，关闭再打开恢复原清单，第三次查询恢复后明确显示已添加且仍为 9。单项原始输入不重复保存到清单输入框。注入保存失败时引擎未收到 add、总数保持 8，并保留可重试项目与未保存反馈。截图 夜间打磨/29-单条添加回执恢复.png 已检查。此处使用合成 preload/RPC 验证真实渲染器，不冒充真实断网；底层持久回执与宿主重启去重已有第三十八、四十三批真实协议验收。

npm test 716 通过/8 跳过，typecheck/build 通过，Impeccable 无发现，diff/脚本语法检查通过；日志 /tmp/ndm-night-single-{tests,types,build,package}.log。CI workspace 新增单条丢回复自动确认、关闭恢复、无重复输入、确认不重发、保存失败不发请求检查，远端结果待验证。最终隔离包 61 项桌面资源与构建一致，宿主 SHA-256 9140a5f891de86ecc360845b5d95314397e804bcbd5ba2bb12c459e7cccbc14f 与当前 release 一致；正式应用未替换。

此前 c179d07 的 CI 35784030014 三平台已全部成功。本批与第四十三批一并推送，后续须检查新增 CI 用例与真实宿主工作流；用户版本号 WIP 保留。

第四十五批：确认创建结果后的键盘焦点。第四十四批 CUA 显示待确认项目清空后原按钮变为禁用，焦点落到 AXWebArea。现在仅在焦点仍属于发起控件或 body 时恢复：还有待确认项则回到可用的确认按钮，全部确认完成则回到链接输入框；用户主动移到其他字段时不抢焦点，关闭窗口也不恢复。

CUA 最终构建使用连续两次不可读、第三次恢复的合成回执：Return 确认失败后 AX 焦点为“确认 1 项”；再次 Return 后显示已添加、总任务仍 9，AX 焦点为下载链接，截图 夜间打磨/30-确认完成键盘焦点.png 已检查。CI workspace 补对应两个焦点断言。npm test 716 通过/8 跳过，typecheck/build 通过，Impeccable 无发现；日志 /tmp/ndm-night-confirm-focus-{tests,types,build,package}.log。最终隔离包 61 项桌面资源与构建逐字节一致，Host 与既有 release 一致，未替换正式应用。

ef3c55d 的 CI 35785417367 Windows/Linux 已通过，macOS 仍活跃。下载并核验 /tmp/ndm-night-ci-renderer-35785417367/report.json：43 项界面检查全部通过、rendererErrors=[]，明确包含第四十四批单条创建丢回复/关闭恢复/保存失败不发请求检查。本批先本地提交，待当前原生 CI 完成后推送，保留用户版本号 WIP。

第四十六批：真实目标盘 ENOSPC 与恢复交付验收。新增 scripts/qa-disk-full-host.mjs，macOS hdiutil 创建独立 128 MB APFS 映像、自有挂载点、HOME/支持目录与两组端口；先核实容量上限及不同文件系统设备号，再仅向该映像写随机占位数据直到系统实际返回 ENOSPC。下载内容为本机 HTTP 合成的 32 MB 随机文件，检查最终文件在出错时尚未发布、diskFull 诊断、保留检查点、释放占位文件后同一任务续传及最终 SHA-256。finally 停止宿主/HTTP、卸载并清理自有映像，未填充系统盘或改动用户下载。

首次设备检查误用了 Node statfs 不提供的 fsid，安全断言在写占位数据之前失败并清理；改用 stat.dev。首次无检查点运行也澄清了持久性边界：显示已写约 1.4 MB，但 ENOSPC 导致同步失败时 durablePrefix 合法地仍为 0，不能据显示进度断言可复用这些字节。最终保留两条验收路径：默认先暂停取得 262144 字节的已确认检查点，再恢复传输并填满磁盘，错误后的检查点保持 262144；--without-checkpoint 则验证从实际持久前缀恢复（本次为 0），两者最终文件均与原始内容一致，不丢弃已确认字节，不信任未提交进度。

最终两模式日志 /tmp/ndm-night-disk-full-final.log 与 /tmp/ndm-night-disk-full-uncommitted-final.log；均 passed=true、actualENOSPC=true、sameTask=true、cleanup=true。调用方式：node scripts/qa-disk-full-host.mjs native/.build/release/NDMHost [--without-checkpoint]。这是 macOS 本地设备验收，未加入依赖挂载权限的跨平台 CI。

另用 --browser-ui 通过窄 HTTP 适配器将真实隔离 Host 接入当前完整渲染器：CUA 列表显示磁盘空间不足；测试占位已释放后按 Return 触发继续，真实 Host 恢复，界面进入最近完成，任务总数仍 1；适配器断言 resume 仅 1 次。等待完成的定位调用短暂超时，随后现有页面 AX 明确显示已完成，未重启或重试任务。截图 夜间打磨/31-真实磁盘不足.png、32-磁盘恢复后完整下载.png 已检查，最终 SHA 一致，日志 /tmp/ndm-night-disk-full-ui.log；临时映像和进程均已清理。当前 Host SHA-256 9140a5f891de86ecc360845b5d95314397e804bcbd5ba2bb12c459e7cccbc14f。

本批无需修改产品逻辑；新增验收脚本语法/diff 检查通过，两个命令模式及真实 UI 模式均运行通过。此前 ef3c55d CI 35785417367 原生 swift test 已成功，正在 release 构建，第四十五批仍等待其结束后一起推送。

第四十七批（进行中）：同一目标盘重新挂载后的断点恢复。隔离两张 128 MB APFS 映像：第一张下载至检查点并停止宿主，卸载后让第二张占用原设备槽，再将第一张挂回同一路径并重启宿主。旧 release 实测设备号 16777239→16777243，文件 inode/创建时间/内容均一致，却返回 downloadRecordChanged；原检查点与文件保留。基线日志 /tmp/ndm-night-remount-baseline.log，映像均已卸载清理。

修复为 offset v2 元数据增加可选 volumeUUID，在已持有的父目录 FD 上用 fgetattrlist 取得 ATTR_VOL_UUID，避免按路径查询引入路径替换竞态。仅在 UUID 与目录 inode/创建时间吻合时将瞬时设备号重新绑定；文件仍单独核对 inode/创建时间、同卷与非符号链接要求。恢复和只读检查共用此逻辑，写入热路径不增加 UUID 查询。旧记录没有 UUID 时仍严格要求原设备号，正常加载后可在下一次已有元数据提交中带上 UUID；不能凭旧记录猜测重挂载后的卷归属。

API 依据：Apple [volumeUUIDString](https://developer.apple.com/documentation/foundation/urlresourcevalues/volumeuuidstring) 定义持久 UUID，以及 [getattrlist/fgetattrlist 手册](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/man/man2/getattrlist.2)。同时用当前 Xcode-beta SDK 头文件与最小 Swift 调用核实 FD 读取，返回 UUID 与 Foundation 一致。初次原型混合 Int32/UInt32 常量导致编译错误，已显式转换各常量；未进入产品运行。

新增 4 项安全/兼容测试：同 UUID 不同设备号能恢复且只读检查不改元数据；错 UUID 时检查/恢复/清理都拒绝且字节不变；旧记录保持设备号约束；正确 UUID 仍拒绝目录创建身份变化。OffsetDownloadStorageTests 共 33 项通过。调试 NDMHost 的实际卸载/换设备号/重启恢复已从 262144 字节检查点完成、文件哈希一致，日志 /tmp/ndm-night-remount-debug.log；脚本 scripts/qa-volume-remount-host.mjs 还需用最终 release 重跑。

完整 npm run test:native → npm run build:native 正在会话 22657 顺序执行，日志 /tmp/ndm-night-remount-native-{tests,build}.log。本批产品修改尚未提交；须等完整测试后完成 release 重挂载验收、磁盘耗尽回归与最终包核对。当前 main/origin 为 0582c15，CI 35786608030 Windows/Linux 成功、macOS 活跃。不要把调试成功或前一轮 CI 当成本批最终验证。

等待本批全量原生测试期间，已核对 0582c15 CI 界面产物 /tmp/ndm-night-ci-renderer-35786608030/report.json：43 项通过、rendererErrors=[]，其中单条创建检查包含第四十五批确认失败留在按钮/确认完成回到输入框的两个焦点断言。该远端证据覆盖已提交的 UI 改动，不包含当前未提交的磁盘身份修复。

第四十七批最终验证完成：完整原生 688 Engine + 560 Core + 32 Bridge = 1280 XCTest（28 跳过、0 失败），另 11 Swift Testing 通过；release 构建 38.96 秒。最终 release 重挂载验收保持同一任务、从 262144 字节起点发出实际 Range 请求并完成 8 MB 文件，SHA 与源数据一致；磁盘耗尽后的 32 MB 同任务恢复仍通过；源文件变化继续拒绝普通重试，明确确认重下后旧检查点/旧数据仍保留且过时确认拒绝重放。日志 /tmp/ndm-night-remount-release.log、/tmp/ndm-night-remount-disk-full.log、/tmp/ndm-night-remount-changed-resource.log。

最终宿主 SHA-256 a1cf7888ec79aece1f0373afe9c9af6ab88bcb3ee78d1fbd1c7381b3dbf462f9；隔离包 61 项桌面资源与 out 逐字节一致，包内宿主与 release 一致，日志 /tmp/ndm-night-remount-package.log。脚本语法与 diff 检查通过。验证范围为 APFS 同一路径重挂载后的 offset v2 下载；不宣称自动查找改变挂载路径的磁盘，也不把缺 UUID 的历史记录猜测为可跨设备恢复。正式应用未替换，自有映像/任务/进程均已清理。本批先提交，待活跃 CI 35786608030 完成后推送；用户版本号 WIP 不变。

第四十八批：安装结果的定位反馈。TransferActivity 安装完成态原先 void revealFile 后立即关闭提示，安装失败/取消态也忽略定位结果；隔离渲染器返回 parent-opened 时，旧版提示消失且没有说明。现改为等待共享 runFileDeliveryAction：正在定位时锁住同一区域操作，缺失/异常留在原提示并可重试，仅安装完成且定位真正成功时关闭；使用原有请求代次隔离迟到结果，失败后仅在焦点掉到 body 时恢复发起按钮。普通下载完成定位保留其已有 App 级反馈。

CUA 最终构建验收：Return 定位期间两按钮禁用；parent-opened 显示原文件不在原位置/已打开保存文件夹，提示保留且焦点回到定位按钮；Promise 拒绝显示暂时无法定位；较新安装失败状态到达后，较早定位回包不能覆盖新说明；成功返回空字符串后才关闭提示。截图 夜间打磨/33-安装结果定位反馈.png 已检查。这里模拟系统定位返回值，不实际打开或修改用户应用文件。

npm test 716 通过/8 跳过，typecheck/build 通过，Impeccable 无发现；日志 /tmp/ndm-night-install-reveal-{tests,types,build,package}.log。CI workspace 增加上述等待/反馈/焦点/迟到结果/成功关闭检查，脚本语法与 diff 通过，远端待运行。最终隔离包 61 项桌面资源与 out 一致，Host SHA-256 a1cf7888ec79aece1f0373afe9c9af6ab88bcb3ee78d1fbd1c7381b3dbf462f9 与当前 release 一致。正式应用未替换。e88b169 CI 35787720220 Windows/Linux 成功、macOS 活跃，本批先本地提交待其结束后推送；用户版本号 WIP 保留。

第四十九批：添加视频时打开浏览器的失败反馈。BrowserPageMediaPicker 与 Composer 媒体解析失败卡片原先忽略 openExternal 返回 false 或 Promise 拒绝；现在共用 useExternalLinkAction，等待时禁用并显示正在打开，失败保留可重试提示，焦点掉到 body 时恢复发起按钮。URL 变化、关闭或卸载会使旧回复失效，不把旧链接错误带到新链接。

CUA 在最终构建的隔离渲染器验证两个入口等待/false 反馈/焦点恢复；700ms 迟到回复期间切换为普通文件链接后无错误残留；通用视频入口 Promise 拒绝也显示同样可重试反馈。截图 夜间打磨/34-打开浏览器失败反馈.png 已检查。系统调用结果由本地夹具模拟，未打开真实网站或接触用户会话。新增 CI workspace 检查还包含重试成功清除错误与调用 URL 数量，等待远端执行。

npm test 716 通过/8 跳过、typecheck/build 通过，Impeccable 无发现；日志 /tmp/ndm-night-browser-feedback-{tests,types,build,package}.log。隔离包 61 项桌面资源与 out 逐字节一致，Host SHA-256 a1cf7888ec79aece1f0373afe9c9af6ab88bcb3ee78d1fbd1c7381b3dbf462f9 与 release 一致。临时夹具页面/进程已清理，正式应用未替换，版本号 WIP 保留。e88b169 CI 原生测试已成功、release 构建仍在执行；本批与第四十八批待该轮结束后一起推送，避免取消其完整原生验收。

05:52 更新：e88b169 的 CI 35787720220 三平台全部成功，完整原生测试/release/三个真实 Host 验收均完成；已将第四十八、四十九批推送到 origin/main 314db8b，新 CI 35788979739 正在执行。

第五十批：详情页保存位置、来源网页、下载链接的打开反馈。此前这三处忽略系统返回结果，定位失败或打开失败无提示。DetailValue 现在等待异步结果，锁住重复点击，并将失败说明保留在对应字段；保存位置复用既有文件交付结果解释，来源链接使用固定简明错误文案。仅在发起操作后焦点掉到 body 时恢复按钮，初次展示不抢焦点；字段变化或任务卸载使旧回复失效。

CUA 最终构建隔离验收三个字段的等待、失败、可重试、焦点恢复；定位尚未回复即切换任务，后续确认新任务没有旧文件/浏览器错误残留。截图 夜间打磨/35-详情页文件与来源反馈.png 已检查。系统回复由合成夹具模拟，没有打开用户文件或网站。新增 CI workspace 检查覆盖同样状态与任务切换，远端待本批推送后执行。

npm test 716 通过/8 跳过、typecheck/build 通过、Impeccable 无发现，日志 /tmp/ndm-night-detail-feedback-{tests,types,build,package}.log；隔离包 61 项桌面资源与 out 一致，宿主与当前 release 逐字节一致。临时夹具页面/进程已清理。用户版本号 WIP 未动，正式应用未替换。本批先本地提交，待 CI 35788979739 结束后推送，避免取消上一轮原生验收。

第五十一批：首次接管下载的保存目录竞态。DestinationDialog 在用户已经选择有效目录后，迟到的 getSettings 空结果仍会显示“未能读取默认目录，请选择保存位置”。用 12 秒延迟默认值、300ms 目录选择的隔离渲染器实际复现：/qa/Chosen 已显示、确认按钮可用，却出现矛盾错误。现尊重 edited 标记，不再用迟到默认值误报用户选择；选择器等待有明确文本/aria-busy，并使用同步 pending 防重复请求。目录选择结束和确认失败后，仅当焦点掉到 body 时恢复发起按钮。

CUA 最终构建复验：选择 /qa/Chosen 后收到空默认设置，目录保持且无错误；确认返回失败，目录仍保留、按钮恢复可用、焦点回到确认按钮。截图 夜间打磨/36-目录确认失败保留选择.png 已检查。新增 CI 检查精确控制默认值、选择器与确认回复顺序，远端待执行。夹具只模拟目录选择和确认，没有修改用户任务或默认下载目录。

npm test 716 通过/8 跳过、typecheck/build 通过、Impeccable 无发现，日志 /tmp/ndm-night-destination-{tests,types,build,package}.log。隔离包 61 项桌面资源与 out 一致，Host 与当前 release 逐字节一致；临时页面和服务器已清理，正式应用未替换。314db8b CI 35788979739 Windows/Linux 成功，macOS 活跃；其已下载界面报告 /tmp/ndm-night-ci-renderer-35788979739/report.json 中两个新增浏览器/安装定位检查通过且 rendererErrors=[]。第五十、五十一批待该 CI 终结后推送。

第五十二批：浏览器恢复后的宿主重启与续传验收。扩展 scripts/qa-recovery-host.mjs 的 --restart-recovery 模式：两个独立 Relay 协议连接、真实失败任务、保留旧片段、明确选择 profile-b 获取新资源；8 MB 新下载开始后暂停并重启 release Host，然后沿用同一任务继续。新增实际 HTTP 非零 Range 断言，核对新 generation、文件名、目录、来源网页、仅所选浏览器的请求凭据以及最终字节。隔离 HOME 与支持目录，不使用真实浏览器资料或生产数据。

最终运行 /tmp/ndm-night-recovery-restart.log 通过，暂停检查点 2375680 字节；重启后非零 Range 请求成立，8 MB SHA-256 43dd1899f8637d264e067f5cef676862aee24e8de2e549575d5722cc3769d4c5 与源数据一致。旧 seg.x99 不变，过时恢复请求拒绝，任务仍为两条无重复；已有 512 KB 基线模式也通过（/tmp/ndm-night-recovery-baseline.log）。两个模式均确认 Host/临时支持目录/HTTP 服务清理完成。

此批只加强验收和 CI，未改产品引擎。macOS CI 增加该真实 Host 重启恢复场景；等待循环为慢速 CI 适当放宽上限，不改变成功断言。脚本语法/diff 检查通过。证明范围是选定浏览器协议连接的本地受控资源，不等于真实 Chrome Store 安装、公开网站或任意文件网页的自动换址恢复。

第五十三批：实际网络中断与启动重试上限。新增 scripts/qa-network-recovery-host.mjs，运行 release Host 与本地 HTTP 服务、隔离 HOME/支持目录/下载目录/端口。第一场景在每次传输 64 KB 后强制断开连接，共 4 次；不手动暂停或重试，验证同一任务自动继续且每次实际 Range 起点增加。第二场景 HEAD 正常但文件请求始终返回 503/Retry-After: 0，验证启动期三次自动重试后进入可重试错误，随后不再发送请求。

/tmp/ndm-night-network-recovery.log 通过：Range 起点 [0,65536,131072,196608,262144]；2 MB 随机文件 SHA-256 c8b3f5986c09e39d97cfb7ece2d0f614f1ec2c0fdafa53aa6178f9d4ccf7b095，与原数据逐字节一致；503 请求总数 4（初次 + 三次重试），最终 completedBytes=0、diagnostic.primaryAction=retry，额外观察仍无请求。两条任务相互独立，Host/支持目录/服务已清理。

本批不改引擎重试政策，只增加可重复验收并纳入 macOS CI。启动期有界重试证据不能扩展成“所有已有进度的网络中断都有次数上限”；现有引擎允许已传输数据的任务继续恢复，避免把正常断续网络当成不可恢复错误。脚本语法/diff 通过，远端执行待推送。
