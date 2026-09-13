# Motrix Next / Rayburst 功能对照与复用实施记录

核查日期：2026-09-14。用户要求覆盖日常下载可靠性、任务管理/自动化、新协议三个方向。这个范围用于分批交付，不把研究、代码完成、测试通过和安装可用混为一谈。

## 对照基线与协作

- 上游：`AnInsomniacy/motrix-next`，锁定 `83dcd3c6ef1e8d31f9aaff1bf4b6bf0588a99fa3`。源码已改名 Rayburst，公开发行版仍叫 Motrix Next。[源码说明](https://github.com/AnInsomniacy/motrix-next/blob/83dcd3c6ef1e8d31f9aaff1bf4b6bf0588a99fa3/README.md)
- NDM 审计基线：`dd5aa84e5accbfd8891a9a51e5533a9bbdaffe91`。首批实现已无冲突 rebase 至 UI 提交 `4f2493e6afae87fa98e786de7e13abec145e12be`；主仓库其后的 UI 与 Douyin 工作不属于本次补丁。
- 功能 worktree：`codex/motrix-functional-upgrades`。UI 任务“评估并集成组件动效”拥有 App、TaskGallery、CompletionPocket、相关样式/预览/视觉 QA、版本号和当前 Applications 部署。
- 两条工作线不共享构建输出、数据库、QA 端口或安装流程。功能补丁通过独立提交协调合入。
- GitHub API 当日返回 10,205 stars、317 forks、7 名提交贡献者；主要作者 1,402 次提交，其余分别 3、1、1、1、1、1。关注度和提交数都不等于模块质量或真实用户验收。

## 许可证与复用方式

主应用为 [MIT](https://github.com/AnInsomniacy/motrix-next/blob/83dcd3c6ef1e8d31f9aaff1bf4b6bf0588a99fa3/LICENSE)。可复制、修改、移植和商业分发，复制代码时必须保留版权与完整许可声明。每个引入模块记录原路径、固定提交、改动、测试来源，并将声明纳入应用已打包的 `THIRD_PARTY.md`。

独立 [Aria2 Next](https://github.com/AnInsomniacy/aria2-next) 引擎采用 GPL 系列许可，不能因为外层应用是 MIT，就把引擎当 MIT 源码移植。采用辅助进程时也须核查实际版本、源码交付和捆绑依赖的许可义务；进程分离本身不是自动豁免。NDM 当前未在根 package 声明产品许可证，本批不会替用户擅自更改产品许可。

复用优先次序：已有 NDM 模块满足要求时增强原模块；上游纯逻辑通过依赖/边界审查后直接移植；复杂协议采用经过契约验证的独立引擎。保留 NDM 的原生 HTTP 分段存储、恢复账本、浏览器会话边界和媒体流程。

## 功能矩阵

此表是代码审计，不代表已完成跨平台实机验证。NDM 两个平台的能力分别列出，不能把 Windows 的实现算到 macOS。

| 功能 | 上游覆盖 | NDM 当前情况 | 工作方向 |
| --- | --- | --- | --- |
| HTTP/HTTPS 分段、暂停恢复 | 有 | macOS 原生实现；Windows aria2 | 保留现有引擎，比较失败处理与恢复契约 |
| FTP | 当前上游核心方向为 HTTP/SFTP，不能假设仍支持 FTP | macOS 有 PASV/REST；Windows 标准 aria2 有 | 修复完成真实性、限速与代理数据通道缺口 |
| SFTP | 有 | 两端输入/引擎白名单未接入 | 辅助协议引擎、主机密钥校验和认证入口 |
| BT/magnet/torrent | 元数据、文件选择、peer、Tracker、分享策略 | Windows 基础 BT；macOS 不支持；共享输入却接受 magnet | 统一能力声明、元数据选择流程、持久化和做种生命周期 |
| ED2K | 自有 Aria2 Next 扩展 | 无 | 独立验证 fork 的 RPC/恢复/安全契约后接入 |
| Thunder | 包装链接交由 Aria2 Next 解析 | 本批新增 HTTP/HTTPS/FTP 包装解析 | 保留签名 URL；不是迅雷 P2P 引擎 |
| 多链接批量 | 有，支持 aria2 input-file 格式和镜像分组 | 已有提取、去重、有序提交、失败重试、加密草稿 | 补可审阅导入；不要重复实现已有批量入口 |
| HLS/DASH/直播 | manifest、音视频字幕选择、录制保存 | NDM 已有媒体预检、直播、合并、Relay 会话、站点解析 | 比较断开、完成和字幕边界；保留现有站点能力 |
| 完整性校验 | aria2 checksum/BT 校验 | 无通用用户文件校验入口；现有 hash 多为请求/恢复指纹 | 新增流式文件校验与期望摘要核对，独立于成功进度 |
| 队列 | 并发、排序、任务控制 | 有并发/串行和集合队列，普通等待队列可能后进先出 | 明确 FIFO、手动重排和暂停/预约约束 |
| 全局/单任务限速 | 有 | 有，原生 FTP/HLS 的覆盖不完整 | 补齐协议覆盖与运行中修改回执 |
| 周期速度规则 | 有 | 有单次预约和临时限速自动恢复 | 周期时间窗口、跨午夜/时区/DST、失败重试 |
| 代理 | 可按范围配置 | 已有 HTTP/SOCKS，FTP 控制/数据连接覆盖不同 | 比较真实出口与凭据作用域，逐协议验证 |
| 分类/目录 | 扩展名、URL 规则、常用/最近目录 | 已有分类子目录和显式任务目录 | 复用分类匹配器前修正通配符语义；用户显式目录优先 |
| 完成动作 | 托盘、通知、keep-awake、电源动作 | 已有通知/打开/定位/安装流程；无完成后睡眠/关机 | 用户可取消的一次性完成动作，活动任务/录制阻止误触发 |
| 历史/恢复 | 本地账本、原生后台运行 | SQLite/原子 JSON、分段恢复、创建回执已有 | 按具体失败对照；保持单一任务账本和稳定 ID |
| 诊断 | 错误码、脱敏日志导出 | macOS 结构化诊断较完整；Windows 常用原始错误文本 | 直接复用 aria2 错误分类，接现有失败展示 |
| 设置导入导出 | 版本化备份 | 无统一用户设置备份入口 | 版本迁移、严格校验、排除凭据、原子应用/回滚 |
| 远程 RPC 管理 | 本次未独立确认可用产品入口 | 现有均为内部 loopback 通信 | 独立产品扩展，不把内部 RPC 宣称为远程管理功能 |

NDM 主要证据：`src/main/windows/{windowsEngine,engineCore,aria2Rpc}.ts`、`native/Sources/NDMEngine/{DownloadManager,FTPEngine,DiagnosticClassifier}.swift`、`native/Sources/NDMCore/Storage/DownloadStore.swift`、`src/renderer/src/lib/{composerBatch,sharedLink}.ts`、`src/main/{composerDraft,temporaryBandwidth}.ts`。

## 可直接复用的候选与边界

| 固定上游路径 | 适合 NDM 的用途 | 必须处理的适配 |
| --- | --- | --- |
| `src/shared/aria2ErrorCodes.ts` | aria2 错误码语义映射 | 替换 Vue i18n 类型，接 NDM 中文提示与脱敏；未知错误保留诊断价值 |
| `src/shared/utils/headerSanitize.ts` | 浏览器请求头白名单、数量/长度限制、丢弃原因 | 修正 DEL/NUL 等控制字符边界，不扩大 NDM 的凭据传递权限 |
| `src/shared/utils/batchHelpers.ts` | aria2 input-file 解析、镜像组、文件名解码 | 多镜像是一项任务；受支持选项白名单；不能丢镜像语义后逐条下载 |
| `src/shared/utils/fileCategory.ts` | 扩展名/URL 分类匹配 | 修正 wildcard `?` 转义；尊重用户显式保存目录；限制正则成本 |
| `src/shared/utils/proxy.ts` | 代理配置正规化与选项策略 | 与 NDM HTTP/SOCKS 优先级、作用域、凭据生命周期对齐 |
| `src/shared/utils/settingsBackup.ts` | 带版本的备份封装/校验 | 不直接序列化 NDM 全部设置；排除密钥，先验证再原子应用 |

本批已直接移植 `aria2ErrorCodes.ts` 的全部 29 项语义映射，在 `src/main/windows/aria2Errors.ts` 保留固定来源与映射，在 `THIRD_PARTY.md` 保留完整 MIT 许可；中文恢复建议和脱敏是 NDM 的适配。其余行仍是候选。上游 Tauri/Vue/Rust 的任务服务、数据库和系统 API 不适合整目录搬进 Electron/React/Swift。

已核实的上游质量边界：在固定源码的纯函数上运行，`sanitizeSingleHeaderValue` 保留 DEL，而 Node HTTP 拒绝该字符；`sanitizeHttpHeaderOptions` 保留 NUL；分类 wildcard 对含 `?` 的规则存在匹配偏差。速度调度还有“先更新窗口状态、RPC 失败后同窗口不再重试”的静态风险。这些发现用于筛选复用方式，不代表整个项目不可靠。

## 分批实施与验收

### 第一批：已有下载的完成真实性与失败诊断

- FTP：校验 SIZE 解析、已知长度和最终成功响应；失败保留 partial；普通下载遇到现有目标改用新名字，明确“重新下载”才在成功后原子替换同一路径；正常、续传、零字节、未知大小、截断、426、控制连接断开、取消/暂停均用真实本地 FTP socket 夹具验证。修复最后数据块携带 EOF 时丢失结束状态的错误。
- aria2：移植错误码语义，覆盖磁盘满、权限、认证、恢复失败、校验失败等，直接供现有失败 UI 使用。
- 普通队列：将列表显示顺序与调度顺序分开，增加 FIFO 与防饥饿验证，保留集合/预约/手动暂停约束。
- Thunder：在共享链接入口严格校验 Base64、UTF-8、AA/ZZ 包装与目标协议；去重后复用现有 HTTP/HTTPS/FTP 引擎。预检、会话匹配、空间检查和最终创建统一使用解码地址，不改变原始签名路径/查询参数。

### 第二批：任务管理和自动化

- 流式 SHA-256/SHA-1/MD5 计算与期望摘要对比，进度/取消/文件变更检查；本地计算，不上传文件。
- 导入 aria2 input-file 的可审阅任务列表，保留镜像组和受支持选项；导入不得直接触发下载。
- 可重排队列、周期限速窗口、目录规则、设置备份。各自拥有明确持久化格式、迁移策略与 ACK。
- 完成后睡眠/关机/退出为明确设置，提供倒计时和取消；失败/暂停/录制中的任务不能算“全部成功”。

### 第三批：BT、SFTP、ED2K 与协议扩展

- 先固定辅助引擎版本和能力握手，验证许可证、可执行文件来源/摘要、Mac arm64 与 Windows 的发行包。
- 通过原生任务账本分配稳定 NDM ID，保存辅助引擎标识和恢复状态；不能让两份现有 EngineClient 同时推送相互覆盖的 snapshot。
- 适配器放入原生 DownloadManager 的 EngineFactory/Engine 契约；保存 NDM ID、引擎 GID、generation、创建回执和提交状态。启动时先对账再创建，避免超时重试制造重复任务。BT 同时需要多文件清单、路径/清理归属、元数据选择闸门与独立做种状态。
- Aria2 Next 审计参考提交 `2521bb0cebbe2feedd096879c54a73efd818fa43`，不把它假定为上游发行包实际捆绑源码。该 fork 已移除 FTP，HTTP/SFTP 使用 libcurl，BT 使用 libtorrent；新的 state-dir 与 NDM 现有标准 aria2 的相邻 `.aria2` 文件不能直接互认，元数据转下载的 GID 语义也不同。必须先固定实际发行包及相符源码，不能替换现有 Windows 二进制后期待自动兼容。
- 逐个实现 BT 元数据/文件选择/分享生命周期，SFTP 认证与主机密钥，ED2K 的独立状态语义。Thunder 先识别其最终传输协议。
- 真实验收必须含：自有 torrent 与两个隔离 peer、选择子集下载、重启恢复、停止做种；本地 SFTP 认证/主机密钥变更/断点续传；ED2K 固定引擎契约及可控传输环境。
- UI 任务接入新的选择面板/设置入口，视觉与功能各自验收后统一安装。

所有批次保留普通下载默认 32 连接/不限速的既定产品方向，不用上游默认值覆盖用户设置。

## 当前交付状态

首批实现已形成四个独立提交：

| 提交 | 可用行为 |
| --- | --- |
| `62c5085` | FTP 仅在正向完成回执与已知长度均通过时完成；失败保留 partial；普通命名避让、显式重下成功后原子替换 |
| `e1fce08` | 普通自动下载按持久任务 ID FIFO；新建与 Relay 不抢占旧队列；队首启动失败后推进下一项；保留手动开始与集合优先级 |
| `179658d` | 直接复用 29 项 aria2 错误语义；中文恢复提示；错误、历史展示与 RPC 文本脱敏；完整 MIT 声明 |
| `0738488` | Thunder 包装导入/去重；预检与提交地址一致；完整 URL 幂等处理，保留签名末尾标点和字面 `&amp;`，不误选查询中的嵌套媒体 URL |

已取得的验证证据：

- `npm test`：448/448 通过；包含错误映射/RPC→快照→持久化、历史脱敏、Thunder 严格解析和真实本地 HTTP 请求字节验证。
- `npm run typecheck`、`npm run build`：通过，并在 rebase 至 UI `4f2493e` 后重跑通过。
- `npm run build:native -- --scratch-path /tmp/ndm-functional-native-release-20260914 --jobs 2`：release NDMHost 构建通过。
- `npm run test:native -- --scratch-path /tmp/ndm-functional-native-build-20260914 --jobs 2`：NDMEngine 541 项、8 跳过、1 失败；NDMCore 552 项和 NDMBridge 24 项零失败，另 11 项 Swift Testing 通过。唯一失败为未修改的 `InstallerRunnerTests.testSLAAcceptedInstallsThroughTheConvertBypass` 挂载 DMG 失败；同一代码精确重跑 1/1 通过（4.749 秒），初次完整 run 同项也通过（5.944 秒）。证据支持间歇性挂载失败，不能断言由并发封包引起，也不能把最终完整 run 称为完整绿灯。定向日志：`/tmp/ndm-functional-installer-focused-20260914.log`。
- 本批原生用例全过：FTP 16 项真实本地 socket 集成；FIFO 6 项 DownloadManager/HTTP 集成加 3 项策略测试。
- 真实 React renderer + 隔离模拟 bridge：手动输入 Thunder 媒体链接后出现清晰度选项；probe、storage、addMedia 地址一致；无效包装显示输入错误且不创建任务；复杂签名链接经粘贴解包与再次提交仍逐字一致。预览返回模拟媒体数据，这不代表真实 YouTube 或已安装版本验收。
- 初次测试暴露 FTP EOF 与 manager 测试文件名问题，已修复后定向及完整套件对应项通过；独立代码复核暴露 URL 二次提取破坏签名问题，已修复并加回归。

验证日志位于本机 `/tmp/ndm-functional-{native-tests-final,native-build-final,integrated-ts-tests,integrated-typecheck,integrated-build}-20260914.log`。预览仅使用隔离端口 51876，该进程和浏览器页已关闭。没有访问或修改生产任务库、活动下载或 `/Applications/NDM.app`。

尚未完成：第二、三批功能的实现；Windows 实机与 FTP 真实跨卷发布验收；首批与 UI 最新文件口袋修复的最终合入及统一安装。当前安装版来自 UI 工作线，不能把功能分支的测试结果归到安装版上。
