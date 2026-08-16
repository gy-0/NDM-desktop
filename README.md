# NDM Desktop

NDM 的 Electron/React 桌面界面，支持 macOS 与 Windows。

- macOS 使用 Swift `NDMHost`，保留完整分段下载与媒体处理能力。
- Windows 使用随安装包分发的 aria2 下载引擎，并由 yt-dlp 解析常见网页媒体。

## 本地开发

```bash
npm install
npm run dev
```

macOS 开发前需先构建宿主：

```bash
cd ../NDM
swift build -c release --product NDMHost
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
npm run qa:windows-engine
```

`qa:windows-engine` 使用真实 aria2 RPC 完成下载、暂停、恢复和最终文件哈希校验。

详细的 Windows 支持范围见 [docs/WINDOWS.md](docs/WINDOWS.md)。

按键回馈使用 [cuelume](https://www.npmjs.com/package/cuelume)。部分列表与侧栏交互参考 [Beautiful UI](https://www.beautifului.dev/)（MIT，Shane Levine）。
