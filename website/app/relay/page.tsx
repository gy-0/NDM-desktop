import type { Metadata } from 'next'
import { Shell } from '@/components/Shell'

export const metadata: Metadata = {
  title: 'Relay'
}

export default function RelayPage() {
  return (
    <Shell current="/relay">
      <section className="ndm-opening" data-span="full">
        <div className="ndm-opening-claim">
          <h1 className="ndm-title">浏览器把下载交给本机 NDM</h1>
          <p className="ndm-lede">
            NDM Relay 是装在 Chrome、Arc 或 Edge 里的本地扩展。它把浏览器的下载和网页视频转交给已经打开的
            NDM，不经过远程服务器。
          </p>
        </div>
      </section>

      <section className="ndm-section">
        <div className="ndm-reading ndm-flow">
          <h2 className="ndm-heading-24">通过 Chrome Web Store 安装</h2>
          <p className="ndm-body">正式版 Relay 将通过 Chrome Web Store 分发。商店入口发布后，可从 NDM 的浏览器设置进入安装页面；安装后打开 NDM，确认扩展显示已连接，再从网页发送下载。</p>
          <p className="ndm-note">商店入口目前尚未提供。现在可以先把下载链接粘贴到 NDM，无需安装扩展。</p>
        </div>
      </section>

      <section className="ndm-section">
        <div className="ndm-reading ndm-flow">
          <h2 className="ndm-heading-24">Windows 第一版没有 Relay</h2>
          <p className="ndm-body">
            Windows 构建尚未随包启用浏览器扩展。文件、磁力链、在线 torrent 和网页视频都通过粘贴到
            NDM 完成。磁力链由 aria2 接管。
          </p>
          <p className="ndm-sources">与 docs/WINDOWS.md 中「当前边界」一致。</p>
        </div>
      </section>
    </Shell>
  )
}
