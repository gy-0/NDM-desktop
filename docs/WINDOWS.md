# NDM for Windows

## 系统要求

- Windows 10 或 Windows 11
- x86-64；Windows 11 ARM 可通过系统的 x64 兼容层运行
- 默认下载目录为当前用户的“下载”文件夹

## 第一版支持范围

- HTTP、HTTPS、FTP 下载
- 磁力链和在线 `.torrent` 链接
- 分段连接、暂停、继续、重试、任务限速、全局限速和定时开始
- 下载历史持久化、Windows 通知、任务栏进度和单实例启动
- 使用 yt-dlp 解析常见网页视频，并下载带音频的兼容格式

Windows 版使用 aria2 1.37.0。进度由 aria2 的真实完成字节生成；界面不会伪造分块范围。

## 当前边界

- 浏览器扩展的 Windows Relay 尚未随第一版启用，链接需粘贴到 NDM。
- 第一版媒体下载选择带音频的单文件兼容格式；尚未随包分发 FFmpeg，因此不合并独立的高分辨率视频轨与音轨。
- 安装器尚未使用商业代码签名证书。Windows SmartScreen 可能显示“未知发布者”；正式给外部用户大规模分发前应完成 Authenticode 签名。

## 构建产物

执行 `npm run package:win` 后生成：

```text
dist/NDM-Windows-2026.8.15-Setup.exe
```

执行 `npm run package:win:dir` 后生成可检查的解包目录：

```text
dist/win-unpacked/
```
