import type { Metadata } from 'next'
import { Shell } from '@/components/Shell'
import { RELEASES_URL } from '@/lib/site'

export const metadata: Metadata = {
  title: '下载'
}

export default function DownloadPage() {
  return (
    <Shell current="/download">
      <section className="ndm-opening" data-span="full">
        <div className="ndm-opening-claim">
          <h1 className="ndm-title">从 GitHub Releases 获取安装包</h1>
          <p className="ndm-lede">
            视频类能力不能上 Mac App Store。当前分发入口是仓库的 Releases 页，没有单独的下载 CDN。
          </p>
          <div className="ndm-button-row">
            <a className="ndm-button" href={RELEASES_URL}>
              打开 Releases
            </a>
          </div>
        </div>
      </section>

      <section className="ndm-section">
        <div className="ndm-split">
          <div className="ndm-stack">
            <h2 className="ndm-heading-24">macOS</h2>
            <p className="ndm-body">
              Apple Silicon 与 Intel 通过同一套 Electron 壳运行，下载内核是 Swift{' '}
              <span className="ndm-mono">NDMHost</span>。装上 NDM Relay 后，Chrome、Arc 或 Edge
              里的下载可以交给 NDM。
            </p>
            <p className="ndm-note">单任务最多 32 路并发。浏览器扩展目录在应用设置里打开。</p>
          </div>
          <div className="ndm-stack">
            <h2 className="ndm-heading-24">Windows</h2>
            <p className="ndm-body">
              需要 Windows 10 或 11，x86-64。Windows 11 ARM 可通过系统的 x64 兼容层运行。引擎是
              aria2 1.37.0，网页视频由 yt-dlp 解析。
            </p>
            <p className="ndm-note">
              第一版尚未启用 Relay，链接需粘贴到 NDM。安装器可能没有商业代码签名，SmartScreen
              可能显示「未知发布者」。
            </p>
          </div>
        </div>
      </section>

      <section className="ndm-section">
        <div className="ndm-reading ndm-flow">
          <h2 className="ndm-heading-24">Windows 第一版还没有的东西</h2>
          <p className="ndm-body">
            浏览器扩展的 Windows Relay 未随第一版启用。媒体下载选择带音频的单文件兼容格式；尚未随包分发
            FFmpeg，因此不合并独立的高分辨率视频轨与音轨。默认下载目录是当前用户的「下载」文件夹。
          </p>
          <p className="ndm-sources">摘自 docs/WINDOWS.md。边界以文档为准，不在站点上提前承诺下一版。</p>
        </div>
      </section>
    </Shell>
  )
}
