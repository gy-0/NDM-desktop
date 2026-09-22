import type { Metadata } from 'next'
import { Shell } from '@/components/Shell'
import { RELEASES_URL } from '@/lib/site'

export const metadata: Metadata = {
  title: '常见问题'
}

export default function FaqPage() {
  return (
    <Shell current="/faq">
      <section className="ndm-opening" data-span="full">
        <div className="ndm-opening-claim">
          <h1 className="ndm-title">会改变决定的几件事</h1>
          <p className="ndm-lede">关于发布、浏览器连接和付费方案的常见问题。</p>
        </div>
      </section>

      <section className="ndm-section ndm-stack">
        <div className="ndm-reading ndm-flow">
          <h2 className="ndm-heading-20">从哪里下载安装？</h2>
          <p className="ndm-body">
            公开安装包尚未发布。正式版本将通过 GitHub Releases 提供，系统要求与安装说明随版本公布。
          </p>
        </div>
        <div className="ndm-reading ndm-flow">
          <h2 className="ndm-heading-20">Windows 会报未知发布者吗？</h2>
          <p className="ndm-body">
            正式安装包的签名与发行验证仍在准备中，目前没有可供公开下载的 Windows 安装包。兼容性与安装注意事项将随正式版本公布。
          </p>
        </div>
        <div className="ndm-reading ndm-flow">
          <h2 className="ndm-heading-20">YouTube 或哔哩哔哩不能用了怎么办？</h2>
          <p className="ndm-body">
            站点改版会导致解析失败。NDM 会把失败显示出来并允许重试，不保证某个站点长期可用。这是所有依赖解析器的下载器的共同限制。
          </p>
        </div>
        <div className="ndm-reading ndm-flow">
          <h2 className="ndm-heading-20">现在能买 Pro 吗？</h2>
          <p className="ndm-body">
            目前尚未开售，价格页展示的是方案草案，也没有付款入口。公开安装包的发布状态请查看下载页。
          </p>
        </div>
        <p className="ndm-sources">
          查看发布状态：{' '}
          <a href={RELEASES_URL}>GitHub Releases</a>。
        </p>
      </section>
    </Shell>
  )
}
