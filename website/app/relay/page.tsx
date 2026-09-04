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
          <h2 className="ndm-heading-24">macOS 上怎么装</h2>
          <p className="ndm-body">打开 Chrome、Arc 或 Edge 的扩展页面，开启开发者模式。在 NDM 设置里打开本地扩展目录，把这个文件夹加载为已解压的扩展。现在装或以后在设置里装都行。</p>
          <p className="ndm-note">扩展随应用分发，路径由 NDM 自己定位，不需要从网上另下一份。</p>
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
