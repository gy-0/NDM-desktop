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
