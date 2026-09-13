# Motrix Next / Rayburst 功能对照与复用实施记录

核查日期：2026-09-14。用户要求覆盖日常下载可靠性、任务管理/自动化、新协议三个方向。这个范围用于分批交付，不把研究、代码完成、测试通过和安装可用混为一谈。

## 最新状态

- `main` 与功能分支均已推送至 `766f942b816fb1531dc005128e013d9cb52cf7c3`，远端引用已核对。UI 与功能代码已合入同一主线，原有 Douyin 未提交工作经逐文件备份和三方合并保留。
- 已实现文件校验、任务文件/镜像导入、FIFO 与队列重排、周期限速、目录规则及常用目录、下载设置备份、完成后动作，以及 BT/SFTP/ED2K 统一任务和恢复。BT 已含选文件、Tracker/WebSeed、peer、分享参数、上传限速和会话加密。
- 最后一项后端收尾是辅助协议代理设置切换。固定引擎的真实代理契约 12 项通过，原生与 Windows 产品接入仍在验证，尚未并入上述提交。
- `/Applications/NDM.app` 仍为 `2026091403`；`2026091404` 仅已准备版本号。最终包、签名、安装后任务保留、真实界面操作尚未完成。Mac 当前锁定，界面验收等待用户手动解锁。
- Windows TS 后端已使用真实引擎测试，但没有 Windows 操作系统实机验收。以下各章节为时间顺序检查点，应以本节及最后的检查点区分当前和历史结果。

## 对照基线与协作

