import type { Metadata } from 'next'
import { Shell } from '@/components/Shell'
import { FREE_FEATURES, PRO_FEATURES, PRO_PRICING } from '@/lib/site'

export const metadata: Metadata = {
  title: '价格'
}

export default function PricingPage() {
  return (
    <Shell current="/pricing">
      <section className="ndm-opening" data-span="full">
        <div className="ndm-opening-claim">
          <h1 className="ndm-title">下载免费。Pro 是一次买断草案。</h1>
          <p className="ndm-lede">
            桌面端商业化开关仍关闭，免费与 Pro 的门禁还没有接到真实付款。下面的价格和分界来自{' '}
            <span className="ndm-mono">license.ts</span> 与商业化备忘录，标为草案。
          </p>
        </div>
      </section>

      <section className="ndm-section">
        <div className="ndm-comparison">
          <div className="ndm-stack">
            <h2 className="ndm-heading-24">免费</h2>
            <p className="ndm-body">日常够用，且永远不加广告或弹窗。Relay 目前只在 macOS 随包提供。</p>
            <ul className="ndm-flow">
              {FREE_FEATURES.map((item) => (
                <li key={item} className="ndm-body">
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div className="ndm-stack">
            <h2 className="ndm-heading-24">Pro 草案</h2>
            <p className="ndm-body">
              早鸟 ${PRO_PRICING.earlyBird}，正式 ${PRO_PRICING.regular}，个人授权最多 {PRO_PRICING.seats}{' '}
              台。不采用订阅制，并包含后续更新。
            </p>
            <ul className="ndm-flow">
              {PRO_FEATURES.map((item) => (
                <li key={item.name} className="ndm-body">
                  {item.name}。{item.note}。
                </li>
              ))}
            </ul>
          </div>
        </div>
        <p className="ndm-sources">
          分界原则：下载这件事本身永远免费。Pro 卖规模与画质，不是「能不能用」。正式开卖前还需要签名激活码、支付通道和店外分发说明。
        </p>
      </section>
    </Shell>
  )
}
