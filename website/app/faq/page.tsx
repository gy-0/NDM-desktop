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
          <p className="ndm-lede">只收录会改变「要不要装」的问题。安装步骤在下载页和 Relay 页。</p>
        </div>
      </section>

      <section className="ndm-section ndm-stack">
        <div className="ndm-reading ndm-flow">
          <h2 className="ndm-heading-20">为什么不在 App Store？</h2>
          <p className="ndm-body">
            Apple 不允许上架可下载 YouTube 等站点视频的应用。Downie 也因此走店外分发。NDM 同样从 GitHub
            Releases 获取安装包。
          </p>
        </div>
        <div className="ndm-reading ndm-flow">
          <h2 className="ndm-heading-20">Windows 会报未知发布者吗？</h2>
          <p className="ndm-body">
            可能。第一版安装器尚未使用商业代码签名证书，SmartScreen 可能拦截。这是当前分发事实，不是产品缺陷文案。
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
            不能。桌面端商业化开关关闭，价格页上的数字是草案。免费档的加速、续传和单个视频下载不受这个开关影响。
          </p>
        </div>
        <p className="ndm-sources">
          需要安装包时打开{' '}
          <a href={RELEASES_URL}>GitHub Releases</a>。
        </p>
      </section>
    </Shell>
  )
}