- 上游：`AnInsomniacy/motrix-next`，锁定 `83dcd3c6ef1e8d31f9aaff1bf4b6bf0588a99fa3`。源码已改名 Rayburst，公开发行版仍叫 Motrix Next。[源码说明](https://github.com/AnInsomniacy/motrix-next/blob/83dcd3c6ef1e8d31f9aaff1bf4b6bf0588a99fa3/README.md)
- NDM 审计基线：`dd5aa84e5accbfd8891a9a51e5533a9bbdaffe91`。首批实现已无冲突 rebase 至 UI 提交 `4f2493e6afae87fa98e786de7e13abec145e12be`，之后通过 merge `3d47b27` 纳入 UI `74144b325ecd7ac7b5d4d528ef11b88f8418a0b2`。未改写已推送分支历史；主仓库尚未提交的 Douyin 工作不属于本次补丁。
- 功能 worktree：`codex/motrix-functional-upgrades`。UI 任务“评估并集成组件动效”完成其独立交付后，已移交主线版本与部署；功能线负责这次统一交付。
- 两条工作线不共享构建输出、数据库、QA 端口或安装流程。功能补丁通过独立提交协调合入。
- GitHub API 当日返回 10,205 stars、317 forks、7 名提交贡献者；主要作者 1,402 次提交，其余分别 3、1、1、1、1、1。关注度和提交数都不等于模块质量或真实用户验收。

## 许可证与复用方式

主应用为 [MIT](https://github.com/AnInsomniacy/motrix-next/blob/83dcd3c6ef1e8d31f9aaff1bf4b6bf0588a99fa3/LICENSE)。可复制、修改、移植和商业分发，复制代码时必须保留版权与完整许可声明。每个引入模块记录原路径、固定提交、改动、测试来源，并将声明纳入应用已打包的 `THIRD_PARTY.md`。

独立 [Aria2 Next](https://github.com/AnInsomniacy/aria2-next) 引擎采用 GPL 系列许可，不能因为外层应用是 MIT，就把引擎当 MIT 源码移植。采用辅助进程时也须核查实际版本、源码交付和捆绑依赖的许可义务；进程分离本身不是自动豁免。NDM 当前未在根 package 声明产品许可证，本批不会替用户擅自更改产品许可。

复用优先次序：已有 NDM 模块满足要求时增强原模块；上游纯逻辑通过依赖/边界审查后直接移植；复杂协议采用经过契约验证的独立引擎。保留 NDM 的原生 HTTP 分段存储、恢复账本、浏览器会话边界和媒体流程。

## 初始差距矩阵

此表保留开始实施时的代码审计基线；最新状态见下文交付检查点。它不代表当前安装版或跨平台实机验证结果。

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

已移植 `aria2ErrorCodes.ts` 的全部 29 项语义映射，并适配 `settingsBackup.ts` 的版本封装、`batchHelpers.ts` 的导入语义、`fileCategory.ts` 的条件匹配语义。固定来源与完整 MIT 许可保留在代码和 `THIRD_PARTY.md`；中文恢复建议、脱敏、加密恢复和有界通配符匹配是 NDM 的适配。上游 Tauri/Vue/Rust 的任务服务、数据库和系统 API 不适合整目录搬进 Electron/React/Swift。

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

## 第一批交付检查点

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

## 持续目标与第二批进展

用户明确要求所有方向继续推进，并要求创建 Goal；当前目标为 active，直到清单功能、适当测试及统一安装完成。开发分支的“已实现”不等于安装版已交付。

| 模块 | 当前证据 | 剩余边界 |
| --- | --- | --- |
| 文件校验 | SHA-256/SHA-1/MD5、期望值、进度/取消/文件变更保护，10 项真实文件测试通过；真实 Electron 中对 1 MiB HTTP 下载成品验证一致及不一致提示 | 随统一安装交付 |
| 设置备份 | MIT 封装适配；8 项下载设置白名单、排除凭据、跨平台目录校验、预览、回读/失败补偿；17 项测试通过。真实 Electron 原生文件对话框导出 JSON，并导入连接数 32→8、不限速→131072 B/s，UI 确认保存回读成功 | 不承诺跨引擎事务；代理配置/bridgePort 因现有更新语义尚未纳入 |
| aria2 任务文件导入 | 25 项通过；多镜像保留同一任务、行级预览，加密持久化完整固定请求、creationKey 和重启回执核对 | 最新完整 UI 流程及统一安装验收 |
| HTTP 镜像 | 原生零数据切换；已有 segment/receipt 时保留来源。native 镜像/续传/创建回执/Store 定向 35 项通过；Windows 标准 aria2 6 项真实 HTTP 验证含首镜像404后的字节一致 | 跨平台安装版验收 |
| 完成后动作 | 默认关闭、一次性启用、30–300 秒可取消倒计时，活动/暂停/失败/缺失任务阻塞、最终权威检查；14 项测试通过；已接 main/Settings | 电源系统调用未实机触发，测试均 stub；历史录制 flag 在适配层按持久任务状态规范 |
| 周期限速 | 20 项通过；跨午夜/星期/DST、失败重试、持久租约、ACK与回读，与临时限速/手动覆盖串行协调；Windows全局限速修复RPC失败后误保存 | 最新完整 UI 与实际限速验收 |
| 手动队列重排 | native FIFO/排序 11 项、Windows队列/Relay入口定向6项通过；陈旧列表拒绝操作，持久排序，新增任务接在队尾 | 最新完整 UI 与安装验收 |
| 目录规则 | MIT语义适配；域名/路径/扩展名组合、显式目录优先、版本与revision、跨平台路径检查；TS服务及Windows创建17项、native5项含真实文件交付通过 | 已对齐安装版 native 配置路径；完整 UI 与统一安装验收 |
| BT、SFTP、ED2K | 原生产品真实 BT 选文件/做种/停止交付、SFTP 2MiB部分续传及重启补认证、ED2K双peer1MiB停止共享交付通过；Windows TS真实辅助流程13项通过；主进程与真实Host完整链路通过 | BT高级设置、Windows跨引擎总限速及最终打包/UI验收继续中 |

第二批初始集成检查：`npm test` 491/491、`npm run typecheck`、`npm run build` 通过（在后续完成动作、恢复和镜像变更前的检查点，不能覆盖后续改动）。日志 `/tmp/ndm-phase2-{tests,typecheck,build}-20260914.log`。

第二批提交检查点已推送并核对远端：`d407574` 校验/备份、`7d1ffc3` 加密导入恢复、`a5a6e01` 镜像/队列、`f6870ea` 自动化及入口接线、`8e81e88` 固定辅助工具/源码/许可。最后一次该检查点完整 TS 运行 543 项：542 通过、1 个 opt-in 标准 aria2 集成测试未启用；该项另行指定本机标准 aria2 后通过。`typecheck/build` 通过；后续目录与辅助功能仍需最终检查，不能沿用旧结果。

主进程协议入口专项 7 项通过：用户选定种子文件限8MiB/普通文件/不跟随符号链接、不可变字节快照与opaque token、前置参数白名单、同key并发单次派发、超时后回执对账、认证字段与错误脱敏。共享协议边界 13 项通过，含ED2K inline sources受限解析；创建之后的失败永不被伪装成“尚未提交”。

真实 Electron QA 使用 `/var/folders/28/7yq61yhd23sb8zz0ynmnsz500000gn/T/ndm-download-tools-qa-xoPd4c`，独立引擎/用户目录，端口 59606/59607/59608。文件 SHA-256 为 `844b0df82fccb18c9abd93af5714be1dce7fc7b9cbacfee5bc718a017baccb44`。导出证据 `/tmp/ndm-tools-qa-export-20260914.json`。验证后关闭自有 Electron/Host/HTTP 服务并确认端口与 PID 消失；隔离 UserDefaults `ndm.support.9a6536959c7a091e` 已导出留证并删除。电脑之后锁定，新增 UI 流程留待可操作时验证，开发和后端集成仍继续。

### 固定辅助引擎及已发现的真实限制

- 官方 Aria2 Next `v2.7.5` macOS arm64 二进制 SHA-256：`c36268f2ab67614ad8737586adab7fc1e1df85e0aef55421bd45f778f0868343`，与 GitHub 发行资产摘要一致。
- Tag 解引用源码：`a9784ea8e36ae83f360ff5157b60c72eb8d96375`；对应源码归档 SHA-256：`01b371683d160b912afa9b89d126dc33d84f0d4e1b5edd1716bbae12695bca29`。引擎版本输出 GPL-2.0-or-later；发行包还需纳入完整依赖许可和源码交付材料。
- 实际版本输出包含 BT、ED2K、SFTP。SFTP 源码只有提供 `ssh-host-key-sha256` 时才设置 libcurl 的主机公钥 SHA256 校验，NDM 必须提供明确的密钥验证流程。
- `scripts/qa-auxiliary-engine.mjs` 在隔离 loopback RPC/HTTP 与固定 GID 上实测：仅 state-dir 重启后没有恢复 RPC 创建任务，重放持久创建请求后恢复暂停任务，再完成 262144 字节逐字验证。这证明需要 NDM 账本重放，不能假设引擎自动恢复。
- 同一固定版本首镜像 404 时返回 errorCode 3，没有自动使用第二镜像；标准 aria2 与该 fork 的镜像语义不同，不能把标准实现的结果直接归于 fork。该脚本保留此限制并单独验证正常下载，不把它报告为镜像成功。
- 原生辅助基础17项：实际2MiB部分下载→暂停ACK→daemon重启→固定GID重放/Range续传→字节一致，以及私有trackerless torrent的元数据选择闸门。日志 `/tmp/ndm-auxiliary-live-20260914.log`。
- `scripts/qa-sftp-contract.mjs` 使用 `scripts/qa-sftp-fixture.py`（仅生成文件、loopback、只读）与独立Paramiko4环境，正确pin完成1MiB SHA256 `631b84027d6b9e52b539c4e8373622d23032dfadc64d60af87339c9037e4f769`；错误pin在密码认证前停止（0 auth/0 read），错误密码不读文件。日志 `/tmp/ndm-sftp-contract-20260914.log`，夹具与引擎均已关闭、临时目录清理。
- 直接复用固定源码 `tools/transfer_validation/ed2k/validate.py`：两个本机隔离peer，inline sources加空nodes.dat排除公网bootstrap，1MiB SHA256 `417dcd5410299a26a1d22a483dcd4c21aea828ae4e63374bd9481cfe645e87a6`、peerCount1、kadRouterCount0。日志 `/tmp/ndm-ed2k-upstream-fixture-20260914.log`。此证据证明协议引擎，不代替NDM发布/恢复验收。
- 工具准备脚本已下载并验证固定二进制、对应完整源码及依赖许可。新增 `verify-auxiliary-tools.mjs` 在mac构建前与签名前后严格核对，防止重签改写helper后运行时hash不符；最小临时app实际deep签名保持Resources/Tools内helper字节不变，仍须正式NDM包验证。
- FTP代理实测后采用最小SOCKS4/5 CONNECT传输以覆盖控制与PASV数据，避免系统代理例外静默直连；HLS对系统会绕过SOCKS的localhost/loopback目标及重定向停止并明确报错。该限制不等于完整支持本机HLS代理。

此时尚未完成的 FTP 跨卷发布和主线合入已在下文取得验证。Windows 实机与统一安装仍待完成；当前 `/Applications/NDM.app` 为 UI 工作线的 build 2026091403，尚未包含功能分支新增模块。

### 第三批基础检查点

- `f3477c1`：原生辅助协议统一账本、稳定 GID/创建回执、目录规则与 FTP/HLS 控制。`c4e8fa5`：跨平台协议入口、主进程不可变种子快照、Windows辅助协议及目录规则 UI。
- 当前完整 `npm test`：601项，598通过、3项显式启用的真实引擎测试跳过、零失败；这3项均有分别启用后的通过记录。`typecheck/build` 通过。日志 `/tmp/ndm-phase3-base-{tests,typecheck,build}-20260914.log`。
- 原生最终定向组合136项中135通过；新目录发布测试因 URL 尾斜杠表示不同失败，已改为比较标准路径与 inode，publication 3项重跑全过。日志 `/tmp/ndm-auxiliary-product-final-20260914.log`、`/tmp/ndm-auxiliary-publication-final-20260914.log`。
- Windows辅助专项13/13通过，使用macOS上的同一固定辅助引擎执行Windows TS后端，不代表Windows OS实机。日志 `/tmp/ndm-windows-auxiliary-tests.log`。
- 真实 Host→主进程 AuxiliaryToolsService→辅助进程→文件发布：种子确认前零载荷请求；同创建key只产生一个任务；选择后1MiB下载并做种，停止做种后完整交付，SHA256 `f232691ecce64cc88b4d6828c8425a180d3d7e04431a55141445123f4443298a`。日志 `/tmp/ndm-auxiliary-host-main-20260914.log`，自有Host/helper/HTTP/临时目录与偏好域已清理。
- FTP/HLS协议控制21项、bandwidth6项、redirect15项通过；直播取消保留已录内容。日志 `/tmp/ndm-protocol-controls-final-cleanup-20260914.log`。

这些检查点仍在功能分支，未替换安装版。下一批接入真实 BT Tracker/WebSeed/peer/分享参数与 Windows 跨引擎总限速，再做最终全量和安装验证。

### 接线与组合验收

- `defa573`：BT 控制的共享格式、主进程校验与 React 面板。真实固定辅助引擎13项专项通过；组件默认值、失败保留草稿、冲突恢复、暂停编辑、会话加密确认已有独立mock bridge验证，不能替代原生应用验收。
- `a9695a4`：修复 renderer 丢弃 `linkType` 导致协议详情不出现；修复 Composer 自动填入默认目录被当作显式目录、绕过规则。预览读取已保存规则，普通与媒体提交仅传手动选择的目录。默认连接数在设置尚未到达时也保持32。新增收藏与最近目录，及恢复自动目录按钮。
- 接线专项：目录与快捷目录4项、renderer snapshot12项通过；TypeScript检查通过。
- `scripts/qa-download-management-host.mjs` 通过真实 Host 与主进程服务组合验证：预览零请求；三任务导入、首镜像404后切换；目录规则实际生效；重排实际请求顺序1→3→2；131072 B/s窗口限速期间未提前完成，退出窗口回读恢复0不限速；三份2MiB文件逐字一致；重建导入服务后原key回执复用且无重复任务；磁盘导入状态未含明文URL。每份SHA256 `45026c02eaf4771246fe89c562f9b0d346943247669f7051a047a10f040deda0`。日志 `/tmp/ndm-management-host-20260914.log`。仅时间输入与安全存储适配器使用隔离QA实现，下载引擎、文件、限速与配置持久化为真实运行。
- 原生 BT 控制9项真实helper验证通过：Tracker/WebSeed、peer添加与传输遥测、分享率/时间/上传/PEX、全局会话加密；清除seed-time同GID保留2MiB partial/inode并续传完成；pending配置恢复；seed-time0自动停止与成品交付。最终并发回归仍在收尾。日志 `/tmp/ndm-bt-controls-final-20260914.log`。
- Windows标准HTTP与辅助SFTP实际并发：总512KiB/s时6.005秒两者共3,194,484字节，约519KiB/s；降至总256KiB/s分别回读128KiB/s；暂停普通任务后辅助得到全额256KiB/s。日志 `/tmp/ndm-win-budget-sftp-real.log`。BT局域网的libtorrent默认配额豁免仍在最后核实，不能沿用SFTP结论。
- `ab1d4ba` 仅准备版本元数据2026.9.14 / build2026091404，尚未打包安装。主线既有Douyin及混合package WIP已备份到 `/tmp/ndm-main-integration-20260914-04kx7o3l` 并在副本试合并；当前没有修改主线WIP。

计划交付后的主要入口：新建下载中的“磁力链、种子、ED2K 与 SFTP”；任务详情中的协议文件选择、分享控制与文件校验；设置的下载页中的任务文件导入、周期限速、目录规则、设置备份和完成后动作。仍须完成最终构建、主线合入及安装验证后才能称为已交付。

### 原生完整回归与主线整合检查点

- `1c429cb`：原生 BT 高级控制与 FTP 跨卷测试。对应完整 native run：NDMEngine 614项、20项显式启用测试跳过、0失败；NDMCore552项、NDMBridge24项零失败；另11项Swift Testing通过。release NDMHost构建成功。日志 `/tmp/ndm-functional-native-complete-20260914.log`、`/tmp/ndm-functional-native-release-complete-20260914.log`。后续代理接入不属于这个全量检查点。
- FTP跨卷单独显式启用1/1通过：自有128MiB APFS sparseimage，源/目标st_dev不同；2MiB发布、原同名文件保留、显式重下替换sentinel并保持路径、无暂存残留。镜像已卸载且源/镜像/挂载目录清理。日志 `/tmp/ndm-ftp-crossvolume-tests-20260914.log`，回执 `/tmp/ndm-ftp-crossvolume-receipt-20260914.json`。
- main已快进到`1c429cb`，在复制备份、逐文件SHA核对和三方试合并后恢复18个既有未提交文件；已消费过时的UI版本元数据，保留原Douyin脚本入口/Host代码/许可/源码与测试。主线包含这些WIP的release构建成功，日志 `/tmp/ndm-main-integrated-native-build-20260914.log`。安装版仍是2026091403。
- 后续代理覆盖核对发现新增辅助协议未接现有网络设置，正在补齐：BT使用引擎代理；SFTP分别验证HTTP CONNECT与SOCKS5；ED2K引擎没有代理能力，启用代理时明确拒绝开始。更改代理会安全暂停这些任务，用户重新开始后使用新设置。不会把旧路径仍在运行视为设置已生效。
- `766f942`：Windows跨进程总预算与BT高级控制，32/32专项（实际helper全部显式启用）通过。对libtorrent默认局域网session限速豁免，使用辅助任务GID分配瞬时下载份额，并与单任务设置取更小值；逐项先降后升、ACK+回读，不改用户持久限速。1MiB本地BT WebSeed在128KiB/s份额下9.226秒完成。日志 `/tmp/ndm-win-budget-controls-final.log`。
- main到`766f942`的完整TS检查628项：621通过、7项显式启用测试跳过、0失败；相关真实引擎项已有单独通过记录。主线typecheck/build通过。日志 `/tmp/ndm-phase3-controls-complete-tests-20260914.log`、`/tmp/ndm-main-controls-{typecheck,build}-20260914.log`。
- 包含既有Douyin WIP的主线release Host重新执行BT主进程完整链路，1MiB字节一致、选择前零payload请求、同key无重复任务、做种期间不误报complete。日志 `/tmp/ndm-main-auxiliary-host-20260914.log`。此验证仍使用隔离任务库，尚未替换安装包。

### 辅助协议代理契约

- `scripts/qa-auxiliary-proxy.mjs`：固定 macOS arm64 Aria2 Next 2.7.5，12项真实测试通过（SFTP7项、BT5项），所有测试进程、监听和临时目录均清理。日志 `/tmp/ndm-auxiliary-proxy-final-20260914.log`。
- SFTP HTTP CONNECT 需使用任务 `all-proxy`；SOCKS5 则用清理继承代理变量后的子进程 `ALL_PROXY=socks5h://…`。两者以不可在本机解析的 `.invalid` 域名确认代理 DNS，1MiB实际交付；拒绝连接时零载荷且未回退直连。直接给 RPC `all-proxy` 传 SOCKS URL 会被此版本拒绝，不能把 ACK 假设成支持。
- BT HTTP/SOCKS5 实际 peer 载荷和 Tracker announce 均经过代理，1MiB SHA-256一致；拒绝代理时零载荷。SOCKS4仅验证数字IP的 Tracker/peer，经代理解析域名不受支持。
- 启用代理时显式禁用 DHT、本地发现与端口映射。上游 SOCKS5 默认仍可能启用 DHT，不能从 TCP 载荷成功推断 UDP 路径；本次未将 UDP 代理声称为已验收。
- 上述为固定引擎契约结果；设置切换、现有任务保留、旧进程停止和重新开始采用新代理，还需两个产品后端的单独验收。
