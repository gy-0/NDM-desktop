# NDM macOS Beta 候选包验收快照

记录时间：2026-08-17（Asia/Singapore）

这是一份带日期的现场快照，不替代后续真实 QA。重新打包、更新 Host 或更换签名后，应重新核对本页证据。

## 候选包

- App：`/Users/gaoyuan/NDM-desktop/dist/mac-arm64/NDM.app`
- 版本：`2026.8.17`（build `2026081701`）
- 体积：570 MB
- URL Scheme：`ndm`
- Bundle ID：`com.neatdownloadmanager.ndm`
- Desktop source commit：`1d3cfd0a74b79dbe086ccb1e9e4597475c9dcddf`
- Native commit：`9ff5e0703d15c0f2784e67753f738ea01bfd858f`
- NDMHost SHA-256：`67c020fc9c1ce9784b38aab47ac480b6af53f6793a5913a174e061ea69fa618f`
- 包内 NDMHost 与 Release 构建哈希一致；包内 Relay 与源码目录无差异。

## 当前已验证

- `swift build -c release --product NDMHost` 通过。
- `npm run package` 从零完成 Electron 构建、打包、完整 ad-hoc 重签和严格校验。
- `codesign --verify --deep --strict --verbose=4` 通过；资源封装为 version 2，当前 CDHash 为 `2e04f6501aafb0fce0130549f2be968d368d3e28`。
- `npx tsc --noEmit` 通过；Electron 自动化测试 28/28 通过；Relay 语法检查与测试 62/62 通过。
- 精确候选包已从 `Contents/MacOS/NDM` 以隔离的 Electron、Host 数据目录和端口启动；确认加载签名后 `file://…/app.asar` 页面。默认资料中的 3592 个用户任务仅用于只读启动检查，没有操作或清理。
- 精确候选包已完成首次引导 3 步，以及真实 64 MB Range HTTP 下载的添加、双分段进度、暂停稳定、继续、完成动效和任务清理；连续/分段两种进度与 Host 数据一致，控制台没有错误。
- 上述包级 QA 的 `ndm-qa-test.bin` 已确认进入 `~/.Trash`，隔离 Host 中同名任务剩余 0 个。
- 精确候选包已验证定时下载：从任务详情点击“1 小时后”，预约状态和时间跨 Electron/Host 完整重启保持一致；随后通过同一真实 IPC 把到点时间压缩到 1.5 秒，任务自动清除预约、进入双分段下载并完整完成。强化后的稳定完成断言连续通过 5 次，控制台无错误，测试文件均进入 `~/.Trash`。
- 精确候选包已验证单任务连接数和限速：任务详情把连接数从 4 调到 2，Host 状态与 Swift `applyConnectionsCount` 日志都确认实时重规划；设置 1 MB/s 后暂停再继续，3.2 秒真实传输样本约为 1.15–1.19 MB/s；恢复不限速和 4 个连接后完整完成。强化后的闭环连续通过，控制台无错误，测试文件进入 `~/.Trash`。
- 精确候选包已验证 Completion Stack：使用包内 ffmpeg 生成 4.05 MB 的有效 MP4，经真实 HTTP 和 Swift 下载／媒体收尾完成；Host 从磁盘返回主文件、英文字幕、WebP 封面和文本资料共 4 项，Electron 任务详情显示“4 个文件 · 1 份字幕”并逐项展开。旁置的 `unrelated.srt` 被正确排除，控制台无错误，任务和本轮隔离数据均已清理到废纸篓；`qa:completion-stack` 脚本与隔离入口保留供后续复验。
- 精确候选包已验证拖放入口：本地文件拖入时明确说明不会复制或上传；HTTP 直链拖入后只预填真实 Composer，在用户确认前 Host 任务为 0。点击“开始下载”后 Swift Host 完成 6 MB 双分段下载且任务字节数一致；任务和隔离目录进入废纸篓，控制台无错误。拖放现在与粘贴入口共用链接／分享口令／磁力链解析，并经过重复任务、设置和空间检查；`qa:drop-entry` 保留供复验。
- 开发态真实 Electron + Swift Host 已验证普通 HTTP 下载的添加、分段进度、暂停稳定、继续、完成和清理。
- 开发态已验证重复任务、404 错误反馈与重试、诊断链接更新、磁盘空间反馈、设置与主题跨重启持久化。
- QA 下载文件均进入废纸篓；没有删除或覆盖用户文件。
- Pro 和商业化草案仍保留在源码中，但 Beta 阶段不启用，也不锁住基础下载、合集和超清能力。

## 尚未满足的发布门槛

### P0

1. **没有 Developer ID Application 证书。** 当前钥匙串只有 Apple Development 身份；候选包只能做结构完整的本地 ad-hoc 签名，不能作为已完成公证、可直接交付外部用户的发行包。
2. **Relay 尚缺真实 Chrome 弹窗交互验收。** Chrome 控制桥报告浏览器不可用。协议层连接、任务交接和自动化测试已验证，但不等同于用户在真实扩展弹窗中的连接、识别和恢复操作。

### P1

1. **当前 YouTube 合集流程受网络/站点条件阻塞。** 本次真实尝试等待识别 120 秒仍未出现“已识别 N 项”，没有创建任务或文件；不能声称当前合集流程通过。

### P2

1. Electron Builder 报告 `package.json` 缺少 author，以及若干重复依赖引用；目前未形成运行故障，但会增加发行元数据和包体治理成本。
2. 当前 arm64 App 约 570 MB，正式发行前仍需分析 Electron、字体和工具资源占用。

## 剩余最短复验顺序

1. 在真实 Chrome 中加载包内 Relay，验证连接、媒体识别、任务交接、Host 未运行与授权过期恢复。
2. 配置 Developer ID 后重新签名、公证并再次执行本页全部包级检查。
