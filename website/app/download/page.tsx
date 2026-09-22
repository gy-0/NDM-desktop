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
          <h1 className="ndm-title">公开安装包尚未发布</h1>
          <p className="ndm-lede">
            NDM 正在准备公开发行。发布后，macOS 与 Windows 安装包将在 GitHub Releases 提供；目前还没有可下载的正式版本。
          </p>
          <div className="ndm-button-row">
            <a className="ndm-button" href={RELEASES_URL}>
              查看发布状态
            </a>
          </div>
        </div>
      </section>

      <section className="ndm-section">
        <div className="ndm-split">
          <div className="ndm-stack">
            <h2 className="ndm-heading-24">macOS</h2>
            <p className="ndm-body">
              支持普通文件与网页视频下载，可暂停、继续，并管理下载队列。正式发布时，请选择与 Mac 芯片匹配的安装包；具体系统要求随版本说明公布。
            </p>
            <p className="ndm-note">单任务最多 32 路并发。Relay 的 Chrome Web Store 入口尚待发布，当前可先粘贴链接下载。</p>
          </div>
          <div className="ndm-stack">
            <h2 className="ndm-heading-24">Windows</h2>
            <p className="ndm-body">
              面向 Windows 10 或 11 的 x86-64 设备，支持文件、磁力链和常见网页视频下载。公开安装包和具体兼容性说明尚待发布。
            </p>
            <p className="ndm-note">
              第一版尚未启用 Relay，链接需粘贴到 NDM。正式安装包的签名与发行验证仍在准备中。
            </p>
          </div>
        </div>
      </section>

      <section className="ndm-section">
        <div className="ndm-reading ndm-flow">
          <h2 className="ndm-heading-24">Windows 第一版还没有的东西</h2>
          <p className="ndm-body">
            媒体下载使用包含声音的单文件格式，暂不支持合并独立的视频与音频轨，因此部分高分辨率格式不可用。默认保存到当前用户的「下载」文件夹。
          </p>
        </div>
      </section>
    </Shell>
  )
}
