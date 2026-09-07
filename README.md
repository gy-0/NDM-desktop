# NDM Desktop

NDM 的 Electron/React 桌面界面，支持 macOS 与 Windows。

- macOS 使用 Swift `NDMHost`，保留完整分段下载与媒体处理能力。
- Windows 使用随安装包分发的 aria2 下载引擎，并由 yt-dlp 解析常见网页媒体。

## 本地开发

```bash
npm install
# macOS 首次准备媒体工具（需要 Xcode Command Line Tools、gpg；Intel 构建 FFmpeg 还需 nasm）
npm run fetch:mac-tools
npm run build:native
npm run dev
```

官网在 `website/`：`cd website && npm install && npm run dev`，打开 http://localhost:3100。品牌源是 `website/DESIGN.md`，公开发布在 `/design.md`。

macOS 宿主源码位于本仓库 `native/`，修改后重新构建：

```bash
npm run build:native
```

## 构建

```bash
# macOS 解包应用
npm run package

# Windows x64 安装器
npm run package:win

# Windows 解包目录
npm run package:win:dir
```

Windows 工具由 `scripts/fetch-windows-tools.mjs` 按固定版本下载并验证 SHA-256，构建不会使用未经校验的二进制。

## 验证

```bash
npm test
npm run typecheck
npm run test:relay
# macOS
npm run test:native
npm run qa:windows-engine
```

`qa:windows-engine` 使用真实 aria2 RPC 完成下载、暂停、恢复和最终文件哈希校验。

### 关键 QA 脚本

| 脚本 | 验证内容 |
|---|---|
| `qa:cleanup` | 任务库整理：批量重试失败、移出暂停/已完成、空库空态与 Esc 关闭 |
| `qa:relay-browser` | Relay 浏览器闭环：弹窗连接、双端点离线恢复、媒体识别、任务交接、真实下载 |
| `qa:failure` | 失败可见性与诊断链接重试 |
| `qa:settings` | 设置跨重启持久化（隔离支持目录） |

注意：`qa:relay-browser` 需要默认端口空闲——若正在运行 NDM，脚本会主动拒绝执行以保护生产实例。

详细的 Windows 支持范围见 [docs/WINDOWS.md](docs/WINDOWS.md)。

商业化方向决策见 [docs/MONETIZATION.md](docs/MONETIZATION.md)（Freemium + 一次买断建议稿）。

按键回馈使用 [cuelume](https://www.npmjs.com/package/cuelume)。部分列表与侧栏交互参考 [Beautiful UI](https://www.beautifului.dev/)（MIT，Shane Levine）。动效令牌来自 [transitions.dev](https://www.transitions.dev/)（MIT）。

## 仓库边界

本仓库是当前 NDM 产品的主仓库：Electron 界面在 `src/`，macOS Swift 引擎在 `native/`，浏览器扩展在 `extension/NDMRelay/`。无需克隆旧 NDM 仓库。Swift UI 不在维护范围内。

`npm run package` 会先增量编译本仓库的 Release 引擎。macOS 媒体工具由 `npm run fetch:mac-tools` 准备到 `native/Vendor/Tools/`，该生成目录不进 Git；脚本下载校验 yt-dlp、Deno，并验证 FFmpeg 源码签名后本地编译。缺少工具时先运行该命令。Windows 使用独立的 `fetch:windows-tools` 流程。

`NDM_SOURCE` 仅用于显式覆盖开发期 Swift 包路径，默认是本仓库的 `native/`；打包始终使用本仓库源码。仅有 Linux 环境的 AI 可以修改代码并运行 JavaScript/Relay 测试，Swift 引擎与 macOS 打包验证需要 macOS。

迁移来源和参考资料见 [docs/NATIVE_MIGRATION.md](docs/NATIVE_MIGRATION.md)。
