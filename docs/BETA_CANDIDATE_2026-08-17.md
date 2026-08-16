# NDM macOS Beta 候选包验收快照

记录时间：2026-08-17（Asia/Singapore）

这是一份带日期的现场快照，不替代后续真实 QA。重新打包、更新 Host 或更换签名后，应重新核对本页证据。

## 候选包

- App：`/Users/gaoyuan/NDM-desktop/dist/mac-arm64/NDM.app`
- 版本：`2026.8.17`（build `2026081701`）
- 体积：570 MB
- URL Scheme：`ndm`
- Bundle ID：`com.neatdownloadmanager.ndm`
- Desktop commit：`2fc4356f82ac537b4cf06c3d011eacf111927760`
- Native commit：`e573952bfe4bbc749ec5fe045bddac38ad662877`
- NDMHost SHA-256：`85289c06d2893195d9a8ed1da2674d880ebdd56e50bf2666bb2780637acecef9`
- 包内 NDMHost 与 Release 构建哈希一致；包内 Relay 与源码目录无差异。

## 当前已验证

- `swift build -c release --product NDMHost` 通过。
- `npm run package` 从零完成 Electron 构建、打包、完整 ad-hoc 重签和严格校验。
- `codesign --verify --deep --strict --verbose=4` 通过；资源封装为 version 2，当前 CDHash 为 `30b8efc8dd0baa59eea565fc18e602e6587ff2ee`。
- `npx tsc --noEmit` 通过；Electron 自动化测试 23/23 通过；Relay 语法检查与测试 62/62 通过。
- 开发态真实 Electron + Swift Host 已验证普通 HTTP 下载的添加、分段进度、暂停稳定、继续、完成和清理。
- 开发态已验证重复任务、404 错误反馈与重试、诊断链接更新、磁盘空间反馈、设置与主题跨重启持久化。
- QA 下载文件均进入废纸篓；没有删除或覆盖用户文件。
- Pro 和商业化草案仍保留在源码中，但 Beta 阶段不启用，也不锁住基础下载、合集和超清能力。

## 尚未满足的发布门槛

### P0

1. **精确候选包尚未完成最后一次界面复验。** Computer Use 连续返回“Mac is locked”；因此不能把此前旧候选包的 `file://` 交互结果直接算作这个签名后包的验收。解锁后需启动上面的精确路径，至少复验添加、暂停/继续、设置/主题、错误与清理，并检查控制台。
2. **没有 Developer ID Application 证书。** 当前钥匙串只有 Apple Development 身份；候选包只能做结构完整的本地 ad-hoc 签名，不能作为已完成公证、可直接交付外部用户的发行包。
3. **Relay 尚缺真实 Chrome 弹窗交互验收。** Chrome 控制桥报告浏览器不可用。协议层连接、任务交接和自动化测试已验证，但不等同于用户在真实扩展弹窗中的连接、识别和恢复操作。

### P1

1. **当前 YouTube 合集流程受网络/站点条件阻塞。** 本次真实尝试等待识别 120 秒仍未出现“已识别 N 项”，没有创建任务或文件；不能声称当前合集流程通过。

### P2

1. Electron Builder 报告 `package.json` 缺少 author，以及若干重复依赖引用；目前未形成运行故障，但会增加发行元数据和包体治理成本。
2. 当前 arm64 App 约 570 MB，正式发行前仍需分析 Electron、字体和工具资源占用。

## 解锁后的最短复验顺序

1. 启动精确候选包路径，确认版本、主题、任务数据和控制台无异常。
2. 用本地 Range HTTP 服务跑一次添加 → 暂停 → 继续 → 完成 → 清理。
3. 在真实 Chrome 中加载包内 Relay，验证连接、媒体识别、任务交接、Host 未运行与授权过期恢复。
4. 配置 Developer ID 后重新签名、公证并再次执行本页全部包级检查。
